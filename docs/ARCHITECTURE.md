# E-GatePass Technical Architecture

> Authoritative technical specification of subsystems, boundaries, data pipelines, and invariants.

This document describes the runtime architecture, subsystem boundaries, database schema relationships, and state transitions of the **EARIST E-GatePass** platform.

---

## 1. System Subsystems & Runtime Boundaries

`mermaid
flowchart TB
    subgraph ClientLayer["Frontend Application (React 19 + TypeScript + Vite)"]
        PortalUI[Visitor Self-Service Portal]
        KioskUI[Assisted Walk-in Kiosk UI]
        GateUI[Entry & Exit Scanner Views]
        GuardUI[Guard Approval Queue Dashboard]
        AdminUI[Admin & Super Admin Consoles]
    end

    subgraph ServerLayer["Serverless Execution Layer (Vercel Functions - Node.js 24)"]
        Gateway[Vercel Edge Gateway / Rewrites]
        AuthHook[Auth Webhook Receiver /api/auth/*]
        PassAPI[Pass Issuance & Scanning /api/passes/*]
        GateAPI[Guard Decision & Evidence /api/gate/*]
        AdminAPI[Staff, Devices & Settings /api/admin/*]
        SystemAPI[Retention & Diagnostics /api/system/*]
        EmailBundle[React Email Runtime Bundle]
    end

    subgraph DataLayer["Database & Storage Authority (Supabase / PostgreSQL 15)"]
        AuthService[Supabase Auth Service]
        PostgresDB[(PostgreSQL Database Engine)]
        StorageVault[(Private Object Storage Vault)]
    end

    subgraph ExternalLayer["External Integrated Providers"]
        ResendAPI[Resend Transactional Email Engine]
        TurnstileAPI[Cloudflare Turnstile Bot Verification]
    end

    PortalUI --> Gateway
    KioskUI --> Gateway
    GateUI --> Gateway
    GuardUI --> Gateway
    AdminUI --> Gateway

    PortalUI -.->|Direct Challenge| TurnstileAPI
    PortalUI -.->|Direct Signed Upload| StorageVault
    KioskUI -.->|Direct Signed Upload| StorageVault

    Gateway --> AuthHook
    Gateway --> PassAPI
    Gateway --> GateAPI
    Gateway --> AdminAPI
    Gateway --> SystemAPI

    AuthHook --> EmailBundle
    EmailBundle --> ResendAPI
    PassAPI --> ResendAPI

    AuthHook --> AuthService
    PassAPI --> PostgresDB
    GateAPI --> PostgresDB
    AdminAPI --> PostgresDB
    SystemAPI --> PostgresDB
    SystemAPI --> StorageVault
`

---

## 2. Core Database Schema & Relational Entities

The PostgreSQL schema enforces strict foreign key integrity, temporal checks, and enum type constraints.

`mermaid
erDiagram
    STAFF_PROFILES ||--o{ VISIT_EVENTS : records
    STAFF_PROFILES ||--o{ INCIDENT_HOLDS : creates
    DEVICES ||--o{ VISIT_EVENTS : scans
    VISITORS ||--o{ PASSES : owns
    VISITORS ||--o{ EVIDENCE : provides
    PASSES ||--o{ VISIT_EVENTS : transitions
    PASSES ||--o{ PASS_EMAIL_VERIFICATIONS : challenges
    PASSES ||--o{ INCIDENT_HOLDS : holds

    STAFF_PROFILES {
        uuid id PK
        string email
        string full_name
        string role
        boolean is_active
        boolean must_change_password
        timestamp created_at
    }

    DEVICES {
        uuid id PK
        uuid user_id FK
        string alias
        string name
        string type
        string gate
        string status
        timestamp registered_at
    }

    VISITORS {
        uuid id PK
        uuid owner_id
        string full_name
        string contact_number
        string email
        string purpose
        timestamp created_at
    }

    PASSES {
        uuid id PK
        uuid visitor_id FK
        uuid public_reference UK
        string status
        string qr_token_hash UK
        timestamp valid_from
        timestamp valid_until
        timestamp entered_at
        timestamp exited_at
    }

    EVIDENCE {
        uuid id PK
        uuid visitor_id FK
        uuid pass_id FK
        string type
        string storage_path
        string mime_type
        int file_size
        string sha256_hash
        timestamp created_at
    }

    VISIT_EVENTS {
        uuid id PK
        uuid pass_id FK
        string event_type
        uuid actor_id
        string gate_id
        timestamp occurred_at
    }

    PASS_EMAIL_VERIFICATIONS {
        uuid id PK
        uuid pass_id FK
        string email
        string code_hash
        string status
        int attempts
        timestamp expires_at
    }

    INCIDENT_HOLDS {
        uuid id PK
        uuid pass_id FK
        uuid visitor_id FK
        uuid created_by FK
        string reason
        boolean is_active
        timestamp created_at
        timestamp released_at
    }
`

