import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { getAppConfig } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import type {
  AvailabilityHoldRecord,
  AvailableSlot,
  BusyInterval,
} from '../models/appointment.ts';
import type { BusinessContext, BusinessHoursEntry, BusinessProfile } from '../models/business.ts';
import type { AppointmentRepository } from '../repositories/appointment-repository.ts';
import type { BusinessService } from './business-service.ts';
import type { CalendarAdapter } from './google-calendar-adapter.ts';

export type CheckAvailabilityInput = {
  requestedDate?: string; // YYYY-MM-DD
  requestedDay?: string; // e.g. Monday, tomorrow, today
  requestedStartTime?: string; // e.g. "10:00", "10:00 AM", "2 PM"
  serviceName?: string;
  timePreference?: 'morning' | 'afternoon';
  daysAhead?: number;
  maxSlots?: number;
  now?: DateTime;
};

export type CheckAvailabilityResult = {
  requestedDate: string | null;
  requestedDay: string | null;
  requestedStartTime: string | null;
  requestedTimeAvailable: boolean | null;
  availableSlots: AvailableSlot[];
  timeZone: string;
  durationMinutes: number;
};

const HOLD_TTL_MINUTES = 10;
const SLOT_STEP_MINUTES = 30;

function parseFlexibleTime(label: string): { hour: number; minute: number } | null {
  const cleaned = label.trim();
  const ampmMatch = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampmMatch) {
    let hour = Number(ampmMatch[1]);
    const minute = ampmMatch[2] ? Number(ampmMatch[2]) : 0;
    const period = (ampmMatch[3] ?? '').toUpperCase();
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (period === 'PM' && hour !== 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const h24Match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (h24Match) {
    const hour = Number(h24Match[1]);
    const minute = Number(h24Match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }

  return null;
}

function parseDisplayTimeTo24Hour(label: string): { hour: number; minute: number } | null {
  const match = label.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const period = (match[3] ?? '').toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}

function getBusinessHoursForLuxonWeekday(
  business: BusinessProfile,
  luxonWeekday: number, // 1=Mon .. 7=Sun
): { openHour: number; openMinute: number; closeHour: number; closeMinute: number } | null {
  const dbDayOfWeek = luxonWeekday === 7 ? 0 : luxonWeekday;

  if (business.structuredHours && business.structuredHours.length > 0) {
    const entry: BusinessHoursEntry | undefined = business.structuredHours.find(
      (item) => item.dayOfWeek === dbDayOfWeek,
    );
    if (!entry || entry.isClosed || !entry.openTime || !entry.closeTime) {
      return null;
    }
    const [openHour = 0, openMinute = 0] = entry.openTime.split(':').map(Number);
    const [closeHour = 0, closeMinute = 0] = entry.closeTime.split(':').map(Number);
    return { openHour, openMinute, closeHour, closeMinute };
  }

  const dayMap: Record<number, keyof BusinessProfile['hours']> = {
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
    7: 'sunday',
  };
  const key = dayMap[luxonWeekday];
  if (!key) return null;

  const raw = business.hours[key];
  if (!raw || raw.toLowerCase() === 'closed') return null;

  const parts = raw.split(/\s+to\s+/i);
  if (parts.length !== 2) return null;

  const start = parseDisplayTimeTo24Hour(parts[0] ?? '');
  const end = parseDisplayTimeTo24Hour(parts[1] ?? '');
  if (!start || !end) return null;

  return {
    openHour: start.hour,
    openMinute: start.minute,
    closeHour: end.hour,
    closeMinute: end.minute,
  };
}

function resolveServiceDuration(
  business: BusinessProfile,
  serviceName?: string,
): { durationMinutes: number; serviceId: string | null } {
  if (serviceName && business.serviceCatalog) {
    const normalized = serviceName.trim().toLowerCase();
    const matched =
      business.serviceCatalog.find(
        (item) =>
          item.isActive &&
          (item.name.toLowerCase().includes(normalized) ||
            normalized.includes(item.name.toLowerCase())),
      ) ??
      business.serviceCatalog.find(
        (item) =>
          item.isActive &&
          ((normalized.includes('install') && item.name.toLowerCase().includes('install')) ||
            (normalized.includes('repair') && item.name.toLowerCase().includes('repair')) ||
            (normalized.includes('maint') && item.name.toLowerCase().includes('maint'))),
      );
    if (matched) {
      return { durationMinutes: matched.durationMinutes, serviceId: matched.id };
    }
  }

  return {
    durationMinutes: business.appointmentDurationMinutes || 60,
    serviceId: null,
  };
}

function conflictsWithBusy(slotStart: DateTime, slotEnd: DateTime, busy: BusyInterval[]): boolean {
  const s0 = slotStart.toMillis();
  const s1 = slotEnd.toMillis();
  return busy.some((interval) => {
    const b0 = Date.parse(interval.startsAt);
    const b1 = Date.parse(interval.endsAt);
    return s0 < b1 && s1 > b0;
  });
}

function matchesDayFilter(slotStart: DateTime, now: DateTime, requestedDay: string): boolean {
  const normalized = requestedDay.trim().toLowerCase();
  if (normalized === 'today') {
    return slotStart.hasSame(now, 'day');
  }
  if (normalized === 'tomorrow') {
    return slotStart.hasSame(now.plus({ days: 1 }), 'day');
  }
  return (slotStart.weekdayLong ?? '').toLowerCase() === normalized;
}

export class AvailabilityService {
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

  async getAvailableSlots(
    context: BusinessContext,
    input: CheckAvailabilityInput = {},
  ): Promise<CheckAvailabilityResult> {
    const business = await this.businessService.getBusinessProfile(context);
    const timeZone = business.timezone || getAppConfig().calendar.timeZone;
    const now = (input.now ?? DateTime.now()).setZone(timeZone);
    const daysAhead = input.daysAhead ?? 7;
    const maxSlots = input.maxSlots ?? 6;
    const { durationMinutes, serviceId } = resolveServiceDuration(business, input.serviceName);

    const rangeStart = now.startOf('day');
    const rangeEnd = rangeStart.plus({ days: daysAhead + 1 });
    const fromIso = rangeStart.toUTC().toISO() ?? new Date().toISOString();
    const toIso = rangeEnd.toUTC().toISO() ?? new Date().toISOString();

    const calendarId = business.googleCalendarId ?? getAppConfig().calendar.calendarId;
    const shouldCheckExternalCalendar = Boolean(
      calendarId && this.calendarAdapter.isConfigured(calendarId),
    );

    const [dbBusy, externalBusy] = await Promise.all([
      this.appointmentRepository.listBusyIntervals(context, fromIso, toIso),
      shouldCheckExternalCalendar && calendarId
        ? this.calendarAdapter
            .listBusyIntervals({
              calendarId,
              timeZone,
              timeMin: fromIso,
              timeMax: toIso,
            })
            .catch((error) => {
              logger.error('availability.calendar_busy_fetch_failed', {
                businessId: context.businessId,
                error,
              });
              throw new Error('Unable to verify live Google Calendar availability right now.');
            })
        : Promise.resolve([] as BusyInterval[]),
    ]);

    const allBusy = [...dbBusy, ...externalBusy];
    const candidates: Array<{ start: DateTime; end: DateTime }> = [];

    for (let offset = 0; offset <= daysAhead; offset += 1) {
      const day = rangeStart.plus({ days: offset });
      const hours = getBusinessHoursForLuxonWeekday(business, day.weekday);
      if (!hours) continue;

      let cursor = day.set({
        hour: hours.openHour,
        minute: hours.openMinute,
        second: 0,
        millisecond: 0,
      });
      const close = day.set({
        hour: hours.closeHour,
        minute: hours.closeMinute,
        second: 0,
        millisecond: 0,
      });

      while (cursor.plus({ minutes: durationMinutes }) <= close) {
        const slotEnd = cursor.plus({ minutes: durationMinutes });
        if (cursor > now.plus({ minutes: 15 }) && !conflictsWithBusy(cursor, slotEnd, allBusy)) {
          candidates.push({ start: cursor, end: slotEnd });
        }
        cursor = cursor.plus({ minutes: SLOT_STEP_MINUTES });
      }
    }

    let filtered = candidates;
    let requestedTimeAvailable: boolean | null = null;

    if (input.requestedDate) {
      const dateFiltered = filtered.filter((slot) => slot.start.toISODate() === input.requestedDate);
      requestedTimeAvailable = dateFiltered.length > 0;
      if (dateFiltered.length > 0) {
        filtered = dateFiltered;
      }
    } else if (input.requestedDay) {
      const dayFiltered = filtered.filter((slot) =>
        matchesDayFilter(slot.start, now, input.requestedDay ?? ''),
      );
      requestedTimeAvailable = dayFiltered.length > 0;
      if (dayFiltered.length > 0) {
        filtered = dayFiltered;
      }
    }

    if (input.timePreference === 'morning') {
      const morning = filtered.filter((slot) => slot.start.hour < 12);
      if (morning.length > 0) {
        filtered = morning;
        if (requestedTimeAvailable === null) requestedTimeAvailable = true;
      } else {
        requestedTimeAvailable = false;
      }
    } else if (input.timePreference === 'afternoon') {
      const afternoon = filtered.filter((slot) => slot.start.hour >= 12);
      if (afternoon.length > 0) {
        filtered = afternoon;
        if (requestedTimeAvailable === null) requestedTimeAvailable = true;
      } else {
        requestedTimeAvailable = false;
      }
    }

    const parsedStartTime = input.requestedStartTime
      ? parseFlexibleTime(input.requestedStartTime)
      : null;

    let selected: Array<{ start: DateTime; end: DateTime }>;
    if (parsedStartTime) {
      const targetMinutes = parsedStartTime.hour * 60 + parsedStartTime.minute;
      const exactMatch = filtered.find(
        (slot) => slot.start.hour === parsedStartTime.hour && slot.start.minute === parsedStartTime.minute,
      );

      if (exactMatch && requestedTimeAvailable !== false) {
        requestedTimeAvailable = true;
        const others = filtered
          .filter((slot) => slot !== exactMatch && slot.start.minute === 0)
          .sort(
            (a, b) =>
              Math.abs(a.start.hour * 60 + a.start.minute - targetMinutes) -
              Math.abs(b.start.hour * 60 + b.start.minute - targetMinutes),
          );
        selected = [exactMatch, ...others].slice(0, maxSlots);
      } else {
        requestedTimeAvailable = false;
        const sortedByProximity = [...filtered].sort((a, b) => {
          const distA = Math.abs(a.start.hour * 60 + a.start.minute - targetMinutes);
          const distB = Math.abs(b.start.hour * 60 + b.start.minute - targetMinutes);
          return distA - distB;
        });
        // Prefer distinct hourly alternatives where possible
        const hourly = sortedByProximity.filter((slot) => slot.start.minute === 0);
        selected = (hourly.length >= Math.min(3, maxSlots) ? hourly : sortedByProximity).slice(
          0,
          maxSlots,
        );
      }
    } else {
      // Without an exact time request, present clean on-the-hour slots first
      const hourly = filtered.filter((slot) => slot.start.minute === 0);
      selected = (hourly.length > 0 ? hourly : filtered).slice(0, maxSlots);
    }
    const expiresAt = now.plus({ minutes: HOLD_TTL_MINUTES }).toUTC().toISO() ?? new Date().toISOString();

    const holds: AvailabilityHoldRecord[] = [];
    const availableSlots: AvailableSlot[] = [];

    for (const slot of selected) {
      const slotToken = `slot_${randomBytes(12).toString('hex')}`;
      const startIso = slot.start.toISO() ?? '';
      const endIso = slot.end.toISO() ?? '';
      const dayLabel = slot.start.weekdayLong ?? '';
      const startTimeLabel = slot.start.toFormat('h:mm a');
      const endTimeLabel = slot.end.toFormat('h:mm a');
      const label = `${dayLabel}, ${slot.start.toFormat('LLL d')} at ${startTimeLabel}`;

      holds.push({
        slotToken,
        businessId: context.businessId,
        serviceId,
        resourceId: 'default',
        label,
        startsAt: slot.start.toUTC().toISO() ?? startIso,
        endsAt: slot.end.toUTC().toISO() ?? endIso,
        timezone: timeZone,
        expiresAt,
        consumedAt: null,
      });

      availableSlots.push({
        slotId: slotToken,
        date: slot.start.toISODate() ?? '',
        day: dayLabel,
        startTime: startTimeLabel,
        endTime: endTimeLabel,
        label,
        start: startIso,
        end: endIso,
        timezone: timeZone,
        expiresAt,
      });
    }

    await this.appointmentRepository.createAvailabilityHolds(context, holds);

    return {
      requestedDate: input.requestedDate ?? null,
      requestedDay: input.requestedDay ?? null,
      requestedStartTime: input.requestedStartTime ?? null,
      requestedTimeAvailable,
      availableSlots,
      timeZone,
      durationMinutes,
    };
  }
}
