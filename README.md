# EARIST E-GatePass

Secure visitor access, digital pass issuance, and gate-management platform for the Eulogio "Amang" Rodriguez Institute of Science and Technology (EARIST).

E-GatePass provides an end-to-end access management pipeline designed to support campus security and visitor accountability. Online visitors register through a public portal protected by Cloudflare Turnstile, while walk-in visitors use campus kiosks equipped with client-side OCR for government ID data extraction. Scanner hardware at campus gates verifies cryptographically signed QR passes, queuing entrants for Guard review before campus entry is granted.

---

## 1. System Context Architecture

```mermaid
flowchart LR
    Visitor[Visitor]
    Kiosk[Kiosk Device]
    Entry[Entry Scanner]
    Guard[Guard Console]
    Exit[Exit Scanner]
    Admin[Admin]
    SuperAdmin[Super Admin]

    UI[React + TypeScript + Vite<br/>Frontend Application]

    API[Vercel Serverless Functions<br/>Node.js 24 API]

    Auth[Supabase Auth<br/>Identity & Sessions]
    DB[(Supabase PostgreSQL<br/>Relational Data & RLS)]
    Storage[(Private Supabase Storage<br/>visitor-photos & visitor-ids)]

    Resend[Resend<br/>Transactional Email]
    Turnstile[Cloudflare Turnstile<br/>Bot Protection]
    OCR[Tesseract.js<br/>Browser Local OCR]

    Visitor --> UI
    Kiosk --> UI
    Entry --> UI
    Guard --> UI
    Exit --> UI
    Admin --> UI
    SuperAdmin --> UI

    UI --> Auth
    UI --> API

    Visitor -.-> Turnstile
    Kiosk -.-> OCR

    API --> Auth
    API --> DB
    API --> Storage
    API --> Resend
```

---

## 2. Technology Stack

| Layer | Technology | Responsibility |
|---|---|---|
| **Frontend** | React 19, TypeScript, Vite 8 | Single Page Application (SPA), responsive mobile/tablet interfaces |
| **Hosting & CDN** | Vercel | Global edge CDN delivery and frontend asset hosting |
| **Serverless API** | Vercel Functions (Node.js 24) | 27 canonical API endpoints across 6 route groups, verification, and cryptography |
| **Database** | Supabase PostgreSQL | Authoritative relational data, Row Level Security (RLS), and RPCs |
| **Authentication** | Supabase Auth | Anonymous visitor sessions, staff identities, and managed device credentials |
| **Object Storage** | Supabase Storage (Private) | Private storage for visitor photos (`visitor-photos`) and IDs (`visitor-ids`) |
| **Transactional Email** | Resend | Dispatch of system notifications, auth invites, and QR pass delivery |
| **Email Templates** | React Email | Type-safe, branded HTML templates built with TypeScript and TSX |
| **Bot Protection** | Cloudflare Turnstile | Non-intrusive CAPTCHA for public visitor registration via Supabase Auth |
| **Local OCR** | Tesseract.js | Client-side optical character recognition for kiosk ID capture |
| **QR Security** | HMAC-SHA256 & SHA-256 | Cryptographic pass bearer tokens with database-stored SHA-256 digest lookup |
| **Timezone Authority** | `Asia/Manila` (UTC+8) | Institutional schedule enforcement and daily audit boundaries |

---

## 3. Core Capabilities & Workflows

### 3.1 Visitor Registration Portal Flow

Visitors register for campus entry online prior to arrival. Registration enforces camera-only facial and ID capture.

