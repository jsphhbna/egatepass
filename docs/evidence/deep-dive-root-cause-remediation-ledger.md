# EARIST E-GatePass — Deep-Dive Root-Cause Remediation & Production Reliability Ledger

## 1. Executive Summary & Production Baseline

- **Repository**: `jsphhbna/egatepass`
- **Branch**: `main`
- **Pre-Fix Verified Baseline Commit**: `bb99f5abcaf35c734760c35e7d741319e33b834a`
- **Target Production Environment**: `https://egatepass.tech`
- **Supabase Project**: `egatepass-dev` (`nhoawvkfqblsgutdffie`)
- **Vercel Hobby Plan Physical Function Invariant**: Exactly 6 physical endpoint entrypoints under `api/` (`api/index.ts`, `api/passes.ts`, `api/guard.ts`, `api/kiosk.ts`, `api/office.ts`, `api/auth.ts`)
- **Biometric Operating Mode**: `RETURNING_FACE_THRESHOLD_MODE=provisional` (no face templates persisted or stored from returning visitor selfies)
- **Forward-Only Migration**: Migration 66 (`20261107000500_post_release_reliability_remediation.sql`)

---

## 2. Root Cause Analysis & Remediations (Findings A–H)

### Finding A: Atomic Rate Limiting, IP Privacy & Anonymous Visitor Session Enforcement
- **Root Cause**:
  1. The email verification slot allocation RPC relied on uncoordinated multi-column queries without total lock ordering, risking deadlocks under concurrent requests across actor, email, and IP dimensions.
  2. The table stored raw client IP addresses (`client_ip text`), violating institutional data minimization and privacy standards.
  3. The `/api/office/verify-email` endpoint did not strictly verify that the caller possessed an anonymous visitor session, leaving open the theoretical possibility of staff or recovery sessions abusing the challenge slot generator.
- **Remediation**:
  1. In Migration 66, implemented `api.request_office_email_verification_slot` with deterministic sorted 64-bit advisory locks (`act:`, `eml:`, `ip:`) derived via `('x' || substr(md5(namespace || val), 1, 16))::bit(64)::bigint` and ordered via `select distinct unnest(lock_keys) as lk order by lk asc`. This guarantees global total lock acquisition order and eliminates deadlock risk.
  2. Replaced `client_ip` with `ip_hmac text default null` indexed by `idx_office_email_verif_ip_hmac_created`. Zeroed legacy raw IP addresses. Added runtime HMAC-SHA256 computation in `server/routes/office/verify-email.ts` using `process.env.RATE_LIMIT_HMAC_SECRET`.
  3. Enforced strict anonymous visitor session verification in `server/routes/office/verify-email.ts`: `if (!session.isAnonymous) throw new HttpError(403, 'anonymous_visitor_session_required')`. Any staff, administrator, or recovery session is rejected immediately with 403 Forbidden.

### Finding B: Truthful Decoupled Decision Outcome & Email Delivery Status
- **Root Cause**:
  1. In `server/routes/office/decide.ts`, the approval decision outcome was intertwined with email delivery. If Resend transport failed or timed out, the visitor was approved in the database, but the API response returned misleading error structures or conflated failure states.
  2. Several Supabase client calls failed to inspect both `{ data, error }`, assuming successful mutations without affirmative data confirmation.
- **Remediation**:
  1. Decoupled the institutional decision from auxiliary email dispatch in `server/routes/office/decide.ts`. The response now returns `{ ok: true, decision: 'approved' | 'rejected', emailDelivery: { status: 'sent' | 'failed' | 'unknown', providerMessageId, error } }`.
  2. Audited and ensured explicit `{ data, error }` pattern matching on all Supabase queries, throwing explicit `HttpError` instances on database failures.
  3. Updated `src/pages/OfficeDashboardPage.tsx` with truthful user feedback: toasting distinct statuses ("submitted to email provider", "confirmed by provider", "failed - staff attention required") rather than falsely claiming guaranteed delivery.

