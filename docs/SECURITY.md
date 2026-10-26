# Security Architecture & Threat Model

This document serves as the authoritative security specification, trust boundary definition, and threat-mitigation contract for the EARIST E-GatePass platform.

---

## 1. System Trust Boundaries

EARIST E-GatePass enforces strict security perimeters across untrusted clients, privileged serverless execution containers, authoritative database layers, and third-party integrations.

```mermaid
flowchart TB
    subgraph Untrusted["Untrusted Client Boundary"]
        Browser["Public Visitor Browser"]
        Kiosk["Walk-In Kiosk Device"]
        StaffUI["Guard & Admin Consoles"]
        ScannerUI["Gate Scanner Devices"]
    end

    subgraph Server["Privileged Server Boundary (Vercel Node.js 24)"]
        VercelAPI["Vercel Serverless Functions<br>api/ and server/"]
    end

    subgraph Data["Authoritative Database Boundary (Supabase)"]
        Auth["Supabase Auth Engine"]
        DB[("PostgreSQL + Row Level Security")]
        Storage[("Private Storage Buckets<br>visitor-photos & visitor-ids")]
    end

    subgraph External["External Services Boundary"]
        Resend["Resend Email Delivery"]
        Turnstile["Cloudflare Turnstile CAPTCHA"]
    end

    Browser -->|HTTPS / Anonymous JWT| VercelAPI
    Kiosk -->|HTTPS / Device JWT| VercelAPI
    StaffUI -->|HTTPS / Staff JWT| VercelAPI
    ScannerUI -->|HTTPS / Device JWT| VercelAPI

    Browser -->|Turnstile Token & Anon Sign-In| Auth
    Browser -.->|Complete Challenge| Turnstile
    Auth -.->|Verify CAPTCHA| Turnstile

    VercelAPI -->|JWT & Session Validation| Auth
    VercelAPI -->|Service-Role & RPC Execution| DB
    VercelAPI -->|Private Asset Validation & Download| Storage
    VercelAPI -->|HTTPS REST API / Webhooks| Resend
```

> **CORE AUTHORIZATION PRINCIPLE**: All client-side UI restrictions, role state variables, and route guards are user-experience controls only. Authoritative security enforcement resides exclusively within serverless endpoint middleware, database Row Level Security (RLS) policies, and `SECURITY DEFINER` stored procedures.

---

## 2. Multi-Actor Authentication

Incoming requests present Supabase Auth JSON Web Tokens (JWT) verified cryptographically against Supabase Auth public keys. The system resolves identity across three distinct actor classes:

```mermaid
flowchart TD
    Req["Incoming HTTP Request"]
    AuthHeader{"Authorization Bearer Present?"}
    JWTValid{"Cryptographically Valid Supabase JWT?"}
    IsRecovery{"Is Recovery Session?"}
    ActorLookup{"Identify Actor Class"}

    Req --> AuthHeader
    AuthHeader -->|No| AnonVisitor["Anonymous Visitor Scope"]
    AuthHeader -->|Yes| JWTValid
    JWTValid -->|No| Reject401["Reject: 401 Unauthorized"]
    JWTValid -->|Yes| IsRecovery

    IsRecovery -->|Yes| RecoveryScope["Recovery-Confined Scope<br>Only /api/auth/complete-password-change"]
    IsRecovery -->|No| ActorLookup

    ActorLookup --> StaffCheck{"Record in staff_profiles<br>AND active == true?"}
    StaffCheck -->|Yes| StaffRole["Resolved Role: guard / admin / superadmin"]
    StaffCheck -->|No| DeviceCheck{"Record in devices<br>AND status == active<br>AND deleted_at IS NULL?"}

    DeviceCheck -->|Yes| DeviceRole["Resolved Device: entry / exit / kiosk<br>Bound to Assigned Gate"]
    DeviceCheck -->|No| AnonVisitor
```

