import { getAppConfig } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import type { AppointmentRecord } from '../models/appointment.ts';
import type { BusinessContext } from '../models/business.ts';
import type { AppointmentRepository } from '../repositories/appointment-repository.ts';
import type { BusinessService } from './business-service.ts';
import { sendAppointmentConfirmationEmail } from './email-service.ts';
import { sendAppointmentConfirmationWhatsApp } from './whatsapp-service.ts';
import type { CalendarAdapter } from './google-calendar-adapter.ts';

export type BookAppointmentRequest = {
  slotId: string;
  customerName: string;
  phone: string;
  customerEmail?: string | null;
  address?: string | null;
  reason: string;
  idempotencyKey: string;
  nowIso?: string;
  asyncCalendarSync?: boolean;
};

export type BookAppointmentResponse =
  | {
      success: true;
      idempotentReplay: boolean;
      pendingConfirmation?: boolean;
      booking: AppointmentRecord;
      message: string;
    }
  | {
      success: false;
      error:
        | 'INVALID_INPUT'
        | 'SLOT_NOT_FOUND'
        | 'SLOT_EXPIRED'
        | 'SLOT_UNAVAILABLE'
        | 'CALENDAR_SYNC_PENDING';
      message: string;
      appointmentId?: string;
    };

const INVALID_PLACEHOLDERS = new Set([
  '',
  'unknown',
  'not known',
  'not provided',
  'none',
  'n/a',
  'na',
  'null',
  'undefined',
]);

export function normalizePhoneNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }
  // Pakistani mobile formats: 03XXXXXXXXX (11 digits) -> +923XXXXXXXXX
  if (digits.length === 11 && digits.startsWith('03')) {
    return `+92${digits.slice(1)}`;
  }
  // US/Canada 10-digit numbers
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  return `+${digits}`;
}

