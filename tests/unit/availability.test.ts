import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { demoBusiness } from '../../src/business/demo-business.ts';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import { InMemoryAppointmentRepository } from '../../src/repositories/appointment-repository.ts';
import { InMemoryBusinessRepository } from '../../src/repositories/business-repository.ts';
import { AvailabilityService } from '../../src/services/availability-service.ts';
import { BusinessService } from '../../src/services/business-service.ts';
import { NoopCalendarAdapter } from '../../src/services/google-calendar-adapter.ts';

const context = {
  businessId: NORTHSTAR_BUSINESS_ID,
};

describe('Phase 4 — Dynamic appointment availability', () => {
  it('generates dynamic slots from business hours and skips closed days (Sunday)', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    const now = DateTime.fromISO('2026-11-21T10:00:00', { zone: 'America/Chicago' });

    const sundayResult = await availability.getAvailableSlots(context, {
      requestedDay: 'Sunday',
      now,
    });
    expect(sundayResult.requestedTimeAvailable).toBe(false);
    expect(sundayResult.availableSlots.length).toBeGreaterThan(0);
    expect(sundayResult.availableSlots.every((slot) => slot.day !== 'Sunday')).toBe(true);

    const mondayResult = await availability.getAvailableSlots(context, {
      requestedDay: 'Monday',
      timePreference: 'morning',
      now,
    });
    expect(mondayResult.requestedTimeAvailable).toBe(true);
    expect(mondayResult.availableSlots.length).toBeGreaterThan(0);
    expect(mondayResult.availableSlots.every((slot) => slot.day === 'Monday')).toBe(true);
    expect(mondayResult.availableSlots[0]?.slotId).toMatch(/^slot_/);
    expect(mondayResult.timeZone).toBe('America/Chicago');
  });

  it('supports exact 10:00 AM booking for 120-minute AC installation on Saturday (9 AM open)', async () => {
    const businessWithCatalog = {
      ...demoBusiness,
      serviceCatalog: [
        { id: 'svc-ac-install', name: 'AC installation', durationMinutes: 120, isActive: true },
      ],
    };
    const businessService = new BusinessService(
      new InMemoryBusinessRepository([businessWithCatalog]),
    );
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });

    // Friday Nov 20, 2026 at 10 AM -> Saturday Nov 21 opens 9 AM to 2 PM
    const now = DateTime.fromISO('2026-11-20T10:00:00', { zone: 'America/Chicago' });
    const satResult = await availability.getAvailableSlots(context, {
      requestedDay: 'Saturday',
      requestedStartTime: '10:00 AM',
      serviceName: 'AC installation',
      now,
    });

    expect(satResult.requestedTimeAvailable).toBe(true);
    expect(satResult.durationMinutes).toBe(120);
    expect(satResult.availableSlots[0]?.startTime).toBe('10:00 AM');
    expect(satResult.availableSlots[0]?.endTime).toBe('12:00 PM');
  });

  it('marks requestedTimeAvailable=false when requested time conflicts with calendar busy interval', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const busyCalendar = {
      isConfigured: () => true,
      listBusyIntervals: async () => [
        {
          startsAt: DateTime.fromISO('2026-11-23T10:00:00', { zone: 'America/Chicago' })
            .toUTC()
            .toISO()!,
          endsAt: DateTime.fromISO('2026-11-23T11:00:00', { zone: 'America/Chicago' })
            .toUTC()
            .toISO()!,
        },
      ],
      createEvent: async () => ({ eventId: 'evt-1' }),
      cancelEvent: async () => {},
    };

    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: busyCalendar,
    });

    const now = DateTime.fromISO('2026-11-22T10:00:00', { zone: 'America/Chicago' });
    const result = await availability.getAvailableSlots(context, {
      requestedDay: 'Monday',
      requestedStartTime: '10:00 AM',
      now,
    });

    expect(result.requestedTimeAvailable).toBe(false);
    expect(result.availableSlots.length).toBeGreaterThan(0);
    expect(result.availableSlots.some((s) => s.startTime === '10:00 AM')).toBe(false);
  });

  it('fails safely instead of returning unverified slots when Google Calendar is unreachable', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const failingCalendar = {
      isConfigured: () => true,
      listBusyIntervals: async () => {
        throw new Error('Google Calendar timeout');
      },
      createEvent: async () => ({ eventId: 'evt-1' }),
      cancelEvent: async () => {},
    };

    const availability = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: failingCalendar,
    });

    const now = DateTime.fromISO('2026-11-22T10:00:00', { zone: 'America/Chicago' });
    await expect(
      availability.getAvailableSlots(context, { requestedDay: 'Monday', now }),
    ).rejects.toThrow('Unable to verify live Google Calendar availability');
  });
});