### Identity Resolution Rules:
1. **Anonymous Visitors**: Have valid Supabase Auth anonymous UIDs. Confined to requesting upload intents and submitting pass issuance.
2. **Staff Members**: Identified by a matching row in `public.staff_profiles` where `active = true`. Full operational eligibility also requires a confirmed Auth email (`email_confirmed_at IS NOT NULL`), completed password onboarding (`must_change_password = false`), privacy acceptance (`privacy_accepted_at IS NOT NULL`), an unconfined session (not recovery-confined), and an authorized staff role (`guard`, `admin`, `superadmin`).
3. **Managed Devices**: Identified by a matching row in `public.devices` where `status = 'active'` and `deleted_at IS NULL`. Types: `entry`, `exit`, `kiosk`.
4. **Recovery Sessions**: Explicitly flagged when authenticated via recovery magic links. Confined strictly to password reset and blocked from scanner, guard, and admin operations (`recovery_session_forbidden`).

---

## 3. Server-Side Authorization Sequence

```mermaid
sequenceDiagram
    participant C as Client (Staff / Device)
    participant API as Vercel API Endpoint
    participant Auth as Supabase Auth
    participant DB as PostgreSQL Database

    C->>API: HTTP Request + Bearer JWT
    API->>Auth: Validate JWT Signature & Claims
    Auth-->>API: Valid Session Claims (sub, email, is_anonymous)
    API->>DB: Query staff_profiles / devices for Caller UID
    DB-->>API: Active Actor Record & Role
    API->>API: Evaluate Role & Permission for Requested Action

    alt Not Authorized
        API-->>C: HTTP 403 Forbidden
    else Authorized
        API->>DB: Execute Parameterized RPC / Service-Role Query
        DB-->>API: Query Result
        API-->>C: HTTP 200 OK + Sanitized Response
    end
```

---

## 4. Institutional Role & Permission Matrix

| Operation / Capability | Anonymous Visitor | Kiosk Device | Entry Scanner | Exit Scanner | Guard | Admin | Super Admin |
|---|---|---|---|---|---|---|---|
| **Register Visitor Pass** (`/api/passes/issue`) | Allowed | Allowed | Denied | Denied | Denied | Denied | Denied |
| **Request Upload Intent** (`api.create_upload_intent`) | Allowed | Allowed | Denied | Denied | Denied | Denied | Denied |
| **Request QR Code by Email** (`/api/passes/email`) | Allowed | Allowed | Denied | Denied | Denied | Denied | Denied |
| **Scan Entry Pass** (`/api/scan-pass`, mode: `entry`) | Denied | Denied | **Allowed** | Denied | Denied | Denied | Denied |
| **Scan Exit Pass** (`/api/scan-pass`, mode: `exit`) | Denied | Denied | Denied | **Allowed** | Denied | Denied | Denied |
| **Guard Queue RPC** (`api.guard_dashboard_page`) | Denied | Denied | Denied | Denied | **Allowed** | **Allowed** | **Allowed** |
| **Approve / Reject Pass** (`/api/decide-visit`) | Denied | Denied | Denied | Denied | **Allowed** | **Allowed** | **Allowed** |
| **Stream Evidence Image** (`/api/evidence`) | Denied | Denied | Denied | Denied | **Allowed** (Pending) | **Allowed** | **Allowed** |
| **Manage Staff Accounts** (`/api/admin/users`, `/api/create-user`) | Denied | Denied | Denied | Denied | Denied | **Allowed** | **Allowed** |
| **Manage Hardware Devices** (`/api/admin/devices`, `/api/create-device`) | Denied | Denied | Denied | Denied | Denied | **Allowed** | **Allowed** |
| **Manage Incident Holds** (`/api/admin/holds`) | Denied | Denied | Denied | Denied | Denied | View Only | **Allowed** (Create & Release) |
| **Update System Settings** (`/api/update-settings`) | Denied | Denied | Denied | Denied | Denied | Denied | **Allowed** |
| **Execute Retention Maintenance** (`/api/admin/retention-maintenance`) | Denied | Denied | Denied | Denied | Denied | Denied | **Allowed** / Cron |
| **Review Reconciliation Tasks** (`/api/reconciliation-items`) | Denied | Denied | Denied | Denied | Denied | Denied | **Allowed** |
| **Promote Admin to Super Admin** (`POST /api/update-user` -> `api.update_staff_profile`) | Denied | Denied | Denied | Denied | Denied | Denied | **Allowed** |

---

## 5. Super Admin Bootstrap & Privilege Protection

