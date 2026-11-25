import { DateTime } from 'luxon';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { demoBusiness } from '../../src/business/demo-business.ts';
import { NORTHSTAR_BUSINESS_ID } from '../../src/db/seed.ts';
import { InMemoryAppointmentRepository } from '../../src/repositories/appointment-repository.ts';
import { InMemoryBusinessRepository } from '../../src/repositories/business-repository.ts';
import { InMemoryLeadRepository } from '../../src/repositories/lead-repository.ts';
import { AvailabilityService } from '../../src/services/availability-service.ts';
import { BookingService } from '../../src/services/booking-service.ts';
import { BusinessService } from '../../src/services/business-service.ts';
import { NoopCalendarAdapter } from '../../src/services/google-calendar-adapter.ts';
import { LeadService } from '../../src/services/lead-service.ts';

const context = {
  businessId: NORTHSTAR_BUSINESS_ID,
  callId: 'perf-call-1',
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

describe('Phase 10 — Tool execution latency budget', () => {
  it('keeps business info, availability, booking, and lead tool logic under 100ms p95', async () => {
    const businessService = new BusinessService(new InMemoryBusinessRepository([demoBusiness]));
    const appointmentRepository = new InMemoryAppointmentRepository();
    const availabilityService = new AvailabilityService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const bookingService = new BookingService({
      businessService,
      appointmentRepository,
      calendarAdapter: new NoopCalendarAdapter(),
    });
    const leadService = new LeadService(new InMemoryLeadRepository());
    const now = DateTime.fromISO('2026-11-21T10:00:00', { zone: 'America/Chicago' });

    // Warm up Luxon timezone and config cache before timing steady-state tool calls
    await availabilityService.getAvailableSlots(context, { now, maxSlots: 1 });

    const timings: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now();
      await businessService.getVerifiedInformation(context, 'hours');
      const avail = await availabilityService.getAvailableSlots(context, { now, maxSlots: 3 });
      const slot = avail.availableSlots[0];
      if (slot) {
        await bookingService.bookAppointment(context, {
          slotId: slot.slotId,
          customerName: `Caller ${i}`,
          phone: `21455501${String(i).padStart(2, '0')}`,
          reason: 'AC check',
          idempotencyKey: `perf-${i}`,
          nowIso: now.toUTC().toISO()!,
        });
      }
      await leadService.captureLead(context, {
        name: `Lead ${i}`,
        phone: `21455502${String(i).padStart(2, '0')}`,
        reason: 'Quote request',
      });
      timings.push(performance.now() - t0);
    }

    const p95 = percentile(timings, 95);
    expect(p95).toBeLessThan(100);
  });
});
