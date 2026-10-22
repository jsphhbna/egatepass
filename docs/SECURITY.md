# Canonical Security Architecture & Threat Model

> Authoritative security specification for the EARIST E-GatePass Visitor Management System.

This document establishes the trust boundaries, cryptographic invariants, identity verification lifecycles, and defense-in-depth controls enforced across the client, serverless API, and database layers of the EARIST E-GatePass platform.

---

## 1. System Trust Boundaries

E-GatePass treats all client environments—including visitor mobile browsers, administrative dashboards, and gate scanners—as **untrusted**. Client-side validation, UI navigation guards, and React role checks are solely user experience mechanisms. Authorization authority resides strictly within the privileged serverless boundary and database Row Level Security policies.

`mermaid
flowchart TB
    subgraph Untrusted["Untrusted Client Boundary"]
        Browser[Visitor Browser / PWA]
        StaffUI[Guard & Admin Portals]
        DeviceUI[Kiosk & Gate Scanner Devices]
    end

    subgraph Server["Privileged Server Boundary (Vercel Node.js 24)"]
        API[API Handlers<br/>actors.ts & http.ts]
        TemplateBundle[Precompiled React Email Bundle]
    end

    subgraph Data["Authoritative Data Boundary (Supabase / PostgreSQL)"]
        Auth[Supabase Auth Service]
        DB[(PostgreSQL 15 Engine<br/>RLS + SECURITY DEFINER RPCs)]
        Storage[(Private Storage Buckets<br/>visitor-id-documents / visitor-photos)]
    end

    subgraph External["External Services Boundary"]
        Resend[Resend API (TLS)]
        Turnstile[Cloudflare Turnstile API]
    end

    Browser -->|HTTPS Request| API
    StaffUI -->|HTTPS + Bearer JWT| API
    DeviceUI -->|HTTPS + Device Bearer| API

    Browser -->|Anonymous Auth| Auth
    StaffUI -->|Session Auth| Auth
    DeviceUI -->|Device Login| Auth

    Browser -.->|Direct Signed Upload Intent| Storage

    API -->|Validate Token / User| Auth
    API -->|service_role Privileged RPCs| DB
    API -->|Admin Signed URLs / Purge| Storage
    API -->|REST API Key| Resend
    API -->|Siteverify Secret| Turnstile

    Browser -->|Widget Verification| Turnstile
`

---

## 2. Authentication & Identity Resolution

Every authenticated mutation or query resolves caller authority through server-side token validation followed by database-backed role resolution.

`mermaid
flowchart TD
    Req[Incoming API Request]
    AuthHeader{Authorization Header Present?}
    JWT{Valid Supabase Auth JWT?}

    Req --> AuthHeader
    AuthHeader -->|No| AnonCheck{Public / Anon Endpoint?}
    AuthHeader -->|Yes| JWT

    AnonCheck -->|Yes| AllowAnon[Execute with Anonymous Authority]
    AnonCheck -->|No| Reject401[Reject: HTTP 401 Unauthorized]

    JWT -->|Invalid / Expired| Reject401
    JWT -->|Valid JWT| ResolveActor[Extract Supabase UID]

    ResolveActor --> CheckStaff{Record in staff_profiles?}
    CheckStaff -->|Active Staff Profile| ResolveStaffRole[Role: guard / admin / superadmin]
    CheckStaff -->|No Profile| CheckDevice{Record in public.devices?}

    CheckDevice -->|Active Device Record| ResolveDeviceRole[Device Type: kiosk / entry / exit<br/>Assigned Gate Scope]
    CheckDevice -->|No Device| CheckVisitor{Anonymous Visitor Session?}

    CheckVisitor -->|Valid Visitor ID| VisitorScope[Visitor Authority: Self-Owned Only]
    CheckVisitor -->|Unrecognized| Reject403[Reject: HTTP 403 Forbidden]
`

---

## 3. Server-Side Authorization Sequence

No client interacts directly with arbitrary tables in PostgreSQL. Operations are funneled through privileged serverless endpoints that authenticate callers and invoke constrained database RPCs.