function isPlaceholder(value: string): boolean {
  return INVALID_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function toDeterministicCalendarEventId(appointmentId: string): string {
  return `appt${appointmentId.replace(/[^a-f0-9]/gi, '').toLowerCase()}`;
}

export type UpdateAppointmentRequest = {
  bookingId: string;
  customerName?: string;
  phone?: string;
  customerEmail?: string | null;
  address?: string | null;
  reason?: string;
  asyncCalendarSync?: boolean;
};

export type UpdateAppointmentResponse =
  | {
      success: true;
      booking: AppointmentRecord;
      calendarUpdated: boolean;
      message: string;
    }
  | {
      success: false;
      error: 'INVALID_INPUT' | 'APPOINTMENT_NOT_FOUND' | 'UPDATE_NOT_SUPPORTED';
      message: string;
    };

export class BookingService {
  private readonly businessService: BusinessService;
  private readonly appointmentRepository: AppointmentRepository;
  private readonly calendarAdapter: CalendarAdapter;

  constructor(deps: {
    businessService: BusinessService;
    appointmentRepository: AppointmentRepository;
    calendarAdapter: CalendarAdapter;
  }) {
    this.businessService = deps.businessService;
    this.appointmentRepository = deps.appointmentRepository;
    this.calendarAdapter = deps.calendarAdapter;
  }

  async bookAppointment(
    context: BusinessContext,
    input: BookAppointmentRequest,
  ): Promise<BookAppointmentResponse> {
    if (isPlaceholder(input.customerName) || isPlaceholder(input.reason)) {
      return {
        success: false,
        error: 'INVALID_INPUT',
        message: 'Caller name and reason must be clearly provided before booking.',
      };
    }

    const phoneE164 = normalizePhoneNumber(input.phone);
    if (!phoneE164) {
      return {
        success: false,
        error: 'INVALID_INPUT',
        message: 'A valid phone number with at least 7 digits is required before booking.',
      };
    }

    const cleanedAddress = input.address?.trim() || null;
    if (cleanedAddress && isPlaceholder(cleanedAddress)) {
      return {
        success: false,
        error: 'INVALID_INPUT',
        message: 'A real service address must be provided if an address is supplied.',
      };
    }

    const cleanedEmail = input.customerEmail?.trim().toLowerCase() || null;
    if (cleanedEmail && (isPlaceholder(cleanedEmail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail))) {
      return {
        success: false,
        error: 'INVALID_INPUT',
        message: 'A valid email address must be provided if an email is supplied.',
      };
    }

    const reservation = await this.appointmentRepository.reserveSlotTransactionally(context, {
      slotToken: input.slotId,
      customerName: input.customerName.trim(),
      phoneE164,
      customerEmail: cleanedEmail,
      address: cleanedAddress,
      reason: input.reason.trim(),
      idempotencyKey: input.idempotencyKey,
      ...(input.nowIso ? { nowIso: input.nowIso } : {}),
    });

    if (!reservation.success) {
      return reservation;
    }

    if (reservation.idempotentReplay) {
      if (reservation.appointment.status === 'confirmed') {
        return {
          success: true,
          idempotentReplay: true,
          booking: reservation.appointment,
          message: 'The appointment is already confirmed.',
        };
      }

      return {
        success: false,
        error: 'CALENDAR_SYNC_PENDING',
        appointmentId: reservation.appointment.id,
        message: 'This booking is still being synchronized. Please wait for confirmation.',
      };
    }

    const business = await this.businessService.getBusinessProfile(context);
    const calendarId = business.googleCalendarId ?? getAppConfig().calendar.calendarId;

    const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    let emailResult: unknown = { skipped: true };
    let whatsappResult: unknown = { skipped: true };

    if (!isTestEnv) {
      const emailPromise = reservation.appointment.customerEmail
        ? sendAppointmentConfirmationEmail({
            toEmail: reservation.appointment.customerEmail,
            businessName: business.name,
            businessLocation: business.location,
            booking: reservation.appointment,
            isUpdate: false,
          }).then((r) => {
            emailResult = r;
          })
        : Promise.resolve();

      const whatsappPromise = reservation.appointment.phoneE164
        ? sendAppointmentConfirmationWhatsApp({
            toPhone: reservation.appointment.phoneE164,
            businessName: business.name,
            businessLocation: business.location,
            booking: reservation.appointment,
            isUpdate: false,
          }).then((r) => {
            whatsappResult = r;
          })
        : Promise.resolve();

      // Wait up to 6s in parallel so cloud workers flush Email + WhatsApp before returning
      await Promise.race([
        Promise.allSettled([emailPromise, whatsappPromise]),
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);

      // Persist notification delivery result to audit_logs for cloud observability
      if (getAppConfig().database.isPostgresConfigured) {
        void (async () => {
          try {
            const { getDbPool } = await import('../db/client.ts');
            await getDbPool().query(
              `INSERT INTO aibitsol.audit_logs (business_id, actor_type, action, entity_type, entity_id, changes_json)
               VALUES ($1, 'agent', 'booking.notifications', 'appointment', $2, $3::jsonb)`,
              [
                context.businessId,
                reservation.appointment.id,
                JSON.stringify({
                  toEmail: reservation.appointment.customerEmail ?? null,
                  toPhone: reservation.appointment.phoneE164 ?? null,
                  emailResult,
                  whatsappResult,
                  env: {
                    hasSmtpUser: Boolean(process.env.SMTP_USER?.trim()),
                    hasSmtpPass: Boolean(process.env.SMTP_PASS?.trim()),
                    hasWaPhoneId: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()),
                    hasWaToken: Boolean(process.env.WHATSAPP_ACCESS_TOKEN?.trim()),
                    waTokenLen: process.env.WHATSAPP_ACCESS_TOKEN?.trim().length ?? 0,
                  },
                }),
              ],
            );
          } catch {
            // Non-fatal observability write
          }
        })();
      }
    }

    if (!calendarId || !this.calendarAdapter.isConfigured(calendarId)) {
      const confirmed = await this.appointmentRepository.markCalendarSynced(
        context,
        reservation.appointment.id,
        null,
      );
      return {
        success: true,
        idempotentReplay: reservation.idempotentReplay,
        booking: confirmed,
        message: 'The appointment was successfully booked.',
      };
    }

    if (input.asyncCalendarSync) {
      // Fast voice path: return immediately after atomic DB reservation and trigger single SKIP-LOCKED outbox sync
      void this.reconcilePendingSyncJobs(context).catch((error) => {
        logger.error('booking.calendar_sync.background_deferred', {
          businessId: context.businessId,
          appointmentId: reservation.appointment.id,
          error,
        });
      });
      return {
        success: true,
        idempotentReplay: reservation.idempotentReplay,
        pendingConfirmation: true,
        booking: reservation.appointment,
        message:
          'Your appointment slot is reserved and we are finalizing your calendar confirmation now.',
      };
    }

    try {
      const { eventId } = await this.calendarAdapter.createEvent({
        calendarId,
        deterministicEventId: toDeterministicCalendarEventId(reservation.appointment.id),
        timeZone: reservation.appointment.timezone,
        summary: `${business.name} Appointment - ${reservation.appointment.customerName}`,
        description: [
          `Customer: ${reservation.appointment.customerName}`,
          `Phone: ${reservation.appointment.phoneE164}`,
          ...(reservation.appointment.address
            ? [`Address: ${reservation.appointment.address}`]
            : []),
          `Reason: ${reservation.appointment.reason}`,
          `Appointment ID: ${reservation.appointment.id}`,
        ].join('\n'),
        startsAt: reservation.appointment.startsAt,
        endsAt: reservation.appointment.endsAt,
      });

      const confirmed = await this.appointmentRepository.markCalendarSynced(
        context,
        reservation.appointment.id,
        eventId,
      );

      return {
        success: true,
        idempotentReplay: reservation.idempotentReplay,
        pendingConfirmation: false,
        booking: confirmed,
        message: 'The appointment was successfully booked and synced with Google Calendar.',
      };
    } catch (error) {
      const nextRetryAtIso = new Date(Date.now() + 30_000).toISOString();
      await this.appointmentRepository.markCalendarSyncDeferred(
        context,
        reservation.appointment.id,
        error instanceof Error ? error.message : 'Unknown calendar sync error',
        nextRetryAtIso,
      );

      logger.error('booking.calendar_sync.deferred', {
        businessId: context.businessId,
        appointmentId: reservation.appointment.id,
        error,
      });

      return {
        success: false,
        error: 'CALENDAR_SYNC_PENDING',
        appointmentId: reservation.appointment.id,
        message:
          'The appointment could not be finalized with the calendar right now. Do not tell the caller it is confirmed.',
      };
    }
  }

  private async syncAppointmentInBackground(
    context: BusinessContext,
    businessName: string,
    calendarId: string,
    appointment: AppointmentRecord,
  ): Promise<void> {
    try {
      const { eventId } = await this.calendarAdapter.createEvent({
        calendarId,
        deterministicEventId: toDeterministicCalendarEventId(appointment.id),
        timeZone: appointment.timezone,
        summary: `${businessName} Appointment - ${appointment.customerName}`,
        description: [
          `Customer: ${appointment.customerName}`,
          `Phone: ${appointment.phoneE164}`,
          ...(appointment.address ? [`Address: ${appointment.address}`] : []),
          `Reason: ${appointment.reason}`,
          `Appointment ID: ${appointment.id}`,
        ].join('\n'),
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
      });

      await this.appointmentRepository.markCalendarSynced(context, appointment.id, eventId);
      logger.info('booking.calendar_sync.background_succeeded', {
        businessId: context.businessId,
        appointmentId: appointment.id,
        eventId,
      });
    } catch (error) {
      const nextRetryAtIso = new Date(Date.now() + 30_000).toISOString();
      await this.appointmentRepository.markCalendarSyncDeferred(
        context,
        appointment.id,
        error instanceof Error ? error.message : 'Background calendar sync error',
        nextRetryAtIso,
      );
      logger.error('booking.calendar_sync.background_deferred', {
        businessId: context.businessId,
        appointmentId: appointment.id,
        error,
      });
    }
  }

  async reconcilePendingSyncJobs(
    context: BusinessContext,
  ): Promise<{ synced: number; failed: number }> {
    const business = await this.businessService.getBusinessProfile(context);
    const calendarId = business.googleCalendarId ?? getAppConfig().calendar.calendarId;
    if (!calendarId || !this.calendarAdapter.isConfigured(calendarId)) {
      return { synced: 0, failed: 0 };
    }

    const jobs = this.appointmentRepository.claimPendingSyncJobs
      ? await this.appointmentRepository.claimPendingSyncJobs(context, 10)
      : await this.appointmentRepository.listPendingSyncJobs(context);
    let synced = 0;
    let failed = 0;

    for (const job of jobs) {
      const appt = await this.appointmentRepository.getAppointmentById(context, job.appointmentId);
      if (!appt || appt.status === 'confirmed' || appt.status === 'cancelled') {
        continue;
      }

      try {
        const { eventId } = await this.calendarAdapter.createEvent({
          calendarId,
          deterministicEventId: toDeterministicCalendarEventId(appt.id),
          timeZone: appt.timezone,
          summary: `${business.name} Appointment - ${appt.customerName}`,
          description: [
            `Customer: ${appt.customerName}`,
            `Phone: ${appt.phoneE164}`,
            ...(appt.address ? [`Address: ${appt.address}`] : []),
            `Reason: ${appt.reason}`,
            `Appointment ID: ${appt.id}`,
          ].join('\n'),
          startsAt: appt.startsAt,
          endsAt: appt.endsAt,
        });

        await this.appointmentRepository.markCalendarSynced(context, appt.id, eventId);
        synced += 1;
      } catch (error) {
        const backoffMs = Math.min(10 * 60_000, 30_000 * 2 ** job.attempts);
        await this.appointmentRepository.markCalendarSyncDeferred(
          context,
          appt.id,
          error instanceof Error ? error.message : 'Calendar sync retry failed',
          new Date(Date.now() + backoffMs).toISOString(),
        );
        failed += 1;
      }
    }

    return { synced, failed };
  }

  async updateAppointment(
    context: BusinessContext,
    input: UpdateAppointmentRequest,
  ): Promise<UpdateAppointmentResponse> {
    if (!this.appointmentRepository.updateAppointmentDetails) {
      return {
        success: false,
        error: 'UPDATE_NOT_SUPPORTED',
        message: 'Updating appointments is not supported in this repository.',
      };
    }

    const updates: {
      customerName?: string;
      phoneE164?: string;
      customerEmail?: string | null;
      address?: string | null;
      reason?: string;
    } = {};

    if (input.customerName !== undefined) {
      if (isPlaceholder(input.customerName)) {
        return {
          success: false,
          error: 'INVALID_INPUT',
          message: 'A valid caller name must be provided to update the appointment.',
        };
      }
      updates.customerName = input.customerName.trim();
    }

    if (input.phone !== undefined) {
      const normalized = normalizePhoneNumber(input.phone);
      if (!normalized) {
        return {
          success: false,
          error: 'INVALID_INPUT',
          message: 'A valid phone number with at least 7 digits is required.',
        };
      }
      updates.phoneE164 = normalized;
    }

    if (input.customerEmail !== undefined) {
      const cleanedEmail = input.customerEmail?.trim().toLowerCase() || null;
      if (cleanedEmail && (isPlaceholder(cleanedEmail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail))) {
        return {
          success: false,
          error: 'INVALID_INPUT',
          message: 'A valid email address must be provided.',
        };
      }
      updates.customerEmail = cleanedEmail;
    }

    if (input.address !== undefined) {
      const cleaned = input.address?.trim() || null;
      if (cleaned && isPlaceholder(cleaned)) {
        return {
          success: false,
          error: 'INVALID_INPUT',
          message: 'A real service address must be provided.',
        };
      }
      updates.address = cleaned;
    }

    if (input.reason !== undefined) {
      if (isPlaceholder(input.reason)) {
        return {
          success: false,
          error: 'INVALID_INPUT',
          message: 'A valid appointment reason must be provided.',
        };
      }
      updates.reason = input.reason.trim();
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        error: 'INVALID_INPUT',
        message: 'At least one field (name, phone, address, or reason) must be provided to update.',
      };
    }

    const updated = await this.appointmentRepository.updateAppointmentDetails(
      context,
      input.bookingId,
      updates,
    );

    if (!updated) {
      return {
        success: false,
        error: 'APPOINTMENT_NOT_FOUND',
        message: 'No existing appointment was found with that booking ID.',
      };
    }

    const business = await this.businessService.getBusinessProfile(context);
    const calendarId = business.googleCalendarId ?? getAppConfig().calendar.calendarId;

    if (updated.customerEmail) {
      void sendAppointmentConfirmationEmail({
        toEmail: updated.customerEmail,
        businessName: business.name,
        businessLocation: business.location,
        booking: updated,
        isUpdate: true,
      });
    }

    if (updated.phoneE164) {
      void sendAppointmentConfirmationWhatsApp({
        toPhone: updated.phoneE164,
        businessName: business.name,
        businessLocation: business.location,
        booking: updated,
        isUpdate: true,
      });
    }
    let calendarUpdated = false;

    if (calendarId && this.calendarAdapter.isConfigured(calendarId) && this.calendarAdapter.updateEvent) {
      const eventId = updated.googleEventId ?? toDeterministicCalendarEventId(updated.id);
      const patchPayload = {
        calendarId,
        eventId,
        summary: `${business.name} Appointment - ${updated.customerName}`,
        description: [
          `Customer: ${updated.customerName}`,
          `Phone: ${updated.phoneE164}`,
          ...(updated.address ? [`Address: ${updated.address}`] : []),
          `Reason: ${updated.reason}`,
          `Appointment ID: ${updated.id}`,
        ].join('\n'),
      };

      if (input.asyncCalendarSync) {
        void this.calendarAdapter.updateEvent(patchPayload).catch((error) => {
          logger.warn('booking.calendar_update.background_failed', {
            businessId: context.businessId,
            appointmentId: updated.id,
            eventId,
            error,
          });
        });
        return {
          success: true,
          booking: updated,
          calendarUpdated: true,
          message:
            'The appointment details were updated in the database and are syncing to Google Calendar.',
        };
      }

      try {
        await this.calendarAdapter.updateEvent(patchPayload);
        calendarUpdated = true;
      } catch (error) {
        logger.warn('booking.calendar_update.failed', {
          businessId: context.businessId,
          appointmentId: updated.id,
          eventId,
          error,
        });
      }
    }

    return {
      success: true,
      booking: updated,
      calendarUpdated,
      message: calendarUpdated
        ? 'The appointment details were updated in both the database and Google Calendar.'
        : 'The appointment details were updated in the database.',
    };
  }
}
