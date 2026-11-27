import { DateTime } from 'luxon';
import { logger } from '../lib/logger.ts';
import type { AppointmentRecord } from '../models/appointment.ts';

export type BookingWhatsAppPayload = {
  toPhone: string;
  businessName: string;
  businessLocation?: string;
  callerLabel?: string | undefined;
  locationLabel?: string | undefined;
  booking: AppointmentRecord;
  isUpdate?: boolean;
  isCancelled?: boolean;
  isRescheduled?: boolean;
};

export type WhatsAppSendResult = {
  sent: boolean;
  provider?: 'meta_cloud_api';
  messageId?: string;
  reason?: string;
};

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION?.trim() || 'v22.0';

/**
 * Formats a local or international phone number into Meta Cloud API digits-only format
 * (e.g. "+92 332-0000125" or "03320000125" -> "923320000125").
 */
export function formatWhatsAppRecipient(rawPhone: string): string | null {
  const override = process.env.WHATSAPP_TEST_RECIPIENT?.trim();
  const source = override || rawPhone;
  const digits = source.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;

  const defaultCountryCode = (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '92').replace(/[^\d]/g, '');
  if (digits.startsWith('00')) {
    return digits.slice(2);
  }
  if (digits.startsWith('0') && defaultCountryCode) {
    return `${defaultCountryCode}${digits.slice(1)}`;
  }
  return digits;
}

function buildConfirmationText(payload: BookingWhatsAppPayload): string {
  const {
    booking,
    businessName,
    businessLocation,
    callerLabel = 'Patient',
    locationLabel = 'Clinic Location',
    isUpdate,
    isCancelled,
    isRescheduled,
  } = payload;
  const tz = booking.timezone || 'Asia/Karachi';
  const startLocal = DateTime.fromISO(booking.startsAt, { zone: 'utc' }).setZone(tz);
  const endLocal = DateTime.fromISO(booking.endsAt, { zone: 'utc' }).setZone(tz);

  const dateDisplay = startLocal.isValid
    ? startLocal.toFormat('cccc, LLLL d, yyyy')
    : booking.startsAt;
  const timeDisplay =
    startLocal.isValid && endLocal.isValid
      ? `${startLocal.toFormat('h:mm a')} – ${endLocal.toFormat('h:mm a')} (${tz})`
      : booking.startsAt;
  const shortRef = booking.bookingCode || `BK${booking.id.slice(0, 6).toUpperCase()}`;

  const heading = isCancelled
    ? 'Appointment Cancelled'
    : isRescheduled
      ? 'Appointment Rescheduled'
      : isUpdate
        ? 'Appointment Updated'
        : 'Appointment Confirmed';
  const intro = isCancelled
    ? `Hi ${booking.customerName}, your appointment (${shortRef}) with ${businessName} has been cancelled as requested:`
    : isRescheduled
      ? `Hi ${booking.customerName}, your appointment (${shortRef}) with ${businessName} has been rescheduled to a new time:`
      : isUpdate
        ? `Hi ${booking.customerName}, your appointment details with ${businessName} have been updated:`
        : `Hi ${booking.customerName}, thank you for booking with ${businessName}! Here are your confirmed appointment details:`;

  return [
    `*${businessName}*`,
    `*${heading}*`,
    '',
    intro,
    '',
    `*Booking ID:* ${shortRef}`,
    `*${callerLabel}:* ${booking.customerName}`,
    `*Service / Reason:* ${booking.reason}`,
    `*Date:* ${dateDisplay}`,
    `*Time:* ${timeDisplay}`,
    `*Phone Number:* ${booking.phoneE164}`,
    `*${locationLabel}:* ${businessLocation || 'Main Medical Plaza, City Center'}`,
    '',
    `Need to check, reschedule, update, or cancel? Call ${businessName} and mention Booking ID *${shortRef}*.`,
  ].join('\n');
}

async function postMetaMessage(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/**
 * Non-blocking WhatsApp booking confirmation via Official Meta WhatsApp Cloud API.
 * Gracefully skips if WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is not configured.
 */
export async function sendAppointmentConfirmationWhatsApp(
  payload: BookingWhatsAppPayload,
): Promise<WhatsAppSendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();

  if (!phoneNumberId || !accessToken) {
    return { sent: false, reason: 'WHATSAPP_NOT_CONFIGURED' };
  }

  const recipient = formatWhatsAppRecipient(payload.toPhone);
  if (!recipient) {
    return { sent: false, reason: 'INVALID_RECIPIENT_PHONE' };
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME?.trim();
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG?.trim() || 'en_US';

  try {
    // 1. Try formatted booking confirmation text (works inside 24h customer care window)
    //    or configured Meta template if WHATSAPP_TEMPLATE_NAME is explicitly set.
    const primaryBody: Record<string, unknown> = templateName
      ? {
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLang },
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          text: {
            preview_url: false,
            body: buildConfirmationText(payload),
          },
        };

    const primary = await postMetaMessage(phoneNumberId, accessToken, primaryBody);

    if (primary.ok) {
      const messages = primary.data.messages as Array<{ id?: string }> | undefined;
      const messageId = messages?.[0]?.id;
      logger.info('whatsapp.confirmation.sent', {
        provider: 'meta_cloud_api',
        bookingId: payload.booking.id,
        isUpdate: Boolean(payload.isUpdate),
        messageId: messageId ?? 'unknown',
      });
      return {
        sent: true,
        provider: 'meta_cloud_api',
        ...(messageId ? { messageId } : {}),
      };
    }

    logger.warn('whatsapp.confirmation.failed', {
      bookingId: payload.booking.id,
      status: primary.status,
      error: primary.data.error ?? primary.data,
    });
    return { sent: false, reason: `META_HTTP_${primary.status}` };
  } catch (error) {
    logger.warn('whatsapp.confirmation.error', {
      bookingId: payload.booking.id,
      error,
    });
    return { sent: false, reason: 'WHATSAPP_REQUEST_ERROR' };
  }
}