To eliminate insecure public bootstrap endpoints, the initial Super Admin account is established through a database-level stored procedure:

```mermaid
flowchart TD
    A[1. Create Supabase Auth Account in Dashboard]
    B[2. Copy User UUID]
    C[3. Execute private.bootstrap_super_admin RPC in SQL Editor]
    D[4. Initial Super Admin Profile Activated]
    E[5. Log in & Create Institutional Admin Profile]
    F[6. Institutional Admin Completes Password Onboarding]
    G[7. Super Admin Promotes Institutional Admin to Super Admin]
    H[8. Verify Institutional Super Admin Access]
    I[9. Deactivate & Ban Developer Bootstrap Identity]

    A --> B
    B --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
```

### Safety Invariants:
- **One-Time Lock (Before First Staff Profile)**: Bootstrap is allowed only before the FIRST staff profile exists. Once any row exists in `public.staff_profiles` (whether Guard, Admin, or Super Admin), bootstrap is permanently locked.
- **Confirmed Human Target Validation**: Database logic verifies the target user exists in `auth.users`, is non-anonymous (`is_anonymous = false`), has a confirmed email (`email_confirmed_at IS NOT NULL`), rejects managed device pseudo-identities (`@devices.egatepass.invalid`), and requires display name length between 2 and 120 characters.
- **Database Operator Restriction**: Execution is restricted to authorized database operators (`postgres`, `supabase_admin`) and revoked from `public`, `anon`, and `authenticated`.
- **Last Super Admin Demotion Protection**: Protection is enforced at three distinct layers:
  1. **Database trigger**: `private.protect_last_superadmin` on `public.staff_profiles` blocks any UPDATE that would leave zero active Super Admins.
  2. **Stored Procedure**: `api.update_staff_profile` enforces operator checks and translates trigger violations.
  3. **API Layer**: `POST /api/update-user` translates trigger exception `23514` to HTTP 409 `cannot_remove_last_superadmin`, which the UI presents as *"Cannot demote or deactivate the last remaining Super Admin."*
- **Safe Decommissioning**: Standard decommissioning consists of deactivating the staff profile via Staff Management and suspending the Auth account (`ban_duration: '876000h'`). Direct Auth user deletion in Supabase Dashboard is blocked by `ON DELETE RESTRICT` foreign key constraints on `staff_profiles.user_id`.

---

## 6. QR Code Cryptographic Tokens & Digest Lookup

Gate passes use high-entropy cryptographically derived bearer tokens. Plaintext QR tokens are never stored in the database.

```mermaid
flowchart LR
    Request["Issuance Request<br>actorId + requestId"]
    Secret["PASS_TOKEN_SECRET<br>Min 32 Characters"]
    HMAC["HMAC-SHA256<br>base64url Encoded"]
    Bearer["Raw QR Bearer Token"]
    Digest["SHA-256 Hash<br>32 Bytes Binary"]
    DB[("public.passes.token_digest")]
    QR["Physical QR Code Display"]

    Request --> HMAC
    Secret --> HMAC
    HMAC --> Bearer
    Bearer --> Digest
    Digest --> DB
    Bearer --> QR
```

### Cryptographic Properties:
1. **Derivation**: `qrToken = createHmac('sha256', PASS_TOKEN_SECRET).update(actorId + ':' + requestId).digest('base64url')`.
2. **Digest Storage**: PostgreSQL stores only `SHA-256(qrToken)` in `public.passes.token_digest`. A database-only read compromise of token digests does not directly reveal the raw QR bearer, assuming the bearer retains sufficient entropy and `PASS_TOKEN_SECRET` remains uncompromised.
3. **Secret Rotation**: Physical QR code verification relies on the stored digest. Idempotent issuance replay recomputes the bearer using the current secret and safely detects secret rotation without corrupting issued passes.
4. **Visual Branding & Scanner Reliability**: All visitor QR codes (portal display, download, share, kiosk display, browser print, and email attachment) composite the EARIST seal in the center using High Error Correction (`errorCorrectionLevel: 'H'`), a safe 17% width ratio, and a solid white backing box. Center branding alters only visual image rendering; it NEVER mutates the underlying raw `qrToken`, its SHA-256 digest, or gate scanner verification.

