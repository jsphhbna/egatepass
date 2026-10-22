# EARIST E-GatePass

> Smart, secure, QR code-based visitor access and gate management platform for the Eulogio \"Amang\" Rodriguez Institute of Science and Technology (EARIST).

EARIST E-GatePass is an institutional visitor management and physical access security system. It replaces slow, unverified paper logbooks with cryptographically verified digital passes, server-validated photo and government ID evidence, browser-local OCR, least-privilege PostgreSQL Row Level Security (RLS), and real-time gate monitoring for campus safety.

---

## Core Capabilities

- **Self-Service Pre-Registration**: Visitors schedule visits online up to 14 days in advance with Cloudflare Turnstile bot deterrence, camera-only government ID capture, and Manila-aware timezone enforcement.
- **Assisted Kiosk Registration**: On-site walk-in kiosks capture visitor details with rear-camera valid ID scanning, 100% browser-local Tesseract OCR text extraction, and thermal ticket printing.
- **Two-Stage Physical Gate Control**: Entry scanners initiate visits and transition passes to pending; campus security guards review face/ID evidence side-by-side before granting campus entry (inside).
- **Cryptographic QR Pass Token Verification**: Server-generated HMAC-SHA256 bearer tokens with SHA-256 database digest storage guarantee that database read compromises cannot forge gate tokens.
- **Private Evidence Vault & Retention Purging**: All face photos and ID captures are uploaded directly to private, RLS-fenced Supabase Storage via short-lived, single-use signed upload intents, automatically purged after configurable retention windows unless placed under an active incident hold.
- **Production Serverless Architecture**: Hosted on Vercel Node.js 24 serverless functions with transactional emails powered by Resend and standard-webhook Supabase Auth hooks.

---

## System Context Diagram

`mermaid
flowchart LR
    Visitor[Visitor]
    Kiosk[Kiosk Device]
    Entry[Entry Scanner]
    Guard[Guard]
    Exit[Exit Scanner]
    Admin[Admin]
    SuperAdmin[Super Admin]

    UI[React 19 + TypeScript + Vite]

    API[Vercel Serverless API<br/>Node.js 24]

    Auth[Supabase Auth]
    DB[(Supabase PostgreSQL)]
    Storage[(Private Supabase Storage)]

    Resend[Resend Email Delivery]
    Turnstile[Cloudflare Turnstile]
    OCR[Tesseract.js<br/>Browser-Local OCR]

    Visitor --> UI
    Kiosk --> UI
    Entry --> UI
    Guard --> UI
    Exit --> UI
    Admin --> UI
    SuperAdmin --> UI

    UI --> Auth
    UI --> API

    Visitor --> Turnstile
    Kiosk --> OCR

    API --> Auth
    API --> DB
    API --> Storage
    API --> Resend
`

---

## Technology Stack

| Layer | Technology | Operational Responsibility |
|:---|:---|:---|
| **Frontend** | React 19, TypeScript, Vite 8 | Responsive institutional UI, camera streams, scanning, browser print |
| **Styling** | Tailwind CSS v4, Lucide Icons | Accessible, institutional design system optimized for mobile Safari & desktop |
| **Hosting & API** | Vercel (Edge Network + Serverless Functions) | Production static asset distribution and privileged Node.js 24 API runtime (syd1) |
| **Authentication** | Supabase Auth | Session authority for visitors (anonymous), staff (JWT), and gate devices |
| **Database** | Supabase PostgreSQL 15 | Relational data, Row Level Security (RLS), atomic transitions, Asia/Manila stats |
| **Object Storage** | Supabase Storage (Private) | RLS-restricted storage for face photos and government ID captures |
| **Email Delivery** | Resend | High-deliverability transactional emails for invitations, codes, and passes |
| **Email Templates** | React Email (TSX) + esbuild | Component-based email markup pre-bundled for Vercel Serverless runtime |
| **Bot Protection** | Cloudflare Turnstile | Server-verified bot deterrence for public pre-registration |
| **OCR Engine** | Tesseract.js (Self-Hosted Assets) | 100% browser-local client OCR; zero remote data transmission |
| **QR Cryptography** | Node.js crypto (HMAC-SHA256) | High-entropy bearer generation; SHA-256 digest lookup in PostgreSQL |
| **Timezone Authority** | Asia/Manila (PHT, UTC+8) | Institutional calendar enforcement, visit validity, and daily gate aggregations |