```mermaid
flowchart TD
    Start[Open Visitor Portal]
    Bot[Cloudflare Turnstile Challenge]
    Session[Supabase Auth Anonymous Session]
    Details[Enter Visitor Information]
    Mode{Peak Mode Active?}
    ID[Capture Valid ID<br/>Camera-Only]
    SkipID[ID Capture Bypassed]
    Face[Capture Face Photo<br/>Camera-Only]
    Intent[Request Upload Intents<br/>api.create_upload_intent RPC]
    Store[Upload Directly to Private Storage<br/>visitor-photos & visitor-ids]
    Issue[Issue Pass Request<br/>POST /api/passes/issue]
    Validate[Server Validates Intent,<br/>Magic Bytes, Size & SHA-256]
    Commit[Commit Pass & Token Digest<br/>api.issue_pass RPC]
    QR[Display Issued QR Pass]

    Start --> Bot
    Bot -->|Verified| Session
    Bot -->|Failed| Reject[Reject Session]
    Session --> Details
    Details --> Mode
    Mode -->|Standard Mode| ID
    Mode -->|Peak Mode| SkipID
    ID --> Face
    SkipID --> Face
    Face --> Intent
    Intent --> Store
    Store --> Issue
    Issue --> Validate
    Validate -->|Valid| Commit
    Validate -->|Invalid| Correction[Prompt Correction]
    Correction --> Face
    Commit --> QR
```

> **Scheduling Note**: Visitors may schedule visits within the institutionally configured scheduling window. The current deployment default uses 30 days ahead.

---

### 3.2 Walk-in Kiosk ID OCR Flow

Kiosk devices located at campus entrances allow walk-in visitors to scan their government ID card for fast, assisted data entry.

```mermaid
flowchart TD
    Start[Visitor Approaches Kiosk]
    Auth[Authenticated Kiosk Device Session]
    CaptureID[Rear Camera Captures Valid ID]
    OCR[Local Tesseract.js Runs in Browser]
    Extract[Extract Name, ID Type, and ID Number]
    Review[Visitor Reviews & Corrects Fields]
    Selfie[Front Camera Captures Visitor Selfie]
    Intent[Request Upload Intents<br/>api.create_upload_intent]
    Store[Upload to Private Storage Buckets]
    Issue[Submit Pass Issuance<br/>POST /api/passes/issue]
    QR[Generate Cryptographic QR Pass]
    Print[Auto-Invoke Thermal Print Receipt]
    Email[Optional Email QR Delivery]

    Start --> Auth
    Auth --> CaptureID
    CaptureID --> OCR
    OCR --> Extract
    Extract --> Review
    Review --> Selfie
    Selfie --> Intent
    Intent --> Store
    Store --> Issue
    Issue --> QR
    QR --> Print
    QR --> Email
```

*Notice: OCR execution occurs entirely within the client browser memory. No unverified ID image is transmitted to third-party recognition APIs.*

---

### 3.3 Pass Lifecycle State Machine

Passes transition through strictly enforced relational states in the PostgreSQL database:

```mermaid
stateDiagram-v2
    [*] --> issued: Pass Issued (POST /api/passes/issue)

    issued --> pending: Entry Scanner Scan (POST /api/scan-pass)
    issued --> expired: Validity Window Ends

    pending --> inside: Guard Approves (POST /api/decide-visit)
    pending --> rejected: Guard Rejects (POST /api/decide-visit)

    inside --> exited: Exit Scanner Scan (POST /api/scan-pass)

    rejected --> [*]
    exited --> [*]
    expired --> [*]
```

| Database Status | UI Display Label | Description |
|---|---|---|
| `issued` | Pass Issued | Pass created; valid for presentation at an entry scanner |
| `pending` | Pending Guard Review | Entry scanned; queued on the Guard Console for verification |
| `inside` | Inside Campus | Guard verified identity and approved entry; visitor is on campus |
| `rejected` | Entry Rejected | Guard denied access (e.g., dress code violation, invalid ID) |
| `exited` | Exited Campus | Exit scanned; visit concluded |
| `expired` | Pass Expired | Scheduling validity window elapsed without entry |

---

### 3.4 Gate Entry & Guard Review Sequence

