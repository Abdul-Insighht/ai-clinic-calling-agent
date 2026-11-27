# Complete Lifecycle, Testing-to-Production, Telephony (SIP) & Cost Guide

This document is the master operational & business reference for **VoxDesk Universal AI Calling Assistant** (baseline: **CareFirst Medical Clinic**). It covers:

1. **Current Free Testing System** — What is running today, **where every free API/service was obtained**, exact setup steps, and what it is suitable for.
2. **Complete 6-Phase Lifecycle** — Development → Staging → Client UAT → Production Readiness → Go-Live → Operations.
3. **Clear Business Scale Criteria** — Exact definitions of **Free Testing**, **Small Business**, **Growing Business**, and **Large Enterprise** (calls/day, concurrency, infrastructure, and verified cost breakdown).
4. **Telephony & Business Phone Number Integration (SIP)** — Connecting a new number or an organization's existing Pakistan/international number.
5. **Client / End-User Guide** & **30-Point Go-Live Sign-Off Checklist**.

---

## 1. Current Free Testing System (What Is Running Right Now)

Right now, CareFirst Medical Clinic runs on a **$0/month Sandbox & Testing Stack**. Every single component below uses an official free/developer tier:

| Component | Current Provider & Tier | Where to Get It (Exact Portal) | Steps Used to Obtain & Configure |
| :--- | :--- | :--- | :--- |
| **AI Voice LLM** | Google Gemini 3.1 Flash Live Preview (**Free Dev Tier**) | https://aistudio.google.com/apikey | Sign in with Google → Create API Key → Set `GOOGLE_API_KEY` in `.env` & LiveKit secrets |
| **Voice Runtime & WebRTC** | LiveKit Cloud (**Build — $0/mo**) | https://cloud.livekit.io/ | Create project → Copy `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` → `lk agent create` / `lk agent deploy` |
| **Database** | Neon PostgreSQL (**Free Tier — $0/mo**) | https://console.neon.tech/ | Create Postgres project → Copy pooled `DATABASE_URL` → Run `pnpm db:migrate && pnpm db:seed` |
| **Backend REST API** | Render Web Service (**Free Tier — $0/mo**) | https://dashboard.render.com/ | Connect GitHub repo → Auto-detect `render.yaml` → Add env vars → Verify `/health/ready` |
| **Web Dashboard** | Vercel (**Hobby — $0/mo**) | https://vercel.com/ | Import GitHub repo → Root Dir `apps/frontend` → Set `VITE_API_BASE_URL` → Connect custom domain |
| **Google Calendar** | Google Cloud Calendar API (**Free Quota**) | https://console.cloud.google.com/ | Enable Calendar API → Create Service Account + JSON key → Share calendar with `client_email` ("Make changes to events") |
| **Email Receipts** | Gmail SMTP (**Free — ~500/day**) | https://myaccount.google.com/apppasswords | Enable 2FA on Gmail → Generate 16-char App Password → Set `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| **WhatsApp Receipts** | Meta WhatsApp Cloud API (**Sandbox Test Number — $0**) | https://developers.facebook.com/ | Create Meta App → Add WhatsApp → Copy `WHATSAPP_PHONE_NUMBER_ID` & `WHATSAPP_ACCESS_TOKEN` → Whitelist test phone in `WHATSAPP_TEST_RECIPIENT` |

### What This Free Testing Setup IS Good For (and Its Limits)
- **Suitable for:** FYP / supervisor evaluation, internal QA, client demos, UAT acceptance calls (~50–100 test calls/month, 1–2 concurrent calls, browser WebRTC calling).
- **NOT suitable for live commercial customers because:**
  - Render Free sleeps after 15 minutes of inactivity (causes 30–50s cold start on the first API call).
  - Gemini Free Tier has strict RPM/RPD rate limits and may log/sample dev traffic depending on Google terms.
  - Meta WhatsApp Test Number only delivers to manually whitelisted test phone numbers.
  - Browser WebRTC requires opening a web link — real callers need a regular phone number (SIP Trunk).

---

## 2. Complete 6-Phase Lifecycle (Development → Production)