### Finding C: Delivery Provenance Tracking & Composite Outbox Mapping
- **Root Cause**:
  1. When office staff manually confirmed email delivery via the office dashboard, the system marked `delivered_at = now()`, erasing the distinction between real provider webhooks and manual staff overrides.
  2. In `server/routes/office/visits.ts`, outbox rows were mapped solely by `office_visit_id`. If an office visit experienced both approval and rejection outbox events across its lifecycle, rows collided and silently overwrote one another.
- **Remediation**:
  1. Added `confirmation_source text check (confirmation_source in ('manual_staff', 'provider_webhook'))` and `manual_confirmed_at timestamptz` to `public.office_visit_email_outbox` and `public.office_visits`.
  2. In `api.reconcile_office_visit_email`, marking delivered sets `confirmation_source = 'manual_staff'` and `manual_confirmed_at = now()`, leaving `delivered_at` null until a true provider webhook arrives.
  3. When `api.record_resend_delivery_event` receives `email.delivered`, it updates `confirmation_source = 'provider_webhook'` and sets `delivered_at = v_occurred` without erasing staff audit notes.
  4. In `server/routes/office/visits.ts`, mapped outbox rows using the composite key `${office_visit_id}:${email_type}`. Exposed `confirmationSource` in the API and updated `OfficeDashboardPage.tsx` to render "Manually confirmed" vs "Delivered by Provider".

### Finding D: Concurrent Approval Safety & QR Parity
- **Root Cause**:
  1. If two office staff members concurrently approved the same visit proposing different raw pass tokens, race conditions could cause the outbox row to store an encrypted token that differed from the canonical pass QR hash.
- **Remediation**:
  1. Ensured the outbox update is bounded by database row locking (`for update`) and idempotency checks.
  2. In `server/routes/office/decide.ts`, the QR code image returned to the caller is generated directly from the canonical decrypted outbox token payload. This guarantees 100% byte-for-byte parity between the email attachment and the dashboard display.
  3. Verified via regression test `tests/post-release-reliability-remediation.test.ts`.

### Finding E: General Office Visit Linking Partial Commit Handling
- **Root Cause**:
  1. In `server/routes/passes/issue.ts`, if general office visit creation (`record_general_office_visit`) failed or timed out after the pass and visitor records committed, the pass was already issued, but the client received an unhandled failure or unlinked state without reconciliation guidance.
- **Remediation**:
  1. Wrapped `record_general_office_visit` in explicit `{ data: ovRows, error: ovErr }` error checking.
  2. If general office linking fails, the issued pass is preserved, and the API returns `officeVisitLinkStatus: 'reconciliation_required'` (or `'linked'` on success, `'not_applicable'` if no office visit was requested).
  3. Implemented consistent behavior across both initial issuance and idempotent replay branches.
  4. Updated `src/pages/GetPassPage.tsx` to inform the visitor if their office visit link requires staff reconciliation at the desk without invalidating their gate entry pass.

### Finding F: Returning Visitor Vehicle Save Failures
- **Root Cause**:
  1. In `server/routes/passes/issue.ts`, if saving a returning visitor vehicle declaration failed (e.g. database constraint or network glitch), the failure could abort the pass response or allow duplicate vehicle entries on retry.
- **Remediation**:
  1. Added unique partial index `returning_visitor_vehicles_profile_plate_uniq` on `public.returning_visitor_vehicles (profile_id, plate_key) where archived_at is null` with prior deduplication in Migration 66.
  2. In `server/routes/passes/issue.ts`, wrapped vehicle persistence in try/catch and explicit return status: `savedVehicleStatus: 'saved' | 'failed' | 'not_requested'`. A failure to save a vehicle declaration never invalidates the issued gate pass.
  3. Updated `src/pages/GetPassPage.tsx` to present clear vehicle save status.

---

## 3. Finding G: Authenticated SECURITY DEFINER Review (Schema `api`)

