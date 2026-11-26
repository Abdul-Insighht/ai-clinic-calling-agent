import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getDbPool, withReadClient, withTransaction } from '../db/client.ts';
import { logger } from '../lib/logger.ts';
import type {
  AppointmentRecord,
  AvailabilityHoldRecord,
  BusyInterval,
  CalendarSyncJobRecord,
  ReserveSlotInput,
  ReserveSlotResult,
} from '../models/appointment.ts';
import type { BusinessContext } from '../models/business.ts';

export type UpdateAppointmentDetailsInput = {
  customerName?: string;
  phoneE164?: string;
  customerEmail?: string | null;
  address?: string | null;
  reason?: string;
};

export interface AppointmentRepository {
  listBusyIntervals(
    context: BusinessContext,
    fromIso: string,
    toIso: string,
    resourceId?: string,
  ): Promise<BusyInterval[]>;
  createAvailabilityHolds(
    context: BusinessContext,
    holds: AvailabilityHoldRecord[],
  ): Promise<void>;
  reserveSlotTransactionally(
    context: BusinessContext,
    input: ReserveSlotInput,
  ): Promise<ReserveSlotResult>;
  markCalendarSynced(
    context: BusinessContext,
    appointmentId: string,
    googleEventId: string | null,
  ): Promise<AppointmentRecord>;
  markCalendarSyncDeferred(
    context: BusinessContext,
    appointmentId: string,
    errorMessage: string,
    nextRetryAtIso: string,
  ): Promise<void>;
  listPendingSyncJobs(context: BusinessContext): Promise<CalendarSyncJobRecord[]>;
  claimPendingSyncJobs?(context: BusinessContext, limit?: number): Promise<CalendarSyncJobRecord[]>;
  getAppointmentById(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null>;
  getAppointmentByCode?(
    context: BusinessContext,
    bookingCode: string,
  ): Promise<AppointmentRecord | null>;
  listAppointments?(context: BusinessContext, limit?: number): Promise<AppointmentRecord[]>;
  updateAppointmentDetails?(
    context: BusinessContext,
    appointmentId: string,
    updates: UpdateAppointmentDetailsInput,
  ): Promise<AppointmentRecord | null>;
  cancelAppointment?(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null>;
  rescheduleAppointment?(
    context: BusinessContext,
    appointmentId: string,
    newSlotToken: string,
    nowIso?: string,
  ): Promise<
    | { success: true; appointment: AppointmentRecord }
    | {
        success: false;
        error: 'APPOINTMENT_NOT_FOUND' | 'SLOT_NOT_FOUND' | 'SLOT_EXPIRED' | 'SLOT_UNAVAILABLE';
        message: string;
      }
  >;
  cleanupExpiredHolds?(context: BusinessContext): Promise<number>;
}

type AppointmentRow = {
  id: string;
  booking_code?: string | null;
  business_id: string;
  service_id: string | null;
  call_id: string | null;
  resource_id: string;
  customer_name: string;
  phone_e164: string;
  customer_email?: string | null;
  address?: string | null;
  reason: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: AppointmentRecord['status'];
  idempotency_key: string;
  google_event_id: string | null;
  created_at: Date;
};

function mapAppointmentRow(row: AppointmentRow): AppointmentRecord {
  return {
    id: row.id,
    bookingCode: row.booking_code ?? `BK${row.id.slice(0, 6).toUpperCase()}`,
    businessId: row.business_id,
    serviceId: row.service_id,
    callId: row.call_id,
    resourceId: row.resource_id,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    customerEmail: row.customer_email ?? null,
    address: row.address ?? null,
    reason: row.reason,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    timezone: row.timezone,
    label: row.starts_at.toISOString(),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    googleEventId: row.google_event_id,
    createdAt: row.created_at.toISOString(),
  };
}

function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a0 = Date.parse(aStart);
  const a1 = Date.parse(aEnd);
  const b0 = Date.parse(bStart);
  const b1 = Date.parse(bEnd);
  return a0 < b1 && a1 > b0;
}

export class PostgresAppointmentRepository implements AppointmentRepository {
  private readonly pool: Pool | undefined;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async listBusyIntervals(
    context: BusinessContext,
    fromIso: string,
    toIso: string,
    resourceId = 'default',
  ): Promise<BusyInterval[]> {
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<{ starts_at: Date; ends_at: Date }>(
      `
      SELECT starts_at, ends_at
      FROM aibitsol.appointments
      WHERE business_id = $1
        AND resource_id = $2
        AND status IN ('pending', 'pending_calendar_sync', 'confirmed')
        AND starts_at < $4::timestamptz
        AND ends_at > $3::timestamptz
      UNION ALL
      SELECT starts_at, ends_at
      FROM aibitsol.calendar_busy_blocks
      WHERE business_id = $1
        AND resource_id = $2
        AND starts_at < $4::timestamptz
        AND ends_at > $3::timestamptz
      `,
      [context.businessId, resourceId, fromIso, toIso],
    );

    return result.rows.map((row) => ({
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
    }));
  }