`mermaid
sequenceDiagram
    autonumber
    actor Client as Client Browser / Scanner
    participant API as Vercel Serverless Function
    participant Auth as Supabase Auth
    participant DB as PostgreSQL Database

    Client->>API: HTTP Request + Bearer JWT
    API->>Auth: supabase.auth.getUser(token)
    Auth-->>API: Validated User Object (UID)

    API->>DB: Query staff_profiles or devices by UID
    DB-->>API: Active Profile (role, status, gate_id)

    API->>API: Validate role against required operation permissions

    alt Authorized
        API->>DB: Execute SECURITY DEFINER RPC (e.g., api.decide_visit)
        DB->>DB: Internal assertion of search_path = '' and row locks
        DB-->>API: Transactional Result
        API-->>Client: HTTP 200 + Sanitized JSON Response
    else Unauthorized Role / Inactive Status
        API-->>Client: HTTP 403 Forbidden { error: 'insufficient_privileges' }
    end
`

---

## 4. Role & Capability Matrix

| Capability / Action | Visitor | Kiosk | Entry Scanner | Exit Scanner | Campus Guard | Administrator | Super Admin |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Self-Service Pre-Registration** | Yes | No | No | No | No | No | No |
| **Walk-In Assisted Registration** | No | Yes | No | No | No | No | No |
| **Request Evidence Upload Intent** | Yes | Yes | No | No | No | No | No |
| **Issue Pass Record** | Yes | Yes | No | No | No | Yes | Yes |
| **Scan QR at Entry (Pending)** | No | No | Yes | No | No | No | No |
| **Review Evidence Queue** | No | No | No | No | Yes | Yes | Yes |
| **Approve / Reject Pass (Inside)** | No | No | No | No | Yes | Yes | Yes |
| **Scan QR at Exit (Exited)** | No | No | No | Yes | No | No | No |
| **Emergency Evacuation Roster** | No | No | No | No | No | Yes | Yes |
| **Manage Hardware Devices** | No | No | No | No | No | Yes | Yes |
| **Create Incident Security Hold** | No | No | No | No | No | Yes | Yes |
| **Release Incident Security Hold** | No | No | No | No | No | No | Yes |
| **Run Retention Evidence Purge** | No | No | No | No | No | No | Yes |
| **Provision Staff (Invite)** | No | No | No | No | No | No | Yes |
| **Promote to Super Admin** | No | No | No | No | No | No | Yes |

---

## 5. Super Admin Bootstrap & Privileged Governance

To prevent account takeover and eliminate default hardcoded administrator accounts, E-GatePass enforces a zero-trust bootstrap lifecycle:

`mermaid
flowchart TD
    A[Create Initial Supabase Auth Account via Dashboard / CLI]
    B[Extract Auth User UUID]
    C[Execute private.bootstrap_super_admin RPC in SQL Editor]
    D[Primary Bootstrap Super Admin Profile Initialized]
    E[Invite Institutional Administrator Account]
    F[Institutional Administrator Accepts Invite & Sets Password]
    G[Super Admin Promotes Institutional Admin to Super Admin]
    H[Verify Institutional Super Admin Access]
    I[Disable or Demote Initial Developer Bootstrap Account]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
`

### Governance Protections

1. **Bootstrap Lockout**: The private.bootstrap_super_admin function fails closed if **any** profile already exists in staff_profiles.
2. **Last Super Admin Invariant**: Database triggers prevent deleting, deactivating, or demoting the last remaining active Super Admin profile.
3. **No Role Spoofing in Metadata**: User roles are strictly stored in public.staff_profiles(role) and never inferred from mutable uth.users(raw_user_meta_data).

---

## 6. Cryptographic QR Pass Security

QR passes use high-entropy bearer secrets generated on the server. Physical QR codes presented by visitors contain bearer tokens that are never stored directly in plaintext within the database.

`mermaid
flowchart LR
    PassID[Pass Identifier UUID]
    HMAC[HMAC-SHA256<br/>PASS_TOKEN_SECRET]
    Bearer[64-Char High Entropy Bearer Token]
    Digest[SHA-256 Hash Digest]
    DB[(public.passes.qr_token_hash)]

    PassID --> HMAC
    HMAC --> Bearer
    Bearer -->|Encoded into QR Graphic| VisitorScreen[Visitor Screen / Paper Ticket]
    Bearer --> Digest
    Digest --> DB
`

