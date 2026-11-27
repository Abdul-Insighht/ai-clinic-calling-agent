# VoxDesk Universal AI Calling Assistant — Complete Organization Setup Guide

This guide explains how **any service-based organization** (Medical Clinic, Dental Practice, Salon/Spa, Auto Workshop, HVAC/Plumbing, Law Firm, Education Institute, Consulting, etc.) can configure and deploy this repository as their own **live AI Calling Assistant** — without rewriting the core engine.

> **Reference Deployment:** CareFirst Medical Clinic (`config/organization.json`) is included as a verified, working production example.

---

## Architecture Overview

- **Voice AI Engine:** LiveKit Agents (Node.js) + LiveKit Cloud WebRTC + Krisp Background Voice Cancellation (BVC)
- **LLM / Voice Pipeline:** Google Gemini Live Native Audio (`gemini-3.1-flash-live-preview` by default; alternative models supported)
- **Database:** PostgreSQL (businesses, services, hours, appointments, call logs, leads, workspace settings)
- **Integrations:** Google Calendar (2-way availability + outbox sync), Gmail SMTP / Resend (booking emails), Meta WhatsApp Cloud API (instant WhatsApp receipts)
- **Web Dashboard:** React + Vite (`apps/frontend`) deployed on Vercel, connected to the Fastify REST API (`src/api/server.ts`) on Render

---

## Prerequisites

1. **Node.js `>= 24.0.0`** and **pnpm `>= 10.0.0`** (`corepack enable`)
2. **LiveKit CLI (`lk`)** installed:
   - Windows: `winget install LiveKit.LiveKitCLI`
   - macOS: `brew install livekit-cli`
   - Linux: `curl -sSL https://get.livekit.io/cli | bash`
3. Install dependencies:
   ```bash
   pnpm install --frozen-lockfile
   ```

---

## Step 1: Configure Your Organization (`config/organization.json`)

Copy the blank universal template:
```bash
cp config/organization.template.json config/organization.json
```

Edit `config/organization.json` with your organization's details across its **12 sections** (optional sections can be left empty `[]` with zero overhead):

| # | Section | What to Fill In |
| :-: | :--- | :--- |
| 1 | `organization` | `name`, `type` (e.g. `dental_clinic`, `auto_workshop`, `salon`), `description`, `location`, `timezone` (IANA, e.g. `Asia/Karachi`, `America/New_York`), `serviceAreas[]` |
| 2 | `businessHours` | `monday`–`sunday` (e.g. `"9 AM to 6 PM"`, `"Closed"`), optional `holidays[]`, `afterHoursBehavior` (`book_next_available` \| `capture_callback_lead`) |
| 3 | `services` | Array of services: `name`, `description`, `bookingType`, `durationMinutes`, `priceDisplay`, `intakeQuestions[]`, `isActive` |
| 4 | `services[].rules` | *(Optional)* Per-service `eligibility`, `requirements[]`, `restrictions[]` |
| 5 | `staff` | *(Optional)* Specialists/team members (`name`, `role`, `qualifications`, `assignedServices[]`) |
| 6 | `availability` | `defaultDurationMinutes`, optional `breaks[]`, `blockedDates[]` |
| 7 | `bookingRules` | `allowBooking`, `allowReschedule`, `allowCancel`, `allowLeadCapture`, `minAdvanceNoticeMinutes`, `requireReadbackConfirmation` |
| 8 | `faqs` | *(Optional)* Approved Q&A pairs (`question`, `answer`, `category`) |
| 9 | `customerInfo` | `callerLabel` (`Patient` / `Client` / `Customer`), `locationLabel` (`Clinic Location` / `Service Address` / `Office`), `bookingUnit` (`Appointment` / `Service Slot`), `fulfillmentMode` (`in_person` \| `on_site` \| `virtual` \| `hybrid`), `askCallerAddress` (`false` for in-person, `true` for home visits) |
| 10 | `escalationRules` | `emergencyPolicy`, `pricingPolicy`, `humanTransferTriggers[]`, `acceptedPaymentMethods[]` |
| 11 | `communication` | `emailConfirmation`, `whatsappConfirmation`, `phoneCallback` |
| 12 | `aiInstructions` | `assistantName`, `voice` (`Puck`, `Aoede`, `Charon`, `Fenrir`, `Kore`), `tone`, `languages[]`, `defaultLanguage`, `greeting`, `prohibitedClaims[]` |

