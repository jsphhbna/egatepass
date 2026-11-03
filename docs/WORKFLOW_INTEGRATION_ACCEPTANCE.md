# E-GatePass — Cross-System Workflow Integration & Physical Acceptance Runbook

## 1. Overview & Baseline

- **Repository:** `jsphhbna/egatepass`
- **Branch:** `main`
- **Production URL:** `https://egatepass.tech`
- **Scope:** Online Visitor Portal, Kiosk Pass Portal, Entry Scanner, Exit Scanner, Guard Station, Admin Console, and Super Admin Management.

This document serves as the authoritative integration closure and verification contract connecting all subsystems of E-GatePass. It details the actual data contracts, operational state machines, security boundaries, and validation results across each workflow stage verified against source code and database RPC definitions.

---

## 2. End-to-End Workflow Architecture & State Lifecycle

```
[ Visitor Portal: /get-pass ]
              │
              ├── Fresh Registration (Face selfie, structured PSGC address, optional vehicle)
              └── Returning Visitor (1:1 Biometric Face Match -> Address & Postal Hydration)
              │
              ▼
    [ API: /api/passes/issue ]
              │
              ├── Computes qrToken: HMAC-SHA256(PASS_TOKEN_SECRET, actorId:requestId)
              ├── Computes token_digest: SHA-256(qrToken) stored in public.passes
              │
              ▼ (Atomic Transaction: passes, visitors, vehicle_declarations)
     Pass Status: 'issued' (source: 'portal')
              │
              ▼
   [ Visitor Pass QR Issued ] (Encodes raw qrToken string)
              │
              ▼
    [ Entry Scanner: /scan/entry ] (Dedicated Device Session Auth)
              │
              ├── POST /api/scan-pass (mode: 'entry', passId: qrToken)
              │     │
              │     ├── Computes digest: SHA-256(passId)
              │     ▼
              │   Database RPC: api.scan_pass(requested_token_digest, mode: 'entry')
              │     ├── Matches passes p WHERE p.token_digest = decode(digest, 'hex')
              │     │
              │     ├── Portal Pass -> Status: 'inside' (time_in: now(), gate assigned)
              │     │                  Entry Scanner UI: 'granted' (Green check UI via entryScanFeedback.ts)
              │     │
              │     └── Kiosk Pass  -> Status: 'pending' (entry_scanned_at: now())
              │                        Entry Scanner UI: 'pending' (Amber waiting UI via entryScanFeedback.ts)
              │
              ▼
   [ Guard Station: /guard ] (Guard Station Device Session Auth)
              │
              ├── GET /api/guard-station-feed?limit=50 (HTTP Polling every 4s, status IN ('inside', 'exited'))
              │     │
              │     ▼
              │   Photo Inspection: GET /api/evidence?id=<photo_evidence_id>
              │   (Physical photo-to-face visual comparison at physical gate barrier)
              │   *Permits 'photo' and 'vehicle_photo'; Government ID ('id_document') strictly rejected with 403*
              │
              ▼
   [ Exit Scanner: /scan/exit ] (Dedicated Device Session Auth)
              │
              ├── POST /api/scan-pass (mode: 'exit', passId: qrToken)
              │     │
              │     ▼
              │   Database RPC: api.scan_pass(mode: 'exit')
              │     ├── Validates entry gate matches scanner gate (wrong_gate fail-closed)
              │     ├── Passes status -> 'exited' (time_out: now(), exit_device_id recorded)
              │     └── Vehicle declarations -> exit_scanned_at: now(), exit_recorded_at: now()
              │
              ▼
[ Admin & Super Admin Consoles: /admin ]
              ├── Realtime Dashboard: GET /api/admin/dashboard
              ├── Visitor Records: GET /api/admin/records
              ├── Device Management: GET /api/admin/devices, POST /api/create-device, POST /api/update-device, DELETE /api/delete-device
              ├── User Management: GET /api/admin/users, POST /api/create-user, POST /api/update-user, POST /api/decommission-user
              ├── Staff Kiosk Approval: POST /api/decide-visit (/admin/legacy-guard)
              ├── System Settings: GET /api/admin/settings, POST /api/update-settings
              ├── Emergency Evacuation Snapshot: GET /api/admin/emergency
              ├── Incident Holds: GET /api/admin/holds
              └── Audit Logs: GET /api/admin/activity
```

---

## 3. Cryptographic Token & Verification Lifecycle (Source Verified)