### Invariants

- **Storage Invariant**: Only the SHA-256 digest (qr_token_hash) is stored in PostgreSQL. Even a complete read compromise of the database does not reveal the bearer tokens needed to construct valid QR codes.
- **Rotation Invariant**: Rotating PASS_TOKEN_SECRET does not invalidate existing issued passes because pass lookup is performed against the immutable digest stored at creation time.

---

## 7. Gate QR Verification & Scan Authorization

`mermaid
sequenceDiagram
    autonumber
    actor Scanner as Managed Scanner Device
    participant API as Vercel /api/gate/scan-pass
    participant DB as PostgreSQL Database

    Scanner->>API: POST /api/gate/scan-pass { qr_token, scan_type: 'entry' }<br/>Authorization: Bearer <device_jwt>
    API->>API: Verify caller device type matches scan_type (e.g. entry device)
    API->>API: Compute token_hash = sha256(qr_token)

    API->>DB: Atomic RPC: api.scan_pass(token_hash, scan_type, gate_id)
    DB->>DB: SELECT * FROM passes WHERE qr_token_hash = token_hash FOR UPDATE
    
    alt Pass Not Found
        DB-->>API: Error: invalid_pass
        API-->>Scanner: HTTP 404 Not Found
    else Expired
        DB-->>API: Error: pass_expired
        API-->>Scanner: HTTP 422 Unprocessable Entity
    else State Mismatch (e.g. Already inside)
        DB-->>API: Error: invalid_state_transition
        API-->>Scanner: HTTP 409 Conflict
    else Valid Entry Transition
        DB->>DB: UPDATE passes SET status = 'pending', entered_at = statement_timestamp()
        DB->>DB: INSERT INTO visit_events (pass_id, event_type, gate_id, actor_id)
        DB-->>API: Success { pass_id, visitor_name, status: 'pending' }
        API-->>Scanner: HTTP 200 OK
    end
`

---

## 8. Pass State Machine Invariants

`mermaid
stateDiagram-v2
    [*] --> issued: Pass created via Portal or Kiosk

    issued --> pending: Valid Entry Scan at Assigned Gate
    issued --> expired: valid_until timestamp exceeded

    pending --> inside: Campus Guard approves entry
    pending --> rejected: Campus Guard denies entry

    inside --> exited: Valid Exit Scan at Assigned Gate

    rejected --> [*]
    exited --> [*]
    expired --> [*]
`

### Invariants Enforced in PostgreSQL

- issued passes can only transition to pending (via entry scan) or expired (via time expiry).
- pending passes can only transition to inside (via guard approval) or ejected (via guard denial).
- inside passes can only transition to exited (via exit scan).
- All transitions log an immutable row in public.visit_events.

---

## 9. Evidence Upload & Isolation Protocol

Visitors upload face photos and government ID images directly to private Supabase Storage buckets using pre-authorized single-use upload intents.

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor Browser
    participant API as Vercel /api/passes/issue
    participant DB as PostgreSQL Database
    participant Storage as Supabase Private Storage

    V->>API: POST /api/passes/issue (visitor metadata, requested intents)
    API->>DB: RPC: api.create_evidence_upload_intent(user_id, bucket, mime_type)
    DB-->>API: Intent ID, object path, 10-minute expiry
    API-->>V: Signed Upload Intent Credentials

    V->>Storage: Direct POST/PUT object to private bucket path
    Storage-->>V: Upload HTTP 200 OK

    V->>API: POST /api/passes/finalize-evidence { intent_id, object_path }
    API->>Storage: HEAD object: verify size, content type
    API->>DB: RPC: api.claim_evidence(intent_id)
    DB->>DB: Mark intent claimed, create evidence record in public.evidence
    DB-->>API: Evidence verified & claimed
    API-->>V: Pass Issuance Complete