---

## 3. Identity Model & Actor Resolution

Actor authorization is determined dynamically on each request through server/actors.ts:

1. **Staff Actors**: Authenticated via Supabase Auth session JWT. The UID is mapped against public.staff_profiles. The database row dictates the canonical role:
   - superadmin: Institutional governance and staff management.
   - dmin: Operations, reporting, device enrollment, and incident holds.
   - guard: Stationed queue reviews and entry/exit decisions.
2. **Device Actors**: Hardware terminals authenticate using device credentials mapped in public.devices. The database row dictates device capabilities:
   - kiosk: Walk-in registration with rear document camera.
   - entry: Inbound gate scanning; authorized to advance passes from issued to pending.
   - exit: Outbound gate scanning; authorized to advance passes from inside to exited.
3. **Visitor Actors**: Anonymous visitors authenticate using ephemeral Supabase anonymous sessions, scoped strictly to their own visitor and pass records.

---

## 4. Pass Issuance & Scanning Pipeline

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor / Kiosk
    participant API as Vercel API
    participant DB as Supabase PostgreSQL
    actor S as Gate Scanner
    actor G as Campus Guard

    V->>API: POST /api/passes/issue { visitorDetails, evidencePaths }
    API->>API: Generate 64-char QR bearer token
    API->>API: Compute token_hash = sha256(qr_token)
    API->>DB: Atomic RPC: api.issue_pass(visitor_id, token_hash, valid_window)
    DB-->>API: Pass Record (ID, public_reference, status: 'issued')
    API-->>V: Render QR Code graphic (contains qr_token)

    Note over V,S: Physical Entry at Campus Gate
    V->>S: Scan QR Code
    S->>API: POST /api/passes/scan { qr_token, scan_type: 'entry' }
    API->>DB: RPC: api.scan_pass(sha256(qr_token), 'entry')
    DB->>DB: Verify status == 'issued' -> Update status = 'pending'
    DB-->>API: Pass 'pending' Guard Review
    API-->>S: Display Visitor Info & 'Pending Guard Review'

    G->>API: POST /api/passes/decide { pass_id, decision: 'approved' }
    API->>DB: RPC: api.decide_visit(pass_id, 'approved', guard_id)
    DB->>DB: Verify status == 'pending' -> Update status = 'inside'
    DB-->>API: Decision confirmed
    API-->>G: Visitor admitted to campus
`

---

## 5. Evidence & Storage Architecture

All face photos and ID captures are uploaded directly to Supabase Private Storage:
- **Bucket isitor-photos**: Visitor portrait photographs.
- **Bucket isitor-id-documents**: Government or school identity document scans.

### Upload Lifecycle

1. **Pre-Authorization**: Client calls pi.create_evidence_upload_intent() to receive an authorized upload path and 10-minute expiry.
2. **Direct Storage Upload**: Client uploads directly to Supabase Storage via signed intent headers.
3. **Verification & Claim**: Client invokes pi.claim_evidence(). The server validates file metadata, MIME type, and byte headers before marking the evidence record active.

---

## 6. Retention, Incident Holds & Purge Pipeline

`mermaid
flowchart TD
    Trigger[Vercel Scheduled Cron /api/system/retention-cleanup<br/>Bearer CRON_SECRET]
    LoadSettings[Load app_settings: retention windows]
    FetchEligible[Query passes with valid_until < cutoff AND status IN exited, rejected, expired]
    CheckHolds{Is pass_id in active incident_holds?}

    Trigger --> LoadSettings
    LoadSettings --> FetchEligible
    FetchEligible --> CheckHolds

    CheckHolds -->|Yes| Skip[Retain Record & Skip Storage Purge]
    CheckHolds -->|No| PurgeStorage[Delete Assets from Private Storage]

    PurgeStorage --> RedactDB[Redact Evidence Hashes & Mark images_purged_at]
    RedactDB --> LogAudit[Log audit_events: retention_purged]
    Skip --> LogAudit
`

---

## 7. Cross-System Reconciliation Subsystem

Network timeouts or provider downtime (e.g. Resend 5xx errors) trigger the creation of a durable task in public.reconciliation_tasks.

1. **Detection**: If a database mutation commits but an external provider fails or returns an uncertain response (outcome_unknown), a reconciliation row is inserted.
2. **Alerting**: Active reconciliation tasks appear in the Super Admin dashboard with error classification and timestamp.
3. **Resolution**: Administrators can retry the failed side effect, mark the task resolved, or dismiss it after manual verification.