1. **Token Generation (Issuance — `server/routes/passes/issue.ts`):**
   - The server reads `PASS_TOKEN_SECRET` (minimum 32 characters).
   - Generates an HMAC-SHA256 signature over `${actorId}:${parsed.data.requestId}`:
     ```ts
     const qrToken = createHmac('sha256', secret)
       .update(`${actorId}:${parsed.data.requestId}`)
       .digest('base64url');
     ```
   - The generated `qrToken` is returned in the API response and rendered into the visitor's QR code.
2. **Database Storage (`public.passes`):**
   - The raw `qrToken` is **never stored** in the database.
   - The issuance handler computes a standard unsalted SHA-256 hash digest of the `qrToken`:
     ```ts
     const tokenDigest = createHash('sha256').update(qrToken).digest('hex');
     ```
   - This 64-character hex string is decoded and stored as a 32-byte binary column `token_digest bytea` in `public.passes`.
3. **Scanner Submission & Verification (`server/routes/gate/scan-pass.ts`):**
   - The scanner optical reader decodes the QR code and submits `passId` (`qrToken`) over TLS with its device bearer token.
   - The API handler computes:
     ```ts
     const digest = createHash('sha256').update(parsed.data.passId).digest('hex');
     ```
   - Invokes `api.scan_pass(..., requested_token_digest: digest, requested_mode: mode)`.
4. **Database Matching (`api.scan_pass` RPC):**
   - The scanner computes a SHA-256 digest of the presented QR token and passes the digest to `api.scan_pass()`. The database matches it against the stored binary token digest under a row-level lock.
   - Queries `public.passes p WHERE p.token_digest = decode(requested_token_digest, 'hex') FOR UPDATE`.

---

## 4. Subsystem Integration & Security Boundary Matrix

| Stage | Subsystem | Endpoint / Event | Source & Target Roles | State Transition | Security & Privacy Boundary | Verification Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Visitor Registration** | Online Portal (`/get-pass`) | `POST /api/passes/issue` | Anonymous visitor -> API Service | `null` -> `issued` | Turnstile token check; PSGC reference validation; stores SHA-256 token digest. | **PASS** (Playwright + Vitest) |
| **2. Returning Biometrics** | Online Portal (`/get-pass`) | `POST /api/passes/identify-returning` | Anonymous visitor -> API Service | 1:1 Biometric Verification | Cosine similarity thresholding (SFace reference >= 0.363); HMAC matchToken digest fail-closed check. | **PASS** (`tests/returning-visitor.test.ts`) |
| **3. Address & Postal State** | Cascading Selector | Pure Resolution Hook | Client React State | Locality restored / preserved | `src/lib/psgcAddressResolution.ts` pure state machine preserves manual overrides on same-locality selection. | **PASS** (Playwright + Vitest) |
| **4. Gate Entry Scan** | Entry Scanner (`/scan/entry`) | `POST /api/scan-pass` | Entry Device (`device_type = entry`) -> API | `issued` -> `inside` (Portal) OR `issued` -> `pending` (Kiosk) | Device session auth; token digest verification; prevents replay; atomic vehicle duplicate entry lock. | **PASS** (Vitest unit + PGlite DB RPC) |
| **5. Entry Scanner UI** | Entry Scanner UI | Shared Decision Helper (`entryScanFeedback.ts`) | Scan Result -> Operator Display | `ready` -> `granted` / `pending` / `error` | Only explicit `inside` yields `'granted'`; only explicit `pending` yields `'pending'`; unknown/missing fails closed to `'error'`. | **PASS** (`tests/entry-scan-feedback.test.ts`) |
| **6. Guard Station Feed** | Guard Station (`/guard`) | `GET /api/guard-station-feed` | Guard Station Device (`guard_station`) -> API | Feed read (`status IN ('inside', 'exited')`) | Asia/Manila current calendar day filter; assigned gate scope; HTTP self-scheduling polling (4s delay). | **PASS** (`tests/guard-station-device.test.ts`) |
| **7. Photo Inspection** | Guard Station (`/guard`) | `GET /api/evidence?id=...` | Guard Station Device -> API | Photo delivery | Strictly delivers `photo` and `vehicle_photo` for active/exited visits at gate; Government ID (`id_document`) returns 403. | **PASS** (Contract tested in PGlite) |
| **8. Gate Exit Scan** | Exit Scanner (`/scan/exit`) | `POST /api/scan-pass` | Exit Device (`device_type = exit`) -> API | `inside` -> `exited` | Exit device auth; gate match validation (`wrong_gate` check); sets `time_out` and vehicle exit timestamps. | **PASS** (PGlite contract test) |
| **9. Kiosk Approval** | Legacy Guard Console (`/admin/legacy-guard`) | `POST /api/decide-visit` | Staff Administrator (`role in admin, superadmin`) -> API | `pending` -> `inside` (Approved) OR `pending` -> `rejected` | Ordinary guard station accounts deprecated from approval; requires authenticated staff administrator. | **PASS** (Migration 41 & 42 tests) |
| **10. Admin Console** | Admin (`/admin/dashboard`, `/admin/records`, etc.) | Specific `/api/admin/*` routes | Authenticated Admin / Super Admin | Realtime read / write / export | Role-based access control; immutable audit logging on sensitive operations. | **PASS** (TypeScript build + unit) |

