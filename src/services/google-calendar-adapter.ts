import { type calendar_v3, google } from 'googleapis';
import { DateTime } from 'luxon';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAppConfig } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import type { BusyInterval } from '../models/appointment.ts';

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

export type CreateCalendarEventInput = {
  calendarId: string;
  timeZone: string;
  summary: string;
  description: string;
  startsAt: string;
  endsAt: string;
  deterministicEventId?: string;
};

export type UpdateCalendarEventInput = {
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  timeZone?: string;
};

export interface CalendarAdapter {
  isConfigured(calendarId?: string | null): boolean;
  listBusyIntervals(params: {
    calendarId: string;
    timeZone: string;
    timeMin: string;
    timeMax: string;
  }): Promise<BusyInterval[]>;
  createEvent(input: CreateCalendarEventInput): Promise<{ eventId: string }>;
  updateEvent?(input: UpdateCalendarEventInput): Promise<void>;
  cancelEvent(params: { calendarId: string; eventId: string }): Promise<void>;
}

function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  const trimmed = raw.trim();
  const decoded = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  const credentials = JSON.parse(decoded) as ServiceAccountCredentials;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google Calendar service account credentials are invalid.');
  }
  return credentials;
}

const CALENDAR_TIMEOUT_MS = 5000;
const BUSY_CACHE_TTL_MS = 15_000;

let cachedCalendarClient: calendar_v3.Calendar | null = null;
let cachedCredentialKey: string | null = null;
const busyIntervalsCache = new Map<string, { expiresAt: number; intervals: BusyInterval[] }>();
const inFlightBusyRequests = new Map<string, Promise<BusyInterval[]>>();