`

---

## 10. Valid ID Privacy & Retention Lifecycle

Identity document images are protected under strict retention schedules and are scrubbed automatically once visits conclude.

`mermaid
flowchart TD
    Camera[Live Camera ID Capture]
    OCR[Local Client Tesseract OCR Engine]
    UserReview[Visitor Reviews / Corrects Fields]
    Upload[Private Storage: visitor-id-documents]
    Evidence[Evidence Metadata Record]
    Retention[Retention Expiry Window Reached]
    HoldCheck{Active Incident Hold Applied?}
    Purge[Permanent Deletion from Storage & Hash Redaction]
    Retain[Preserve Evidence Until Security Hold Released]

    Camera --> OCR
    OCR --> UserReview
    UserReview --> Upload
    Upload --> Evidence
    Evidence --> Retention
    Retention --> HoldCheck
    HoldCheck -->|No Active Hold| Purge
    HoldCheck -->|Active Hold Present| Retain
    Retain --> HoldCheck
`

> **Privacy Assertion**: OCR is strictly a text-extraction algorithm run inside the client's WebAssembly sandbox. E-GatePass does **not** perform automated facial recognition, remote biometric verification, or cross-referencing against external identity databases.

---

## 11. Transactional Email Security (Supabase Auth Hook)

Supabase Auth sends email events as signed HTTP webhooks. The receiver verifies standard cryptographic webhook signatures before processing.

`mermaid
sequenceDiagram
    autonumber
    participant SA as Supabase Auth
    participant Hook as Vercel /api/auth/send-email-hook
    participant Verify as StandardWebhooks Validator
    participant Bundle as React Email Runtime Bundle
    participant Resend as Resend API

    SA->>Hook: POST /api/auth/send-email-hook (raw payload)<br/>Headers: webhook-id, webhook-timestamp, webhook-signature
    Hook->>Verify: verify(rawBody, headers, SEND_EMAIL_HOOK_SECRET)

    alt Signature Invalid or Timestamp Skewed (>5 min)
        Verify-->>Hook: Invalid
        Hook-->>SA: HTTP 401 Unauthorized { error: 'invalid_webhook_signature' }
    else Signature Valid
        Verify-->>Hook: Signature Verified
        Hook->>Bundle: Render appropriate email template (e.g. StaffInviteEmail)
        Bundle-->>Hook: Sanitized HTML markup
        Hook->>Resend: POST https://api.resend.com/emails
        Resend-->>Hook: HTTP 200 { id: 're_...' }
        Hook-->>SA: HTTP 200 {}
    end
`

---

## 12. Build-Time Email Supply Chain Architecture

To ensure total determinism across Vercel Functions and prevent runtime module resolution errors (ERR_MODULE_NOT_FOUND):

`mermaid
flowchart LR
    Source[server/templates/index.ts<br/>+ 9 TSX Templates]
    Esbuild[scripts/bundle-email-templates.mjs<br/>esbuild Node compiler]
    Artifact[server/templates/index.js<br/>precompiled JS bundle - git ignored]
    NFT[Vercel Node File Trace]
    Runtime[Production Node.js 24 Serverless Function]

    Source --> Esbuild
    Esbuild --> Artifact
    Artifact --> NFT
    NFT --> Runtime
`

---

## 13. Self-Service QR Email Dispatch Verification

To prevent email spam and unauthorized pass interception, sending a QR code via email requires a 6-digit challenge verification code:

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor
    participant API as Vercel API
    participant DB as PostgreSQL Database
    participant Resend as Resend API

    V->>API: POST /api/passes/email/request-code { public_reference, email }
    API->>DB: Atomic RPC: api.request_email_verification_code
    DB->>DB: Enforce rate limit (max 5/hr/recipient, max 3/pass)
    DB->>DB: Generate random 6-digit code with bcrypt-compatible hash
    DB-->>API: 6-digit challenge code
    API->>Resend: Send VerificationCodeEmail
    Resend->>V: Delivery to visitor inbox

    V->>API: POST /api/passes/email/verify-and-send { public_reference, code }
    API->>DB: Atomic RPC: api.verify_and_claim_email_dispatch
    DB->>DB: Verify code, expiry (5 min), and failed attempts (<5)
    DB-->>API: Dispatch claim granted
    API->>Resend: Send PassIssuedEmail with attached QR code
    API->>DB: Atomic RPC: api.finalize_email_dispatch
    DB-->>API: Status marked 'dispatched'
    API-->>V: Success confirmed
`