---

## 5. Subsystem Source-Code & API Map

Rather than a generic query endpoint, the administrative console communicates through distinct, purpose-specific API routes:

- **Dashboard Realtime Metrics:** `GET /api/admin/dashboard`
- **Visitor Records & Audit Search:** `GET /api/admin/records`
- **Device Management & Enrollment:** `GET /api/admin/devices`, `POST /api/create-device`, `POST /api/update-device`, `DELETE /api/delete-device`, `POST /api/update-device-auth`, `POST /api/device/reauthenticate`
- **Staff User Accounts:** `GET /api/admin/users`, `POST /api/create-user`, `POST /api/update-user`, `POST /api/decommission-user`
- **Campus Settings & Capacities:** `GET /api/admin/settings`, `POST /api/update-settings`
- **Emergency Evacuation Snapshot:** `GET /api/admin/emergency` (retrieves active campus evacuation roster; read-only evacuation telemetry, does not trigger lockdown or mutate pass states)
- **Incident Holds:** `GET /api/admin/holds`
- **Security Audit Trail Activity:** `GET /api/admin/activity`
- **Automated Image Purge & Retention:** `POST /api/purge-images`, `POST /api/admin/retention-maintenance`
- **Kiosk Pass Review & Decision:** `POST /api/decide-visit` (Admin / Super Admin role required)

---

## 6. Comprehensive Test Suite Evidence Map

| Test Suite File | Feature & Scope Covered | Declared Tests | Test Type | Invariants Proven |
| :--- | :--- | :--- | :--- | :--- |
| `tests/entry-scan-feedback.test.ts` | Production scanner response mapping ([`src/lib/entryScanFeedback.ts`](../src/lib/entryScanFeedback.ts)) | 13 | Unit | Proves `inside` -> `granted`, `pending` -> `pending`, unknown/missing statuses fail closed to `error`, timeouts & network failures provide proper operator guidance. |
| `tests/returning-visitor-address-hardening.test.ts` | PSGC normalization, reference validation, postal code reconstruction, profile persistence | 58 | Integration / Unit | Proves PSGC 10-digit locality normalization, fail-closed persistence in `issue.ts`, honest PHLPost provenance, and same-locality manual override preservation. |
| `tests/returning-visitor.test.ts` | Returning visitor biometric, cryptographic, configuration, and related utility behavior | 20 | Unit / Integration | Proves 1:1 biometric threshold readiness, provisional vs calibrated cosine matching, AES-256-GCM embedding encryption/decryption, Manila business date calculation, safety ceilings, token digest verification, and cryptographic utilities. |
| `tests/returning-visitor-lookup.test.ts` | Returning visitor profile lookup & privacy masking | 7 | Integration | Proves method enforcement (405), token auth (401), payload validation (400), non-anonymous session rejection (403), rate-limiting (429), and candidate masking without leaking plaintext PII. |
| `tests/returning-visitor-provisional-workflow.test.ts` | Provisional enrollment activation, capabilities & 1:1 cosine matching | 8 | Integration | Proves decoupled enrollment readiness, key length guards, verification secret guards, candidate masking, 1:1 cosine similarity matching, low-quality/multi-face rejection (422), and expired/revoked profile rejection. |
| `tests/returning-visitor-turnstile-lifecycle.test.ts` | Cloudflare Turnstile token validation on returning flows | 6 | Integration | Proves Turnstile session initialization, session reuse, expired session refresh, fail-closed handling on challenge errors/missing site key, preflight execution, and single widget instance persistence. |
| `tests/guard-station-device.test.ts` | Guard Station feed criteria, gate confinement, keyset pagination | 13 | Integration (PGlite + API) | Proves Asia/Manila current calendar day filtering, gate scoping, `status IN ('inside', 'exited')`, and cursor pagination without row duplication. |
| `tests/migration-chain-pglite.test.ts` | PostgreSQL schema migrations (000100 through 001400) | 24 | Database Contract (PGlite) | Proves sequential migration execution, RPC signatures, RLS policies, least-privilege table grants, D1-D10 credential triggers, and pass status enums. |
| `tests/e2e/returning-visitor-address-prefill.spec.ts` | Returning visitor address flow with mocked API responses | 3 | Browser E2E with mocked API responses (Playwright) | Proves browser-level Welcome Back address hydration, manual postal override synchronization, selector modal re-selection preservation, and pass issuance payload serialization using mocked API routes. |