async function createCalendarClient(): Promise<calendar_v3.Calendar> {
  const calendarConfig = getAppConfig().calendar;
  const credentialKey = `${calendarConfig.credentialSource}:${calendarConfig.clientEmail ?? ''}:${calendarConfig.credentialsPath ?? ''}`;

  if (cachedCalendarClient && cachedCredentialKey === credentialKey) {
    return cachedCalendarClient;
  }

  let credentials: ServiceAccountCredentials;

  if (calendarConfig.clientEmail && calendarConfig.privateKey) {
    credentials = {
      client_email: calendarConfig.clientEmail,
      private_key: calendarConfig.privateKey.replace(/\\n/g, '\n'),
    };
  } else if (calendarConfig.credentialsJson) {
    credentials = parseServiceAccountJson(calendarConfig.credentialsJson);
  } else if (calendarConfig.credentialsPath) {
    const contents = await readFile(resolve(process.cwd(), calendarConfig.credentialsPath), 'utf8');
    credentials = parseServiceAccountJson(contents);
  } else {
    throw new Error('Google Calendar credentials are not configured.');
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  await auth.authorize();

  cachedCalendarClient = google.calendar({ version: 'v3', auth });
  cachedCredentialKey = credentialKey;
  return cachedCalendarClient;
}

export function clearCalendarCache(): void {
  busyIntervalsCache.clear();
  inFlightBusyRequests.clear();
}

export async function warmUpCalendarClient(): Promise<void> {
  const cfg = getAppConfig().calendar;
  if (!cfg.calendarId || cfg.credentialSource === 'none') {
    return;
  }
  try {
    await createCalendarClient();
    logger.info('google_calendar.client.warmed_up', {});
  } catch (error) {
    logger.warn('google_calendar.client.warmup_failed', { error });
  }
}

function parseEventBound(
  value: calendar_v3.Schema$EventDateTime | undefined,
  timeZone: string,
): string | null {
  if (!value) return null;
  if (value.dateTime) {
    const dt = DateTime.fromISO(value.dateTime, { setZone: true });
    return dt.isValid ? dt.toUTC().toISO() : null;
  }
  if (value.date) {
    const dt = DateTime.fromISO(value.date, { zone: timeZone }).startOf('day');
    return dt.isValid ? dt.toUTC().toISO() : null;
  }
  return null;
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  isConfigured(calendarId?: string | null): boolean {
    const cfg = getAppConfig().calendar;
    return Boolean((calendarId ?? cfg.calendarId) && cfg.credentialSource !== 'none');
  }

  async listBusyIntervals(params: {
    calendarId: string;
    timeZone: string;
    timeMin: string;
    timeMax: string;
  }): Promise<BusyInterval[]> {
    const cacheKey = [params.calendarId, params.timeZone, params.timeMin, params.timeMax].join('|');
    const cached = busyIntervalsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.intervals;
    }

    const inFlight = inFlightBusyRequests.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const requestPromise = (async () => {
      const calendar = await createCalendarClient();
      const response = await calendar.events.list(
        {
          calendarId: params.calendarId,
          timeMin: params.timeMin,
          timeMax: params.timeMax,
          singleEvents: true,
          orderBy: 'startTime',
        },
        { timeout: CALENDAR_TIMEOUT_MS },
      );

      const intervals: BusyInterval[] = [];
      for (const event of response.data.items ?? []) {
        if (event.status === 'cancelled' || event.transparency === 'transparent') {
          continue;
        }
        const startsAt = parseEventBound(event.start, params.timeZone);
        const endsAt = parseEventBound(event.end, params.timeZone);
        if (startsAt && endsAt) {
          intervals.push({ startsAt, endsAt });
        }
      }

      busyIntervalsCache.set(cacheKey, {
        expiresAt: Date.now() + BUSY_CACHE_TTL_MS,
        intervals,
      });
      return intervals;
    })();

    inFlightBusyRequests.set(cacheKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      inFlightBusyRequests.delete(cacheKey);
    }
  }

  async createEvent(input: CreateCalendarEventInput): Promise<{ eventId: string }> {
    const calendar = await createCalendarClient();
    try {
      const response = await calendar.events.insert(
        {
          calendarId: input.calendarId,
          sendUpdates: 'none',
          requestBody: {
            ...(input.deterministicEventId ? { id: input.deterministicEventId } : {}),
            summary: input.summary,
            description: input.description,
            start: { dateTime: input.startsAt, timeZone: input.timeZone },
            end: { dateTime: input.endsAt, timeZone: input.timeZone },
            transparency: 'opaque',
          },
        },
        { timeout: CALENDAR_TIMEOUT_MS },
      );

      const eventId = response.data.id;
      if (!eventId) {
        throw new Error('Google Calendar returned an incomplete event response.');
      }

      busyIntervalsCache.clear();
      logger.info('google_calendar.event.created', { eventId });
      return { eventId };
    } catch (error) {
      const gErr = error as { code?: number; status?: number };
      if (input.deterministicEventId && (gErr.code === 409 || gErr.status === 409)) {
        busyIntervalsCache.clear();
        logger.info('google_calendar.event.idempotent_exists', {
          eventId: input.deterministicEventId,
        });
        return { eventId: input.deterministicEventId };
      }
      throw error;
    }
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<void> {
    const calendar = await createCalendarClient();
    await calendar.events.patch(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        sendUpdates: 'none',
        requestBody: {
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.startsAt
            ? { start: { dateTime: input.startsAt, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } }
            : {}),
          ...(input.endsAt
            ? { end: { dateTime: input.endsAt, ...(input.timeZone ? { timeZone: input.timeZone } : {}) } }
            : {}),
        },
      },
      { timeout: CALENDAR_TIMEOUT_MS },
    );
    if (input.startsAt || input.endsAt) {
      busyIntervalsCache.clear();
    }
    logger.info('google_calendar.event.updated', { eventId: input.eventId });
  }

  async cancelEvent(params: { calendarId: string; eventId: string }): Promise<void> {
    const calendar = await createCalendarClient();
    await calendar.events.delete(
      {
        calendarId: params.calendarId,
        eventId: params.eventId,
        sendUpdates: 'none',
      },
      { timeout: CALENDAR_TIMEOUT_MS },
    );
    busyIntervalsCache.clear();
  }
}

export async function testGoogleCalendarConnection() {
  const calendarId = getAppConfig().calendar.calendarId;
  if (!calendarId) {
    throw new Error('Missing required environment variable: GOOGLE_CALENDAR_ID');
  }
  const calendar = await createCalendarClient();
  const response = await calendar.calendars.get({ calendarId });
  return {
    success: true,
    calendarId: response.data.id ?? calendarId,
    summary: response.data.summary ?? null,
    timeZone: response.data.timeZone ?? null,
  };
}

export class NoopCalendarAdapter implements CalendarAdapter {
  isConfigured(): boolean {
    return false;
  }

  async listBusyIntervals(): Promise<BusyInterval[]> {
    return [];
  }

  async createEvent(): Promise<{ eventId: string }> {
    throw new Error('Calendar adapter is not configured.');
  }

  async updateEvent(): Promise<void> {
    // No-op
  }

  async cancelEvent(): Promise<void> {
    // No-op
  }
}