```mermaid
sequenceDiagram
    participant V as Visitor
    participant E as Entry Scanner
    participant API as Vercel API
    participant DB as Supabase DB
    participant G as Guard Console
    participant X as Exit Scanner

    V->>E: Present QR Code
    E->>API: POST /api/scan-pass (mode: entry)
    API->>DB: RPC api.scan_pass (verify token_digest & gate)
    DB-->>API: Valid issued pass
    API-->>E: Scan Accepted (Status: Pending Guard Review)

    G->>DB: RPC api.guard_dashboard (fetch pending queue)
    DB-->>G: Visitor details & photo evidence references
    G->>API: GET /api/evidence?id=<uuid>
    API-->>G: Stream photo evidence securely
    G->>API: POST /api/decide-visit (decision: approved / rejected)
    API->>DB: RPC api.decide_visit (atomic transition to inside/rejected)
    DB-->>G: Decision confirmed

    Note over V,G: Visitor conducts on-campus business

    V->>X: Present QR Code at gate exit
    X->>API: POST /api/scan-pass (mode: exit)
    API->>DB: RPC api.scan_pass (verify status == inside)
    API->>DB: Atomic transition status -> exited
    DB-->>X: Exit Verified (Gate opens)
```

---

### 3.5 Supabase Auth Transactional Email Delivery

System emails (invitations, password resets, email confirmations) are routed through a secure webhook into Resend using compiled React Email templates.

```mermaid
sequenceDiagram
    participant SA as Supabase Auth
    participant Hook as /api/auth/send-email-hook
    participant Bundle as React Email Runtime Bundle<br/>(server/templates/index.js)
    participant Resend as Resend API
    participant User as Recipient Mailbox

    SA->>Hook: POST /api/auth/send-email-hook<br/>(Signed Standard Webhook)
    Hook->>Hook: Verify Webhook Signature (SEND_EMAIL_HOOK_SECRET)
    Hook->>Bundle: Render Branded Action Template (e.g., StaffInviteEmail)
    Bundle-->>Hook: Compiled HTML Output
    Hook->>Resend: POST /emails (Resend REST API)
    Resend-->>Hook: Provider Message ID
    Resend->>User: Deliver Branded Email (notifications@egatepass.tech)
    Hook-->>SA: HTTP 200 OK
```

#### Production Build Supply Chain Architecture

To ensure Vercel's Node File Tracer (`@vercel/nft`) packages all React Email templates without module resolution failures:

```mermaid
flowchart LR
    Source[Authoritative Source<br/>server/templates/*.tsx + index.ts]
    Script[Build Script<br/>scripts/bundle-email-templates.mjs]
    Bundle[Generated Runtime Bundle<br/>server/templates/index.js<br/>Ignored by Git]
    Trace[Vercel Node File Trace<br/>@vercel/nft]
    Func[Production Auth Hook Function<br/>api/auth/send-email-hook]

    Source --> Script
    Script --> Bundle
    Bundle --> Trace
    Trace --> Func
```

---


---

### 3.6 Resend Delivery Observability Webhook

Email delivery events are asynchronously reported by Resend back to the platform via a signed standard webhook:

```mermaid
sequenceDiagram
    participant Resend as Resend Delivery Network
    participant API as POST /api/webhooks/resend<br/>(/api/auth/resend-webhook)
    participant DB as Supabase PostgreSQL<br/>(public.resend_webhook_events)
    participant Audit as Audit Trail<br/>(public.audit_events)

    Resend->>API: POST /api/webhooks/resend (signed delivery event)
    API->>API: Verify Signature (RESEND_WEBHOOK_SECRET)
    API->>DB: RPC api.record_resend_delivery_event (atomic transaction)
    alt First delivery attempt (claim + audit succeed)
        DB-->>API: { ok: true, status: 'processed', duplicate: false }
        API-->>Resend: HTTP 200 OK { status: 'processed' }
    else Duplicate or replayed webhook
        DB-->>API: { ok: true, status: 'already_processed', duplicate: true }
        API-->>Resend: HTTP 200 OK { status: 'already_processed', duplicate: true }
    else Persistent or transient database failure
        DB-->>API: Error (transaction rolls back, claim NOT persisted)
        API-->>Resend: HTTP 500 (Resend retries delivery later)
    end
```

