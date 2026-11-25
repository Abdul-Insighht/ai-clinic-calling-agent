-- Phase 1 (Single-Business, Future-Ready with business_id): PostgreSQL Schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Businesses (single business initially; business_id kept for future multi-business expansion)
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  receptionist_name TEXT NOT NULL DEFAULT 'Sarah',
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  emergency_policy TEXT NOT NULL,
  pricing_policy TEXT NOT NULL,
  default_appointment_duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (default_appointment_duration_minutes > 0),
  google_calendar_id TEXT,
  ai_voice TEXT NOT NULL DEFAULT 'Puck',
  ai_model TEXT NOT NULL DEFAULT 'gemini-2.5-flash-native-audio-preview-12-2025',
  ai_temperature NUMERIC(3, 2) NOT NULL DEFAULT 0.80,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users (admin/staff dashboard accounts)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'staff')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);

-- 3. Business hours (0 = Sunday .. 6 = Saturday)
CREATE TABLE IF NOT EXISTS business_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time TIME,
  close_time TIME,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  display_label TEXT NOT NULL,
  UNIQUE (business_id, day_of_week),
  CHECK (is_closed OR (open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time))
);
CREATE INDEX IF NOT EXISTS idx_business_hours_business ON business_hours(business_id);

-- 4. Services offered
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_services_business ON services(business_id);

-- 5. Service areas
CREATE TABLE IF NOT EXISTS service_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  area_name TEXT NOT NULL,
  postal_code TEXT,
  UNIQUE (business_id, area_name)
);
CREATE INDEX IF NOT EXISTS idx_service_areas_business ON service_areas(business_id);

-- 6. Pricing rules (only is_verified = TRUE may be quoted to callers)
CREATE TABLE IF NOT EXISTS pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  pricing_type TEXT NOT NULL CHECK (pricing_type IN ('fixed', 'starting_at', 'range', 'estimate_only')),
  amount_cents INTEGER CHECK (amount_cents >= 0),
  max_amount_cents INTEGER CHECK (max_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_business ON pricing_rules(business_id);

-- 7. Calls / LiveKit session records
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  livekit_room_name TEXT NOT NULL,
  livekit_room_sid TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER CHECK (duration_seconds >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_calls_business ON calls(business_id, started_at DESC);

-- 8. Appointments (authoritative reservation store with overlap & idempotency protection)
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  resource_id TEXT NOT NULL DEFAULT 'default',
  customer_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  reason TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'pending_calendar_sync', 'confirmed', 'failed', 'cancelled')
  ),
  idempotency_key TEXT NOT NULL,
  google_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at < ends_at),
  UNIQUE (business_id, idempotency_key),
  CONSTRAINT no_overlapping_active_appointments EXCLUDE USING gist (
    business_id WITH =,
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'pending_calendar_sync', 'confirmed'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_business_time ON appointments(business_id, starts_at);

-- 9. Availability holds (expiring opaque slot tokens issued by availability checks)
CREATE TABLE IF NOT EXISTS availability_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  resource_id TEXT NOT NULL DEFAULT 'default',
  slot_token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_availability_holds_business_token ON availability_holds(business_id, slot_token);

-- 10. Leads (persistent customer enquiries)
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  reason TEXT NOT NULL,
  location TEXT,
  preferred_time TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  consent_given BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_business_phone ON leads(business_id, phone_e164);

-- 11. Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  changes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_business_created ON audit_logs(business_id, created_at DESC);

-- 12. Calendar sync jobs (durable outbox for Google Calendar synchronization)
CREATE TABLE IF NOT EXISTS calendar_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'cancel')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_jobs_pending ON calendar_sync_jobs(status, next_retry_at);

-- 13. External calendar busy blocks (inbound sync from Google Calendar)
CREATE TABLE IF NOT EXISTS calendar_busy_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL DEFAULT 'default',
  external_event_id TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, external_event_id),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_calendar_busy_blocks_range ON calendar_busy_blocks(business_id, starts_at, ends_at);
