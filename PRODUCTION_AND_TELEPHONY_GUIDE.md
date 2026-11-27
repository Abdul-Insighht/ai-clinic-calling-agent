# Testing vs. Production Deployment, Telephony (SIP) & Cost Guide

This guide provides a complete, supervisor- and client-ready roadmap covering:
1. **Testing / Sandbox Mode** (what is currently running for CareFirst Medical Clinic)
2. **Production Mode Criteria & Upgrade Steps**
3. **Connecting an Organization's Own Business Phone Number (SIP Trunking)**
4. **Estimated Production Cost Breakdown** (WhatsApp, Phone/SIP, AI Voice, Hosting)

---

## 1. Testing / Sandbox Mode (Current CareFirst Setup)

Use this workflow for **development, FYP/supervisor demos, and pre-launch client acceptance testing**.

| Component | Current Testing Setup | Notes |
| :--- | :--- | :--- |
| **Voice Calling** | Browser WebRTC (`https://voxdesk.abdulrehmanai.tech/` & LiveKit Agent Console) | No phone carrier fees during testing |
| **Voice AI Agent** | LiveKit Cloud (`CA_8zh49ZVULXCL`) + Gemini 3.1 Flash Live + Krisp BVC | Live production-grade voice pipeline |
| **Backend API** | Render Free Web Service (`https://ai-clinic-calling-agent.onrender.com`) | May cold-start after 15 min inactivity |
| **Database** | Neon PostgreSQL Free Tier | Serverless Postgres, scales to zero |
| **Frontend Dashboard** | Vercel Hobby Tier | Auto-deploys from `main` |
| **Email** | Gmail SMTP (16-char App Password) | Up to ~500 emails/day |
| **WhatsApp** | Meta Cloud API Test Number / `WHATSAPP_TEST_RECIPIENT` | Sends to whitelisted test numbers |
| **Google Calendar** | Service Account shared with test calendar | Full 2-way busy check + booking sync |

### Step-by-Step Testing Verification Checklist
1. Fill `config/organization.json` and run:
   ```bash
   pnpm org:validate
   pnpm org:preview
   node scripts/org-cli.ts apply config/organization.json --confirm
   ```
2. Run automated checks:
   ```bash
   pnpm typecheck
   pnpm test
   pnpm frontend:build
   ```
3. Run a **live end-to-end test call** on the dashboard:
   - Verify greeting uses the organization's name and assistant name.
   - Ask about hours, location, and services (verify zero hallucinated prices/services).
   - Book a slot → verify Booking ID (`BKxxx`), Google Calendar event, Email receipt, WhatsApp receipt, and Dashboard Appointments + Call Logs + Linked Booking Drawer.
   - Test **Reschedule** and **Cancel** from both voice and Dashboard.

---

## 2. Production Mode — Criteria & Step-by-Step Upgrade

Before handing the system to a live organization handling real customers/patients, complete every step below:

### Step 1: Always-On Infrastructure (No Cold Starts)
- **Backend API (Render):** Upgrade from Free → **Starter ($7/mo)** or **Standard ($25/mo)** so `/api/v1/*` never sleeps and responds in <200ms.
- **Database (Neon):** Enable **Neon Launch ($19/mo+)** with automated daily backups, point-in-time recovery, and connection pooling.
- **LiveKit Cloud:** Upgrade to **Ship ($50/mo)** or **Scale** with `numIdleProcesses: 1` (already configured in `src/main.ts`) so calls answer with zero container cold-start.

### Step 2: Production WhatsApp Business API (Meta)
1. Verify your business in **Meta Business Suite** (requires business registration document + domain verification).
2. Register the organization's **dedicated WhatsApp Business phone number** (must not be active on personal WhatsApp app).
3. Add a payment method in Meta Business Manager (for paid Utility template conversations).
4. Create and get Meta approval for **Utility Templates** (`booking_confirmed`, `booking_rescheduled`, `booking_cancelled`).
5. Generate a permanent **System User Access Token** (never expires).
6. In `.env` & LiveKit/Render secrets:
   - Set `WHATSAPP_PHONE_NUMBER_ID` & `WHATSAPP_ACCESS_TOKEN`
   - **Clear `WHATSAPP_TEST_RECIPIENT=`** (leave empty so messages go to real callers!)