### Phase 1: Development / Local Testing
- Separate local/dev DB and test credentials (never touch live customer data).
- Run verified project commands:
  ```bash
  pnpm install
  pnpm typecheck
  pnpm test
  pnpm frontend:build
  pnpm org:validate
  pnpm org:preview
  ```
- Verify all organization config validation rules (missing name, invalid services, bad duration, disabled workflows) and core booking/reschedule/cancel/double-booking tests.

### Phase 2: Cloud Staging / Sandbox
- Keep **Staging** strictly separate from **Production** (separate Neon branch/DB, separate LiveKit project, separate Google test calendar, `WHATSAPP_TEST_RECIPIENT` set).
- Verify `/health/live`, `/health/ready`, end-to-end WebRTC call, Google Calendar sync, Email, WhatsApp, and Dashboard logs.

### Phase 3: Client Onboarding & UAT (User Acceptance Testing)
- Collect the 12-section client profile (`config/organization.json`) and present `pnpm org:preview` for written client approval (name, services, prices, hours, greeting, language, policies, human transfer number, privacy notice).
- Have the client's staff execute real UAT calls: normal inquiry, booking, reschedule, cancel, out-of-hours, unavailable service, emergency/escalation, caller interruption, noisy room, and Calendar/Email failure fallback.
- **Exit Gate:** Written client UAT sign-off before go-live.

### Phase 4: Production Readiness (Mandatory Before Go-Live)
- **Infrastructure:** Always-on paid backend compute, persistent LiveKit agent (`numIdleProcesses >= 1`), paid Neon DB with scheduled backups **plus a verified restore test**, custom domain HTTPS, connection pooling, and rate limits.
- **Security:** Rotate all dev/exposed API keys, remove pre-filled demo login credentials in `apps/frontend/src/App.tsx`, update seeded admin password, restrict CORS allowlist, keep `.env` out of Git, and enforce PII redaction in logs.
- **Privacy & Legal (Healthcare / Sensitive Orgs):** Inform callers they are speaking to an AI receptionist; if recording is ever enabled, announce clear consent and define retention/deletion rules; keep medical diagnosis strictly prohibited; never use client transcripts for model training without written consent.
- **Monitoring & Alerting:** Track Call Answer Rate, Call Failure Rate, TTFA/Tool Latency, Booking Success, Calendar Sync Failures, API Uptime, LiveKit Worker Status, SIP Audio Quality, and Daily AI/Telephony Spend (e.g., UptimeRobot / Better Stack + LiveKit Cloud Observability).
- **Load & Rollback Testing:** Test peak concurrent calls, simultaneous booking on the same slot (atomic lock), worker restart recovery, and rollback to previous deployment version.

### Phase 5: Controlled Production Go-Live
1. Freeze approved `config/organization.json` and tag Git commit.
2. Back up production DB → run `pnpm db:migrate` → `node scripts/org-cli.ts apply config/organization.json --confirm`.
3. Upload production secrets to LiveKit Cloud (`lk agent update-secrets`) and Render; clear `WHATSAPP_TEST_RECIPIENT`.
4. Deploy LiveKit agent (`lk agent deploy`), Render API, and Vercel frontend.
5. Connect SIP Inbound Trunk + Dispatch Rule + organization phone number.
6. Place external mobile test call → verify two-way audio, booking, Calendar, Email, WhatsApp, and Dashboard → switch to live traffic under close first-week monitoring.

### Phase 6: Ongoing Operations & Maintenance
- Weekly review of call logs, failed tool/sync alerts, monthly usage/cost report, backup verification, and controlled change requests whenever the organization updates services or policies.

---

## 3. Business Scale Criteria & Verified Production Costs

