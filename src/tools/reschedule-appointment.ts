import { tool } from '@livekit/agents';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import type { BookingService } from '../services/booking-service.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const rescheduleAppointmentParameters = z.object({
  bookingCode: z
    .string()
    .min(1)
    .describe('The short Booking ID provided by the caller (e.g. BK001) or UUID.'),
  newSlotId: z
    .string()
    .min(1)
    .describe('The exact opaque slotId from the latest getAvailableAppointments result.'),
  verificationHint: z
    .string()
    .min(3)
    .describe('Caller name or phone number on file for privacy verification.'),
  callerConfirmedReschedule: z
    .boolean()
    .describe(
      'MUST be true ONLY AFTER the caller explicitly confirms the new date and time.',
    ),
});

export function createRescheduleAppointmentTool(
  context: BusinessContext,
  bookingService: BookingService,
) {
  return tool({
    name: 'rescheduleAppointment',

    description: `
      Reschedule an existing appointment (by Booking ID e.g. BK001) to a new available slotId from getAvailableAppointments.
      Requires caller verification (name or phone) and explicit confirmation (callerConfirmedReschedule: true).
      Updates PostgreSQL, moves the Google Calendar event, and sends updated Gmail & WhatsApp confirmation.
    `,

    parameters: rescheduleAppointmentParameters,

    execute: async ({ bookingCode, newSlotId, verificationHint, callerConfirmedReschedule }) => {
      const startedAt = performance.now();
      if (!callerConfirmedReschedule) {
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED',
          message:
            'Please read back the new date and time and ask the caller to explicitly confirm before calling rescheduleAppointment with callerConfirmedReschedule: true.',
        };
      }

      logger.info('appointment.reschedule.started', {
        businessId: context.businessId,
        bookingCode,
        newSlotId,
      });

      try {
        const result = await bookingService.rescheduleAppointment(context, {
          bookingRef: bookingCode,
          newSlotId,
          verificationHint,
          asyncCalendarSync: true,
        });

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('rescheduleAppointment', durationMs, result.success);

        if (!result.success) {
          logger.warn('appointment.reschedule.failed', {
            businessId: context.businessId,
            bookingCode,
            error: result.error,
          });
          return {
            success: false,
            error: result.error,
            message: result.message,
          };
        }

        const b = result.booking;
        const tz = b.timezone || 'Asia/Karachi';
        const startLocal = DateTime.fromISO(b.startsAt, { zone: 'utc' }).setZone(tz);
        const endLocal = DateTime.fromISO(b.endsAt, { zone: 'utc' }).setZone(tz);
        const code = b.bookingCode || `BK${b.id.slice(0, 6).toUpperCase()}`;

        logger.info('appointment.reschedule.succeeded', {
          businessId: context.businessId,
          bookingCode: code,
          durationMs,
        });

        return {
          success: true,
          bookingCode: code,
          bookingId: b.id,
          date: startLocal.isValid ? startLocal.toFormat('cccc, LLL d, yyyy') : b.startsAt,
          startTime: startLocal.isValid ? startLocal.toFormat('h:mm a') : b.startsAt,
          endTime: endLocal.isValid ? endLocal.toFormat('h:mm a') : b.endsAt,
          timeZone: tz,
          message: `Appointment ${code} has been rescheduled. Updated Gmail and WhatsApp confirmations have been sent.`,
        };
      } catch (error) {
        logger.error('appointment.reschedule.error', {
          businessId: context.businessId,
          bookingCode,
          error,
        });
        return {
          success: false,
          error: 'RESCHEDULE_ERROR',
          message: 'Unable to reschedule that appointment right now.',
        };
      }
    },
  });
}
