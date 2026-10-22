# System Architecture & Technical Specifications

This document details the software architecture, relational data models, subsystem boundaries, and runtime execution pipelines of the EARIST E-GatePass platform.

---

## 1. Subsystem Architecture

EARIST E-GatePass is partitioned into four decoupled architecture tiers:

```mermaid
flowchart TD
    subgraph ClientTier["1. Client Tier (React 18 + TypeScript + Vite)"]
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
        EmailBundle[Build-Time React Email Bundle<br/>server/templates/index.js]
    end

    subgraph DataTier["3. Data & Storage Tier (Supabase)"]
        SupabaseAuth[Supabase Auth Service<br/>Anonymous & Authenticated JWTs]
        Postgres[(Supabase PostgreSQL<br/>Authoritative Schema & RLS)]
        Storage[(Supabase Object Storage<br/>Private: visitor-photos & visitor-ids)]
    end

    subgraph ExternalTier["4. External Service Providers"]
        ResendAPI[Resend REST API<br/>Transactional Email]
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
```

---

## 2. Authoritative Relational Data Model

The PostgreSQL database enforces relational integrity, unique constraints, and foreign-key cascading rules:

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
```

---

## 3. Canonical API Route Architecture

The platform's API surface is declared in `server/route-map.ts`. All endpoints run within Vercel Serverless Function instances:

### 3.1 Admin Router (`/api/admin/*`)
- `GET /api/admin/activity`: Historical audit event query for administrators.
- `GET /api/admin/dashboard`: High-level operational metrics and active gate counters.
- `GET /api/admin/devices`: Hardware scanner fleet inventory and status list.
- `GET /api/admin/emergency`: Real-time campus population roll-call for safety evacuations.
- `GET/POST/DELETE/PATCH /api/admin/holds`: Incident hold management on visitor records.
- `GET /api/admin/records`: Paginated visitor pass log with filtering by date and gate.
- `GET/POST /api/admin/retention-maintenance`: Manual or cron-authenticated retention engine.
- `GET /api/admin/settings`: Institutional configuration (working hours, retention days).
- `GET /api/admin/users`: Staff member list and profile state management.

### 3.2 Gate Router (`/api/*`)
- `POST /api/scan-pass`: Scanner endpoint for entry and exit events; verifies `token_digest` and gate.
- `POST /api/decide-visit`: Guard console decision endpoint (approve or reject entry).
- `GET /api/evidence`: Authenticated proxy for streaming private visitor photos and ID cards.

### 3.3 Passes Router (`/api/passes/*`)
- `POST /api/passes/issue`: Atomically validates evidence upload intents and issues QR gate passes.
- `POST /api/passes/email`: Two-step verification challenge and dispatch of QR passes via email.

### 3.4 Auth & System Router (`/api/*`)
- `POST /api/auth/send-email-hook`: Supabase Auth standard webhook receiver.
- `POST /api/auth/complete-password-change`: Password update handler.
- `POST /api/auth/reset-password`: Trigger password reset email.
- `POST /api/create-user`, `POST /api/update-user`: Staff management endpoints.
- `POST /api/create-device`, `POST /api/update-device`, `DELETE /api/delete-device`: Device lifecycle.
- `POST /api/update-settings`: Super Admin system settings update.
- `POST /api/purge-images`: Super Admin manual image purge.
- `GET /api/reconciliation-items`: Super Admin review of cross-system anomalies.

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

    Note over Browser,DB: 2. Issuance Phase
    Browser->>API: POST /api/passes/issue { photoIntentId, idIntentId, visitor, requestId }
    API->>Storage: Download private file & validate magic bytes / size
    API->>API: Derive HMAC-SHA256 bearer & SHA-256 token_digest
    API->>DB: RPC api.issue_pass (commits visitor, visitor_evidence, pass atomically)
    DB-->>API: Public Reference & Validity Window
    API-->>Browser: HTTP 200 { passId, qrToken, validFrom, validUntil }

    Note over Browser,DB: 3. Gate Verification Phase
    Browser->>API: Present QR at Gate -> POST /api/scan-pass (mode: entry)
    API->>DB: RPC api.scan_pass (match token_digest & update status -> pending)
    DB-->>API: Accepted -> Status: Pending Guard Review
    API-->>Browser: Scan Accepted

    Note over Browser,DB: 4. Guard Review Phase
    Browser->>DB: Guard Console invokes RPC api.guard_dashboard
    DB-->>Browser: Pending passes list
    Browser->>API: GET /api/evidence?id=<evidence_id>
    API->>Storage: Download private file
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
