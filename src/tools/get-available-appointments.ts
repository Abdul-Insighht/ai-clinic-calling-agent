import { tool } from '@livekit/agents';
import { z } from 'zod';
import { getAppConfig } from '../config/index.ts';
import { NORTHSTAR_BUSINESS_ID } from '../db/seed.ts';
import { logger } from '../lib/logger.ts';
import type { BusinessContext } from '../models/business.ts';
import {
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
} from '../repositories/appointment-repository.ts';
import { AvailabilityService } from '../services/availability-service.ts';
import { createDefaultBusinessService } from '../services/business-service.ts';
import { GoogleCalendarAdapter } from '../services/google-calendar-adapter.ts';
import { recordToolMetric } from '../services/metrics-service.ts';

export const getAvailableAppointmentsParameters = z.object({
  requestedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Optional specific date in YYYY-MM-DD format requested by the caller.'),
  requestedDay: z
    .string()
    .optional()
    .describe('Optional day requested by the caller, such as Monday, Tuesday, today, or tomorrow.'),
  requestedStartTime: z
    .string()
    .optional()
    .describe('Optional exact start time requested by the caller, e.g. "10:00 AM", "2:30 PM", or "14:00".'),
  serviceName: z
    .string()
    .optional()
    .describe('Optional service name so slot duration matches the requested service.'),
  timePreference: z
    .enum(['morning', 'afternoon'])
    .optional()
    .describe('Optional preference for morning or afternoon slots.'),
});

export function createGetAvailableAppointmentsTool(
  context: BusinessContext,
  availabilityService: AvailabilityService,
) {
  return tool({
    name: 'getAvailableAppointments',

    description: `
      Check currently available appointment slots for the business.
      Always call this tool fresh for any availability question.
      Checking availability does NOT book or reserve a slot.
      Only offer slots returned by this tool and pass the exact slotId to bookAppointment.
    `,

    parameters: getAvailableAppointmentsParameters,

    execute: async ({ requestedDate, requestedDay, requestedStartTime, serviceName, timePreference }) => {
      const startedAt = performance.now();
      logger.info('appointment.availability.checked', {
        businessId: context.businessId,
        requestedDate: requestedDate ?? null,
        requestedDay: requestedDay ?? null,
        requestedStartTime: requestedStartTime ?? null,
      });

      try {
        const result = await availabilityService.getAvailableSlots(context, {
          ...(requestedDate ? { requestedDate } : {}),
          ...(requestedDay ? { requestedDay } : {}),
          ...(requestedStartTime ? { requestedStartTime } : {}),
          ...(serviceName ? { serviceName } : {}),
          ...(timePreference ? { timePreference } : {}),
        });

        const durationMs = Math.round(performance.now() - startedAt);
        recordToolMetric('getAvailableAppointments', durationMs, true);

        logger.info('appointment.availability.returned', {
          businessId: context.businessId,
          slotCount: result.availableSlots.length,
          requestedTimeAvailable: result.requestedTimeAvailable,
          durationMs,
        });

        return {
          success: true,
          requestedDate: result.requestedDate,
          requestedDay: result.requestedDay,
          requestedStartTime: result.requestedStartTime,
          requestedTimeAvailable: result.requestedTimeAvailable,
          availableSlots: result.availableSlots,
          timeZone: result.timeZone,
          message:
            result.requestedTimeAvailable === false
              ? 'The requested day, period, or exact time is unavailable or already booked. These are the closest available alternatives. No appointment has been booked.'
              : 'These are the currently available appointment slots. No appointment has been booked yet.',
        };
      } catch (error) {
        logger.error('appointment.availability.failed', {
          businessId: context.businessId,
          error,
        });

        return {
          success: false,
          requestedDate: requestedDate ?? null,
          requestedDay: requestedDay ?? null,
          requestedTimeAvailable: null,
          availableSlots: [],
          message:
            'Appointment availability could not be checked right now. Do not guess or invent appointment times.',
        };
      }
    },
  });
}

function createDefaultAvailabilityService(): AvailabilityService {
  const config = getAppConfig();
  const appointmentRepository = config.database.isPostgresConfigured
    ? new PostgresAppointmentRepository()
    : new InMemoryAppointmentRepository();
  return new AvailabilityService({
    businessService: createDefaultBusinessService(),
    appointmentRepository,
    calendarAdapter: new GoogleCalendarAdapter(),
  });
}

export const getAvailableAppointments = createGetAvailableAppointmentsTool(
  { businessId: NORTHSTAR_BUSINESS_ID },
  createDefaultAvailabilityService(),
);
