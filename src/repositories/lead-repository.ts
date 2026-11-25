import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getDbPool, withReadClient, withTransaction } from '../db/client.ts';
import type { BusinessContext } from '../models/business.ts';
import type {
  CallRecord,
  CallStatus,
  CreateLeadPersistenceInput,
  LeadRecord,
} from '../models/lead.ts';

export interface LeadRepository {
  upsertLead(
    context: BusinessContext,
    input: CreateLeadPersistenceInput,
    dedupeWindowHours?: number,
  ): Promise<{ lead: LeadRecord; deduplicated: boolean }>;
  listLeads(context: BusinessContext): Promise<LeadRecord[]>;
}

export interface CallRepository {
  startCall(
    context: BusinessContext,
    input: { livekitRoomName: string; livekitRoomSid?: string | null },
  ): Promise<CallRecord>;
  completeCall(
    context: BusinessContext,
    callId: string,
    status?: Exclude<CallStatus, 'active'>,
  ): Promise<void>;
  recordHumanTransferRequest(context: BusinessContext, reason: string | null): Promise<void>;
}

type LeadRow = {
  id: string;
  business_id: string;
  call_id: string | null;
  customer_name: string;
  phone_e164: string;
  reason: string;
  location: string | null;
  preferred_time: string | null;
  status: LeadRecord['status'];
  consent_given: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapLeadRow(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    callId: row.call_id,
    customerName: row.customer_name,
    phoneE164: row.phone_e164,
    reason: row.reason,
    location: row.location,
    preferredTime: row.preferred_time,
    status: row.status,
    consentGiven: row.consent_given,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresLeadRepository implements LeadRepository {
  private readonly pool: Pool | undefined;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async upsertLead(
    context: BusinessContext,
    input: CreateLeadPersistenceInput,
    dedupeWindowHours = 24,
  ): Promise<{ lead: LeadRecord; deduplicated: boolean }> {
    return withTransaction(async (client) => {
      const existing = await client.query<LeadRow>(
        `
        SELECT * FROM leads
        WHERE business_id = $1
          AND phone_e164 = $2
          AND created_at >= NOW() - ($3::int * INTERVAL '1 hour')
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [context.businessId, input.phoneE164, dedupeWindowHours],
      );

      const found = existing.rows[0];
      if (found) {
        const updated = await client.query<LeadRow>(
          `
          UPDATE leads
          SET customer_name = $3,
              reason = $4,
              location = COALESCE($5, location),
              preferred_time = COALESCE($6, preferred_time),
              updated_at = NOW()
          WHERE business_id = $1 AND id = $2
          RETURNING *
          `,
          [
            context.businessId,
            found.id,
            input.customerName,
            input.reason,
            input.location ?? null,
            input.preferredTime ?? null,
          ],
        );
        return {
          deduplicated: true,
          lead: mapLeadRow(updated.rows[0] ?? found),
        };
      }

      const inserted = await client.query<LeadRow>(
        `
        INSERT INTO leads (
          business_id, call_id, customer_name, phone_e164,
          reason, location, preferred_time, status, consent_given
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8)
        RETURNING *
        `,
        [
          context.businessId,
          context.callId ?? null,
          input.customerName,
          input.phoneE164,
          input.reason,
          input.location ?? null,
          input.preferredTime ?? null,
          input.consentGiven ?? true,
        ],
      );

      const row = inserted.rows[0];
      if (!row) {
        throw new Error('Failed to persist lead.');
      }

      await client.query(
        `
        INSERT INTO audit_logs (business_id, actor_type, actor_id, action, entity_type, entity_id, changes_json)
        VALUES ($1, 'agent', $2, 'lead.captured', 'lead', $3, $4::jsonb)
        `,
        [
          context.businessId,
          context.callId ?? 'agent',
          row.id,
          JSON.stringify({ status: 'new', hasLocation: Boolean(row.location) }),
        ],
      );

      return {
        deduplicated: false,
        lead: mapLeadRow(row),
      };
    }, this.pool ?? getDbPool());
  }

  async listLeads(context: BusinessContext): Promise<LeadRecord[]> {
    return withReadClient(async (client) => {
      const result = await client.query<LeadRow>(
        `
        SELECT * FROM leads
        WHERE business_id = $1
        ORDER BY created_at DESC
        `,
        [context.businessId],
      );
      return result.rows.map(mapLeadRow);
    }, this.pool ?? getDbPool());
  }
}

export class InMemoryLeadRepository implements LeadRepository {
  private readonly leads = new Map<string, LeadRecord>();

  async upsertLead(
    context: BusinessContext,
    input: CreateLeadPersistenceInput,
    dedupeWindowHours = 24,
  ): Promise<{ lead: LeadRecord; deduplicated: boolean }> {
    const cutoffMs = Date.now() - dedupeWindowHours * 3_600_000;
    for (const existing of this.leads.values()) {
      if (
        existing.businessId === context.businessId &&
        existing.phoneE164 === input.phoneE164 &&
        Date.parse(existing.createdAt) >= cutoffMs
      ) {
        existing.customerName = input.customerName;
        existing.reason = input.reason;
        existing.location = input.location ?? existing.location;
        existing.preferredTime = input.preferredTime ?? existing.preferredTime;
        existing.updatedAt = new Date().toISOString();
        return { lead: { ...existing }, deduplicated: true };
      }
    }

    const nowIso = new Date().toISOString();
    const lead: LeadRecord = {
      id: randomUUID(),
      businessId: context.businessId,
      callId: context.callId ?? null,
      customerName: input.customerName,
      phoneE164: input.phoneE164,
      reason: input.reason,
      location: input.location ?? null,
      preferredTime: input.preferredTime ?? null,
      status: 'new',
      consentGiven: input.consentGiven ?? true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.leads.set(lead.id, lead);
    return { lead: { ...lead }, deduplicated: false };
  }

  async listLeads(context: BusinessContext): Promise<LeadRecord[]> {
    return [...this.leads.values()].filter((lead) => lead.businessId === context.businessId);
  }
}

export class PostgresCallRepository implements CallRepository {
  private readonly pool: Pool | undefined;

  constructor(pool?: Pool) {
    this.pool = pool;
  }

  async startCall(
    context: BusinessContext,
    input: { livekitRoomName: string; livekitRoomSid?: string | null },
  ): Promise<CallRecord> {
    return withTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        business_id: string;
        livekit_room_name: string;
        livekit_room_sid: string | null;
        status: CallStatus;
        started_at: Date;
        ended_at: Date | null;
        duration_seconds: number | null;
      }>(
        `
        INSERT INTO calls (business_id, livekit_room_name, livekit_room_sid, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING *
        `,
        [context.businessId, input.livekitRoomName, input.livekitRoomSid ?? null],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to start call record.');
      }

      return {
        id: row.id,
        businessId: row.business_id,
        livekitRoomName: row.livekit_room_name,
        livekitRoomSid: row.livekit_room_sid,
        status: row.status,
        startedAt: row.started_at.toISOString(),
        endedAt: row.ended_at ? row.ended_at.toISOString() : null,
        durationSeconds: row.duration_seconds,
      };
    }, this.pool ?? getDbPool());
  }

  async completeCall(
    context: BusinessContext,
    callId: string,
    status: Exclude<CallStatus, 'active'> = 'completed',
  ): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `
        UPDATE calls
        SET status = $3,
            ended_at = NOW(),
            duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
        WHERE business_id = $1 AND id = $2
        `,
        [context.businessId, callId, status],
      );
    }, this.pool ?? getDbPool());
  }

  async recordHumanTransferRequest(context: BusinessContext, reason: string | null): Promise<void> {
    await withTransaction(async (client) => {
      await client.query(
        `
        INSERT INTO audit_logs (business_id, actor_type, actor_id, action, entity_type, entity_id, changes_json)
        VALUES ($1, 'agent', $2, 'human_transfer.requested', 'call', $3, $4::jsonb)
        `,
        [
          context.businessId,
          context.callId ?? 'agent',
          context.callId ?? null,
          JSON.stringify({ transferAvailable: false, hasReason: Boolean(reason) }),
        ],
      );
    }, this.pool ?? getDbPool());
  }
}

export class InMemoryCallRepository implements CallRepository {
  private readonly calls = new Map<string, CallRecord>();
  public readonly transferRequests: Array<{ businessId: string; callId: string | null }> = [];

  async startCall(
    context: BusinessContext,
    input: { livekitRoomName: string; livekitRoomSid?: string | null },
  ): Promise<CallRecord> {
    const record: CallRecord = {
      id: randomUUID(),
      businessId: context.businessId,
      livekitRoomName: input.livekitRoomName,
      livekitRoomSid: input.livekitRoomSid ?? null,
      status: 'active',
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationSeconds: null,
    };
    this.calls.set(record.id, record);
    return { ...record };
  }

  async completeCall(
    context: BusinessContext,
    callId: string,
    status: Exclude<CallStatus, 'active'> = 'completed',
  ): Promise<void> {
    const call = this.calls.get(callId);
    if (call && call.businessId === context.businessId) {
      call.status = status;
      call.endedAt = new Date().toISOString();
      call.durationSeconds = Math.max(
        0,
        Math.floor((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000),
      );
    }
  }

  async recordHumanTransferRequest(context: BusinessContext): Promise<void> {
    this.transferRequests.push({
      businessId: context.businessId,
      callId: context.callId ?? null,
    });
  }
}