> **Reference Rates (Verified Nov 2026 · USD/PKR ≈ 276.50 via SBP):**
> - **LiveKit Cloud:** Build `$0/mo` (dev) · Ship from **`$50/mo`** · Scale from **`$500/mo`**
> - **Gemini 3.1 Flash Live Preview:** `$0.005/min` input audio + `$0.018/min` output audio = **`~$0.023/min`** combined (pay-as-you-go; excludes taxes/tool tokens)
> - **Render Compute:** Starter (512MB) **`$7/mo`** · Standard (1 CPU / 2GB) **`$25/mo`** per service
> - **Neon PostgreSQL:** Usage-based paid compute/storage (budget `~$15–$25/mo` for small, `$40–$80/mo` for large — verify in Neon billing console)
> - **Vercel:** Hobby `$0/mo` (non-commercial limits) · Pro **`$20/mo`** (commercial production)
> - **Resend Email:** Free up to `3,000 emails/mo` (`$0`) · Pro **`$20/mo`** (`50,000 emails`)
> - **WhatsApp Business Cloud API (Pakistan Rate Card):** Utility (booking confirmations/reminders) **`$0.015/delivered msg`** · Marketing `$0.0473/msg` · Service replies free within 1,000/mo quota
> - **SIP Telephony:** Telnyx starting inbound `$0.0032/min` + `$1/mo` DID (US/EU); Twilio Pakistan outbound `$0.155–$0.180/min` (Pakistan local inbound DID / PTA SIP trunk requires a written carrier quote from PTCL / Nayatel / Wateen / SIP provider)

### Clear Tier Comparison (What "Small", "Growing", and "Large" Mean)

| Criteria | Tier 0: Free Testing / Demo | Tier 1: Small Production Business | Tier 2: Growing / Medium Business | Tier 3: Large / Enterprise |
| :--- | :--- | :--- | :--- | :--- |
| **Typical Organization** | FYP, Supervisor Demo, UAT | Single-doctor clinic, salon, small workshop | Multi-doctor medical center, busy auto center | Hospital chain, university, high-volume helpline |
| **Call Volume** | 50 – 100 calls / mo | **300 – 500 calls / mo** (~10–20/day) | **1,500 – 2,000 calls / mo** (~50–70/day) | **6,000+ calls / mo** (200+/day) |
| **Voice Minutes (3 min avg)** | 150 – 300 min | ~1,500 min / mo | ~6,000 min / mo | 18,000+ min / mo |
| **Peak Concurrent Calls** | 1 – 2 | 1 – 2 | 3 – 5 | 10 – 50+ |
| **LiveKit Plan** | Build ($0) | Ship ($50/mo) | Ship ($50/mo + overage) | Scale ($500+/mo) |
| **Gemini Audio (~$0.023/min)** | $0 (Free dev tier) | ~$34.50 / mo | ~$138.00 / mo | ~$414+ / mo |
| **Backend + DB + Frontend** | Render/Neon/Vercel Free ($0) | Render $7 + Neon ~$19 + Vercel $0–$20 | Render $25 + Neon ~$30 + Vercel $20 | Render $50+ + Neon $80+ + Vercel $20+ |
| **WhatsApp Utility ($0.015/msg)** | $0 (Test recipient) | ~$7.50 (500 msgs) | ~$30.00 (2,000 msgs) | ~$90+ (6,000+ msgs) |
| **SIP / Telephony** | $0 (Browser WebRTC) | ~$5 – $25/mo *(carrier-dependent)* | ~$20 – $90/mo *(carrier-dependent)* | Custom PTA SIP Trunk / multi-channel quote |
| **Estimated Monthly Total** | **$0 / mo** | **~$125 – $165 / mo** *(~PKR 35k – 46k)* | **~$310 – $400 / mo** *(~PKR 86k – 110k)* | **$1,150+ / mo** *(~PKR 320k+)* |

*Note: Estimates exclude domain renewal, local bank/FX taxes, Pakistan carrier call-forwarding fees, and support/maintenance labour.*

---

## 4. Connecting an Organization's Own Business Phone Number (SIP Trunking)

```text
Caller (Mobile / Landline)
  └──► Organization Business Number (Direct SIP or Carrier Call Forwarding)
         └──► SIP Carrier (Twilio / Telnyx / PTCL / Nayatel / Wateen)
                └──► LiveKit Cloud SIP Inbound Trunk
                       └──► LiveKit SIP Dispatch Rule (agentName: "ai-receptionist")
                              └──► VoxDesk AI Voice Agent (Gemini Live + Tools)
```