---

## 7. Physical Device Acceptance Checklist

This checklist documents verification status across all system requirements, clearly distinguishing between automated test evidence and physical on-site hardware checks.

| Requirement ID | Verification Item | Target Subsystem / Device | Test Method | Status | Notes / Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AC-01** | Same-locality postal override preservation | Visitor Portal (`/get-pass`) | Playwright E2E (Mocked API) + Vitest Unit | **PASS** | Verified in `returning-visitor-address-prefill.spec.ts` (mocked browser E2E) & `returning-visitor-address-hardening.test.ts`. |
| **AC-02** | Locality change resets postal state to fresh lookup | Visitor Portal (`/get-pass`) | Vitest Unit | **PASS** | Verified in Part 5 of `tests/returning-visitor-address-hardening.test.ts`. |
| **AC-03** | Pass issuance payload captures accurate postal provenance | Pass API (`/api/passes/issue`) | Playwright E2E (Mocked API) + Vitest Integration | **PASS** | Intercepted payload in browser E2E verifies `postalCodeSource: 'manual'` when overridden; server persistence verified in hardening suite. |
| **AC-04** | Entry Scanner grants instant entry for online passes | Entry Scanner (`/scan/entry`) | Vitest Unit (Shared Helper) | **PASS** | Verified in `tests/entry-scan-feedback.test.ts`. `inside` resolves to `'granted'` (green). |
| **AC-05** | Entry Scanner reflects pending status for kiosk passes | Entry Scanner (`/scan/entry`) | Vitest Unit (Shared Helper) | **PASS** | Verified in `tests/entry-scan-feedback.test.ts`. `pending` resolves to `'pending'` (amber). |
| **AC-06** | Entry Scanner fails closed on unrecognized status | Entry Scanner (`/scan/entry`) | Vitest Unit (Shared Helper) | **PASS** | Verified in `tests/entry-scan-feedback.test.ts`. Unrecognized status resolves to `'error'`. |
| **AC-07** | Optical camera QR scanning on physical Android / iOS handheld | Entry Scanner (`/scan/entry`) | Physical Smartphone / Scanner Tablet | **NOT TESTED (PHYSICAL HARDWARE)** | Barcode decoder verified via synthetic stream; requires on-site testing on physical gate hardware rig. |
| **AC-08** | Physical ESC/POS thermal receipt printing at kiosk | Kiosk Portal (`/kiosk`) | Physical USB / Network Thermal Printer | **NOT TESTED (PHYSICAL HARDWARE)** | Thermal printer canvas and ESC/POS raster generation verified via unit tests; requires physical printer. |
| **AC-09** | Mobile WebKit / Safari layout & touch interactions | iPhone 12, iOS 27 Safari | Playwright Mobile WebKit Emulation | **PASS (EMULATION)** | Responsive layout and touch targets verified via Playwright WebKit emulation. Physical iPhone 12 testing is **NOT TESTED (PHYSICAL HARDWARE)**. |
| **AC-10** | Guard Station live feed updates on pass entry | Guard Station (`/guard`) | Vitest + PostgreSQL PGlite | **PASS (AUTOMATED)** | Proved in `tests/guard-station-device.test.ts` (Asia/Manila date and gate filtering via 4s polling). Real-world security booth continuous operation is **NOT TESTED (PHYSICAL HARDWARE)**. |
| **AC-11** | Guard Station photo evidence access control | Guard Station (`/guard`) | Vitest + PGlite DB Contract | **PASS** | `/api/evidence` strictly permits `photo` and `vehicle_photo` and blocks government ID retrieval. |
| **AC-12** | Exit Scanner validates departure and transitions to exited | Exit Scanner (`/scan/exit`) | PGlite DB RPC Contract | **PASS** | Verified in `tests/migration-chain-pglite.test.ts`. Passes transition `inside -> exited`. |
| **AC-13** | Full TypeScript compilation & production bundle build | Whole Repository | `tsc` + `vite build` | **PASS** | Client and API build succeed with 0 errors. |