---

## 14. Password Recovery Authority Verification

A URL containing ?type=recovery alone does **not** grant password reset authorization. The frontend requires a verified Supabase Auth session event before allowing password modification.

`mermaid
flowchart TD
    URL[User Clicks Email Link]
    ParamCheck{URL contains type=recovery?}
    AuthListener[Supabase Auth State Change Listener]
    EventCheck{PASSWORD_RECOVERY Event Emitted?}
    SessionValid{Valid Authenticated Session Present?}
    AllowReset[Render Password Reset Form]
    DenyReset[Redirect to Login / Show Invalid Session Error]

    URL --> ParamCheck
    ParamCheck -->|No| DenyReset
    ParamCheck -->|Yes| AuthListener
    AuthListener --> EventCheck
    EventCheck -->|No| DenyReset
    EventCheck -->|Yes| SessionValid
    SessionValid -->|Yes| AllowReset
    SessionValid -->|No| DenyReset
`

---

## 15. Cloudflare Turnstile Bot Deterrence Flow

`mermaid
sequenceDiagram
    autonumber
    actor V as Visitor Browser
    participant T as Cloudflare Turnstile
    participant API as Vercel API

    V->>T: Load Turnstile widget & complete challenge
    T-->>V: Ephemeral one-time Turnstile token
    V->>API: POST /api/passes/issue { ...visitorData, turnstile_token }
    API->>T: POST https://challenges.cloudflare.com/turnstile/v0/siteverify
    T-->>API: Response { success: true/false }

    alt Verification Passed
        API->>API: Continue pass issuance
    else Verification Failed
        API-->>V: HTTP 403 Forbidden { error: 'bot_verification_failed' }
    end
`

---

## 16. Concurrency & Idempotency Controls

All state-changing endpoints implement database-level concurrency fencing using PostgreSQL transactional advisory locks and partial unique indexes.

`mermaid
flowchart TD
    Req[Incoming State Mutation Request]
    ExtractKey[Extract Idempotency Key / Request ID]
    Lock[Acquire Advisory Lock: pg_advisory_xact_lock]
    CheckExisting{Existing Record with Request ID?}

    Req --> ExtractKey
    ExtractKey --> Lock
    Lock --> CheckExisting

    CheckExisting -->|Same Completed Request| ReturnCached[Return Idempotent Cached Result]
    CheckExisting -->|Conflicting In-Flight Operation| ReturnConflict[Reject: HTTP 409 Conflict]
    CheckExisting -->|Fresh Request| ExecuteTx[Execute Atomic State Transition]

    ExecuteTx --> CommitTx[Commit Transaction & Release Lock]
`

---

## 17. Evidence Retention & Incident Holds

`mermaid
stateDiagram-v2
    [*] --> ActiveEvidence: Pass Issued & Evidence Recorded

    ActiveEvidence --> EligibleForPurge: Retention Window Elapsed (e.g. 30 days)

    EligibleForPurge --> SuspendedUnderHold: Incident Hold Created by Admin
    EligibleForPurge --> Purged: Retention Cleanup Job Runs (No Hold)

    SuspendedUnderHold --> EligibleForPurge: Incident Hold Released by Super Admin

    Purged --> [*]
`

---

## 18. Cross-System Partial Failure Reconciliation

When a workflow spans multiple autonomous systems (e.g., Supabase PostgreSQL and Resend), partial failures are captured in public.reconciliation_tasks for auditing and resolution.

`mermaid
flowchart TD
    Step1[Step 1: Database Mutation Committed]
    Step2[Step 2: External Provider Call (Resend / Storage)]
    CheckResult{Provider Call Succeeded?}
    Success[Operation Finalized]
    Task[Insert Task into public.reconciliation_tasks]
    AdminAlert[Flagged in Super Admin Dashboard]

    Step1 --> Step2
    Step2 --> CheckResult
    CheckResult -->|Yes| Success
    CheckResult -->|No / Network Timeout| Task
    Task --> AdminAlert
`

---

## 19. Browser Security Headers

Configured directly in ercel.json and applied to all outgoing responses:

