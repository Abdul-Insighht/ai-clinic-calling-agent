import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { hashPassword } from '../api/auth.ts';
import { loadEnvironmentFiles } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { closeDbPool, getDbPool, withTransaction } from './client.ts';

export const NORTHSTAR_BUSINESS_ID = '22222222-2222-4222-8222-222222222222';

export async function seedDatabase(targetPool: Pool = getDbPool()): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `
      INSERT INTO businesses (
        id, name, receptionist_name, description, location, timezone,
        emergency_policy, pricing_policy, default_appointment_duration_minutes, ai_voice
      )
      VALUES (
        $1, 'NorthStar Heating & Air', 'Sarah',
        'NorthStar Heating & Air provides residential HVAC repair, maintenance, and installation services.',
        'Karachi, Pakistan', 'Asia/Karachi',
        'For potentially dangerous situations such as a gas smell, instruct the caller to leave the property and contact the appropriate emergency service or gas utility. Do not attempt technical diagnosis.',
        'Do not invent pricing. Explain that final pricing depends on diagnosis and a technician can provide an estimate.',
        60, 'Puck'
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [NORTHSTAR_BUSINESS_ID],
    );

    const northstarHours = [
      [0, null, null, true, 'Closed'],
      [1, '08:00:00', '18:00:00', false, '8 AM to 6 PM'],
      [2, '08:00:00', '18:00:00', false, '8 AM to 6 PM'],
      [3, '08:00:00', '18:00:00', false, '8 AM to 6 PM'],
      [4, '08:00:00', '18:00:00', false, '8 AM to 6 PM'],
      [5, '08:00:00', '18:00:00', false, '8 AM to 6 PM'],
      [6, '09:00:00', '14:00:00', false, '9 AM to 2 PM'],
    ] as const;

    for (const [dayOfWeek, openTime, closeTime, isClosed, displayLabel] of northstarHours) {
      await client.query(
        `
        INSERT INTO business_hours (business_id, day_of_week, open_time, close_time, is_closed, display_label)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (business_id, day_of_week) DO NOTHING
        `,
        [NORTHSTAR_BUSINESS_ID, dayOfWeek, openTime, closeTime, isClosed, displayLabel],
      );
    }

    const northstarServices = [
      ['Air conditioning repair', 60],
      ['Heating repair', 60],
      ['HVAC maintenance', 60],
      ['AC installation', 120],
      ['Furnace installation', 120],
      ['Indoor air quality services', 60],
    ] as const;

    for (const [serviceName, durationMinutes] of northstarServices) {
      await client.query(
        `
        INSERT INTO services (business_id, name, duration_minutes)
        VALUES ($1, $2, $3)
        ON CONFLICT (business_id, name) DO NOTHING
        `,
        [NORTHSTAR_BUSINESS_ID, serviceName, durationMinutes],
      );
    }

    for (const area of ['Dallas', 'Plano', 'Frisco', 'Richardson', 'McKinney']) {
      await client.query(
        `
        INSERT INTO service_areas (business_id, area_name)
        VALUES ($1, $2)
        ON CONFLICT (business_id, area_name) DO NOTHING
        `,
        [NORTHSTAR_BUSINESS_ID, area],
      );
    }

    const defaultUsers = [
      ['admin@northstar.example', 'NorthStar Admin', 'admin', 'NorthStarAdmin123!'],
      ['staff@northstar.example', 'NorthStar Staff', 'staff', 'NorthStarStaff123!'],
    ] as const;

    for (const [email, fullName, role, plainPassword] of defaultUsers) {
      await client.query(
        `
        INSERT INTO users (business_id, email, password_hash, full_name, role)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO NOTHING
        `,
        [NORTHSTAR_BUSINESS_ID, email, hashPassword(plainPassword), fullName, role],
      );
    }
  }, targetPool);

  logger.info('db.seed.completed', {
    businessId: NORTHSTAR_BUSINESS_ID,
  });
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  loadEnvironmentFiles();
  try {
    await seedDatabase();
  } finally {
    await closeDbPool();
  }
}
