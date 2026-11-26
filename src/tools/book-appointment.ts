import { tool } from '@livekit/agents';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { getAppConfig } from '../config/index.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
} from '../repositories/appointment-repository.ts';
import { BookingService } from '../services/booking-service.ts';
import { createDefaultBusinessService } from '../services/business-service.ts';
import { GoogleCalendarAdapter } from '../services/google-calendar-adapter.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const bookAppointmentParameters = z.object({
  slotId: z
    .string()
    .min(1)
    .describe('The exact opaque slotId returned by the most recent availability tool result.'),
  customerName: z.string().min(1).describe('The caller name exactly as confirmed by the caller.'),
  phone: z
    .string()
    .min(7)
    .describe('The caller phone number exactly as confirmed by the caller.'),
  customerEmail: z
    .string()
    .optional()
    .describe('Optional caller email address to send the booking confirmation email.'),
  address: z
    .string()
    .optional()
    .describe('The service street address or city confirmed by the caller.'),
  reason: z
    .string()
    .min(1)
    .describe('A short description of why the caller needs the appointment.'),
  callerConfirmedDetails: z
    .boolean()
    .describe(
      'MUST be true ONLY AFTER you have read back all details (service, date/time, name, phone, address, email) and the caller explicitly said yes/confirmed. Set false if not yet confirmed.',
    ),
});

export function createBookAppointmentTool(context: BusinessContext, bookingService: BookingService) {
  return tool({
    name: 'bookAppointment',

    description: `
      Book one verified appointment using the exact slotId from the latest
      getAvailableAppointments result ONLY AFTER reading back all details and receiving explicit caller confirmation (callerConfirmedDetails: true).
      Never call this tool before the caller explicitly says yes to the read-back summary.
      Never claim the appointment is booked unless this tool returns success: true.
      If the slot is expired or unavailable, call getAvailableAppointments again.
    `,

    parameters: bookAppointmentParameters,

    execute: async ({
      slotId,
      customerName,
      phone,
      customerEmail,
      address,
      reason,
      callerConfirmedDetails,
    }) => {
      const startedAt = performance.now();
      if (!callerConfirmedDetails) {
        logger.warn('appointment.booking.blocked_unconfirmed', {
          businessId: context.businessId,
          slotId,
        });
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED',
          message:
            'Booking blocked: read back the service, date/time, full name, phone number, address, and email to the caller first, and wait for them to explicitly confirm before calling bookAppointment with callerConfirmedDetails: true.',
        };
      }

      logger.info('appointment.booking.started', {
        businessId: context.businessId,
        slotId,
      });

      const idempotencyKey = `${context.callId ?? 'session'}:${slotId}`;

      try {
        const result = await bookingService.bookAppointment(context, {
          slotId,
          customerName,
          phone,
          ...(customerEmail ? { customerEmail } : {}),
          ...(address ? { address } : {}),
          reason,
          idempotencyKey,
          asyncCalendarSync: true,
        });

        if (!result.success) {
          logger.warn('appointment.booking.failed', {
            businessId: context.businessId,
            slotId,
            error: result.error,
          });

          return {
            success: false,
            error: result.error,
            message: result.message,
          };
        }

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('bookAppointment', durationMs, true);

        logger.info('appointment.booking.succeeded', {
          businessId: context.businessId,
          bookingId: result.booking.id,
          slotId,
          idempotentReplay: result.idempotentReplay,
          durationMs,
        });

        const tz = result.booking.timezone || 'Asia/Karachi';
        const startLocal = DateTime.fromISO(result.booking.startsAt, { zone: 'utc' }).setZone(tz);
        const endLocal = DateTime.fromISO(result.booking.endsAt, { zone: 'utc' }).setZone(tz);

        return {
          success: true,
          pendingConfirmation: Boolean(result.pendingConfirmation),
          bookingId: result.booking.id,
          slotId,
          date: startLocal.isValid ? startLocal.toFormat('cccc, LLL d, yyyy') : result.booking.label,
          startTime: startLocal.isValid ? startLocal.toFormat('h:mm a') : result.booking.startsAt,
          endTime: endLocal.isValid ? endLocal.toFormat('h:mm a') : result.booking.endsAt,
          timeZone: tz,
          address: result.booking.address ?? null,
          appointmentLabel: result.booking.label,
          start: result.booking.startsAt,
          end: result.booking.endsAt,
          message: result.message,
        };
      } catch (error) {
        logger.error('appointment.booking.error', {
          businessId: context.businessId,
          slotId,
          error,
        });

        return {
          success: false,
          error: 'BOOKING_ERROR',
          message:
            'The appointment could not be finalized. Do not tell the caller that it was booked.',
        };
      }
    },
  });
}

function createDefaultBookingService(): BookingService {
  const config = getAppConfig();
  const appointmentRepository = config.database.isPostgresConfigured
    ? new PostgresAppointmentRepository()
    : new InMemoryAppointmentRepository();
  return new BookingService({
    businessService: createDefaultBusinessService(),
    appointmentRepository,
    calendarAdapter: new GoogleCalendarAdapter(),
  });
}

export const bookAppointment = createBookAppointmentTool(
  { businessId: NORTHSTAR_BUSINESS_ID },
  createDefaultBookingService(),
);