---

## Visitor Portal Registration Flow

The public portal enables campus visitors to pre-register or register on arrival. Registration enforces Cloudflare Turnstile verification, authenticates an anonymous Supabase session, captures live camera photos, and provisions private evidence records before pass issuance.

`mermaid
flowchart TD
    Start[Open Visitor Portal]
    Bot[Cloudflare Turnstile Challenge]
    Session[Anonymous Supabase Session]
    Details[Fill Visitor Details & Purpose]
    Mode{Peak Mode Active?}
    ID[Live Camera ID Capture]
    SkipID[Skip ID Requirement]
    Face[Live Camera Face Photo]
    Upload[Create Private Upload Intent]
    Store[Direct Upload to Private Storage]
    Validate[Server Validates Evidence & Integrity]
    Issue[Issue Visitor Pass Record]
    QR[Display Cryptographic QR Pass]

    Start --> Bot
    Bot -->|Verified| Session
    Bot -->|Failed / Expired| Stop[Reject Registration]
    Session --> Details
    Details --> Mode
    Mode -->|Standard Mode| ID
    Mode -->|Peak Mode| SkipID
    ID --> Face
    SkipID --> Face
    Face --> Upload
    Upload --> Store
    Store --> Validate
    Validate -->|Valid Evidence| Issue
    Validate -->|Invalid / Missing| Retry[Request Evidence Correction]
    Retry --> Face
    Issue --> QR
`

---

## Kiosk OCR Registration Flow

On-premise walk-in kiosks run on managed Android tablets or touch terminals with rear-facing document cameras. Tesseract OCR runs entirely inside the visitor's local browser session.

`mermaid
flowchart TD
    Start[Visitor Approaches Kiosk]
    Auth[Authenticated Managed Kiosk Session]
    Capture[Rear Camera Valid ID Capture]
    OCR[Local Tesseract OCR Engine]
    Parse[Extract & Clean Name / ID Fields]
    Review[Visitor Reviews & Corrects Fields]
    Face[Front Camera Face Photo Capture]
    Final[Final Review & Privacy Acceptance]
    Issue[Server Validates & Issues Pass]
    QR[Render QR Code Token]
    Print[Browser Print Receipt / Ticket]
    Email[Optional Verification Code & QR Email]

    Start --> Auth
    Auth --> Capture
    Capture --> OCR
    OCR --> Parse
    Parse --> Review
    Review --> Face
    Face --> Final
    Final --> Issue
    Issue --> QR
    QR --> Print
    QR --> Email
`

> **Note on OCR Trust Boundary**: OCR is purely a UX convenience for fast form-filling. OCR output is untrusted and does **not** grant authorization. The visitor must review extracted fields, and campus guards visually inspect physical and digital IDs at the gate.

---

## Pass Lifecycle State Machine

Pass transitions are strictly serialized and enforced at the PostgreSQL database level using atomic RPCs and row locks (FOR UPDATE).

`mermaid
stateDiagram-v2
    [*] --> issued: Pass Issued via Portal / Kiosk

    issued --> pending: Entry Scanner Scans QR Code
    issued --> expired: Validity Window Closes Without Entry

    pending --> inside: Campus Guard Approves Entry
    pending --> rejected: Campus Guard Denies Entry

    inside --> exited: Exit Scanner Scans QR Code

    rejected --> [*]
    exited --> [*]
    expired --> [*]
`

---

