import { tool } from '@livekit/agents';
import { z } from 'zod';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import type { BookingService } from '../services/booking-service.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const cancelAppointmentParameters = z.object({
  bookingCode: z
    .string()
    .min(1)
    .describe('The short Booking ID provided by the caller (e.g. BK001) or UUID.'),
  verificationHint: z
    .string()
    .min(3)
    .describe('Caller name or phone number on file for privacy verification before cancelling.'),
  callerConfirmedCancel: z
    .boolean()
    .describe(
      'MUST be true ONLY AFTER the caller explicitly confirms they want to cancel this appointment.',
    ),
});

export function createCancelAppointmentTool(
  context: BusinessContext,
  bookingService: BookingService,
) {
  return tool({
    name: 'cancelAppointment',

    description: `
      Cancel an existing appointment by Booking ID (e.g. BK001) after verifying caller name or phone
      and receiving explicit confirmation (callerConfirmedCancel: true).
      Frees the slot in PostgreSQL, removes the Google Calendar event, and sends Gmail & WhatsApp cancellation notice.
    `,

    parameters: cancelAppointmentParameters,

    execute: async ({ bookingCode, verificationHint, callerConfirmedCancel }) => {
      const startedAt = performance.now();
      if (!callerConfirmedCancel) {
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED',
          message:
            'Please ask the caller to explicitly confirm they want to cancel this appointment before calling cancelAppointment with callerConfirmedCancel: true.',
        };
      }

      logger.info('appointment.cancel.started', {
        businessId: context.businessId,
        bookingCode,
      });

      try {
        const result = await bookingService.cancelAppointment(context, {
          bookingRef: bookingCode,
          verificationHint,
          asyncCalendarSync: true,
        });

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('cancelAppointment', durationMs, result.success);

        if (!result.success) {
          logger.warn('appointment.cancel.failed', {
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

        const code =
          result.booking.bookingCode || `BK${result.booking.id.slice(0, 6).toUpperCase()}`;
        logger.info('appointment.cancel.succeeded', {
          businessId: context.businessId,
          bookingCode: code,
          durationMs,
        });

        return {
          success: true,
          bookingCode: code,
          bookingId: result.booking.id,
          status: result.booking.status,
          message: `Appointment ${code} has been cancelled and the slot is now released. A cancellation confirmation has been sent.`,
        };
      } catch (error) {
        logger.error('appointment.cancel.error', {
          businessId: context.businessId,
          bookingCode,
          error,
        });
        return {
          success: false,
          error: 'CANCEL_ERROR',
          message: 'Unable to cancel that appointment right now.',
        };
      }
    },
  });
}