> **Security Rule:** Never place API keys, passwords, or tokens inside `config/organization.json`. All credentials belong in `.env` and cloud secrets.

---

## Step 2: Configure Environment & Integrations (`.env`)

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Fill in each integration below:

### 2.1 PostgreSQL Database
Create a PostgreSQL database (e.g. **Neon**, **Supabase**, or **Render Postgres**) and set:
```env
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
```

### 2.2 LiveKit Cloud (Voice Transport & Agent Hosting)
1. Create a project at https://cloud.livekit.io/.
2. Copy your WebSocket URL, API Key, and API Secret:
   ```env
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxxxxx
   LIVEKIT_API_SECRET=xxxxxxxx
   ```
3. Run `lk agent create` (for first-time setup) to link your project in `livekit.toml`.

### 2.3 AI Voice Model (Gemini Live or Alternative Models)
**Default (Active) — Google Gemini Live Native Audio:**
1. Get an API key from https://aistudio.google.com/apikey.
2. Set in `.env`:
   ```env
   GOOGLE_API_KEY=AIza...
   GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
   GEMINI_VOICE=Puck
   ```
   Supported voices: `Puck`, `Aoede`, `Charon`, `Fenrir`, `Kore`.

**Alternative Models (Optional — in `src/main.ts`):**
- **Gemini 2.5 Flash Native Audio:** Change `model` in `src/main.ts` to `'gemini-2.5-flash-native-audio-preview-12-2025'`.
- **STT + LLM + TTS Pipeline (Deepgram + OpenAI + Cartesia):** Uncomment **Option A (LiveKit Cloud Inference)** in `src/main.ts` to use `deepgram/nova-3` + `openai/gpt-4.1-mini` + `cartesia/sonic-3` (uses LiveKit Cloud Inference billing; no separate OpenAI/Cartesia keys required when hosted on LiveKit Cloud).

### 2.4 Google Calendar (Live Availability + Booking Sync)
1. In **Google Cloud Console**, enable the **Google Calendar API**.
2. Create a **Service Account** and generate a JSON key.
3. Open your target **Google Calendar → Settings and sharing → Share with specific people**, add the Service Account `client_email` with **"Make changes to events"** permission.
4. Set in `.env`:
   ```env
   GOOGLE_CALENDAR_ID=your-calendar-id@gmail.com
   GOOGLE_CALENDAR_TIME_ZONE=Asia/Karachi
   GOOGLE_CALENDAR_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
   GOOGLE_CALENDAR_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```
   *(Alternatively, set `GOOGLE_CALENDAR_CREDENTIALS_JSON` with the full JSON string.)*

### 2.5 Email Confirmations (Gmail SMTP or Resend)
**Option A — Gmail SMTP (Recommended for quick setup):**
1. Enable 2-Step Verification on your Google account and create a 16-character **App Password**.
2. Set in `.env`:
   ```env
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=your-clinic@gmail.com
   SMTP_PASS=your16charapppassword
   EMAIL_FROM="Your Organization <your-clinic@gmail.com>"
   ```
**Option B — Resend:** Set `RESEND_API_KEY=re_...`.

### 2.6 WhatsApp Auto-Confirmations (Meta Cloud API)
1. Create an app in **Meta for Developers** → add the **WhatsApp** product.
2. Generate a permanent **System User Access Token** and copy your **Phone Number ID**.
3. Set in `.env`:
   ```env
   WHATSAPP_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_ACCESS_TOKEN=EAA...
   WHATSAPP_DEFAULT_COUNTRY_CODE=92
   # Optional: leave blank in production to send to real callers
   WHATSAPP_TEST_RECIPIENT=
   ```