### Option A: New Dedicated SIP Number (Twilio / Telnyx)
1. Purchase a voice-capable DID number in Twilio or Telnyx.
2. Copy your LiveKit Cloud **SIP URI** (`sip:<project-id>.sip.livekit.cloud`).
3. Create the LiveKit Inbound Trunk & Dispatch Rule:
   ```bash
   lk sip inbound create --name "org-inbound-trunk" \
     --numbers "+1234567890" \
     --auth-user "sip_username" \
     --auth-pass "strong_sip_password"

   lk sip dispatch create \
     --name "org-receptionist-dispatch" \
     --trunk-ids "<ST_trunk_id>" \
     --room-prefix "call-" \
     --agent-name "ai-receptionist"
   ```
4. Point the Twilio/Telnyx Origination SIP URI to `sip:<project-id>.sip.livekit.cloud;transport=tls`.
5. Place an external mobile test call and verify two-way audio + room creation + booking.

### Option B: Organization's Existing Business Number (Pakistan / International)
- **Method 1 — Carrier Call Forwarding (Fastest, Zero Downtime):**
  - Keep the clinic's existing Jazz / Zong / Ufone / PTCL number and forward calls (24/7 unconditional, or busy/no-answer after 3 rings) to the SIP DID connected to LiveKit.
  - *Pakistan Caution:* Do **not** assume universal GSM forwarding codes (`*21*`, `*61*`, `*67*`) work identically on every carrier/landline. Always confirm exact activation/deactivation codes and per-minute forwarding charges directly with the organization's carrier in writing.
- **Method 2 — Direct Local SIP Trunk or Porting:**
  - **International (US/UK/EU/UAE):** Port the existing business number directly into Twilio/Telnyx.
  - **Pakistan (Enterprise):** Obtain a **PTA-licensed SIP Trunk** (PTCL / Nayatel / Wateen) and connect it to LiveKit Cloud's Inbound SIP URI (or via a lightweight Asterisk/FreeSWITCH SBC).

---

## 5. Client / End-User Guide (Non-Technical Handover)

Share these 7 steps with the organization owner/manager:
1. **Share Organization Details:** Fill in business profile, hours, services, prices, FAQs, and escalation rules.
2. **Review & Approve Preview:** Verify the AI greeting, tone, services, and booking policies before testing.
3. **Authorize Accounts:** Provide secure access/keys for Google Calendar, Email sender, WhatsApp Business, and Phone routing.
4. **Run UAT Test Calls:** Test booking, rescheduling, cancellation, and common customer questions with staff.
5. **Sign Off for Go-Live:** Approve final config and launch date.
6. **Daily Dashboard Use:** Log in to view live calls, linked bookings, Call Detail Drawer, CSV export, Reschedule/Cancel, and Knowledge Base updates.
7. **Support & Change Requests:** Contact AiBitSol support for new integrations, carrier changes, or monthly usage reports.

---

## 6. Final 30-Point Go-Live Sign-Off Checklist

- **Dev & Staging (5):** Typecheck/tests pass · Frontend build passes · `org:validate` passes · Staging DB/secrets isolated · End-to-end test call passes.
- **Client Approval (5):** Profile & prices approved · Greeting & languages approved · Booking/cancel rules approved · UAT scenarios passed · Written sign-off recorded.
- **Production Infra (5):** Paid always-on API & DB · Migrations run after backup · Backup restore tested · All secrets rotated & stored securely · Custom HTTPS domain & DNS verified.
- **Telephony & Integrations (5):** Production SIP trunk & dispatch rule tested · Two-way audio verified · Carrier fallback routing tested · Production Google Calendar & Email verified · Meta WhatsApp Business & Utility templates approved (`WHATSAPP_TEST_RECIPIENT` cleared).
- **Security & Ops (5):** Default demo login removed & RBAC verified · Privacy/AI notice approved · Monitoring & cost alerts active · Concurrent load & worker restart tested · Rollback & incident contact documented.
- **Launch & Handover (5):** Production smoke test passed · Client go-live approval recorded · Dashboard access delivered · Client guide & support contact delivered · First-week monitoring owner assigned.
