import { tool } from '@livekit/agents';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import type { BookingService } from '../services/booking-service.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const getAppointmentDetailsParameters = z.object({
  bookingCode: z
    .string()
    .min(1)
    .describe('The short Booking ID provided by the caller (for example BK001, BK039) or UUID.'),
  verificationHint: z
    .string()
    .min(3)
    .describe(
      'The caller name or phone number (or last 4 digits of phone) to verify privacy before sharing booking details.',
    ),
});

export function createGetAppointmentDetailsTool(
  context: BusinessContext,
  bookingService: BookingService,
) {
  return tool({
    name: 'getAppointmentDetails',

    description: `
      Look up an existing appointment by its Booking ID (e.g. BK001) after verifying the caller's name or phone number.
      Use this whenever a caller calls back to check their appointment date, time, service, status, or details.
      Never reveal appointment details unless this tool returns success: true.
    `,

    parameters: getAppointmentDetailsParameters,

    execute: async ({ bookingCode, verificationHint }) => {
      const startedAt = performance.now();
      logger.info('appointment.lookup.started', {
        businessId: context.businessId,
        bookingCode,
      });

      try {
        const result = await bookingService.lookupAppointment(context, {
          bookingRef: bookingCode,
          verificationHint,
        });

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('getAppointmentDetails', durationMs, result.success);

        if (!result.success) {
          logger.warn('appointment.lookup.failed', {
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

        logger.info('appointment.lookup.succeeded', {
          businessId: context.businessId,
          bookingCode: code,
          durationMs,
        });

        return {
          success: true,
          bookingCode: code,
          bookingId: b.id,
          customerName: b.customerName,
          phone: b.phoneE164,
          customerEmail: b.customerEmail ?? null,
          address: b.address ?? null,
          reason: b.reason,
          status: b.status,
          date: startLocal.isValid ? startLocal.toFormat('cccc, LLL d, yyyy') : b.startsAt,
          startTime: startLocal.isValid ? startLocal.toFormat('h:mm a') : b.startsAt,
          endTime: endLocal.isValid ? endLocal.toFormat('h:mm a') : b.endsAt,
          timeZone: tz,
        };
      } catch (error) {
        logger.error('appointment.lookup.error', {
          businessId: context.businessId,
          bookingCode,
          error,
        });
        return {
          success: false,
          error: 'LOOKUP_ERROR',
          message: 'Unable to look up that appointment right now.',
        };
      }
    },
  });
}