### 2.7 API Authentication Secrets
Generate two strong random 32+ character strings:
```env
JWT_ACCESS_SECRET=change-me-to-a-long-random-secret-1
JWT_REFRESH_SECRET=change-me-to-a-long-random-secret-2
```

---

## Step 3: Initialize Database & Apply Organization Config

Run the database migration, seed initial admin user, validate your JSON config, preview it, and apply it to PostgreSQL:

```bash
# 1. Create tables & seed base record
pnpm db:migrate
pnpm db:seed

# 2. Validate config/organization.json against the 12-section Zod schema
pnpm org:validate

# 3. Preview compiled services, hours, terminology, and notification labels
pnpm org:preview

# 4. Apply configuration to PostgreSQL (requires --confirm safety flag)
node scripts/org-cli.ts apply config/organization.json --confirm
```

---

## Step 4: Verify Locally Before Deploying

```bash
# TypeScript check
pnpm typecheck

# Full automated test suite (security, latency, booking, availability, org config)
pnpm test

# Frontend production build check
pnpm frontend:build
```

To test the voice agent locally:
```bash
pnpm dev
```

---

## Step 5: Deploy to Production

### 5.1 LiveKit Cloud (AI Voice Agent)
1. Upload your secrets to LiveKit Cloud:
   ```bash
   lk agent update-secrets --secrets-file .env
   ```
2. Deploy the agent:
   ```bash
   lk agent deploy
   ```
3. Check status (wait until `Status = Running` and `Replicas = 1 / 1 / 1`):
   ```bash
   lk agent status
   ```

### 5.2 Render (Backend REST API)
1. Push your repo to GitHub.
2. Create a new **Web Service** on **Render** (uses `render.yaml` automatically: build `corepack enable && pnpm install --frozen-lockfile`, start `node src/api/server.ts`, health check `/health/live`).
3. Add the `.env` variables in Render's **Environment** tab.
4. Verify: `GET https://<your-api>.onrender.com/health/ready` returns `{"status":"ok","postgresConfigured":true}`.

### 5.3 Vercel (Web Dashboard)
1. Import the same GitHub repo in **Vercel**.
2. Set **Root Directory** to `apps/frontend` (`apps/frontend/vercel.json` is pre-configured).
3. Add environment variable:
   ```env
   VITE_API_BASE_URL=https://<your-api>.onrender.com
   ```
4. Attach your custom domain (e.g. `voxdesk.yourdomain.com`).

---

## Built-In AI Tools (9 Tools — Automatically Configured)

| Tool | Purpose |
| :--- | :--- |
| `get_business_information` | Answers hours, services, location, policies, and verified pricing |
| `get_available_appointments` | Checks live open slots (excludes booked & Google Calendar busy times) |
| `book_appointment` | Atomically books a slot, syncs Google Calendar, and sends Email + WhatsApp |
| `get_appointment_details` | Looks up an existing booking via Booking ID (e.g. `BK044`) + phone/name check |
| `update_appointment` | Updates caller details or reason on an existing booking |
| `reschedule_appointment` | Moves an existing booking to a new verified open slot |
| `cancel_appointment` | Cancels a booking and updates Calendar, Email, and WhatsApp |
| `capture_lead` | Captures callback/inquiry details when caller does not book |
| `request_human_transfer` | Logs and triggers escalation to a human representative |

---

## Pre-Launch Security Checklist

- [ ] `.env` is **never** committed to Git (verified via `.gitignore`).
- [ ] Replace default seeded login credentials (`admin@northstar.example` / `NorthStarAdmin123!`) in PostgreSQL and clear pre-filled credentials in `apps/frontend/src/App.tsx` before handing over to a live client.
- [ ] Clear `WHATSAPP_TEST_RECIPIENT` in production so real callers receive WhatsApp confirmations.
- [ ] Verify `POST /api/v1/auth/login`, `/health/ready`, and a full live test call (booking + Calendar + Email + WhatsApp + Dashboard view).