## Physical Gate Entry & Exit Flow

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor
    actor E as Entry Scanner
    participant API as Vercel API
    participant DB as Supabase DB
    actor G as Campus Guard
    actor X as Exit Scanner

    V->>E: Present QR Pass
    E->>API: POST /api/passes/scan (type: entry, gate_id)
    API->>DB: Atomic RPC: Verify QR HMAC digest & state
    DB-->>API: Pass valid -> Transition to 'pending'
    API-->>E: Display Visitor Details & 'Pending Guard Review'

    G->>API: Guard Queue polls /api/admin/guard-dashboard
    API->>DB: Fetch pending passes with evidence signed URLs
    DB-->>G: Display Face Photo vs. Valid ID Photo

    alt Guard Approves
        G->>API: POST /api/passes/decide (decision: approved)
        API->>DB: Atomic RPC: Transition to 'inside', log timestamp
        DB-->>G: Status 'inside' confirmed
        Note over V,G: Visitor admitted to campus
        
        V->>X: Present QR Pass upon leaving
        X->>API: POST /api/passes/scan (type: exit, gate_id)
        API->>DB: Atomic RPC: Verify 'inside' status -> Transition to 'exited'
        DB-->>X: Exit approved & logged
    else Guard Rejects
        G->>API: POST /api/passes/decide (decision: rejected, reason)
        API->>DB: Atomic RPC: Transition to 'rejected', log reason
        DB-->>G: Rejection recorded
    end