| Security Header | Configured Value | Purpose |
|:---|:---|:---|
| **Content-Security-Policy** | default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; media-src 'self' data: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; | Prevents XSS, data exfiltration, clickjacking, and unauthorized third-party scripts. |
| **Strict-Transport-Security** | max-age=31536000; includeSubDomains; preload | Enforces HTTPS connections and prevents SSL-stripping attacks. |
| **X-Content-Type-Options** | 
osniff | Prevents MIME-type sniffing by browsers. |
| **X-Frame-Options** | DENY | Disallows rendering the application inside frames/iframes to eliminate clickjacking. |
| **Referrer-Policy** | strict-origin-when-cross-origin | Strips path and query information from cross-origin referrer headers. |
| **Permissions-Policy** | camera=(self), microphone=(), geolocation=(), browsing-topics=() | Restricts camera access strictly to the application origin; disables microphone and tracking APIs. |

---

## 20. Secret Classification Matrix

| Variable Name | Exposure Boundary | Secret? | Operational Role |
|:---|:---|:---:|:---|
| VITE_SUPABASE_URL | Public / Browser Bundle | No | Canonical Supabase project API gateway |
| VITE_SUPABASE_PUBLISHABLE_KEY | Public / Browser Bundle | No | Public Supabase client key with RLS enforcement |
| VITE_TURNSTILE_SITE_KEY | Public / Browser Bundle | No | Cloudflare Turnstile public challenge site key |
| SUPABASE_SECRET_KEY | Vercel Serverless Runtime Only | **YES** | Privileged database access bypassing RLS |
| PASS_TOKEN_SECRET | Vercel Serverless Runtime Only | **YES** | 32-byte secret key for HMAC-SHA256 QR generation |
| RESEND_API_KEY | Vercel Serverless Runtime Only | **YES** | Resend API token for transactional email dispatch |
| SEND_EMAIL_HOOK_SECRET | Vercel Serverless Runtime Only | **YES** | Standard Webhook secret for verifying Supabase Auth hooks |
| CRON_SECRET | Vercel Serverless Runtime Only | **YES** | Bearer secret authenticating Vercel Cron maintenance tasks |
| RESEND_FROM_EMAIL | Vercel Serverless Runtime Only | No | Verified institutional sender address |

---

## 21. Threat & Mitigation Matrix

| Threat Description | Trust Boundary | Primary Mitigating Control | Enforcement Layer | Residual Risk |
|:---|:---|:---|:---|:---|
| **Client modifies own user role** | Client → Server | Roles stored in staff_profiles(role), never in JWT metadata. | Database RLS & API | Zero client write access to staff_profiles. |
| **Visitor accesses another's evidence** | Client → Storage | Storage RLS permits access only if active signed upload intent matches caller. | Supabase Storage RLS | Low; signed URLs expire in 60 seconds. |
| **Compromised QR database digest** | Data Boundary | Database stores only SHA-256 digest; QR bearer contains HMAC secret. | Server Cryptography | High entropy prevents rainbow table precomputation. |
| **Replayed QR bearer token** | Gate Boundary | State machine allows entry only from issued state; transitions are atomic. | PostgreSQL Row Locks | Physical QR clone cannot be reused after entry. |
| **Forged Auth Email Hook** | External → Server | Webhook HMAC-SHA256 signature and timestamp validated via standardwebhooks. | Vercel API Gateway | Zero unauthenticated webhook execution. |
| **Password reset parameter tampering** | Client → Auth | 	ype=recovery query param verified against genuine Auth state change event. | React Auth Listener | Bypasses without email verification rejected. |
| **Last Super Admin deleted/demoted** | Admin UI → Database | PostgreSQL trigger rejects any mutation that reduces active Super Admins to 0. | Database Trigger | Super Admin lockout programmatically impossible. |
| **Evidence deleted during investigation** | Retention Cleanup | public.incident_holds table checked before any evidence purge. | SQL Retention Definer | Evidence remains protected until explicit release. |
| **Turnstile verification bypass** | Visitor → API | Server-side validation against https://challenges.cloudflare.com/turnstile/v0/siteverify. | Vercel Serverless API | Single-use tokens prevent replay attacks. |
