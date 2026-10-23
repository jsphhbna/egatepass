# System Architecture & Technical Specifications

This document details the software architecture, relational data models, subsystem boundaries, and runtime execution pipelines of the EARIST E-GatePass platform.

---

## 1. Subsystem Architecture

EARIST E-GatePass is partitioned into four decoupled architecture tiers:

```mermaid
flowchart TD
    subgraph ClientTier["1. Client Tier (React 19 + TypeScript + Vite 8)"]
        Portal[Visitor Portal<br/>Public Registration & QR Display]
        Kiosk[Walk-In Kiosk View<br/>Self-Service & Local OCR]
        GuardUI[Guard Console<br/>Verification & Queue Decision]
        AdminUI[Admin Dashboard<br/>Staff, Devices & Settings]
        ScannerUI[Gate Scanner Hardware<br/>Entry / Exit QR Readers]
    end

    subgraph EdgeTier["2. Edge & Serverless Tier (Vercel)"]
        EdgeCDN[Vercel Global Edge CDN<br/>Static Assets & SPA Routing]
        API[Serverless API Functions<br/>Node.js 24 Execution Context]
        AuthHook[Send Email Hook Endpoint<br/>Standard Webhook Verification]
        ResendHook[Resend Delivery Webhook<br/>Standard Webhook Verification]
        EmailBundle[Build-Time React Email Bundle<br/>server/templates/index.js]
    end

    subgraph DataTier["3. Data & Storage Tier (Supabase)"]
        SupabaseAuth[Supabase Auth Service<br/>Anonymous & Authenticated JWTs]
        Postgres[(Supabase PostgreSQL<br/>Authoritative Schema & RLS)]
        Storage[(Supabase Object Storage<br/>Private: visitor-photos & visitor-ids)]
    end

    subgraph ExternalTier["4. External Service Providers"]
        ResendAPI[Resend REST API<br/>Transactional Email]
        ResendEvents[Resend Webhooks<br/>Delivery Events]
        TurnstileAPI[Cloudflare Turnstile<br/>Bot Protection]
    end

    ClientTier -->|HTTPS Static Fetch| EdgeCDN
    ClientTier -->|HTTPS API Requests| API
    ClientTier -->|Auth Handshake & Session| SupabaseAuth
    ClientTier -.->|Direct Image Upload via Intent| Storage
    ClientTier -.->|Solve Challenge| TurnstileAPI

    API -->|Service-Role & RPC Queries| Postgres
    API -->|Validate & Stream Private Files| Storage
    API -->|Send Notifications / Invites| ResendAPI
    AuthHook --> EmailBundle
    AuthHook --> ResendAPI
    ResendEvents -->|POST /api/webhooks/resend| ResendHook
    ResendHook -->|Atomic Deduplication & Audit| Postgres
```

---

## 2. Authoritative Relational Data Model

The PostgreSQL database enforces relational integrity, unique constraints, and foreign-key cascading rules across 15 canonical application tables:

```mermaid
erDiagram
    visitors ||--o{ passes : "receives"
    visitors ||--o{ visitor_evidence : "owns"
    visitors ||--o{ incident_holds : "subject_to"
    passes ||--o{ visit_events : "generates"
    passes ||--o{ incident_holds : "subject_to"
    upload_intents ||--o| visitor_evidence : "materializes"
    staff_profiles ||--o{ visit_events : "decides"
    staff_profiles ||--o{ incident_holds : "manages"
    devices ||--o{ visit_events : "records"

    visitors {
        uuid id PK
        uuid owner_id FK
        text full_name
        text purpose
        date visit_date
        text status
        timestamptz created_at
    }

    passes {
        uuid id PK
        uuid visitor_id FK
        uuid public_reference
        bytea token_digest
        text source
        text status
        timestamptz valid_from
        timestamptz valid_until
        timestamptz issued_at
    }

    visitor_evidence {
        uuid id PK
        uuid visitor_id FK
        uuid upload_intent_id FK
        text kind
        text bucket_id
        text object_path
        text content_type
        bytea sha256
        integer byte_size
        timestamptz created_at
        timestamptz purged_at
    }

    upload_intents {
        uuid id PK
        uuid owner_id FK
        text source
        text kind
        text bucket_id
        text object_path
        text content_type
        integer max_bytes
        text status
        timestamptz expires_at
    }

    staff_profiles {
        uuid user_id PK
        text display_name
        text role
        boolean active
        boolean must_change_password
        timestamptz created_at
    }

    devices {
        uuid user_id PK
        text alias
        text name
        text type
        text gate
        text status
        timestamptz created_at
        timestamptz deleted_at
    }

    incident_holds {
        uuid id PK
        uuid visitor_id FK
        uuid pass_id FK
        text reason
        boolean active
        uuid created_by FK
        timestamptz created_at
        uuid released_by FK
        timestamptz released_at
    }

    audit_events {
        bigint id PK
        uuid actor_id
        text actor_kind
        text actor_role
        text action
        text target_type
        text target_id
        jsonb before_state
        jsonb after_state
        uuid request_id
        text outcome
        timestamptz occurred_at
    }

    visit_events {
        bigint id PK
        uuid pass_id FK
        uuid visitor_id FK
        text event
        text reason
        uuid device_id FK
        text gate
        uuid guard_id FK
        timestamptz occurred_at
    }

    resend_webhook_events {
        bigint id PK
        text provider_event_id UK
        text event_type
        timestamptz received_at
    }
```

