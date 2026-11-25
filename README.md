# AiBitSol AI Receptionist

Single-business (future-ready with `business_id`), English-only browser AI receptionist built on **LiveKit Agents (Node.js 24 + TypeScript)**, **Gemini Live native audio**, **Fastify**, **PostgreSQL**, **Google Calendar sync**, and **React**.

## Architecture (Phase 1 — Single-Business Release)

- **Voice Runtime**: LiveKit Agents (`src/main.ts`, `src/agent/receptionist.ts`, `src/agent/prompt.ts`) + Gemini Live API (`@livekit/agents-plugin-google`).
- **Backend API**: Fastify + TypeScript (`src/api/server.ts`) with scrypt password hashing, HS256 JWT auth, admin/staff RBAC, rate limiting, and server-side LiveKit room token minting (`POST /api/v1/livekit/token`).
- **Database**: One PostgreSQL database (`src/db/migrations/001_initial_schema.sql`) with `business_id` on business-owned tables (ready for future multi-business expansion), `btree_gist` non-overlapping appointment exclusion constraints, idempotency keys, and durable Google Calendar outbox (`calendar_sync_jobs`).
- **Frontend**: Single-business React + TypeScript + LiveKit React SDK dashboard (`apps/frontend/`).
- **Observability & Deployment**: PII-redacting structured JSON logger (`src/lib/logger.ts`), OpenTelemetry Collector (`infrastructure/monitoring/`), and multi-service `docker-compose.yml`.

## Quick Start (Local Development)

### 1. Prerequisites
- Node.js `>=24.0.0`
- `pnpm >=10.0.0`
- LiveKit CLI (`lk`) for local agent dev/simulations (`winget install LiveKit.LiveKitCLI` on Windows)
- PostgreSQL 17 (optional for local in-memory dev; required for production)

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your rotated credentials:
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `GOOGLE_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_VOICE`
- `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_CLIENT_EMAIL`, `GOOGLE_CALENDAR_PRIVATE_KEY` (or `GOOGLE_CALENDAR_CREDENTIALS_JSON`)
- `DATABASE_URL`, `JWT_ACCESS_SECRET`

Never commit `.env`, `.env.local`, or service-account JSON key files.

### 3. Install Dependencies
```bash
pnpm install
```

### 4. Database Migrations & Seed (when `DATABASE_URL` is configured)
```bash
pnpm db:migrate
pnpm db:seed
```

### 5. Run Services
```bash
# Check config & runtime health
pnpm health

# Start Fastify API (port 3001)
pnpm api:start

# Start React Dashboard (port 5173)
pnpm frontend:dev

# Start LiveKit Agent Worker
pnpm dev
```

Demo login accounts (in-memory dev mode):
- Admin: `admin@northstar.example` / `NorthStarAdmin123!`
- Staff: `staff@northstar.example` / `NorthStarStaff123!`

## Docker Compose Deployment
```bash
docker compose up --build
```
Services started: `postgres`, `redis`, `migrate`, `api` (`:3001`), `agent-worker`, `frontend` (`:8080`), and `otel-collector` (`:4317` / `:4318`).

## Quality Assurance & Testing
```bash
# Typecheck, lint, and unit/security/performance tests
pnpm typecheck
pnpm lint
pnpm test

# Build React dashboard
pnpm frontend:build

# LiveKit text & audio simulations (requires lk CLI)
lk agent simulate text --scenarios scenarios.yaml
lk agent simulate text --scenarios tests/scenarios/
lk agent simulate audio --scenarios tests/scenarios/interruption.yaml
```