An exhaustive audit of all PostgreSQL functions in schema `api` possessing `SECURITY DEFINER` and granted `EXECUTE` to the `authenticated` role identified exactly 14 functions. Each has been reviewed for caller identity, execution role boundaries, and trusted authorization context:

| # | Function Signature | Allowed Execution Roles | Caller Context | Trusted Authorization Defense |
|---|-------------------|-------------------------|----------------|-------------------------------|
| 1 | `api.abandon_upload_intent(uuid)` | `anon`, `authenticated`, `service_role` | Visitor / Client | Enforces intent ownership: `owner_id = auth.uid()` or caller is `admin`/`superadmin`. Default-deny for arbitrary UUIDs. |
| 2 | `api.acknowledge_privacy()` | `authenticated` | Staff login | Bounded to caller: updates `privacy_accepted_at = now()` exclusively for `user_id = auth.uid()`. Cannot mutate other users. |
| 3 | `api.admin_publish_thermal_template(int)` | `authenticated` | Admin Dashboard | Enforces `private.has_staff_role(array['admin', 'superadmin'])`. Rejects standard staff and guard roles. |
| 4 | `api.admin_restore_thermal_template(int)` | `authenticated` | Admin Dashboard | Enforces `private.has_staff_role(array['admin', 'superadmin'])`. Rejects unauthorized staff. |
| 5 | `api.admin_save_thermal_template(text, jsonb, int)` | `authenticated` | Admin Dashboard | Enforces `private.has_staff_role(array['admin', 'superadmin'])`. Validates layout structure and prevents unauthorized template tampering. |
| 6 | `api.create_upload_intent(pass_source, evidence_kind, text)` | `anon`, `authenticated`, `service_role` | Portal / Kiosk / Guard | Enforces matrix: `portal` requires visitor, `kiosk` requires verified kiosk device, `guard_offline` requires `admin`/`superadmin`. Prevents privilege escalation. |
| 7 | `api.current_actor()` | `anon`, `authenticated`, `service_role` | Client App Context | Read-only helper: inspects `auth.uid()`, returns caller's profile and staff role, or anonymous visitor context. Zero mutation capability. |
| 8 | `api.guard_dashboard(int, int)` | `authenticated` | Guard Station | Requires `admin` or `superadmin` role (guard role deprecated in Migration 41). Rejects unauthorized callers. |
| 9 | `api.guard_dashboard_page(int, timestamptz, uuid, timestamptz)` | `authenticated` | Guard Station Polling | Requires `admin` or `superadmin` role. Strictly enforces server-side pagination cursor invariants. |
| 10 | `api.guard_offline_snapshot_page(text, int)` | `authenticated` | Guard Offline Sync | Requires `admin` or `superadmin` role. Returns only authorized daily operational snapshot slices. |
| 11 | `api.guard_recover_pass_action(uuid, text, text)` | `authenticated` | Guard Recovery | Requires `admin` or `superadmin` role. Validates action against strict status lifecycle state machine. |
| 12 | `api.guard_search_pending_queue(text, int)` | `authenticated` | Guard Search | Requires `admin` or `superadmin` role. Bounds search query length and rate. |
| 13 | `api.guard_search_recovery_visitors(text, int)` | `authenticated` | Guard Recovery Search | Requires `admin` or `superadmin` role. Scoped to authorized recovery queries only. |
| 14 | `api.guard_sync_offline_event(uuid, uuid, text, text, int, timestamptz, text)` | `authenticated` | Guard Offline Event Sync | Requires `admin` or `superadmin` role. Enforces immutable UUID event deduplication, optimistic concurrency, and audit trail logging. |

**Audit Conclusion**: All 14 authenticated `SECURITY DEFINER` functions in schema `api` strictly validate caller role/ownership via `auth.uid()` or `private.has_staff_role(...)`, enforce safe `search_path = ''`, and have default-deny semantics against unauthorized caller escalation.

---

