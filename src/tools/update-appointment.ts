import { tool } from '@livekit/agents';
import { z } from 'zod';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import type { BookingService } from '../services/booking-service.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const updateAppointmentParameters = z.object({
  bookingId: z
    .string()
    .min(1)
    .describe('The exact bookingId returned by bookAppointment in this session.'),
  customerName: z
    .string()
    .min(1)
    .optional()
    .describe('Corrected caller name (for example, after confirming spelling).'),
  phone: z
    .string()
    .min(7)
    .optional()
    .describe('Corrected caller phone number.'),
  customerEmail: z
    .string()
    .optional()
    .describe('Corrected or newly provided caller email address for confirmation email.'),
  address: z
    .string()
    .optional()
    .describe('Corrected service street address or city.'),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe('Corrected service reason or note.'),
});

export function createUpdateAppointmentTool(
  context: BusinessContext,
  bookingService: BookingService,
) {
  return tool({
    name: 'updateAppointment',

    description: `
      Update details (customerName, phone, customerEmail, address, or reason) of an already-booked appointment
      in PostgreSQL, Google Calendar, Gmail confirmation, and WhatsApp using the exact bookingId from bookAppointment.
      Call this whenever the caller corrects their name spelling, phone, email, address, or reason after booking.
      Never tell the caller an appointment was updated unless this tool returns success: true.
    `,

    parameters: updateAppointmentParameters,

    execute: async ({ bookingId, customerName, phone, customerEmail, address, reason }) => {
      const startedAt = performance.now();
      logger.info('appointment.update.started', {
        businessId: context.businessId,
        bookingId,
      });

      try {
        const result = await bookingService.updateAppointment(context, {
          bookingId,
          ...(customerName !== undefined ? { customerName } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(customerEmail !== undefined ? { customerEmail } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(reason !== undefined ? { reason } : {}),
          asyncCalendarSync: true,
        });

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('updateAppointment', durationMs, result.success);

        if (!result.success) {
          logger.warn('appointment.update.failed', {
            businessId: context.businessId,
            bookingId,
            error: result.error,
          });
          return {
            success: false,
            error: result.error,
            message: result.message,
          };
        }

        logger.info('appointment.update.succeeded', {
          businessId: context.businessId,
          bookingId: result.booking.id,
          calendarUpdated: result.calendarUpdated,
          durationMs,
        });

        return {
          success: true,
          bookingId: result.booking.id,
          customerName: result.booking.customerName,
          phone: result.booking.phoneE164,
          customerEmail: result.booking.customerEmail ?? null,
          address: result.booking.address ?? null,
          reason: result.booking.reason,
          calendarUpdated: result.calendarUpdated,
          message: result.message,
        };
      } catch (error) {
        logger.error('appointment.update.error', {
          businessId: context.businessId,
          bookingId,
          error,
        });
        return {
          success: false,
          error: 'UPDATE_ERROR',
          message:
            'The appointment could not be updated right now. Do not tell the caller it was updated.',
        };
      }
    },
  });
}