### Step 3: Production Email (Custom Domain Deliverability)
- Move from personal Gmail SMTP to **Resend** (`RESEND_API_KEY`) or **Google Workspace SMTP** with **SPF, DKIM, and DMARC** DNS records on the organization's domain (e.g., `appointments@carefirstclinic.com`) so booking emails never land in spam.

### Step 4: Security & Access Hardening
- Rotate all API keys (`GOOGLE_API_KEY`, `LIVEKIT_API_SECRET`, `SMTP_PASS`, `WHATSAPP_ACCESS_TOKEN`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`).
- Remove pre-filled demo login credentials in `apps/frontend/src/App.tsx` and update the admin password in PostgreSQL.
- Set `NODE_ENV=production` and `LOG_LEVEL=info` across LiveKit Cloud and Render.
- Set up uptime monitoring (e.g., BetterStack / UptimeRobot) on `GET /health/ready`.

---

## 3. Connecting an Organization's Business Phone Number (SIP Trunking)

To let real callers dial a **regular phone number** (landline or mobile) and speak directly to the AI Calling Assistant, connect a **SIP Trunk** to **LiveKit Cloud**.

### Architecture Flow
```text
Caller (Mobile/Landline)
  └──► Organization Phone Number (or Call Forwarding)
         └──► SIP Provider (Twilio / Telnyx / Plivo / Local SIP Carrier)
                └──► LiveKit Cloud SIP Inbound Trunk
                       └──► LiveKit SIP Dispatch Rule (agentName: "ai-receptionist")
                              └──► VoxDesk AI Voice Agent (Gemini Live + Tools)
```

### Option A: Connect a New Dedicated Phone Number (Twilio / Telnyx — Fastest)
1. **Buy a Voice-Capable Number** in **Twilio** or **Telnyx** (supports SIP trunking; ~$1–$2/month).
2. **Get your LiveKit SIP URI** from LiveKit Cloud Dashboard → **Settings → Project → SIP URI** (looks like `sip:<project-id>.sip.livekit.cloud`).
3. **Create a LiveKit Inbound SIP Trunk** using the LiveKit CLI:
   ```bash
   lk sip inbound create --name "org-inbound-trunk" \
     --numbers "+1234567890" \
     --auth-user "sip_username" \
     --auth-pass "strong_sip_password"
   ```
4. **Create a LiveKit SIP Dispatch Rule** to automatically route every incoming call into a unique room and dispatch `ai-receptionist`:
   ```bash
   lk sip dispatch create \
     --name "org-receptionist-dispatch" \
     --trunk-ids "<ST_trunk_id_from_step_3>" \
     --room-prefix "call-" \
     --agent-name "ai-receptionist"
   ```
5. **Configure Twilio / Telnyx Origination URI:**
   - In Twilio Elastic SIP Trunking (or Telnyx SIP Connection), set the **Origination SIP URI** to `sip:<project-id>.sip.livekit.cloud;transport=tls` and attach your purchased phone number.
6. **Test:** Dial the number from any mobile phone — the AI receptionist answers within ~1–2 seconds!

### Option B: Connect an Organization's EXISTING Business Number (e.g., Pakistan Jazz/Zong/PTCL or Existing Landline)
Organizations usually want to keep their **existing published phone number**. Two proven ways:

1. **Method 1 — Call Forwarding (Zero Downtime, Works Everywhere Including Pakistan):**
   - Provision a SIP DID number (via Twilio, Telnyx, or Zadarma) and link it to LiveKit SIP (Option A above).
   - Enable **Call Forwarding** on the clinic's existing business mobile/PTCL landline to that SIP DID:
     - **Unconditional (24/7 AI):** Dial `*21*<SIP_DID>#` (or configure in PBX/carrier portal).
     - **No-Answer / Busy Fallback (Hybrid Human + AI):** Dial `*61*<SIP_DID>#` and `*67*<SIP_DID>#` — if human reception doesn't pick up within 3 rings, the AI receptionist answers automatically!
2. **Method 2 — Direct Local SIP Trunk or Number Porting:**
   - **US / UK / EU / UAE:** Port the existing business number directly into **Twilio** or **Telnyx** (takes 1–2 weeks) so it rings LiveKit SIP directly with zero forwarding leg.
   - **Pakistan (Enterprise / Multi-Channel):** Request a **PTA-licensed SIP Trunk** from **PTCL**, **Nayatel**, or **Wateen** and point its SIP termination/origination to LiveKit Cloud's SIP URI (or a local SBC / Asterisk / FreeSWITCH bridge connected to LiveKit SIP).

---

## 4. Production Cost Breakdown (Estimated)

> *Note: Provider pricing changes periodically; figures below reflect typical 2025–2026 published pay-as-you-go rates in USD (approx. PKR at 1 USD ≈ 280 PKR).*

### Per-Component Pricing

| Service | Testing / Sandbox | Production Unit / Monthly Rate |
| :--- | :--- | :--- |
| **LiveKit Cloud** (WebRTC + Agent Hosting + SIP) | Free Build tier (limited monthly minutes) | **Ship: $50/mo** (includes generous quota) + ~$0.01/min overage |
| **AI Voice Model (Gemini Live Native Audio)** | Free / Pay-as-you-go dev quota | **~$0.02 – $0.05 / minute** of live audio *(Alternative: Deepgram + GPT-4.1-mini + Cartesia ≈ ~$0.04 – $0.07 / min)* |
| **Telephony / SIP Trunk (Twilio / Telnyx)** | $0 (WebRTC only) | Phone number: **$1–$2/mo** + Inbound voice: **$0.004–$0.014 / min** (Telnyx is cheaper; Twilio ~$0.0085–$0.014/min) |
| **WhatsApp Business Cloud API (Meta)** | $0 (Test recipient) | **Utility template** (booking confirmation): **~$0.005 – $0.015 / message** (Pakistan Utility ≈ ~$0.0054/msg; 24h customer-initiated replies are **FREE**) |
| **Email Confirmations (Resend / Gmail)** | $0 (Gmail SMTP / Resend Free) | **Resend Free:** up to 3,000 emails/mo ($0) · Pro: **$20/mo** (50k emails) |
| **PostgreSQL Database (Neon)** | $0 (Free tier) | **Launch: ~$19/mo** (scales with compute/storage) |
| **Backend API Hosting (Render)** | $0 (Free tier) | **Starter: $7/mo** (always-on, no cold start) |
| **Frontend Dashboard (Vercel)** | $0 (Hobby) | **$0 (Hobby)** or **$20/mo (Pro)** for commercial team seats |
| **Google Calendar API** | $0 | **$0** (free within generous Google Cloud quotas) |

### Realistic Total Monthly Budget Estimates (3-Minute Average Call)

| Deployment Scale | Monthly Calls | Voice Minutes | Estimated Monthly Total (USD) | Approx. PKR / Month |
| :--- | :---: | :---: | :---: | :---: |
| **Testing / FYP Demo** (WebRTC, Free tiers) | ~50 – 100 | 150 – 300 min | **$0 – $5 / mo** | ~PKR 0 – 1,500 |
| **Small Clinic / Business** (Live SIP + WhatsApp + Always-on API) | 500 calls | 1,500 min | **$95 – $145 / mo** *(~$0.19–$0.29 / call)* | ~PKR 27,000 – 40,000 |
| **Busy Clinic / Growing Business** | 2,000 calls | 6,000 min | **$220 – $360 / mo** *(~$0.11–$0.18 / call)* | ~PKR 62,000 – 100,000 |

> **ROI Context:** Even at 2,000 calls/month (~$250/mo), the AI receptionist handles 24/7 inbound calling, instant booking, Calendar sync, Email, and WhatsApp at a fraction of the cost of a single full-time reception shift — with zero missed calls and zero double-bookings.
