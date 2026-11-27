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

function spellEmailForVoice(email?: string): string | null {
  if (!email) return null;
  const cleaned = email.trim().toLowerCase();
  const [local, domain] = cleaned.split('@');
  if (!local || !domain) return cleaned;
  const spelledLocal = local
    .split('')
    .map((ch) => (ch === '.' ? 'dot' : ch === '_' ? 'underscore' : ch === '-' ? 'dash' : ch.toUpperCase()))
    .join(' - ');
  return `${spelledLocal} at ${domain.replace(/\./g, ' dot ')}`;
}

export function createBookAppointmentTool(context: BusinessContext, bookingService: BookingService) {
  let pendingDraft: {
    slotId: string;
    normalizedEmail: string;
    userTurnCountAtDraft: number;
  } | null = null;

  return tool({
    name: 'bookAppointment',

    description: `
      Book one verified appointment using the exact slotId from the latest
      getAvailableAppointments result ONLY AFTER reading back all details (including spelling the email letter-by-letter) and receiving explicit caller confirmation (callerConfirmedDetails: true).
      CRITICAL: Copy the caller's spelled email letters EXACTLY without autocorrecting names (for example keep "rehman" as "rehman", NEVER change it to "rahman").
      Never claim the appointment is booked unless this tool returns success: true.
      If the tool returns CONFIRMATION_REQUIRED, immediately read back the exact summary and spelledEmailForReadback and wait for the caller to say yes in their next turn before calling again.
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
      const normalizedEmail = (customerEmail ?? '').trim().toLowerCase();
      const spelledEmailForReadback = spellEmailForVoice(customerEmail);

      // Phase-1 / Turn-Verified Confirmation Guard:
      // In live voice sessions (context.userTurnCount !== undefined), it is code-enforced that:
      // 1) A draft readback MUST happen first, returning the exact spelledEmailForReadback of the string we received.
      // 2) The caller MUST speak a subsequent confirmation turn (userTurnCount > userTurnCountAtDraft)
      //    for this exact slotId + normalizedEmail before any DB write, Email, or WhatsApp is allowed!
      const isLiveVoiceSession = typeof context.userTurnCount === 'number';
      const draftMatchesAndCallerReplied =
        pendingDraft !== null &&
        pendingDraft.slotId === slotId &&
        pendingDraft.normalizedEmail === normalizedEmail &&
        (!isLiveVoiceSession || (context.userTurnCount ?? 0) > pendingDraft.userTurnCountAtDraft);

      if (!callerConfirmedDetails || (isLiveVoiceSession && !draftMatchesAndCallerReplied)) {
        if (isLiveVoiceSession) {
          pendingDraft = {
            slotId,
            normalizedEmail,
            userTurnCountAtDraft: context.userTurnCount ?? 0,
          };
        }
        logger.warn('appointment.booking.blocked_unconfirmed', {
          businessId: context.businessId,
          slotId,
          callerConfirmedDetails,
          userTurnCount: context.userTurnCount ?? null,
          spelledEmailForReadback,
        });
        return {
          success: false,
          error: 'CONFIRMATION_REQUIRED',
          spelledEmailForReadback,
          message: spelledEmailForReadback
            ? `NOT BOOKED YET. Warmly read back these details to the caller right now — Patient: ${customerName}, Phone: ${phone}, Service: ${reason}, and email spelled as "${spelledEmailForReadback}" — then ask naturally: "Does everything sound right?" STOP and wait for the caller to confirm before calling bookAppointment again.`
            : `NOT BOOKED YET. Warmly read back these details to the caller right now — Patient: ${customerName}, Phone: ${phone}, Service: ${reason} — then ask naturally: "Does everything sound right?" STOP and wait for the caller to confirm before calling bookAppointment again.`,
        };
      }

      // Clear draft once caller has explicitly confirmed in a new turn
      pendingDraft = null;

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

        const bookingCode =
          result.booking.bookingCode || `BK${result.booking.id.slice(0, 6).toUpperCase()}`;

        return {
          success: true,
          pendingConfirmation: Boolean(result.pendingConfirmation),
          bookingCode,
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
          message: `${result.message} Share Booking ID ${bookingCode} with the caller (never read the raw UUID).`,
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