## 4. Finding H: Offline IndexedDB Evidence Privacy Review

- **Component**: `src/lib/offline/guardIndexedDb.ts`
- **Stored Data Classes**:
  - Today's Manila operational passes (`egatepass_guard_offline` object store `passes`)
  - Offline registration queue (`offline_registrations`) with temporary `photoBlob` and `idBlob`
  - Offline event queue (`offline_events`) with UUID event deduplication keys
- **Blob Lifecycle**:
  1. When an offline registration is created without network connectivity, `photoBlob` and `idBlob` are temporarily staged in IndexedDB.
  2. Upon successful network sync (`syncStatus === 'synced'`) or unresolvable conflict (`syncStatus === 'conflict'`), `stripStoredBlobs(id)` explicitly executes `delete updated.photoBlob; delete updated.idBlob; cursor.update(updated)`. The raw biometric/ID blobs are purged from client storage.
  3. Absolute retention ceiling: any pending or syncing record older than 7 days (`sevenDaysAgo`) is transitioned to `conflict` with `conflictReason: 'expired_local_evidence_exceeded_policy'` and its blobs are stripped immediately.
  4. Daily operational purge: pass records are scoped to today's Manila date window (`getManilaDayValidityWindow()`) and purged upon day transition.
- **Threat Model**:
  - *Threat Actor*: Physical device thief or unauthorized person accessing an unmonitored guard tablet.
  - *Attack Vector*: Inspecting browser developer tools or extracting IndexedDB storage files from the tablet file system.
  - *Mitigations*:
    1. Zero server secrets, signing keys, or service role credentials are stored in IndexedDB or localStorage.
    2. Blobs are ephemeral and purged immediately upon sync.
    3. Operational deployment standard mandates OS-level full disk encryption (BitLocker, Android Knox, or iOS Data Protection) and PIN/biometric screen lock on all guard tablets.
  - *Documented Residual Risk*: On an unencrypted or screen-unlocked tablet physically seized during an active network outage before sync completes, pending offline registration photos remain in browser storage until the 7-day retention sweep or sync occurs.

---

## 5. Verification Test Evidence

| Test Suite | Commands Run | Status | Key Invariants Verified |
|---|---|---|---|
| Migration Chain (PGlite) | `npm run test:migrations` | **PASS (36/36 tests)** | Migrations 1 through 66 apply sequentially without error; verified Migration 66 IP privacy and rate limiting. |
| Reliability & Concurrency | `npx vitest run tests/post-release-reliability-remediation.test.ts` | **PASS (7/7 tests)** | Multi-dimension advisory locks, anonymous visitor session rejection, decoupled email outcomes, provenance tracking, QR parity, partial commit resilience. |
| System Contracts | `npm run test:contracts` | **PASS** | API route contracts, schema boundaries, privilege contracts. |
| Documentation Contracts | `npm run test:docs` | **PASS** | Architecture boundaries, schema documentation, Hobby plan 6-function constraint. |
| API TypeScript Typecheck | `npm run typecheck:api` | **PASS** | Zero type errors across all server routes and API entrypoints. |
| Unit Test Suite | `npm run test:unit` | **PASS** | Client and server unit tests pass cleanly. |
| Production Build | `npm run build` | **PASS** | Vite production bundle compiles cleanly. |

---

## 6. Production Deployment & Release Gates

- **Remote Migration Status**: Migration 66 applied to Supabase `egatepass-dev` (`nhoawvkfqblsgutdffie`).
- **Git Commit**: Tracked under conventional commit `fix(reliability): atomic rate limiting, truthful email status, provenance tracking, and partial commit resilience`.
- **GitHub Actions CI**: Verified passing on `origin/main`.
- **Vercel Production Deployment**: Verified live at `https://egatepass.tech`.
- **Hardware Status**: Thermal printer (MXW01), hardware barcode scanners, and iPhone camera optical calibration marked `NOT TESTED (PHYSICAL HARDWARE)` in accordance with governance instructions.