---

## 3. Canonical API Route Architecture

The platform's API surface is declared in `server/route-map.ts`. All 27 endpoints execute within Vercel Serverless Function instances:

### 3.1 Admin Router (9 routes: `/api/admin/*`)
- `GET /api/admin/activity`: Historical audit event query for administrators.
- `GET /api/admin/dashboard`: High-level operational metrics and active gate counters.
- `GET /api/admin/devices`: Hardware scanner fleet inventory and status list.
- `GET /api/admin/emergency`: Real-time campus population roll-call for safety evacuations.
- `GET, POST, DELETE, PATCH /api/admin/holds`: Incident hold management on visitor records.
- `GET /api/admin/records`: Paginated visitor pass log with filtering by date and gate.
- `GET, POST /api/admin/retention-maintenance`: Manual or cron-authenticated retention engine.
- `GET /api/admin/settings`: Institutional configuration (working hours, retention days).
- `GET /api/admin/users`: Staff member list and profile state management.

### 3.2 Auth Router (4 routes: `/api/auth/*`)
- `POST /api/auth/complete-password-change`: Password update handler.
- `POST /api/auth/reset-password`: Trigger password reset email.
- `POST /api/auth/send-email-hook`: Supabase Auth standard webhook receiver for outbound transactional emails.
- `POST /api/auth/resend-webhook`: Resend delivery observability webhook receiver (external rewrite path: `POST /api/webhooks/resend`).

### 3.3 Passes Router (2 routes: `/api/passes/*`)
- `POST /api/passes/issue`: Atomically validates evidence upload intents and issues QR gate passes.
- `POST /api/passes/email`: Two-step verification challenge and dispatch of QR passes via email.

### 3.4 Device Router (4 routes: `/api/*`)
- `POST /api/create-device`: Register new gate or kiosk scanner device.
- `DELETE /api/delete-device`: Decommission and soft-delete device hardware.
- `POST /api/update-device`: Update device display name, gate binding, or type.
- `POST /api/update-device-auth`: Rotate device login credentials.

### 3.5 Gate Router (3 routes: `/api/*`)
- `POST /api/scan-pass`: Scanner endpoint for entry and exit events; verifies `token_digest` and gate.
- `POST /api/decide-visit`: Guard console decision endpoint (approve or reject entry).
- `GET /api/evidence`: Authenticated proxy for streaming private visitor photos and ID cards.

### 3.6 System Router (5 routes: `/api/*`)
- `POST /api/create-user`: Provision staff account.
- `POST /api/update-user`: Update staff role or status.
- `POST /api/update-settings`: Super Admin system settings update.
- `POST /api/purge-images`: Super Admin manual image purge.
- `GET, PATCH /api/reconciliation-items`: Super Admin review and resolution of cross-system anomalies.

---

## 4. End-to-End Ingestion & Scan Architecture