---

## 7. Gate Device Scan Authorization Sequence

```mermaid
sequenceDiagram
    participant D as Scanner Hardware Device
    participant API as Vercel API (/api/scan-pass)
    participant DB as PostgreSQL Database

    D->>API: POST /api/scan-pass { passId: rawBearer, mode: 'entry' } (Bearer {device_jwt})
    API->>API: Verify Device Session & Active Status
    API->>API: Compute token_digest = SHA-256(rawBearer)
    API->>DB: RPC api.scan_pass(token_digest, mode, device_id)
    DB->>DB: Match passes.token_digest & Verify Status == 'issued'
    DB->>DB: Atomic Update: status -> 'pending', insert visit_events

    alt Scan Valid & Accepted
        DB-->>API: Status: 'pending', Gate: 'Main Gate'
        API-->>D: HTTP 200 { status: 'pending', message: 'Pending Guard Review' }
    else Invalid Status / Wrong Gate / Expired
        DB-->>API: Error: pass_expired / invalid_status / gate_mismatch
        API-->>D: HTTP 409 { error: 'Pass is not eligible for entry' }
    end
```

---

## 8. Pass State Machine Invariants

Pass lifecycle transitions are governed by database-enforced state checks:

```mermaid
stateDiagram-v2
    [*] --> issued: POST /api/passes/issue

    issued --> pending: Entry Scan (mode: entry)
    issued --> expired: Validity Window Ends

    pending --> inside: Guard Approves (POST /api/decide-visit)
    pending --> rejected: Guard Rejects (POST /api/decide-visit)

    inside --> exited: Exit Scan (mode: exit)

    rejected --> [*]
    exited --> [*]
    expired --> [*]
```

---

## 9. Evidence Ingestion & Upload Intent Architecture

To prevent arbitrary file storage injection, clients cannot upload directly without pre-authorized intents:

```mermaid
sequenceDiagram
    participant C as Visitor / Kiosk Browser
    participant API as Vercel API
    participant DB as PostgreSQL Database
    participant Storage as Private Supabase Storage

    C->>DB: RPC api.create_upload_intent(source, kind, content_type)
    DB->>DB: Verify Actor Session & Rate Limits
    DB-->>C: Returns { intent_id, bucket_id, object_path, max_bytes }

    C->>Storage: Direct Upload: storage.from(bucket_id).upload(object_path, blob)
    Storage-->>C: Upload Acknowledged

    C->>API: POST /api/passes/issue { photoIntentId, idIntentId, visitor, requestId }
    API->>DB: Query upload_intents (verify pending, owner, not expired)
    API->>Storage: Download Private Object Server-Side
    API->>API: Validate Magic Bytes (JPEG/PNG/WEBP), Max Size (5MB), Compute SHA-256
    API->>DB: RPC api.issue_pass (commits visitor, visitor_evidence, pass atomically)
    DB-->>API: Public Reference & Validity Window
    API-->>C: HTTP 200 { passId, qrToken, validFrom, validUntil }
```

---

## 10. Evidence Retrieval & Viewing Security

Staff review visitor evidence strictly through an authenticated server proxy:

```mermaid
sequenceDiagram
    participant G as Guard Console
    participant API as /api/evidence?id={uuid}
    participant DB as PostgreSQL Database
    participant Storage as Private Supabase Storage

    G->>API: GET /api/evidence?id={evidence_id} (Bearer {staff_jwt})
    API->>DB: Query visitor_evidence metadata
    DB-->>API: { visitor_id, bucket_id, object_path, content_type, expires_at, purged_at }

    alt Evidence Purged
        API-->>G: HTTP 410 Gone (Evidence Expired)
    else Evidence Expired but Under Hold
        API->>DB: Query incident_holds for visitor_id / pass_id
        alt Hold Active & Caller is Admin/SuperAdmin
            API->>DB: Insert audit_events (action: 'evidence.review_held')
            API->>Storage: Download Private Object
            Storage-->>API: Binary Stream
            API-->>G: HTTP 200 + Stream Image (Cache-Control: private, no-store)
        else No Hold or Caller is Guard
            API-->>G: HTTP 410 Gone
        end
    else Normal Active Evidence (Pending Queue)
        API->>DB: Verify passes.status == 'pending' for Guard
        API->>Storage: Download Private Object
        Storage-->>API: Binary Stream
        API-->>G: HTTP 200 + Stream Image (Sandbox CSP, nosniff)
    end
```