`

---

## Auth Transactional Email Architecture

Supabase Auth uses standard webhooks to dispatch authentication events (staff invitations, password resets, email updates) through a secure serverless pipeline to Resend.

`mermaid
sequenceDiagram
    autonumber
    participant SA as Supabase Auth
    participant Hook as Vercel /api/auth/send-email-hook
    participant Mapper as Auth Email Mapper
    participant Bundle as React Email Runtime Bundle
    participant R as Resend API
    actor U as Staff Recipient

    SA->>Hook: POST signed event (webhook-id, signature, timestamp)
    Hook->>Hook: StandardWebhooks.verify(rawBody, secret)
    Hook->>Mapper: prepareAuthEmails(payload)
    Mapper->>Bundle: renderStaffInviteEmail(props)
    Bundle-->>Mapper: HTML with absolute EARIST seal URL
    Mapper-->>Hook: Recipient + Generic Subject + HTML
    Hook->>R: POST https://api.resend.com/emails
    R-->>Hook: HTTP 200 { id: \"re_...\" }
    R->>U: Deliver transactional email to inbox
    Hook-->>SA: HTTP 200 {}
`

### Build-Time React Email Bundling Pipeline

To resolve @vercel/nft (Node File Trace) limitations where .js ESM specifiers cannot trace .tsx source components at deployment time, email templates are compiled into a self-contained runtime bundle during pre-build:

`mermaid
flowchart LR
    Sources[server/templates/*.tsx<br/>authoritative source]
    IndexTS[server/templates/index.ts<br/>type contracts]
    Script[scripts/bundle-email-templates.mjs<br/>esbuild compiler]
    Artifact[server/templates/index.js<br/>build artifact - git ignored]
    NFT[@vercel/nft Tracer]
    Function[api/auth/[...route].func<br/>Vercel Production Bundle]

    Sources --> Script
    IndexTS --> Script
    Script --> Artifact
    Artifact --> NFT
    NFT --> Function
`

---

## Self-Service QR Email Dispatch Flow

Visitors who complete registration at a kiosk can securely dispatch their QR pass to their personal email address through a two-step challenge-verification workflow.

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor
    participant UI as Kiosk / Portal UI
    participant API as Vercel API
    participant DB as Supabase PostgreSQL
    participant R as Resend API

    V->>UI: Enter email address
    UI->>API: POST /api/passes/email/request-code
    API->>DB: RPC: Rate-limit check & generate 6-digit challenge code
    DB-->>API: Challenge created (5-minute expiry)
    API->>R: Send VerificationCodeEmail
    R->>V: 6-digit verification code arrives in inbox

    V->>UI: Enter 6-digit code
    UI->>API: POST /api/passes/email/verify-and-send
    API->>DB: RPC: Lock row, verify attempts, validate code
    DB-->>API: Challenge verified & claim ID locked
    API->>R: Send PassIssuedEmail with attached QR pass
    R->>V: Deliver QR pass to visitor inbox
    API->>DB: RPC: Finalize dispatch status (dispatched)
`

---

## User Roles & System Permissions

| Role / Actor | Authentication | Scope & Capabilities |
|:---|:---|:---|
| **Visitor** | Anonymous Supabase session | Pre-register for visits, upload live evidence via signed intents, view own pass |
| **Kiosk Device** | Managed Device identity (kiosk) | Assisted registration, rear-camera OCR scanning, thermal ticket printing |
| **Entry Scanner** | Managed Device identity (entry) | Scan QR codes at designated gates, advance issued passes to pending review |
| **Exit Scanner** | Managed Device identity (exit) | Scan QR codes at designated gates, advance inside passes to exited status |
| **Campus Guard** | Staff Auth (guard) | Review pending visitors, compare live face vs. ID evidence, approve/reject entry |
| **Administrator** | Staff Auth (dmin) | Operational dashboard, visitor logs, device management, incident holds |
| **Super Administrator** | Staff Auth (superadmin) | Full institutional governance, staff provisioning, system settings, retention runs |

---

## Evidence Security & Privacy Lifecycle

All facial photographs and identity document scans are classified as sensitive biometric-adjacent data. E-GatePass enforces strict privacy and retention boundaries:

`mermaid
flowchart LR
    Capture[Live Camera Capture]
    Intent[Server Signed Upload Intent]
    Private[Private Supabase Storage]
    Validate[Server Integrity Verification]
    Record[DB Evidence Metadata Record]
    Hold{Active Incident Hold?}
    Delete[Cryptographic Permanent Purge]

    Capture --> Intent
    Intent --> Private
    Private --> Validate
    Validate --> Record
    Record --> Hold
    Hold -->|No Hold & Ret Window Reached| Delete
    Hold -->|Active Hold Applied| Retain[Preserve Evidence Until Released]
    Retain --> Hold
`

---

## Repository Directory Structure

`	ext
egatepass/
├── api/                           # Vercel Serverless Function entrypoints
│   ├── admin/                     # Staff, device, settings, and retention endpoints
│   ├── auth/                      # Supabase Send Email Hook handler
│   ├── passes/                    # Pass issuance, scanning, decisions, and QR email
│   └── system/                    # Health and readiness diagnostics
├── server/                        # Shared server logic (Node.js 24 ESM)
│   ├── routes/                    # Modular route controllers
│   ├── templates/                 # Authoritative React Email templates (.tsx)
│   ├── actors.ts                  # Server-side JWT and device actor resolution
│   ├── auth-email-hook.ts         # Supabase webhook payload mapper
│   ├── email.ts                   # Resend API integration and error classifier
│   └── supabase.ts                # Privileged service_role client factory
├── src/                           # Client Single Page Application (React 19 + Vite)
│   ├── components/                # Modular UI components (Input, Dialog, Scanner)
│   ├── pages/                     # Application routes (Portal, Kiosk, Guard, Admin)
│   ├── services/                  # Client API clients and Supabase queries
│   └── types/                     # Shared TypeScript domain contracts
├── supabase/                      # Database authority
│   ├── migrations/                # Immutable sequential PostgreSQL migrations
│   ├── tests/                     # pgTAP SQL contract tests
│   └── config.toml                # Local Supabase CLI configuration
├── scripts/                       # Operational and build scripts
│   ├── bundle-email-templates.mjs # Build-time React Email compiler (esbuild)
│   └── run-startup-e2e.mjs        # Playwright browser startup test runner
├── public/                        # Static public web assets
│   ├── earist-logo.png            # Official institutional crest
│   └── tesseract/                 # Self-hosted browser OCR worker and language models
├── tests/                         # Automated test suite (Vitest + Playwright)
├── docs/                          # Comprehensive technical documentation
│   └── archive/                   # Archived historical migration artifacts
├── vercel.json                    # Vercel routing, rewrites, and security headers
├── package.json                   # Dependency manifests and scripts
└── tsconfig.api.json              # Explicit NodeNext typechecker configuration
`

---

## Local Development Setup

### Prerequisites

- **Node.js**: 24.x or 22.x
- **Package Manager**: 
pm (v10+)
- **Git**

### Installation & Execution

1. **Clone the repository**:
   `ash
   git clone https://github.com/jsphhbna/egatepass.git
   cd egatepass
   `

2. **Install dependencies**:
   `ash
   npm install
   `

3. **Configure environment variables**:
   Create a .env.local file in the root directory (see [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)):
   `env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   VITE_TURNSTILE_SITE_KEY=your-turnstile-site-key
   SUPABASE_SECRET_KEY=your-supabase-secret-key
   PASS_TOKEN_SECRET=your-32-byte-hex-secret
   RESEND_API_KEY=re_your_api_key
   RESEND_FROM_EMAIL=EARIST E-GatePass <notifications@egatepass.tech>
   SEND_EMAIL_HOOK_SECRET=v1,whsec_your_base64_secret
   `

4. **Start the local development server**:
   `ash
   npm run dev
   `

5. **Run test suites**:
   `ash
   npm test                  # Run all 32 unit and contract test suites
   npm run typecheck:api     # Verify server-side NodeNext API contracts
   npm run build             # Build production frontend and bundle email templates
   npx vercel build --prod   # Verify complete Vercel production serverless bundle
   `

---

## Documentation Index

| Document | Primary Focus & Target Audience |
|:---|:---|
| [**docs/SECURITY.md**](docs/SECURITY.md) | **Canonical Security Architecture**: Trust boundaries, threat matrix, cryptographic proofs, RLS |
| [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) | **Technical System Architecture**: Subsystems, data schemas, sequence diagrams, invariants |
| [**docs/DEPLOYMENT.md**](docs/DEPLOYMENT.md) | **Production Deployment Guide**: Vercel configuration, Supabase migrations, DNS, Resend |
| [**docs/OPERATIONS.md**](docs/OPERATIONS.md) | **Standard Operating Procedures**: Staff onboarding, device registration, incident holds |
| [**docs/ENVIRONMENT.md**](docs/ENVIRONMENT.md) | **Authoritative Environment Variables Contract**: Scopes, secrets, validation rules |
| [**docs/ENVIRONMENT_AND_CRON.md**](docs/ENVIRONMENT_AND_CRON.md) | **Automated Maintenance**: Vercel Cron, database cursors, retention jobs, incident holds |
| [**docs/MANUAL_QA_RUNBOOK.md**](docs/MANUAL_QA_RUNBOOK.md) | **Manual QA & Verification Runbook**: Step-by-step cross-device operational test procedures |
| [**docs/SUPER_ADMIN_BOOTSTRAP.md**](docs/SUPER_ADMIN_BOOTSTRAP.md) | **Privileged Identity Bootstrap**: Creating the primary institutional Super Admin account |
| [**docs/CLEAN_DATA_HANDOFF.md**](docs/CLEAN_DATA_HANDOFF.md) | **Final Institutional Handoff Checklist**: Verification gates, secret rotation, signoff |
| [**docs/TROUBLESHOOTING.md**](docs/TROUBLESHOOTING.md) | **Diagnostics & Runbook**: Fast resolution for webhooks, RLS denials, devices, and scanning |
| [**docs/IMAGE_SECURITY.md**](docs/IMAGE_SECURITY.md) | **Biometric & ID Evidence Security**: Upload intents, storage isolation, retention policies |
| [**docs/AUDIT_POLICY.md**](docs/AUDIT_POLICY.md) | **Compliance & Audit Logging**: Immutable security event logs, redaction rules, audit RLS |

---

## License

This software is developed for the **Eulogio \"Amang\" Rodriguez Institute of Science and Technology (EARIST)**.
All rights reserved.
