import { DateTime } from 'luxon';
import type { Transporter } from 'nodemailer';
import { logger } from '../lib/logger.ts';
import type { AppointmentRecord } from '../models/appointment.ts';

export type BookingEmailPayload = {
  toEmail: string;
  businessName: string;
  businessLocation?: string;
  booking: AppointmentRecord;
  isUpdate?: boolean;
};

let cachedTransporter: Transporter | null = null;
let cachedSmtpKey: string | null = null;

async function getSmtpTransporter(): Promise<Transporter | null> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, '').trim();
  if (!user || !pass) {
    return null;
  }

  const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || '465');
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  const key = `${host}:${port}:${user}`;

  if (cachedTransporter && cachedSmtpKey === key) {
    return cachedTransporter;
  }

  const { default: nodemailer } = await import('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });
  cachedSmtpKey = key;
  return cachedTransporter;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildConfirmationEmail(payload: BookingEmailPayload): {
  subject: string;
  text: string;
  html: string;
} {
  const { booking, businessName, isUpdate } = payload;
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
  const shortRef = `#${booking.id.slice(0, 8).toUpperCase()}`;

  const subject = isUpdate
    ? `Updated Appointment Confirmation (${shortRef}) — ${businessName}`
    : `Appointment Confirmed (${shortRef}) — ${businessName}`;

  const heading = isUpdate ? 'Appointment Updated' : 'Appointment Confirmed';
  const intro = isUpdate
    ? `Hi ${booking.customerName}, your appointment details with ${businessName} have been updated:`
    : `Hi ${booking.customerName}, thank you for booking with ${businessName}! Here are your confirmed appointment details:`;

  const text = [
    intro,
    '',
    `Booking Reference: ${shortRef} (ID: ${booking.id})`,
    `Service / Reason: ${booking.reason}`,
    `Date: ${dateDisplay}`,
    `Time: ${timeDisplay}`,
    `Phone: ${booking.phoneE164}`,
    `Address: ${booking.address || 'Not provided'}`,
    '',
    `If you need to reschedule or make any changes, please call ${businessName}.`,
  ].join('\n');

  const html = `
<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b1020;font-family:Inter,Segoe UI,Arial,sans-serif;color:#eef2ff;">
    <div style="max-width:560px;margin:0 auto;background:#131a2e;border:1px solid #273357;border-radius:14px;overflow:hidden;">
      <div style="padding:22px 26px;border-bottom:1px solid #273357;background:#1b2440;">
        <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#38bdf8;font-weight:700;">
          ${escapeHtml(businessName)}
        </div>
        <h2 style="margin:6px 0 0;font-size:21px;color:#eef2ff;">${heading}</h2>
      </div>
      <div style="padding:24px 26px;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#cbd5e1;">
          ${escapeHtml(intro)}
        </p>
        <table style="width:100%;border-collapse:collapse;background:#0b1020;border:1px solid #273357;border-radius:10px;">
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;width:38%;">Booking ID</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#38bdf8;font-size:13px;font-weight:700;">${escapeHtml(shortRef)} <span style="color:#64748b;font-weight:400;font-size:11px;">(${escapeHtml(booking.id)})</span></td>
          </tr>
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;">Customer</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#eef2ff;font-size:13px;font-weight:600;">${escapeHtml(booking.customerName)}</td>
          </tr>
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;">Service / Reason</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#eef2ff;font-size:13px;">${escapeHtml(booking.reason)}</td>
          </tr>
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;">Date</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#eef2ff;font-size:13px;font-weight:600;">${escapeHtml(dateDisplay)}</td>
          </tr>
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;">Time</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#22c55e;font-size:13px;font-weight:600;">${escapeHtml(timeDisplay)}</td>
          </tr>
          <tr>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#94a3b8;font-size:13px;">Phone Number</td>
            <td style="padding:11px 14px;border-bottom:1px solid #273357;color:#eef2ff;font-size:13px;">${escapeHtml(booking.phoneE164)}</td>
          </tr>
          <tr>
            <td style="padding:11px 14px;color:#94a3b8;font-size:13px;">Service Address</td>
            <td style="padding:11px 14px;color:#eef2ff;font-size:13px;">${escapeHtml(booking.address || 'Not provided')}</td>
          </tr>
        </table>
        <p style="margin:18px 0 0;font-size:12.5px;color:#94a3b8;">
          Need to reschedule or update your details? Just call ${escapeHtml(businessName)} and mention reference <strong>${escapeHtml(shortRef)}</strong>.
        </p>
      </div>
    </div>
  </body>
</html>
`.trim();

  return { subject, text, html };
}

export async function sendAppointmentConfirmationEmail(
  payload: BookingEmailPayload,
): Promise<{ sent: boolean; provider: 'resend' | 'smtp' | 'none' }> {
  const toEmail = payload.toEmail.trim();
  if (!toEmail || !toEmail.includes('@')) {
    return { sent: false, provider: 'none' };
  }

  const { subject, text, html } = buildConfirmationEmail(payload);
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const rawFrom = process.env.EMAIL_FROM?.trim().replace(/^["']|["']$/g, '');
  const fromAddress =
    rawFrom ||
    (process.env.SMTP_USER ? `${payload.businessName} <${process.env.SMTP_USER.trim()}>` : 'VoxDesk AI <onboarding@resend.dev>');

  // 1. Prefer Resend if configured (production SaaS)
  if (resendApiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [toEmail],
          subject,
          text,
          html,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Resend HTTP ${response.status}: ${body}`);
      }
      logger.info('email.confirmation.sent', {
        provider: 'resend',
        bookingId: payload.booking.id,
        isUpdate: Boolean(payload.isUpdate),
      });
      return { sent: true, provider: 'resend' };
    } catch (error) {
      logger.error('email.confirmation.failed', {
        provider: 'resend',
        bookingId: payload.booking.id,
        error,
      });
      return { sent: false, provider: 'resend' };
    }
  }

  // 2. Fallback to Gmail / Custom SMTP (nodemailer)
  const transporter = await getSmtpTransporter();
  if (!transporter) {
    logger.info('email.confirmation.skipped_not_configured', {
      bookingId: payload.booking.id,
    });
    return { sent: false, provider: 'none' };
  }

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject,
      text,
      html,
    });
    logger.info('email.confirmation.sent', {
      provider: 'smtp',
      bookingId: payload.booking.id,
      isUpdate: Boolean(payload.isUpdate),
    });
    return { sent: true, provider: 'smtp' };
  } catch (primaryError) {
    // Cloud containers sometimes block port 465; automatically retry via port 587 STARTTLS
    const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.replace(/\s+/g, '').trim();
    if (user && pass && (!process.env.SMTP_PORT || process.env.SMTP_PORT === '465')) {
      try {
        const { default: nodemailer } = await import('nodemailer');
        const fallbackTransporter = nodemailer.createTransport({
          host,
          port: 587,
          secure: false,
          requireTLS: true,
          auth: { user, pass },
          connectionTimeout: 8000,
          greetingTimeout: 8000,
          socketTimeout: 10000,
        });
        await fallbackTransporter.sendMail({
          from: fromAddress,
          to: toEmail,
          subject,
          text,
          html,
        });
        logger.info('email.confirmation.sent', {
          provider: 'smtp',
          port: 587,
          bookingId: payload.booking.id,
          isUpdate: Boolean(payload.isUpdate),
        });
        return { sent: true, provider: 'smtp' };
      } catch (fallbackError) {
        logger.error('email.confirmation.failed', {
          provider: 'smtp',
          bookingId: payload.booking.id,
          primaryError,
          fallbackError,
        });
        return { sent: false, provider: 'smtp' };
      }
    }
    logger.error('email.confirmation.failed', {
      provider: 'smtp',
      bookingId: payload.booking.id,
      error: primaryError,
    });
    return { sent: false, provider: 'smtp' };
  }
}
