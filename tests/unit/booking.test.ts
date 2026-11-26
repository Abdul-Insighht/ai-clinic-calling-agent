import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { demoBusiness } from '../../src/business/demo-business.ts';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import { InMemoryAppointmentRepository } from '../../src/repositories/appointment-repository.ts';
import { InMemoryBusinessRepository } from '../../src/repositories/business-repository.ts';
import { AvailabilityService } from '../../src/services/availability-service.ts';
import { BookingService } from '../../src/services/booking-service.ts';
import { BusinessService } from '../../src/services/business-service.ts';
import { createBookAppointmentTool } from '../../src/tools/book-appointment.ts';
import {
  type CalendarAdapter,
  NoopCalendarAdapter,
} from '../../src/services/google-calendar-adapter.ts';

const northstarContext = {
  businessId: NORTHSTAR_BUSINESS_ID,
  callId: 'call-1',
};

class FlakyCalendarAdapter implements CalendarAdapter {
  public shouldFail = true;
  public createdCount = 0;
  public updatedEvents: Array<{ eventId: string; summary?: string; description?: string }> = [];

  isConfigured(): boolean {
    return true;
  }

  async listBusyIntervals() {
    return [];
  }

  async createEvent() {
    if (this.shouldFail) {
      throw new Error('Google Calendar 503 Service Unavailable');
    }
    this.createdCount += 1;
    return { eventId: `gcal-evt-${this.createdCount}` };
  }

  async updateEvent(input: {
    calendarId: string;
    eventId: string;
    summary?: string;
    description?: string;
  }) {
    this.updatedEvents.push({
      eventId: input.eventId,
      summary: input.summary,
      description: input.description,
    });
  }

  async cancelEvent() {
    // No-op
  }
}