  async createAvailabilityHolds(
    context: BusinessContext,
    holds: AvailabilityHoldRecord[],
  ): Promise<void> {
    if (holds.length === 0) return;

    const values: unknown[] = [];
    const placeholders = holds.map((hold, idx) => {
      const base = idx * 9;
      values.push(
        context.businessId,
        hold.serviceId,
        hold.resourceId,
        hold.slotToken,
        hold.label,
        hold.startsAt,
        hold.endsAt,
        hold.timezone,
        hold.expiresAt,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::timestamptz, $${base + 7}::timestamptz, $${base + 8}, $${base + 9}::timestamptz)`;
    });

    const targetPool = this.pool ?? getDbPool();
    await targetPool.query(
      `
      INSERT INTO aibitsol.availability_holds (
        business_id, service_id, resource_id, slot_token,
        label, starts_at, ends_at, timezone, expires_at
      )
      VALUES ${placeholders.join(', ')}
      `,
      values,
    );
  }

  async reserveSlotTransactionally(
    context: BusinessContext,
    input: ReserveSlotInput,
  ): Promise<ReserveSlotResult> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const targetPool = this.pool ?? getDbPool();
    const txStart = performance.now();
    const client = await targetPool.connect();
    const poolConnectMs = Math.round(performance.now() - txStart);
    let txStarted = false;
    let releaseError: Error | undefined;

    try {
      const tBegin = performance.now();
      await client.query('BEGIN');
      const beginMs = Math.round(performance.now() - tBegin);
      txStarted = true;

      // 1. Lock expiring hold first (saves idempotency SELECT on normal first-time bookings)
      const tHold = performance.now();
      const holdResult = await client.query<{
        id: string;
        service_id: string | null;
        resource_id: string;
        label: string;
        starts_at: Date;
        ends_at: Date;
        timezone: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `
        SELECT id, service_id, resource_id, label, starts_at, ends_at, timezone, expires_at, consumed_at
        FROM aibitsol.availability_holds
        WHERE business_id = $1 AND slot_token = $2
        FOR UPDATE
        `,
        [context.businessId, input.slotToken],
      );
      const holdLockMs = Math.round(performance.now() - tHold);

      const hold = holdResult.rows[0];
      if (!hold || hold.consumed_at !== null) {
        // Check idempotent replay if hold was already consumed or missing
        const existingResult = await client.query<AppointmentRow>(
          `
          SELECT * FROM aibitsol.appointments
          WHERE business_id = $1 AND idempotency_key = $2
          LIMIT 1
          `,
          [context.businessId, input.idempotencyKey],
        );
        const existing = existingResult.rows[0];
        await client.query('COMMIT');
        txStarted = false;

        if (existing) {
          return {
            success: true as const,
            idempotentReplay: true,
            appointment: mapAppointmentRow(existing),
          };
        }

        if (!hold) {
          return {
            success: false as const,
            error: 'SLOT_NOT_FOUND' as const,
            message: 'The requested appointment slot does not exist or is no longer valid.',
          };
        }

        return {
          success: false as const,
          error: 'SLOT_UNAVAILABLE' as const,
          message: 'The requested appointment slot is no longer available.',
        };
      }

      if (hold.expires_at.getTime() <= Date.parse(nowIso)) {
        await client.query('COMMIT');
        txStarted = false;
        return {
          success: false as const,
          error: 'SLOT_EXPIRED' as const,
          message: 'That appointment slot selection has expired. Please check availability again.',
        };
      }

      // 2. Single atomic writable CTE: insert appointment + consume hold + enqueue outbox + audit log
      try {
        const tCte = performance.now();
        const inserted = await client.query<{
          id: string;
          booking_code: string | null;
          created_at: Date;
        }>(
          `
          WITH inserted_appt AS (
            INSERT INTO aibitsol.appointments (
              business_id, service_id, call_id, resource_id,
              customer_name, phone_e164, customer_email, address, reason, starts_at, ends_at,
              timezone, status, idempotency_key
            )
            VALUES ($1, $2, $3, $4, $5, $6, $16, $7, $8, $9, $10, $11, 'pending_calendar_sync', $12)
            RETURNING id, booking_code, created_at
          ),
          consumed_hold AS (
            UPDATE aibitsol.availability_holds
            SET consumed_at = NOW()
            WHERE id = $13
          ),
          queued_job AS (
            INSERT INTO aibitsol.calendar_sync_jobs (business_id, appointment_id, operation, status)
            SELECT $1, id, 'create', 'pending' FROM inserted_appt
          ),
          logged_audit AS (
            INSERT INTO aibitsol.audit_logs (
              business_id, actor_type, actor_id, action, entity_type, entity_id, changes_json
            )
            SELECT $1, 'agent', $14, 'appointment.reserved', 'appointment', id, $15::jsonb
            FROM inserted_appt
          )
          SELECT id, booking_code, created_at FROM inserted_appt
          `,
          [
            context.businessId,
            hold.service_id,
            context.callId ?? null,
            hold.resource_id,
            input.customerName,
            input.phoneE164,
            input.address ?? null,
            input.reason,
            hold.starts_at,
            hold.ends_at,
            hold.timezone,
            input.idempotencyKey,
            hold.id,
            context.callId ?? 'agent',
            JSON.stringify({
              status: 'pending_calendar_sync',
              startsAt: hold.starts_at.toISOString(),
            }),
            input.customerEmail ?? null,
          ],
        );

        const cteWriteMs = Math.round(performance.now() - tCte);
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('Failed to persist appointment reservation.');
        }

        const tCommit = performance.now();
        await client.query('COMMIT');
        const commitMs = Math.round(performance.now() - tCommit);
        txStarted = false;

        logger.info('booking.tx.spans', {
          businessId: context.businessId,
          appointmentId: row.id,
          poolConnectMs,
          beginMs,
          holdLockMs,
          cteWriteMs,
          commitMs,
          totalTxMs: Math.round(performance.now() - txStart),
        });

        return {
          success: true as const,
          idempotentReplay: false,
          appointment: {
            id: row.id,
            bookingCode: row.booking_code ?? `BK${row.id.slice(0, 6).toUpperCase()}`,
            businessId: context.businessId,
            serviceId: hold.service_id,
            callId: context.callId ?? null,
            resourceId: hold.resource_id,
            customerName: input.customerName,
            phoneE164: input.phoneE164,
            customerEmail: input.customerEmail ?? null,
            address: input.address ?? null,
            reason: input.reason,
            startsAt: hold.starts_at.toISOString(),
            endsAt: hold.ends_at.toISOString(),
            timezone: hold.timezone,
            label: hold.label,
            status: 'pending_calendar_sync',
            idempotencyKey: input.idempotencyKey,
            googleEventId: null,
            createdAt: row.created_at.toISOString(),
          },
        };
      } catch (error) {
        const pgError = error as { code?: string };
        if (txStarted) {
          try {
            await client.query('ROLLBACK');
            txStarted = false;
          } catch (rbErr) {
            releaseError = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
          }
        }
        if (pgError.code === '23P01') {
          return {
            success: false as const,
            error: 'SLOT_UNAVAILABLE' as const,
            message: 'The requested appointment slot is no longer available.',
          };
        }
        if (pgError.code === '23505') {
          const existingRes = await targetPool.query<AppointmentRow>(
            'SELECT * FROM aibitsol.appointments WHERE business_id = $1 AND idempotency_key = $2 LIMIT 1',
            [context.businessId, input.idempotencyKey],
          );
          if (existingRes.rows[0]) {
            return {
              success: true as const,
              idempotentReplay: true,
              appointment: mapAppointmentRow(existingRes.rows[0]),
            };
          }
        }
        throw error;
      }
    } catch (error) {
      if (txStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          releaseError = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async markCalendarSynced(
    context: BusinessContext,
    appointmentId: string,
    googleEventId: string | null,
  ): Promise<AppointmentRecord> {
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<AppointmentRow>(
      `
      WITH updated_appt AS (
        UPDATE aibitsol.appointments
        SET status = 'confirmed', google_event_id = $3, updated_at = NOW()
        WHERE business_id = $1 AND id = $2
        RETURNING *
      ),
      completed_jobs AS (
        UPDATE aibitsol.calendar_sync_jobs
        SET status = 'completed', updated_at = NOW()
        WHERE business_id = $1 AND appointment_id = $2 AND status IN ('pending', 'processing')
      )
      SELECT * FROM updated_appt
      `,
      [context.businessId, appointmentId, googleEventId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Appointment not found while marking calendar sync complete.');
    }

    return mapAppointmentRow(row);
  }

  async markCalendarSyncDeferred(
    context: BusinessContext,
    appointmentId: string,
    errorMessage: string,
    nextRetryAtIso: string,
  ): Promise<void> {
    const targetPool = this.pool ?? getDbPool();
    await targetPool.query(
      `
      UPDATE aibitsol.calendar_sync_jobs
      SET status = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END,
          attempts = attempts + 1,
          last_error = $3,
          next_retry_at = $4::timestamptz,
          updated_at = NOW()
      WHERE business_id = $1 AND appointment_id = $2 AND status IN ('pending', 'processing')
      `,
      [context.businessId, appointmentId, errorMessage, nextRetryAtIso],
    );
  }

  async listPendingSyncJobs(context: BusinessContext): Promise<CalendarSyncJobRecord[]> {
    return withReadClient(async (client) => {
      const result = await client.query<{
        id: string;
        business_id: string;
        appointment_id: string;
        operation: CalendarSyncJobRecord['operation'];
        status: CalendarSyncJobRecord['status'];
        attempts: number;
        last_error: string | null;
        next_retry_at: Date;
      }>(
        `
        SELECT id, business_id, appointment_id, operation, status, attempts, last_error, next_retry_at
        FROM calendar_sync_jobs
        WHERE business_id = $1 AND status = 'pending' AND next_retry_at <= NOW()
        ORDER BY created_at ASC
        `,
        [context.businessId],
      );

      return result.rows.map((row) => ({
        id: row.id,
        businessId: row.business_id,
        appointmentId: row.appointment_id,
        operation: row.operation,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        nextRetryAt: row.next_retry_at.toISOString(),
      }));
    }, this.pool ?? getDbPool());
  }

  async claimPendingSyncJobs(
    context: BusinessContext,
    limit = 10,
  ): Promise<CalendarSyncJobRecord[]> {
    return withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        business_id: string;
        appointment_id: string;
        operation: CalendarSyncJobRecord['operation'];
        status: CalendarSyncJobRecord['status'];
        attempts: number;
        last_error: string | null;
        next_retry_at: Date;
      }>(
        `
        WITH claimed AS (
          SELECT id
          FROM calendar_sync_jobs
          WHERE business_id = $1
            AND attempts < 8
            AND (
              (status = 'pending' AND next_retry_at <= NOW())
              OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes')
            )
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE calendar_sync_jobs j
        SET status = 'processing', updated_at = NOW()
        FROM claimed
        WHERE j.id = claimed.id
        RETURNING j.id, j.business_id, j.appointment_id, j.operation, j.status, j.attempts, j.last_error, j.next_retry_at
        `,
        [context.businessId, limit],
      );

      return result.rows.map((row) => ({
        id: row.id,
        businessId: row.business_id,
        appointmentId: row.appointment_id,
        operation: row.operation,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        nextRetryAt: row.next_retry_at.toISOString(),
      }));
    }, this.pool ?? getDbPool());
  }

  async getAppointmentById(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null> {
    return withReadClient(async (client) => {
      const result = await client.query<AppointmentRow>(
        'SELECT * FROM appointments WHERE business_id = $1 AND id = $2 LIMIT 1',
        [context.businessId, appointmentId],
      );
      const row = result.rows[0];
      return row ? mapAppointmentRow(row) : null;
    }, this.pool ?? getDbPool());
  }

  async getAppointmentByCode(
    context: BusinessContext,
    bookingCode: string,
  ): Promise<AppointmentRecord | null> {
    const normalized = bookingCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!normalized) return null;
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<AppointmentRow>(
      `
      SELECT *
      FROM aibitsol.appointments
      WHERE business_id = $1
        AND UPPER(booking_code) = $2
      LIMIT 1
      `,
      [context.businessId, normalized],
    );
    const row = result.rows[0];
    return row ? mapAppointmentRow(row) : null;
  }

  async listAppointments(context: BusinessContext, limit = 50): Promise<AppointmentRecord[]> {
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<AppointmentRow>(
      `
      SELECT *
      FROM aibitsol.appointments
      WHERE business_id = $1
      ORDER BY starts_at DESC
      LIMIT $2
      `,
      [context.businessId, limit],
    );
    return result.rows.map(mapAppointmentRow);
  }

  async updateAppointmentDetails(
    context: BusinessContext,
    appointmentId: string,
    updates: UpdateAppointmentDetailsInput,
  ): Promise<AppointmentRecord | null> {
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<AppointmentRow>(
      `
      UPDATE aibitsol.appointments
      SET customer_name  = COALESCE($3, customer_name),
          phone_e164     = COALESCE($4, phone_e164),
          address        = CASE WHEN $5::boolean THEN $6 ELSE address END,
          reason         = COALESCE($7, reason),
          customer_email = CASE WHEN $8::boolean THEN $9 ELSE customer_email END,
          updated_at     = NOW()
      WHERE business_id = $1 AND id = $2
      RETURNING *
      `,
      [
        context.businessId,
        appointmentId,
        updates.customerName ?? null,
        updates.phoneE164 ?? null,
        updates.address !== undefined,
        updates.address ?? null,
        updates.reason ?? null,
        updates.customerEmail !== undefined,
        updates.customerEmail ?? null,
      ],
    );
    const row = result.rows[0];
    return row ? mapAppointmentRow(row) : null;
  }

  async cancelAppointment(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null> {
    const targetPool = this.pool ?? getDbPool();
    const result = await targetPool.query<AppointmentRow>(
      `
      UPDATE aibitsol.appointments
      SET status = 'cancelled', updated_at = NOW()
      WHERE business_id = $1 AND id = $2
      RETURNING *
      `,
      [context.businessId, appointmentId],
    );
    const row = result.rows[0];
    return row ? mapAppointmentRow(row) : null;
  }

  async rescheduleAppointment(
    context: BusinessContext,
    appointmentId: string,
    newSlotToken: string,
    nowIso = new Date().toISOString(),
  ): Promise<
    | { success: true; appointment: AppointmentRecord }
    | {
        success: false;
        error: 'APPOINTMENT_NOT_FOUND' | 'SLOT_NOT_FOUND' | 'SLOT_EXPIRED' | 'SLOT_UNAVAILABLE';
        message: string;
      }
  > {
    return withTransaction(async (client) => {
      const holdRes = await client.query<{
        id: string;
        resource_id: string;
        starts_at: Date;
        ends_at: Date;
        timezone: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `
        SELECT id, resource_id, starts_at, ends_at, timezone, expires_at, consumed_at
        FROM aibitsol.availability_holds
        WHERE business_id = $1 AND slot_token = $2
        FOR UPDATE
        `,
        [context.businessId, newSlotToken],
      );
      const hold = holdRes.rows[0];
      if (!hold) {
        return {
          success: false as const,
          error: 'SLOT_NOT_FOUND' as const,
          message: 'That new time slot is no longer valid. Please check availability again.',
        };
      }
      if (hold.consumed_at !== null) {
        return {
          success: false as const,
          error: 'SLOT_UNAVAILABLE' as const,
          message: 'That new time slot is no longer available.',
        };
      }
      if (hold.expires_at.getTime() <= Date.parse(nowIso)) {
        return {
          success: false as const,
          error: 'SLOT_EXPIRED' as const,
          message: 'That slot hold expired. Please check availability again.',
        };
      }

      const overlapRes = await client.query(
        `
        SELECT 1 FROM aibitsol.appointments
        WHERE business_id = $1
          AND id <> $2
          AND resource_id = $3
          AND status IN ('pending', 'pending_calendar_sync', 'confirmed')
          AND starts_at < $5::timestamptz
          AND ends_at > $4::timestamptz
        LIMIT 1
        `,
        [context.businessId, appointmentId, hold.resource_id, hold.starts_at, hold.ends_at],
      );
      if (overlapRes.rows.length > 0) {
        return {
          success: false as const,
          error: 'SLOT_UNAVAILABLE' as const,
          message: 'That new time slot was just booked. Please pick another open slot.',
        };
      }

      const updated = await client.query<AppointmentRow>(
        `
        UPDATE aibitsol.appointments
        SET starts_at = $3,
            ends_at = $4,
            timezone = $5,
            status = 'confirmed',
            updated_at = NOW()
        WHERE business_id = $1 AND id = $2
        RETURNING *
        `,
        [context.businessId, appointmentId, hold.starts_at, hold.ends_at, hold.timezone],
      );
      const row = updated.rows[0];
      if (!row) {
        return {
          success: false as const,
          error: 'APPOINTMENT_NOT_FOUND' as const,
          message: 'No existing appointment was found with that booking ID.',
        };
      }

      await client.query(
        `UPDATE aibitsol.availability_holds SET consumed_at = NOW() WHERE id = $1`,
        [hold.id],
      );

      return {
        success: true as const,
        appointment: mapAppointmentRow(row),
      };
    }, this.pool ?? getDbPool());
  }

  async cleanupExpiredHolds(context: BusinessContext): Promise<number> {
    return withTransaction(async (client) => {
      const result = await client.query(
        `
        DELETE FROM availability_holds
        WHERE business_id = $1
          AND consumed_at IS NULL
          AND expires_at < NOW() - INTERVAL '1 hour'
        `,
        [context.businessId],
      );
      return result.rowCount ?? 0;
    }, this.pool ?? getDbPool());
  }
}

export class InMemoryAppointmentRepository implements AppointmentRepository {
  private readonly holds = new Map<string, AvailabilityHoldRecord>();
  private readonly appointments = new Map<string, AppointmentRecord>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly syncJobs = new Map<string, CalendarSyncJobRecord>();
  private bookingSeq = 0;

  async listBusyIntervals(
    context: BusinessContext,
    fromIso: string,
    toIso: string,
    resourceId = 'default',
  ): Promise<BusyInterval[]> {
    const busy: BusyInterval[] = [];
    for (const appt of this.appointments.values()) {
      if (
        appt.businessId === context.businessId &&
        appt.resourceId === resourceId &&
        (appt.status === 'pending' ||
          appt.status === 'pending_calendar_sync' ||
          appt.status === 'confirmed') &&
        intervalsOverlap(appt.startsAt, appt.endsAt, fromIso, toIso)
      ) {
        busy.push({ startsAt: appt.startsAt, endsAt: appt.endsAt });
      }
    }
    return busy;
  }

  async createAvailabilityHolds(
    _context: BusinessContext,
    holds: AvailabilityHoldRecord[],
  ): Promise<void> {
    for (const hold of holds) {
      this.holds.set(hold.slotToken, { ...hold });
    }
  }

  async reserveSlotTransactionally(
    context: BusinessContext,
    input: ReserveSlotInput,
  ): Promise<ReserveSlotResult> {
    const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
    const idempKey = `${context.businessId}:${input.idempotencyKey}`;
    const existingId = this.idempotencyIndex.get(idempKey);
    if (existingId) {
      const existing = this.appointments.get(existingId);
      if (existing) {
        return { success: true, idempotentReplay: true, appointment: { ...existing } };
      }
    }

    const hold = this.holds.get(input.slotToken);
    if (!hold || hold.businessId !== context.businessId) {
      return {
        success: false,
        error: 'SLOT_NOT_FOUND',
        message: 'The requested appointment slot does not exist or is no longer valid.',
      };
    }

    if (hold.consumedAt !== null) {
      return {
        success: false,
        error: 'SLOT_UNAVAILABLE',
        message: 'The requested appointment slot is no longer available.',
      };
    }

    if (Date.parse(hold.expiresAt) <= nowMs) {
      return {
        success: false,
        error: 'SLOT_EXPIRED',
        message: 'That appointment slot selection has expired. Please check availability again.',
      };
    }

    for (const appt of this.appointments.values()) {
      if (
        appt.businessId === context.businessId &&
        appt.resourceId === hold.resourceId &&
        (appt.status === 'pending' ||
          appt.status === 'pending_calendar_sync' ||
          appt.status === 'confirmed') &&
        intervalsOverlap(appt.startsAt, appt.endsAt, hold.startsAt, hold.endsAt)
      ) {
        return {
          success: false,
          error: 'SLOT_UNAVAILABLE',
          message: 'The requested appointment slot is no longer available.',
        };
      }
    }

    const id = randomUUID();
    const bookingCode = `BK${String(++this.bookingSeq).padStart(3, '0')}`;
    const createdAt = new Date(nowMs).toISOString();
    const appointment: AppointmentRecord = {
      id,
      bookingCode,
      businessId: context.businessId,
      serviceId: hold.serviceId,
      callId: context.callId ?? null,
      resourceId: hold.resourceId,
      customerName: input.customerName,
      phoneE164: input.phoneE164,
      customerEmail: input.customerEmail ?? null,
      address: input.address ?? null,
      reason: input.reason,
      startsAt: hold.startsAt,
      endsAt: hold.endsAt,
      timezone: hold.timezone,
      label: hold.label,
      status: 'pending_calendar_sync',
      idempotencyKey: input.idempotencyKey,
      googleEventId: null,
      createdAt,
    };

    hold.consumedAt = createdAt;
    this.appointments.set(id, appointment);
    this.idempotencyIndex.set(idempKey, id);

    const jobId = randomUUID();
    this.syncJobs.set(jobId, {
      id: jobId,
      businessId: context.businessId,
      appointmentId: id,
      operation: 'create',
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextRetryAt: createdAt,
    });

    return { success: true, idempotentReplay: false, appointment: { ...appointment } };
  }

  async markCalendarSynced(
    context: BusinessContext,
    appointmentId: string,
    googleEventId: string | null,
  ): Promise<AppointmentRecord> {
    const appt = this.appointments.get(appointmentId);
    if (!appt || appt.businessId !== context.businessId) {
      throw new Error('Appointment not found.');
    }
    appt.status = 'confirmed';
    appt.googleEventId = googleEventId;

    for (const job of this.syncJobs.values()) {
      if (job.businessId === context.businessId && job.appointmentId === appointmentId) {
        job.status = 'completed';
      }
    }
    return { ...appt };
  }

  async markCalendarSyncDeferred(
    context: BusinessContext,
    appointmentId: string,
    errorMessage: string,
    nextRetryAtIso: string,
  ): Promise<void> {
    for (const job of this.syncJobs.values()) {
      if (
        job.businessId === context.businessId &&
        job.appointmentId === appointmentId &&
        job.status !== 'completed'
      ) {
        job.attempts += 1;
        job.status = job.attempts >= 8 ? 'failed' : 'pending';
        job.lastError = errorMessage;
        job.nextRetryAt = nextRetryAtIso;
      }
    }
  }

  async listPendingSyncJobs(context: BusinessContext): Promise<CalendarSyncJobRecord[]> {
    return [...this.syncJobs.values()].filter(
      (job) => job.businessId === context.businessId && job.status === 'pending',
    );
  }

  async claimPendingSyncJobs(
    context: BusinessContext,
    limit = 10,
  ): Promise<CalendarSyncJobRecord[]> {
    const claimed: CalendarSyncJobRecord[] = [];
    for (const job of this.syncJobs.values()) {
      if (claimed.length >= limit) break;
      if (job.businessId === context.businessId && job.status === 'pending' && job.attempts < 8) {
        job.status = 'processing';
        claimed.push({ ...job });
      }
    }
    return claimed;
  }

  async getAppointmentById(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null> {
    const appt = this.appointments.get(appointmentId);
    if (!appt || appt.businessId !== context.businessId) {
      return null;
    }
    return { ...appt };
  }

  async getAppointmentByCode(
    context: BusinessContext,
    bookingCode: string,
  ): Promise<AppointmentRecord | null> {
    const normalized = bookingCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!normalized) return null;
    for (const appt of this.appointments.values()) {
      if (
        appt.businessId === context.businessId &&
        appt.bookingCode?.toUpperCase() === normalized
      ) {
        return { ...appt };
      }
    }
    return null;
  }

  async updateAppointmentDetails(
    context: BusinessContext,
    appointmentId: string,
    updates: UpdateAppointmentDetailsInput,
  ): Promise<AppointmentRecord | null> {
    const appt = this.appointments.get(appointmentId);
    if (!appt || appt.businessId !== context.businessId) {
      return null;
    }
    if (updates.customerName !== undefined) appt.customerName = updates.customerName;
    if (updates.phoneE164 !== undefined) appt.phoneE164 = updates.phoneE164;
    if (updates.customerEmail !== undefined) appt.customerEmail = updates.customerEmail;
    if (updates.address !== undefined) appt.address = updates.address;
    if (updates.reason !== undefined) appt.reason = updates.reason;
    return { ...appt };
  }

  async cancelAppointment(
    context: BusinessContext,
    appointmentId: string,
  ): Promise<AppointmentRecord | null> {
    const appt = this.appointments.get(appointmentId);
    if (!appt || appt.businessId !== context.businessId) {
      return null;
    }
    appt.status = 'cancelled';
    return { ...appt };
  }

  async rescheduleAppointment(
    context: BusinessContext,
    appointmentId: string,
    newSlotToken: string,
    nowIso = new Date().toISOString(),
  ): Promise<
    | { success: true; appointment: AppointmentRecord }
    | {
        success: false;
        error: 'APPOINTMENT_NOT_FOUND' | 'SLOT_NOT_FOUND' | 'SLOT_EXPIRED' | 'SLOT_UNAVAILABLE';
        message: string;
      }
  > {
    const appt = this.appointments.get(appointmentId);
    if (!appt || appt.businessId !== context.businessId) {
      return {
        success: false,
        error: 'APPOINTMENT_NOT_FOUND',
        message: 'No existing appointment was found with that booking ID.',
      };
    }
    const hold = this.holds.get(newSlotToken);
    if (!hold || hold.businessId !== context.businessId) {
      return {
        success: false,
        error: 'SLOT_NOT_FOUND',
        message: 'That new time slot is no longer valid.',
      };
    }
    if (hold.consumedAt !== null) {
      return {
        success: false,
        error: 'SLOT_UNAVAILABLE',
        message: 'That new time slot is no longer available.',
      };
    }
    if (Date.parse(hold.expiresAt) <= Date.parse(nowIso)) {
      return {
        success: false,
        error: 'SLOT_EXPIRED',
        message: 'That slot hold expired.',
      };
    }
    for (const other of this.appointments.values()) {
      if (
        other.id !== appointmentId &&
        other.businessId === context.businessId &&
        other.resourceId === hold.resourceId &&
        (other.status === 'pending' ||
          other.status === 'pending_calendar_sync' ||
          other.status === 'confirmed') &&
        intervalsOverlap(other.startsAt, other.endsAt, hold.startsAt, hold.endsAt)
      ) {
        return {
          success: false,
          error: 'SLOT_UNAVAILABLE',
          message: 'That new time slot is already booked.',
        };
      }
    }

    appt.startsAt = hold.startsAt;
    appt.endsAt = hold.endsAt;
    appt.timezone = hold.timezone;
    appt.label = hold.label;
    appt.status = 'confirmed';
    hold.consumedAt = nowIso;
    return { success: true, appointment: { ...appt } };
  }

  async listAppointments(context: BusinessContext, limit = 50): Promise<AppointmentRecord[]> {
    return [...this.appointments.values()]
      .filter((a) => a.businessId === context.businessId)
      .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))
      .slice(0, limit)
      .map((a) => ({ ...a }));
  }
}