```mermaid
sequenceDiagram
    participant Browser as Client Browser
    participant API as Vercel Functions
    participant DB as PostgreSQL
    participant Storage as Private Storage

    Note over Browser,Storage: 1. Registration & Upload Phase
    Browser->>DB: RPC api.create_upload_intent (request upload path)
    DB-->>Browser: { intent_id, bucket_id, object_path, max_bytes }
    Browser->>Storage: Direct upload to private bucket (visitor-photos / visitor-ids)
    Storage-->>Browser: Upload complete

    Note over Browser,Storage: 2. Issuance Phase
    Browser->>API: POST /api/passes/issue { uploadIntents, visitorDetails }
    API->>DB: RPC api.issue_pass (atomic verification & token digest insertion)
    DB-->>API: { passId, tokenDigest }
    API-->>Browser: { qrToken, passId } (Display QR to visitor)

    Note over Browser,Storage: 3. Gate Scanning & Decision Phase
    Browser->>API: POST /api/scan-pass (Entry gate scanner reads QR)
    API->>DB: RPC api.scan_pass (match token_digest & gate)
    DB-->>API: Status: Pending Guard Review
    API-->>Browser: Hold visitor at barrier

    Browser->>DB: RPC api.guard_dashboard (Guard fetches pending queue)
    DB-->>Browser: Queue items with evidence IDs
    Browser->>API: GET /api/evidence?id=<evidence_id>
    API->>Storage: Stream private photo object
    API-->>Browser: Stream photo evidence
    Browser->>API: POST /api/decide-visit { passId, decision: 'approved' }
    API->>DB: RPC api.decide_visit (atomic transition status -> inside)
    DB-->>Browser: Approved confirmed
```

---

## 5. Storage Architecture & Privacy Policies

Private storage assets are partitioned into two designated buckets:
1. `visitor-photos`: Face photos captured by online visitors or kiosk cameras.
2. `visitor-ids`: Scanned government or school ID documents.

### Storage Invariants:
- **Zero Public Access**: Buckets are marked private; public URL access is permanently disabled.
- **Access Delegation**: Staff access assets solely via `/api/evidence?id=<uuid>`, which evaluates caller roles (`guard`, `admin`, `superadmin`), pass states, and active incident holds before streaming the image.
- **Ephemeral Upload Intents**: Upload intents expire within 15 minutes. Abandoned uploads are cleaned up during daily retention maintenance.
- **Retention & Purge**: Expired assets are deleted from storage, and `visitor_evidence.purged_at` is stamped in PostgreSQL.

---

## 6. Dedicated Email Hooks Architecture

The platform separates outbound email dispatch from inbound delivery feedback using two distinct, decoupled webhook flows:

```text
1. Outbound Auth Dispatch: Supabase Auth Send Email Hook
   Supabase Auth
       ↓ signed standard webhook
   POST /api/auth/send-email-hook
       ↓ (verified via SEND_EMAIL_HOOK_SECRET)
   React Email template rendering
       ↓
   Resend REST API (via RESEND_API_KEY)
   Purpose: Dispatches transactional system emails (staff invites, password resets, magic links).

2. Inbound Delivery Feedback: Resend Delivery Observability Webhook
   Resend Event System
       ↓ signed delivery event
   POST /api/webhooks/resend  (rewritten to /api/auth/resend-webhook)
       ↓ (verified via RESEND_WEBHOOK_SECRET)
   Atomic deduplication (public.resend_webhook_events)
       ↓
   Audit logging (public.audit_events with masked recipient)
   Purpose: Observability of delivery outcome (sent, delivered, delayed, bounced, complained).
```

> **IMPORTANT**: Neither hook is an inbound user mailbox or reply receiver. `notifications@egatepass.tech` does not receive inbound user correspondence.

---

## 7. Performance & Referential Covering Indexes (Migration 20261023020000)

To resolve unindexed foreign key warnings identified during performance reviews and eliminate table-level share locks during parent table mutations, migration `20261023020000_performance_covering_indexes.sql` introduces covering partial btree indexes on:
- `passes(decided_by)`, `passes(entry_device_id)`, `passes(exit_device_id)`
- `visit_events(visitor_id)`, `visit_events(guard_id)`, `visit_events(device_id)`
- `upload_intents(visitor_id)`
- `incident_holds(created_by)`, `incident_holds(released_by)`, `incident_holds(pass_id)`, `incident_holds(visitor_id)`
- `visitors(created_by_device_id)`

---

## 8. Atomic Webhook Idempotency (Migration 20261023140000)

To eliminate race conditions during high-frequency Resend delivery webhook events across concurrent serverless instances, forward migration `20261023140000_resend_webhook_idempotency.sql` introduces the `resend_webhook_events` table:
- Enforces database-level uniqueness on `provider_event_id` (`CONSTRAINT resend_webhook_events_provider_id_unique UNIQUE (provider_event_id)`).
- Replays of already processed webhooks safely return HTTP 200 `already_processed` without inserting duplicate audit events.