---

## 11. Transactional Email Security & Supply Chain

### 11.1 Supabase Auth Webhook Verification
Supabase Auth dispatches authentication events to `/api/auth/send-email-hook` using standard webhooks:
- Each incoming request is verified using the `standardwebhooks` protocol and `SEND_EMAIL_HOOK_SECRET`.
- Tampered headers, mismatched timestamps (> 5 min skew), or missing signatures are rejected with HTTP 401.

### 11.2 Email Build Supply Chain Architecture
```mermaid
flowchart LR
    TSX["Authoritative Source<br>server/templates/*.tsx & index.ts"]
    Script["Build Script<br>scripts/bundle-email-templates.mjs"]
    Bundle["Generated Runtime Artifact<br>server/templates/index.js (Git-Ignored)"]
    Trace["Vercel File Tracer<br>@vercel/nft"]
    Function["Production Auth Function<br>api/auth/send-email-hook"]

    TSX --> Script
    Script --> Bundle
    Bundle --> Trace
    Trace --> Function
```

---

## 12. QR Pass Email Verification Challenge

Visitors requesting their QR pass via email must satisfy an anti-abuse challenge:

```mermaid
sequenceDiagram
    participant V as Visitor Browser
    participant API as POST /api/passes/email
    participant DB as PostgreSQL Database
    participant Resend as Resend API

    V->>API: Action: request_code { passId, qrToken, recipientEmail }
    API->>DB: RPC api.request_qr_email_code
    Note over DB: Rate limits: 3/pass/15m, 5/recipient/15m, 10/actor/15m
    DB-->>API: verificationId & SHA-256 hashed 6-digit code
    API->>Resend: Send 6-Digit Code Email
    Resend-->>V: Deliver Code (10-minute expiry)

    V->>API: Action: verify_and_send { verificationId, code, qrToken }
    API->>DB: RPC api.claim_qr_email_dispatch
    Note over DB: Checks code hash & attempt count (max 5)
    DB-->>API: Authorized
    API->>Resend: Send Email with Embedded Pass PNG
    API->>DB: RPC api.finalize_qr_email_dispatch (record delivery status)
    API-->>V: Success Confirmation
```

---

## 13. Cloudflare Turnstile Bot Protection & Abuse Controls

### 13.1 Generic Preview Isolation & Server Secret Boundary
To maintain cryptographic boundaries and prevent experimental or pull-request builds from querying production databases or sending live emails:
- **Server Privileged Secret Isolation**: All privileged server credentials (`SUPABASE_SECRET_KEY`, `PASS_TOKEN_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `SEND_EMAIL_HOOK_SECRET`, `RESEND_WEBHOOK_SECRET`) are strictly restricted to the **Production** scope in Vercel. Generic Preview scopes receive ONLY public frontend configuration (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`).
- **Zero Production Fallback**: Server functions executing in Preview never receive production service-role or signing credentials.
- **SSO Deployment Protection**: Generic Preview deployments are protected by Vercel SSO deployment protection.

### 13.2 Turnstile Fail-Closed Enforcement Across Protected Surfaces
Cloudflare Turnstile is configured in Managed mode for authoritative bot protection:
- `VITE_TURNSTILE_SITE_KEY` is scoped to Production in Vercel.
- In Production, every protected human surface (**Visitor Portal**, **Staff Login**, **Forgot Password**) strictly fails closed: if the Turnstile site key is missing or the client omits a valid CAPTCHA response token, the action is blocked immediately at the client boundary with a security configuration error.
- In preview/local environments where `import.meta.env.PROD` is false, developer flow bypass is safely permitted.

### 13.3 Cryptographic Key Separation & Abuse Control Invariants
- Pass issuance rate limiting uses a dedicated, high-entropy server secret (`RATE_LIMIT_HMAC_SECRET`) with a minimum of 32 characters (256 bits of entropy).
- Cryptographic key separation is complete: the rate limiter NEVER falls back to `PASS_TOKEN_SECRET` or any other system secret. In Production, missing or undersized `RATE_LIMIT_HMAC_SECRET` immediately throws HTTP 503 `abuse_control_unavailable`.

