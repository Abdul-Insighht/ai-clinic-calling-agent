import type { Pool } from 'pg';
import { getDbPool, withTransaction } from '../db/client.ts';
import type {
  BusinessContext,
  BusinessHoursEntry,
  BusinessHoursMap,
  BusinessProfile,
  BusinessServiceItem,
  VerifiedPricingRule,
} from '../models/business.ts';

export interface BusinessRepository {
  getBusinessProfile(context: BusinessContext): Promise<BusinessProfile | null>;
}

const DAY_KEYS: (keyof BusinessHoursMap)[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function buildHoursMap(entries: BusinessHoursEntry[]): BusinessHoursMap {
  const map: BusinessHoursMap = {
    monday: 'Closed',
    tuesday: 'Closed',
    wednesday: 'Closed',
    thursday: 'Closed',
    friday: 'Closed',
    saturday: 'Closed',
    sunday: 'Closed',
  };

  for (const entry of entries) {
    const key = DAY_KEYS[entry.dayOfWeek];
    if (key) {
      map[key] = entry.isClosed ? 'Closed' : entry.displayLabel;
    }
  }

  return map;
}

export class PostgresBusinessRepository implements BusinessRepository {
  private readonly pool: Pool | undefined;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async getBusinessProfile(context: BusinessContext): Promise<BusinessProfile | null> {
    return withTransaction(async (client) => {
      const businessResult = await client.query<{
        id: string;
        name: string;
        receptionist_name: string;
        description: string;
        location: string;
        timezone: string;
        emergency_policy: string;
        pricing_policy: string;
        default_appointment_duration_minutes: number;
        google_calendar_id: string | null;
        ai_voice: string;
        ai_model: string;
      }>(
        `
        SELECT id, name, receptionist_name, description, location, timezone,
               emergency_policy, pricing_policy, default_appointment_duration_minutes,
               google_calendar_id, ai_voice, ai_model
        FROM businesses
        WHERE id = $1
        LIMIT 1
        `,
        [context.businessId],
      );

      const row = businessResult.rows[0];
      if (!row) {
        return null;
      }

      const [hoursResult, servicesResult, areasResult, pricingResult] = await Promise.all([
        client.query<{
          day_of_week: number;
          open_time: string | null;
          close_time: string | null;
          is_closed: boolean;
          display_label: string;
        }>(
          `
          SELECT day_of_week, open_time, close_time, is_closed, display_label
          FROM business_hours
          WHERE business_id = $1
          ORDER BY day_of_week ASC
          `,
          [context.businessId],
        ),
        client.query<{
          id: string;
          name: string;
          description: string | null;
          duration_minutes: number;
          is_active: boolean;
        }>(
          `
          SELECT id, name, description, duration_minutes, is_active
          FROM services
          WHERE business_id = $1 AND is_active = TRUE
          ORDER BY name ASC
          `,
          [context.businessId],
        ),
        client.query<{ area_name: string }>(
          `
          SELECT area_name
          FROM service_areas
          WHERE business_id = $1
          ORDER BY area_name ASC
          `,
          [context.businessId],
        ),
        client.query<{
          id: string;
          service_id: string | null;
          label: string;
          pricing_type: VerifiedPricingRule['pricingType'];
          amount_cents: number | null;
          max_amount_cents: number | null;
          currency: string;
          notes: string | null;
          is_verified: boolean;
        }>(
          `
          SELECT id, service_id, label, pricing_type, amount_cents, max_amount_cents,
                 currency, notes, is_verified
          FROM pricing_rules
          WHERE business_id = $1
          ORDER BY label ASC
          `,
          [context.businessId],
        ),
      ]);

      const structuredHours: BusinessHoursEntry[] = hoursResult.rows.map((item) => ({
        dayOfWeek: item.day_of_week,
        openTime: item.open_time,
        closeTime: item.close_time,
        isClosed: item.is_closed,
        displayLabel: item.display_label,
      }));

      const serviceCatalog: BusinessServiceItem[] = servicesResult.rows.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        durationMinutes: item.duration_minutes,
        isActive: item.is_active,
      }));

      const pricingRules: VerifiedPricingRule[] = pricingResult.rows.map((item) => ({
        id: item.id,
        serviceId: item.service_id,
        label: item.label,
        pricingType: item.pricing_type,
        amountCents: item.amount_cents,
        maxAmountCents: item.max_amount_cents,
        currency: item.currency,
        notes: item.notes,
        isVerified: item.is_verified,
      }));

      return {
        id: row.id,
        name: row.name,
        receptionistName: row.receptionist_name,
        description: row.description,
        location: row.location,
        timezone: row.timezone,
        hours: buildHoursMap(structuredHours),
        structuredHours,
        services: serviceCatalog.map((item) => item.name),
        serviceCatalog,
        serviceAreas: areasResult.rows.map((item) => item.area_name),
        pricingRules,
        emergencyPolicy: row.emergency_policy,
        pricingPolicy: row.pricing_policy,
        appointmentDurationMinutes: row.default_appointment_duration_minutes,
        googleCalendarId: row.google_calendar_id,
        aiVoice: row.ai_voice,
        aiModel: row.ai_model,
      };
    }, this.pool ?? getDbPool());
  }
}

export class InMemoryBusinessRepository implements BusinessRepository {
  private readonly records = new Map<string, BusinessProfile>();

  constructor(profiles: BusinessProfile[] = []) {
    for (const profile of profiles) {
      if (profile.id) {
        this.records.set(profile.id, profile);
      }
    }
  }

  async getBusinessProfile(context: BusinessContext): Promise<BusinessProfile | null> {
    return this.records.get(context.businessId) ?? null;
  }
}
