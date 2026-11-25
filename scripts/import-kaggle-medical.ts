import { DateTime } from 'luxon';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvironmentFiles } from '../src/config/index.ts';
import { closeDbPool, getDbPool, withTransaction } from '../src/db/client.ts';
import { NORTHSTAR_BUSINESS_ID } from '../src/db/seed.ts';

type RawKaggleRow = {
  patientId: string;
  appointmentId: string;
  gender: string;
  scheduledDay: string;
  appointmentDay: string;
  age: number;
  neighbourhood: string;
  hipertension: boolean;
  diabetes: boolean;
  alcoholism: boolean;
  handcap: number;
  smsReceived: boolean;
  noShow: boolean;
};

type MappedAppointment = {
  kaggleAppointmentId: string;
  customerName: string;
  phoneE164: string;
  customerEmail: string | null;
  address: string;
  reason: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: 'confirmed' | 'cancelled';
  idempotencyKey: string;
};

function toTitleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : ''))
    .join(' ');
}

function deriveMedicalReason(row: RawKaggleRow): string {
  if (row.hipertension && row.diabetes) return 'Diabetes & Hypertension Follow-Up';
  if (row.hipertension) return 'Hypertension & Blood Pressure Follow-Up';
  if (row.diabetes) return 'Diabetes Care & Blood Sugar Checkup';
  if (row.age >= 0 && row.age <= 14) return 'Pediatric & Child Health Checkup';
  if (row.handcap > 0) return 'Specialized Mobility & Care Consultation';
  return 'General Medical Consultation';
}

function parseKaggleCsv(csvPath: string, maxRowsToScan = 2500): RawKaggleRow[] {
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rows: RawKaggleRow[] = [];

  for (let i = 1; i < lines.length && rows.length < maxRowsToScan; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 14) continue;

    const age = Number.parseInt(cols[5] ?? '0', 10);
    if (Number.isNaN(age) || age < 0) continue;

    rows.push({
      patientId: (cols[0] ?? '').trim(),
      appointmentId: (cols[1] ?? '').trim(),
      gender: (cols[2] ?? '').trim(),
      scheduledDay: (cols[3] ?? '').trim(),
      appointmentDay: (cols[4] ?? '').trim(),
      age,
      neighbourhood: toTitleCase((cols[6] ?? 'Central Clinic').trim()),
      hipertension: cols[8] === '1',
      diabetes: cols[9] === '1',
      alcoholism: cols[10] === '1',
      handcap: Number.parseInt(cols[11] ?? '0', 10) || 0,
      smsReceived: cols[12] === '1',
      noShow: (cols[13] ?? '').trim().toLowerCase() === 'yes',
    });
  }

  return rows;
}