### 13.4 Resend Delivery Webhook Observability & Atomic Idempotency
- Transactional email delivery outcomes are monitored via a dedicated Standard Webhooks receiver (`/api/webhooks/resend` rewritten to `/api/auth/resend-webhook`).
- Webhook payloads are verified cryptographically via Svix / Standard Webhook signatures against `RESEND_WEBHOOK_SECRET`. In Production, missing secrets fail closed with HTTP 503 `webhook_secret_unconfigured`.
- Replay and race protection is guaranteed at the database level via table `public.resend_webhook_events` (`provider_event_id UNIQUE`). Replays return HTTP 200 `already_processed` without duplicate audit logging.
- Recipient email addresses are masked (`v***r@...`) in `audit_events` to preserve privacy.
- **Neither webhook is an inbound email mailbox or reply processor.**

### 13.4 Supabase Free-Tier Security Advisor Review
Supabase Security Advisor reports `auth_leaked_password_protection` as disabled. This feature is restricted to paid Supabase tiers and is an accepted platform limitation on the current Free plan. In accordance with zero-cost architecture guidelines, password security is strictly enforced at the application boundary via mandatory 12+ character complexity, mixed-case, numbers, and symbols.

### 13.5 Content Security Policy (CSP) Directives Justification
The production CSP header enforces tight origins with explicit exemptions:
- `wasm-unsafe-eval`: Authoritatively required for client-side Tesseract.js WebAssembly OCR compilation in browser web workers.
- `style-src 'unsafe-inline'`: Required for dynamic toast notification styling (Sonner) and Radix UI dialog portal locking.
- `script-src 'unsafe-inline'`: Required for Cloudflare Turnstile explicit widget execution.

Cloudflare Turnstile protects public visitor registration, staff/device authentication, and password recovery from automated attacks:
- **Public Visitor Portal**: Non-intrusive challenge required before issuing an anonymous session.
- **Staff & Device Login (`/login`)**: Challenge verification token required for human staff credentials.
- **Password Recovery (`/forgot-password`)**: Challenge verification token required before issuing password reset emails.
- **Anonymous Pass Issuance Abuse Boundary**: Pass issuance is authoritative and concurrency-safe, rate limited by client bucket hex key via the `api.consume_rate_limit` database function on `public.rate_limit_buckets`. Idempotent replay of identical requests remains permitted.

```mermaid
flowchart TD
    Widget["Cloudflare Turnstile Widget on /get-pass"]
    Token["Visitor Solves Challenge -> captchaToken"]
    AnonSignIn["supabase.auth.signInAnonymously({ options: { captchaToken } })"]
    SupabaseAuth["Supabase Auth Service"]
    CloudflareAPI["Cloudflare Siteverify API"]
    Session["Anonymous Visitor Session Created"]

    Widget --> Token
    Token --> AnonSignIn
    AnonSignIn --> SupabaseAuth
    SupabaseAuth --> CloudflareAPI
    CloudflareAPI -->|Valid Token| Session
    CloudflareAPI -->|Invalid Token| Denied["Sign-In Rejected"]
```

*Note: The Cloudflare Turnstile Secret Key is configured in the Supabase Dashboard under Authentication > CAPTCHA / Bot & Abuse Protection. Vercel server functions do not require `Turnstile server secret`.*

---

## 14. Incident Holds & Evidence Retention

Campus security investigations require evidence preservation beyond standard retention windows:

```mermaid
stateDiagram-v2
    [*] --> ActiveEvidence: Image Uploaded & Verified

    ActiveEvidence --> EligibleForPurge: Retention Window Elapsed (Photo: 7 Days, ID: 30 Days)

    EligibleForPurge --> Held: Active row in incident_holds (active == true)
    EligibleForPurge --> Purged: No Active Hold

    Held --> EligibleForPurge: Hold Released by Admin (active = false)

    Purged --> [*]: Storage Object Erased, visitor_evidence.purged_at Marked
```

---

## 15. Cross-System Reconciliation