> **CRITICAL ARCHITECTURAL NOTICE**: Neither `/api/auth/send-email-hook` nor `/api/webhooks/resend` functions as an inbound mailbox or email receiver. `notifications@egatepass.tech` does not process inbound user correspondence.

### 3.7 QR Pass Email Verification Flow

Visitors can request a copy of their issued pass via email through a secure two-step verification challenge handled by a single discriminated endpoint:

```mermaid
sequenceDiagram
    participant V as Visitor
    participant UI as Portal UI
    participant API as POST /api/passes/email
    participant DB as Supabase DB
    participant Resend as Resend API

    V->>UI: Enter Email & Click Send Code
    UI->>API: POST /api/passes/email<br/>{ action: 'request_code', passId, qrToken, recipientEmail }
    API->>DB: RPC api.request_qr_email_code (rate limits, generate 6-digit code)
    DB-->>API: verificationId & SHA-256 hashed code
    API->>Resend: Send Verification Code Email
    Resend-->>V: Deliver 6-digit code

    V->>UI: Enter 6-digit code
    UI->>API: POST /api/passes/email<br/>{ action: 'verify_and_send', verificationId, code, qrToken }
    API->>DB: RPC api.claim_qr_email_dispatch (verify code, lock attempts)
    DB-->>API: Authorized
    API->>Resend: Send Pass Email with Embedded QR PNG
    API->>DB: RPC api.finalize_qr_email_dispatch (mark delivery outcome)
    API-->>UI: Success confirmation
```

---

## 4. Institutional Roles & Security

| Actor | Primary Responsibility | Authentication Mechanism |
|---|---|---|
| **Visitor** | Registers online, receives digital QR pass | Anonymous Supabase session with Turnstile verification |
| **Kiosk Device** | Self-service registration & local OCR on campus | Managed device credentials (`devices` table) |
| **Entry Scanner** | Scans QR code at campus gates | Authenticated scanner device bound to gate identifier |
| **Guard** | Reviews pending passes, inspects evidence, approves/rejects | Authenticated staff account (`role = 'guard'`) |
| **Exit Scanner** | Verifies exiting visitors at gate barriers | Authenticated scanner device bound to gate identifier |
| **Admin** | Manages staff accounts, hardware devices, and visitor logs | Authenticated staff account (`role = 'admin'`) |
| **Super Admin** | Configures system settings, retention windows, promotes admins | Authenticated staff account (`role = 'superadmin'`) |

---

## 5. Evidence Lifecycle & Privacy Protection

```mermaid
flowchart LR
    Capture[Camera Capture<br/>Selfie & ID]
    Intent[Upload Intent<br/>api.create_upload_intent]
    Private[Private Supabase Storage<br/>visitor-photos & visitor-ids]
    Validate[Server Validation<br/>POST /api/passes/issue]
    Record[visitor_evidence Row Created]
    HoldCheck{Active Incident Hold?}
    Retention[Retention Cleanup<br/>Purge Storage & Mark purged_at]
    Preserved[Preserved Until Hold Released]

    Capture --> Intent
    Intent --> Private
    Private --> Validate
    Validate --> Record
    Record --> HoldCheck
    HoldCheck -->|No Hold & Expired| Retention
    HoldCheck -->|Active Hold| Preserved
    Preserved -->|Hold Released| HoldCheck
```

Visitor evidence is stored exclusively in private storage buckets (`visitor-photos` and `visitor-ids`). Staff view images through `GET /api/evidence?id=<uuid>`, which streams the asset through Vercel with `Cache-Control: private, no-store` and sandbox CSP protections.

---

## 6. Repository Layout