describe('Phase 4 — Transactional booking, idempotency, and calendar outbox sync', () => {
  const now = DateTime.fromISO('2026-11-21T10:00:00', { zone: 'America/Chicago' });

  it('prevents double-booking when two callers race for the same slot', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const chosen = slots.availableSlots[0];
    expect(chosen).toBeDefined();

    const [first, second] = await Promise.all([
      booking.bookAppointment(northstarContext, {
        slotId: chosen!.slotId,
        customerName: 'Alice Smith',
        phone: '214-555-0101',
        reason: 'AC not cooling',
        idempotencyKey: 'call-a:slot-1',
        nowIso: now.toUTC().toISO()!,
      }),
      booking.bookAppointment(northstarContext, {
        slotId: chosen!.slotId,
        customerName: 'Bob Jones',
        phone: '214-555-0102',
        reason: 'Furnace check',
        idempotencyKey: 'call-b:slot-1',
        nowIso: now.toUTC().toISO()!,
      }),
    ]);

    const successes = [first, second].filter((r) => r.success);
    const failures = [first, second].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(!failures[0]!.success && failures[0]!.error).toBe('SLOT_UNAVAILABLE');
  });

  it('rejects expired slot tokens and handles idempotent duplicate requests', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const firstSlot = slots.availableSlots[0]!;
    const secondSlot = slots.availableSlots[1]!;

    const expiredResult = await booking.bookAppointment(northstarContext, {
      slotId: firstSlot.slotId,
      customerName: 'Late Caller',
      phone: '214-555-0103',
      reason: 'Tune-up',
      idempotencyKey: 'call-late:1',
      nowIso: now.plus({ minutes: 15 }).toUTC().toISO()!,
    });
    expect(expiredResult.success).toBe(false);
    expect(!expiredResult.success && expiredResult.error).toBe('SLOT_EXPIRED');

    const initial = await booking.bookAppointment(northstarContext, {
      slotId: secondSlot.slotId,
      customerName: 'Repeat Caller',
      phone: '214-555-0104',
      reason: 'Heater inspection',
      idempotencyKey: 'call-repeat:same-key',
      nowIso: now.toUTC().toISO()!,
    });
    const duplicate = await booking.bookAppointment(northstarContext, {
      slotId: secondSlot.slotId,
      customerName: 'Repeat Caller',
      phone: '214-555-0104',
      reason: 'Heater inspection',
      idempotencyKey: 'call-repeat:same-key',
      nowIso: now.toUTC().toISO()!,
    });

    expect(initial.success).toBe(true);
    expect(duplicate.success).toBe(true);
    if (initial.success && duplicate.success) {
      expect(duplicate.idempotentReplay).toBe(true);
      expect(duplicate.booking.id).toBe(initial.booking.id);
    }
  });

  it('never falsely confirms when Google Calendar fails and reconciles via durable outbox', async () => {
    const calendarBusiness = {
      ...demoBusiness,
      googleCalendarId: 'northstar@group.calendar.google.com',
    };
    const businessService = new BusinessService(new InMemoryBusinessRepository([calendarBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const flakyCalendar = new FlakyCalendarAdapter();

    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: flakyCalendar,
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: flakyCalendar,
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const chosen = slots.availableSlots[0]!;

    const failedSync = await booking.bookAppointment(northstarContext, {
      slotId: chosen.slotId,
      customerName: 'Outbox Caller',
      phone: '214-555-0105',
      reason: 'AC repair',
      idempotencyKey: 'call-outbox:1',
      nowIso: now.toUTC().toISO()!,
    });
    expect(failedSync.success).toBe(false);
    expect(!failedSync.success && failedSync.error).toBe('CALENDAR_SYNC_PENDING');

    const pendingJobs = await appointmentRepository.listPendingSyncJobs(northstarContext);
    expect(pendingJobs).toHaveLength(1);

    flakyCalendar.shouldFail = false;
    const reconciled = await booking.reconcilePendingSyncJobs(northstarContext);
    expect(reconciled).toEqual({ synced: 1, failed: 0 });

    if (!failedSync.success && failedSync.appointmentId) {
      const updated = await appointmentRepository.getAppointmentById(
        northstarContext,
        failedSync.appointmentId,
      );
      expect(updated?.status).toBe('confirmed');
      expect(updated?.googleEventId).toBe('gcal-evt-1');
    }
  });

  it('updates booked appointment details in both repository and Google Calendar', async () => {
    const calendarBusiness = {
      ...demoBusiness,
      googleCalendarId: 'northstar@group.calendar.google.com',
    };
    const businessService = new BusinessService(new InMemoryBusinessRepository([calendarBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const calendar = new FlakyCalendarAdapter();
    calendar.shouldFail = false;

    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: calendar,
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: calendar,
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const chosen = slots.availableSlots[0]!;

    const booked = await booking.bookAppointment(northstarContext, {
      slotId: chosen.slotId,
      customerName: 'Muhammad Danial',
      phone: '03001234567',
      address: 'Street 12, Lahore',
      reason: 'AC repair',
      idempotencyKey: 'call-update:1',
      nowIso: now.toUTC().toISO()!,
    });
    expect(booked.success).toBe(true);
    if (!booked.success) return;

    const updated = await booking.updateAppointment(northstarContext, {
      bookingId: booked.booking.id,
      customerName: 'Muhammad Daniyal',
    });

    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.booking.customerName).toBe('Muhammad Daniyal');
      expect(updated.calendarUpdated).toBe(true);
    }
    expect(calendar.updatedEvents).toHaveLength(1);
    expect(calendar.updatedEvents[0]?.eventId).toBe('gcal-evt-1');
    expect(calendar.updatedEvents[0]?.summary).toContain('Muhammad Daniyal');
    expect(calendar.updatedEvents[0]?.description).toContain('Customer: Muhammad Daniyal');
  });

  it('blocks bookAppointment tool when callerConfirmedDetails is false (prevents premature WhatsApp/Email)', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const chosen = slots.availableSlots[0]!;
    const toolDef = createBookAppointmentTool(northstarContext, booking);

    const blocked = (await toolDef.execute(
      {
        slotId: chosen.slotId,
        customerName: 'Unconfirmed Caller',
        phone: '03283121702',
        reason: 'General Medical Consultation',
        callerConfirmedDetails: false,
      },
      {} as never,
    )) as { success: boolean; error?: string };

    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe('CONFIRMATION_REQUIRED');
    const saved = await appointmentRepository.listAppointments(northstarContext);
    expect(saved).toHaveLength(0);
  });

  it('assigns clean sequential human-friendly booking codes (BK001, BK002)', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const booking = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    const slots = await availability.getAvailableSlots(northstarContext, {
      requestedDay: 'Monday',
      now,
    });
    const first = await booking.bookAppointment(northstarContext, {
      slotId: slots.availableSlots[0]!.slotId,
      customerName: 'Patient One',
      phone: '03283121701',
      reason: 'Checkup 1',
      idempotencyKey: 'seq:1',
      nowIso: now.toUTC().toISO()!,
    });
    const second = await booking.bookAppointment(northstarContext, {
      slotId: slots.availableSlots[1]!.slotId,
      customerName: 'Patient Two',
      phone: '03283121702',
      reason: 'Checkup 2',
      idempotencyKey: 'seq:2',
      nowIso: now.toUTC().toISO()!,
    });

    expect(first.success && first.booking.bookingCode).toBe('BK001');
    expect(second.success && second.booking.bookingCode).toBe('BK002');
  });
});