When an operation spans multiple systems (PostgreSQL, Storage, Resend) and encounters partial network failures:
1. The error does not abort without a record.
2. An entry is recorded in `public.reconciliation_tasks` with payload references and error details.
3. Super Admins review, retry, or acknowledge pending reconciliation items via `GET /api/reconciliation-items`.

---

## 16. Browser Security Headers (`vercel.json`)

| Security Header | Directive / Value | Purpose |
|---|---|---|
| **Content-Security-Policy** | Strict origin policy with script, frame, and connect constraints | Mitigates XSS, data exfiltration, and unauthorized frame embedding |
| **Strict-Transport-Security** | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS and protects against SSL stripping |
| **X-Frame-Options** | `DENY` | Prevents clickjacking by blocking iframe rendering |
| **X-Content-Type-Options** | `nosniff` | Blocks MIME-type sniffing by browsers |
| **Referrer-Policy** | `strict-origin-when-cross-origin` | Limits referrer leakage to third-party domains |
| **Permissions-Policy** | `camera=(self), microphone=(), geolocation=()` | Restricts hardware API access to own origin |

---

## 17. Environment Secret Classification

### Browser-Safe Client Configuration (`VITE_*`)
- `VITE_SUPABASE_URL`: Public Supabase API endpoint.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: Supabase publishable browser key (`sb_publishable_...`; intentionally public and governed by RLS).
- `VITE_TURNSTILE_SITE_KEY`: Public site key for Cloudflare Turnstile widget.

### Protected Server Secrets (Vercel Functions Only — Production Scope)
- `SUPABASE_SECRET_KEY`: Service-role key for backend operations; bypasses RLS.
- `PASS_TOKEN_SECRET`: Cryptographic secret (minimum 32 characters) for HMAC QR tokens.
- `RATE_LIMIT_HMAC_SECRET`: Dedicated cryptographic key (minimum 32 characters) for network rate-limiting HMAC.
- `CRON_SECRET`: Bearer authentication token for maintenance endpoints.
- `RESEND_API_KEY`: API key for transactional email delivery.
- `SEND_EMAIL_HOOK_SECRET`: Shared secret for Supabase Auth Send Email Hook verification.
- `RESEND_WEBHOOK_SECRET`: Shared secret for Resend Delivery Webhook verification.
- `RESEND_FROM_EMAIL`: Non-secret server configuration (`EARIST E-GatePass <notifications@egatepass.tech>`).

---

## 18. Threat Model & Mitigation Matrix

| Threat Scenario | Trust Boundary | Primary Mitigation Control | Enforcement Layer | Residual Risk |
|---|---|---|---|---|
| **Client Modifies User Role** | Untrusted Client | Roles stored in `staff_profiles`; client writes blocked | PostgreSQL RLS & Schema | Compromise of server service-role key |
| **Visitor Reads Other IDs** | Untrusted Client | Private Storage buckets; access proxy verifies role | `server/routes/gate/evidence.ts` | Stolen staff credentials |
| **Device Spoofs Device Type** | Managed Device | Hardware type bound to database `devices` row | Database device record | Physical compromise of scanner device |
| **Scanner Used at Wrong Gate** | Scanner Device | Scans checked against device gate assignment | Stored procedure `api.scan_pass` | Human error in gate assignment |
| **Stolen Token Digest** | Database Boundary | Raw token is HMAC-derived; only SHA-256 digest stored | PostgreSQL `passes.token_digest` | Weak secret or brute-force if secret leaked |
| **Replayed QR Bearer** | Gate Scanner | Pass transitions to `pending` upon first scan | Database atomic transaction | Scanning before original visitor arrives |
| **Concurrent Pass Issuance** | Visitor Registration | Idempotency key and unique token digest constraints | PostgreSQL unique constraints | Client timeout with unreturned token |
| **Forged Storage Path** | Storage Ingestion | Pre-authorized upload intents with random paths | RPC `api.create_upload_intent` | Abandoned upload intent before expiry |
| **Email Bombing / Spam** | External Integration | Tiered rate limits (pass, recipient, actor) | RPC `api.request_qr_email_code` | Distributed spam across multiple passes |
| **Forged Email Webhook** | Auth Hook Endpoint | Standard Webhook HMAC signature verification | `/api/auth/send-email-hook` | Leaked webhook secret |
| **Password Recovery Tampering** | Auth Workflow | Recovery session confined; blocked from admin/scanner | `getVerifiedSessionContext` | Attacker controls victim email inbox |
| **Accidental Last Admin Removal** | Staff Governance | Defensive check blocks demoting last Super Admin | Stored procedure & API route | Database manual override via SQL editor |
| **Evidence Deleted During Incident** | Retention Engine | Active `incident_holds` suspend automated purge | Stored procedures & cron handler | Failure of human officer to place hold |
| **Turnstile Challenge Bypass** | Public Registration | Challenge verified by Supabase Auth before session | Supabase Auth CAPTCHA | Sophisticated CAPTCHA solving farms |