async function main() {
  loadEnvironmentFiles();

  const csvPath = resolve(process.cwd(), 'KaggleV2-May-2016.csv');
  const rows = parseKaggleCsv(csvPath, 2500);
  if (rows.length === 0) {
    throw new Error(`No valid rows found in ${csvPath}`);
  }

  // Count top real neighbourhoods from the Kaggle dataset
  const areaCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.neighbourhood) {
      areaCounts.set(r.neighbourhood, (areaCounts.get(r.neighbourhood) ?? 0) + 1);
    }
  }
  const topAreas = [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([area]) => area);

  const timeZone = 'Asia/Karachi';
  const now = DateTime.now().setZone(timeZone);

  // Pick 30 diverse real rows (mix of confirmed + cancelled + varied medical conditions)
  const selectedRows: RawKaggleRow[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (seenIds.has(row.appointmentId)) continue;
    seenIds.add(row.appointmentId);
    selectedRows.push(row);
    if (selectedRows.length >= 30) break;
  }

  // Spread across the next 6 open business days (skipping Sunday), 5 busy 1-hour slots per day
  // Leaving open slots at 9 AM, 11 AM, 1 PM, 3 PM, 5 PM for live voice booking tests!
  const busyHoursWeekday = [10, 12, 14, 16, 17];
  const busyHoursSaturday = [9, 11, 13];

  const mappedAppointments: MappedAppointment[] = [];
  let rowIdx = 0;
  let dayOffset = 0;

  while (rowIdx < selectedRows.length && dayOffset < 14) {
    const day = now.plus({ days: dayOffset }).startOf('day');
    dayOffset += 1;
    if (day.weekday === 7) continue; // Sunday closed

    const hoursForDay = day.weekday === 6 ? busyHoursSaturday : busyHoursWeekday;
    for (const hour of hoursForDay) {
      if (rowIdx >= selectedRows.length) break;
      const src = selectedRows[rowIdx]!;
      rowIdx += 1;

      const startLocal = day.set({ hour, minute: 0, second: 0, millisecond: 0 });
      const endLocal = startLocal.plus({ hours: 1 });
      const shortNum = src.appointmentId.slice(-7).padStart(7, '0');

      mappedAppointments.push({
        kaggleAppointmentId: src.appointmentId,
        customerName: `Patient #${src.appointmentId}`,
        phoneE164: `+92300${shortNum}`,
        customerEmail: null,
        address: `${src.neighbourhood}, Vitória Clinic District`,
        reason: deriveMedicalReason(src),
        startsAt: startLocal.toUTC().toISO()!,
        endsAt: endLocal.toUTC().toISO()!,
        timezone: timeZone,
        status: src.noShow ? 'cancelled' : 'confirmed',
        idempotencyKey: `kaggle:${src.appointmentId}`,
      });
    }
  }

  const datasetJson = {
    source: 'Kaggle Medical Appointment No-Shows (KaggleV2-May-2016.csv — 110,527 real clinic rows)',
    generatedAt: new Date().toISOString(),
    business: {
      id: NORTHSTAR_BUSINESS_ID,
      name: 'CareFirst Medical Clinic',
      receptionistName: 'Sarah',
      description:
        'CareFirst Medical Clinic provides walk-in visits, general medical consultations, blood pressure and diabetes care, pediatric checkups, lab work, and prescription renewals.',
      location: 'Main Medical Plaza, City Center',
      timezone: timeZone,
      aiVoice: 'Puck',
      defaultAppointmentDurationMinutes: 60,
      emergencyPolicy:
        'For medical emergencies such as severe chest pain, difficulty breathing, heavy bleeding, or loss of consciousness, instruct the caller to hang up and call local emergency services or go to the nearest emergency room immediately. Never provide medical diagnoses.',
      pricingPolicy:
        'Do not invent treatment prices. Explain that standard consultation fees are confirmed at reception and final costs depend on the doctor evaluation and any lab tests needed.',
      hours: [
        { dayOfWeek: 0, openTime: null, closeTime: null, isClosed: true, displayLabel: 'Closed' },
        { dayOfWeek: 1, openTime: '09:00:00', closeTime: '18:00:00', isClosed: false, displayLabel: '9 AM to 6 PM' },
        { dayOfWeek: 2, openTime: '09:00:00', closeTime: '18:00:00', isClosed: false, displayLabel: '9 AM to 6 PM' },
        { dayOfWeek: 3, openTime: '09:00:00', closeTime: '18:00:00', isClosed: false, displayLabel: '9 AM to 6 PM' },
        { dayOfWeek: 4, openTime: '09:00:00', closeTime: '18:00:00', isClosed: false, displayLabel: '9 AM to 6 PM' },
        { dayOfWeek: 5, openTime: '09:00:00', closeTime: '18:00:00', isClosed: false, displayLabel: '9 AM to 6 PM' },
        { dayOfWeek: 6, openTime: '09:00:00', closeTime: '14:00:00', isClosed: false, displayLabel: '9 AM to 2 PM' },
      ],
      services: [
        { name: 'General Medical Consultation', durationMinutes: 60 },
        { name: 'Hypertension & Blood Pressure Follow-Up', durationMinutes: 60 },
        { name: 'Diabetes Care & Blood Sugar Checkup', durationMinutes: 60 },
        { name: 'Pediatric & Child Health Checkup', durationMinutes: 60 },
        { name: 'Lab Work & Prescription Renewal', durationMinutes: 60 },
        { name: 'Urgent Walk-In Assessment', durationMinutes: 60 },
      ],
      serviceAreas: topAreas,
    },
    stats: {
      totalCsvRowsScanned: rows.length,
      importedAppointmentsCount: mappedAppointments.length,
      confirmedCount: mappedAppointments.filter((a) => a.status === 'confirmed').length,
      cancelledNoShowCount: mappedAppointments.filter((a) => a.status === 'cancelled').length,
    },
    appointments: mappedAppointments,
  };

  const outDir = resolve(process.cwd(), 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'medical-clinic-dataset.json');
  writeFileSync(outPath, JSON.stringify(datasetJson, null, 2), 'utf8');

  const pool = getDbPool();
  await withTransaction(async (client) => {
    const b = datasetJson.business;
    await client.query(
      `
      UPDATE aibitsol.businesses
      SET name = $2,
          receptionist_name = $3,
          description = $4,
          location = $5,
          timezone = $6,
          emergency_policy = $7,
          pricing_policy = $8,
          default_appointment_duration_minutes = $9,
          ai_voice = $10,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        b.id,
        b.name,
        b.receptionistName,
        b.description,
        b.location,
        b.timezone,
        b.emergencyPolicy,
        b.pricingPolicy,
        b.defaultAppointmentDurationMinutes,
        b.aiVoice,
      ],
    );

    await client.query('DELETE FROM aibitsol.business_hours WHERE business_id = $1', [b.id]);
    for (const h of b.hours) {
      await client.query(
        `
        INSERT INTO aibitsol.business_hours (business_id, day_of_week, open_time, close_time, is_closed, display_label)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [b.id, h.dayOfWeek, h.openTime, h.closeTime, h.isClosed, h.displayLabel],
      );
    }

    await client.query('DELETE FROM aibitsol.services WHERE business_id = $1', [b.id]);
    for (const svc of b.services) {
      await client.query(
        `
        INSERT INTO aibitsol.services (business_id, name, duration_minutes)
        VALUES ($1, $2, $3)
        `,
        [b.id, svc.name, svc.durationMinutes],
      );
    }

    await client.query('DELETE FROM aibitsol.service_areas WHERE business_id = $1', [b.id]);
    for (const area of b.serviceAreas) {
      await client.query(
        `
        INSERT INTO aibitsol.service_areas (business_id, area_name)
        VALUES ($1, $2)
        `,
        [b.id, area],
      );
    }

    // Clear old dummy/test appointments & holds so real clinic schedule is clean
    await client.query('DELETE FROM aibitsol.calendar_sync_jobs WHERE business_id = $1', [b.id]);
    await client.query('DELETE FROM aibitsol.availability_holds WHERE business_id = $1', [b.id]);
    await client.query('DELETE FROM aibitsol.appointments WHERE business_id = $1', [b.id]);

    for (const appt of datasetJson.appointments) {
      await client.query(
        `
        INSERT INTO aibitsol.appointments (
          business_id, resource_id, customer_name, phone_e164, customer_email,
          address, reason, starts_at, ends_at, timezone, status, idempotency_key
        )
        VALUES ($1, 'default', $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11)
        ON CONFLICT (business_id, idempotency_key) DO NOTHING
        `,
        [
          b.id,
          appt.customerName,
          appt.phoneE164,
          appt.customerEmail,
          appt.address,
          appt.reason,
          appt.startsAt,
          appt.endsAt,
          appt.timezone,
          appt.status,
          appt.idempotencyKey,
        ],
      );
    }
  }, pool);

  console.log(
    JSON.stringify(
      {
        status: 'SUCCESS',
        jsonWritten: outPath,
        businessName: datasetJson.business.name,
        serviceAreas: datasetJson.business.serviceAreas,
        stats: datasetJson.stats,
      },
      null,
      2,
    ),
  );
  await closeDbPool();
}

main().catch(async (err) => {
  console.error('Import failed:', err);
  await closeDbPool();
  process.exit(1);
});