```text
egatepass/
├── README.md                           # Public architecture & system overview
├── vercel.json                         # Vercel deployment, headers & rewrites
├── vite.config.ts                      # Vite build configuration
├── package.json                        # Dependencies, scripts, and prebuild hooks
│
├── api/                                # Vercel Serverless Function entrypoints
├── server/                             # Privileged backend handlers & routes
│   ├── routes/                         # Canonical route handlers (route-map.ts)
│   ├── templates/                      # React Email templates (.tsx) & index.ts
│   └── email.ts                        # Resend provider integration
│
├── src/                                # React frontend SPA
│   ├── components/                     # Reusable UI & modal components
│   ├── pages/                          # Page views (Portal, Kiosk, Guard, Admin)
│   ├── services/                       # Client services (visitorRegistration, guard)
│   └── lib/                            # Scheduling, OCR, and Supabase client
│
├── scripts/
│   └── bundle-email-templates.mjs      # Prebuild React Email bundling script
│
├── supabase/
│   ├── migrations/                     # Sequential PostgreSQL migrations
│   └── config.toml                     # Supabase CLI configuration
│
├── tests/                              # Unit, contract, and migration test suite
└── docs/                               # Detailed operational & security specifications
```

---

## 7. Local Development Quick-Start

### Prerequisites
- **Node.js**: Node.js 24.x recommended (LTS)
- **Package Manager**: npm

### Setup
```bash
# 1. Clone the repository
git clone https://github.com/jsphhbna/egatepass.git
cd egatepass

# 2. Install dependencies
npm install

# 3. Configure local environment
cp .env.example .env.local
# Update .env.local with your Supabase development credentials

# 4. Start local development server
npm run dev

# 5. Run automated test suite
npm test

# 6. Verify production build & email bundle
npm run build
npx vercel build --prod
```

---


### Environment & Secret Isolation Policy
- **Production Scope**: Contains all privileged provider credentials (`SUPABASE_SECRET_KEY`, `PASS_TOKEN_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `SEND_EMAIL_HOOK_SECRET`, `RESEND_WEBHOOK_SECRET`).
- **Generic Preview Scope**: Protected by Vercel SSO; receives ONLY public frontend configuration (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`). Production privileged secrets are never copied into generic preview deployments.

## 8. Documentation Index

| Document | Purpose |
|---|---|
| [docs/SECURITY.md](docs/SECURITY.md) | Canonical security contract, trust boundaries, actor resolution, and threat matrix |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | In-depth engineering specifications, relational entity models, and data flows |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel deployment, migration ordering, Send Email Hook setup, and rollback |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Daily administration, staff/device lifecycle, incident holds, and reconciliation |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Authoritative environment variable table and secret rotation rules |
| [docs/ENVIRONMENT_AND_CRON.md](docs/ENVIRONMENT_AND_CRON.md) | Maintenance endpoint specification and cron readiness |
| [docs/MANUAL_QA_RUNBOOK.md](docs/MANUAL_QA_RUNBOOK.md) | Step-by-step test matrix covering desktop, iOS Safari, Kiosk, and gate scanners |
| [docs/SUPER_ADMIN_BOOTSTRAP.md](docs/SUPER_ADMIN_BOOTSTRAP.md) | Initial privilege bootstrap via Supabase `private.bootstrap_super_admin` RPC |
| [docs/CLEAN_DATA_HANDOFF.md](docs/CLEAN_DATA_HANDOFF.md) | Ownership transfer checklist, developer decommissioning, and sign-off |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Diagnostic matrices for Auth Email Hook, device auth, RLS denials, and scanner errors |
| [docs/IMAGE_SECURITY.md](docs/IMAGE_SECURITY.md) | Camera capture constraints, upload intents, and private storage lifecycle |
| [docs/AUDIT_POLICY.md](docs/AUDIT_POLICY.md) | Audit trail schema, protected action exemptions, and strict sensitive data redaction |