---

## 19. Thermal Print Template Security Model

The thermal print template subsystem introduces a dynamic layout engine for physical ticket rendering. To prevent arbitrary code injection, cross-site scripting (XSS), or malicious image exfiltration:

### 19.1 Strict Allowlist Schema Enforcement
- **Client & Server Schema Validation**: All template JSON payloads are validated using the strict Zod schema `thermalTemplateLayoutSchema`.
- **Allowed Element Types**: Only explicit primitives are recognized: `institution_logo`, `institution_name`, `visitor_name`, `visit_date`, `qr_code`, `pass_reference`, `static_text`, `divider`, `rectangle`.
- **Rejection of Arbitrary Markup**: Any unexpected properties, script tags, HTML tags, or remote resource URLs (`http://`, `https://`) are strictly rejected.
- **Canvas Bounds**: Fixed at 384px width with bounded coordinates (`0 <= x <= 384`, `y >= 0`, `height <= 1200`). Coordinate overflow or oversized dimensions trigger immediate schema rejection.

### 19.2 Role Authorization
- **Super Admin Exclusive**: Only authenticated sessions with `staff_profiles.role = 'superadmin'` are authorized to call `api.save_thermal_template_draft` and `api.publish_thermal_template`.
- **Tamper Resistance**: Mandatory elements (`institution_name`, `visitor_name`, `visit_date`, `qr_code`, `pass_reference`) cannot be removed from a published template.

---

## 20. Guard Offline Operations & Device Storage Threat Model

During connectivity outages, operational access authority delegates to the Guard tablet. This section defines the localized storage threat model, retention invariants, and synchronization security controls:

### 20.1 Client Storage Threat Model & Honest Boundaries
- **Storage Technology**: Browser IndexedDB (`egatepass_guard_offline`).
- **Storage Boundary**: Data is isolated by browser Same-Origin Policy (`https://egatepass.tech`) and protected by the physical device screen lock.
- **Honest Security Boundary**: Browser IndexedDB is **NOT** a tamper-proof hardware security module (HSM) or hardware-backed TPM. Physical extraction from an unlocked device or rooted OS is possible.
- **Zero Server Secrets**: No server service-role keys, database passwords, or signing secrets are EVER written to browser local storage, IndexedDB, or client cookies.

### 20.2 Operational Cache Scoping & Daily Purge Policy
- **Minimal Operational Footprint**: The tablet only caches operationally relevant passes: today's date in `Asia/Manila` in `issued`, `pending`, or `inside` status. Historical passes are excluded.
- **Local Data Retention**:
  - Daily automatic purge clears previous calendar days' cached visitor records.
  - Successfully synchronized event outbox entries and offline registration records are purged upon receipt acknowledgment from the server.
  - Staff logout or session invalidation purges all sensitive local caches.

### 20.3 Server Synchronization & Conflict Defense
- **Immutable Provenance**: Every offline event carries an immutable random UUID `eventId` and `actorId`. Offline walk-in registrations carry an immutable UUID `offlineRegistrationId`.
- **No Blind Overwrite**: The server RPC `api.sync_offline_event` locks target pass rows (`FOR UPDATE`), evaluates `expected_status`, and verifies legitimate lifecycle transitions.
- **Conflict Handling**: If a pass was modified on the server during the outage (e.g. cancelled or exited remotely), the sync engine refuses to overwrite the record and writes a conflict record to `public.reconciliation_tasks` for administrative triage.

