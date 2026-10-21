# E-GatePass Project State

Updated: 2026-10-21 Asia/Manila

Current stage: Guard dashboard contract restoration, Asia/Manila daily statistics invariant, Auth / RLS recovery confinement, and Vercel Preview preflight LOCALLY VERIFIED; provider/database integration BLOCKED (hosted Supabase migration history EMPTY; entire 18-migration chain UNAPPLIED on egatepass-dev)

## Repository identity

- Working copy: `C:\Users\Administrator\Downloads\egatepass`
- Branch: `feat/runtime-migration`
- Remote branch: `origin/feat/runtime-migration`
- Base commit: `86a455ede2adc68ef6e09794e3ad118b70f63162`
- M3 checkpoint HEAD: `6239cd79de4ee51c4515b144804661bc4f4a506f`
- Target origin: `https://github.com/jsphhbna/egatepass.git`
- Read-only reference main: `6906b91f9a1c4910f6bdfa14ee62aa3e3d46da7c`
- Local rollback branch: `checkpoint/s0-original-f2f1a2b-20261020`
- Pre-existing user change preserved: `.env.example` (unstaged, uncommitted)
- Targeted correction start: `dcc9854d22c1aeec1c87d3a1dac55f183741b993`
- Auth/RLS recurrence closure baseline HEAD: `1d1633890dff98e79583276798c31ed95d2dac8e` (corrects previous report typo `1d1633890bb8a728b77a064da2cf8a38541eb93a`)

## Baseline capability state

| Capability | Implementation | Verification |
|---|---|---|
| Original React/Vite UI | Present | Build PASS; public and isolated authenticated role-route browser captures PASS |
| Firebase/Firestore/Netlify/Cloudinary backend | Present (legacy fallback baseline) | 238 legacy emulator/unit tests PASS; production behavior NOT TESTED |
| Supabase target | Canonical migrations 00100–00700, local config, pgTAP authorization suite (69 assertions), private-bucket/RPC/bootstrap design | Static contract PASS; clean reset, RLS, Auth, Data API and Storage behavior BLOCKED because Docker/Postgres/authorized test project are unavailable |
| Vercel target | `vercel.json` SPA/region scaffold; full `/api/*` endpoints implemented | Local config contract PASS; API typecheck PASS; provider link/deploy NOT TESTED |
| Resend target | Environment names present | NOT TESTED; no real email sent |
| Browser E2E | Playwright 1.64.1 startup harness (4 cases: dev/configured, dev/missing, dev/malformed, preview/configured) | 4/4 PASS on Playwright Edge |
| Owner manual QA | Runbook updated | AWAITING OWNER |

## P0 white-screen recovery

- Exact pre-fix revision `86a455e` reproduced a blank document in Edge: `#root` had zero children and Firebase Auth threw `auth/invalid-api-key` at `src/lib/firebase.ts:13` before React mounted.
- Ordinary `.env.local` contains the Supabase browser variable names and no `VITE_FIREBASE_*` names; values were not displayed.
- The runtime now mounts a fail-safe shell before dynamically loading `App`, validates the Supabase URL/key without throwing, and isolates still-legacy privileged modules behind lazy routes.
- Shared Auth session/profile resolution, login, verification resend, and password-reset request now use `@supabase/supabase-js`. Real hosted/local Auth actors remain NOT TESTED because no authorized isolated Supabase environment is available.
- `npm run test:e2e:startup`: PASS for dev configured, dev missing, dev malformed, and built preview configured; each exercises Edge, the original landing, no page/console error, JavaScript entrypoint response, and 390px no-overflow check.

## M1/S3 identity slice

- Implemented Supabase session/profile/device resolution, controlled device-alias normalization, shared login, verification resend, recovery request/callback, staff privacy acknowledgement, logout, and token acquisition.
- Implemented `/api/auth/complete-password-change` as a Vercel Web Handler plus `20261020000400_identity_rpcs.sql`. It revalidates bearer/current password/active Guard state and records partial completion for reconciliation.
- Local checks PASS: API typecheck; frontend build; identity static 4/4; existing Supabase static 5/5.

## M2/S4 registration and issuance slice

- Portal and kiosk visible forms, photo/ID previews, consent, success QR, download/share/print, and default scheduling presentation are preserved.
- Portal anonymous Auth uses `egatepass-portal-auth`; staff/device Auth uses `egatepass-operator-auth`, preventing a portal registration from replacing a kiosk/operator session.
- The registration service requests short-lived owner/source/kind-bound intents and uploads only to server-derived private Storage paths.
- `/api/passes/issue` authenticates the bearer, downloads actual objects, enforces JPEG/PNG/WebP magic bytes and 5 MiB limits, hashes them, and invokes the service-only transaction.
- Migration `20261020000500_pass_issuance.sql` validates source identity, scheduling/Peak Mode/evidence, locks and claims intents, and creates visitor/evidence/pass/audit rows atomically. Stable request IDs make successful retries idempotent.
- Local checks PASS: frontend build, API typecheck, issuance static 7/7, existing Supabase static 5/5, identity static 4/4.

## M3/S5 gate lifecycle slice

- Entry and exit pages preserve the original scanner UI and now call Vercel `/api/scan-pass`; the raw QR bearer is hashed before database lookup and never logged or stored.
- Migration `20261020000600_gate_lifecycle.sql` implements locked entry/pending, Guard approve/reject, and gate-matched exit transitions with operational events and version increments.
- Guard queue, daily summary, rejection reasons, and Realtime invalidation now use Supabase. A five-second refresh remains as delivery recovery.
- `/api/evidence` revalidates the staff session/profile/privacy/password state, restricts Guard reads to currently pending visitors, rejects expired/purged evidence, and returns private no-store responses.
- Local checks PASS: lifecycle static 6/6, frontend build, and API typecheck.

## M4/S6 Admin and operations runtime migration

- Complete removal of direct Firebase/Firestore/Netlify imports from all Admin pages: `AdminDashboard.tsx`, `AdminRecords.tsx`, `AdminUsers.tsx`, `DevicesPage.tsx`, `AdminSettings.tsx`, `AdminEmergency.tsx`, `AdminAuditLogs.tsx`, and `AdminPage.tsx`.
- Decoupled timestamp architecture: Created `src/lib/timestamp.ts` implementing `AppTimestamp` and `asAppTimestamp()`, and updated `src/types/index.ts`.
- Staff management: Implemented `/api/create-user`, `/api/update-user`, `/api/admin/users`, and `api.create_staff_profile`/`api.update_staff_profile`. Enforces last active Super Admin invariant via PostgreSQL trigger.
- Physical device governance: Implemented `/api/create-device`, `/api/update-device`, `/api/update-device-auth`, `/api/delete-device`, `/api/admin/devices`, and `api.create_device_profile`/`api.update_device_profile`/`api.retire_device`. Enforces strict device alias normalization and `@devices.egatepass.invalid` addresses.
- Dashboard & Operational metrics: Implemented `/api/admin/dashboard` returning bounded today passes, inside counts, exited counts, and decisions.
- Emergency evacuation: Implemented `/api/admin/emergency` querying active inside visitors with gate/entry timestamps, 15-second polling, and paper printout checkbox support.
- Visitor records & exports: Implemented `/api/admin/records` with cursor-based pagination, bounded CSV exports via `collectCursorPages`, and strict redaction of credentials/sensitive paths.
- Audit & Reconciliation activity: Implemented `/api/admin/activity` and `/api/reconciliation-items` with filtered cursor exports for visitor, administrative, and Super Admin reconciliation views.
- Settings & Storage purge: Implemented `/api/admin/settings`, `/api/update-settings`, and `/api/purge-images`. Separates Admin operational fields from Super Admin retention/security fields. Supports dry-run and bounded storage deletion with reconciliation logging.
- Verification: `tests/admin-governance-static.test.ts` (6/6 PASS), Vitest static suite (10 files, 79 tests PASS), `npm run typecheck:api` (PASS, exit code 0), `npm run build` (PASS, exit code 0), and Playwright startup browser suite (4/4 PASS, exit code 0).
- Database assertions: Authored `supabase/tests/006_admin_governance.test.sql` (10 assertions). Total authored database assertions: 69.
- Provider integration remains `IMPLEMENTED — NOT VERIFIED / INTEGRATION BLOCKED` until Docker Desktop or an authorized non-production Supabase project is available.

## M4 Corrections & M5-F13 Slice

- **F01 Device Credential Target Validation**: `api/update-device-auth.ts` validates staff profile first (returns 403 `cannot_modify_staff_via_device_endpoint`), checks existing non-retired device target (returns 404), checks alias uniqueness, validates Auth existence before writes, logs honest compensation/reconciliation on partial failure, and writes mandatory immutable audit records.
- **F02 Image Purge Incident Hold Protection**: `api/purge-images.ts` inspects active holds by both `visitor_id` AND `pass_id` (resolving `passes.visitor_id`), re-verifies holds and active/future passes right before physical storage delete, respects dry-run truthfulness, and records audit/reconciliation.
- **F03 & F10 Settings & Audit Atomic Persistence**: Migration `20261020000800_admin_hardening.sql` created atomic `api.update_app_settings` RPC locking singleton row and inserting audit log within one PostgreSQL transaction; added `automatic_cleanup_enabled` column and truthful persistence.
- **F04 Staff Email Verification**: `server/actors.ts` enforces `email_confirmed_at` check on human staff actors (403 `email_verification_required`), preserving device exemptions.
- **F05 Device Alias Contract Alignment**: `src/pages/DevicesPage.tsx` updated to `DEVICE_ALIAS_PATTERN` (`/^[a-z0-9][a-z0-9-]{2,62}$/`), accepting short alias or `@devices.egatepass.invalid`, matching backend `controlledDeviceEmail` and client `normalizeLoginIdentity`.
- **F06 Authoritative Dashboard Counters**: `api/admin/dashboard.ts`, `useAdminDashboardData.ts`, and `AdminDashboard.tsx` query authoritative database counts (`{ count: 'exact', head: true }`) for today totals, inside, exited, rejected, and pending (`status = 'pending'`, unconstrained by null `decided_at`).
- **F07 & F12 Complete Emergency Roster**: `api/admin/emergency.ts` replaces silent 500 limit with paginated fetch-to-completion (bounded by 10,000 ceiling and returning truthful `truncated` flag); removed all fabricated `new Date()` timestamps in `AdminEmergency.tsx`.
- **F08 Stable Compound Cursors & CSV Formula Escaping**: `server/cursor.ts` supports `(timestamp, id)` base64url JSON cursors with legacy ISO fallback. `api/admin/records.ts` and `api/admin/activity.ts` use deterministic secondary sort by `id DESC` and PostgREST compound `.or(...)` filter. Hardened formula escaping in `completeExport.ts` and `DashboardExportActions.tsx` for `/^[=+\-@\t\r]/`.
- **F09 Peak Mode Scope Selector in UI**: `src/pages/AdminSettings.tsx` updated to provide 4-way scope selector (`off`, `portal`, `kiosk`, `both`), truthful scope modal disclosure, and strict face photo retention.
- **F11 Staff List Scalability & Email Semantics**: `api/admin/users.ts` updated with per-user fallback lookup for profiles beyond page 1 and marked unconfirmed users as `confirmationPending: true`.
- **M5-F13 Optional QR Email Delivery**: Built two-step mailbox possession proof and delivery endpoint `api/passes/email.ts` with Resend adapter, QR PNG generation, recipient consent verification, 6-digit code verification, and reconciliation logging on provider failure without rolling back the issued pass. Built `src/components/EmailPassModal.tsx` and integrated into `src/pages/GetPassPage.tsx` and `src/pages/KioskPage.tsx`, fully preserving Download QR, print, and share actions with zero visual disruption.
- **Local Verification**: 12 test files, 119 tests PASS (`npx vitest run --exclude "**/firestore.rules.test.ts"`), `npm run typecheck:api` (PASS), `npm run build` (PASS), `npm run test:e2e:startup` (4/4 PASS on Edge), `git diff --check` (PASS). Real provider integration remains `IMPLEMENTED — NOT VERIFIED / INTEGRATION BLOCKED`.

## One-Pass Root-Cause Resolution & Independent Audit (P0-01–P0-05, C-01–C-05)

- **P0-01 Pass Identity Contract & Digest Hex Serialization**: `api/passes/email.ts` unifies pass lookup by resolving `public_reference` or UUID to `passes.id`. Strips Postgres `\x` or `0x` bytea prefix on `token_digest` and uses `crypto.timingSafeEqual` with 32-byte SHA-256 buffer.
- **P0-02 Email Challenge Atomicity, CSPRNG & Idempotency**: Additive migration `20261020000900_qr_email_idempotency.sql` creates atomic RPCs `api.request_email_verification_code`, `api.verify_and_claim_email_dispatch`, and `api.finalize_email_dispatch` with row locking (`FOR UPDATE`), unique idempotency indexes, and request ID deduplication. Replaced pseudo-random generator with Node `crypto.randomInt`. Enforces race-resistant rate limits, failure-safe retries without duplicate dispatches, and non-destructive reconciliation on provider failure.
- **P0-03 Settings Atomic RPC Fail-Closed**: Removed direct table update and unverified audit insert fallback from `api/update-settings.ts`. Strictly fails closed with mapped HTTP errors (403, 404, 400, 503) on RPC failure without partial mutations.
- **P0-04 Image Purge Incident Hold Protection & Fail-Closed Checks**: `api/purge-images.ts` checks both visitor-linked AND pass-linked active incident holds right before storage delete. Explicitly inspects `.error` outcomes on all queries and fails closed without deleting assets if any check fails.
- **P0-05 Governance Target Validation & Error Inspection**: `api/update-device-auth.ts` inspects `staffError` on `staff_profiles` check (fails closed with 503); inspects `{ error: auditError }` on audit insert and logs reconciliation on failure.
- **C-01 Dashboard True Counts & Manila Window**: Aligned `pendingToday` in `api/admin/dashboard.ts` to passes scanned today (`entry_scanned_at` within Manila day), distinct from all-time pending (`allPending`).
- **C-02 Emergency Evacuation Roster Integrity**: In `AdminEmergency.tsx`, added bold screen alert and print header (`print:block`) when `isTruncated === true` (10,000 ceiling), and prominent error banner on load failures.
- **C-03 Compound Cursor Validation & CSV Formula Injection Defense**: Hardened `server/cursor.ts` with `decodeCursorStrict` checking ISO timestamp and UUID/BigInt formats, rejecting malformed cursors with 400. In `src/lib/completeExport.ts`, sanitized formula prefixes `=+\-@` even after leading spaces, tabs, carriage returns, or control characters.
- **C-04 Peak Mode & Roles Validation**: Re-verified 4-way peak mode scope rules (`off`, `portal`, `kiosk`, `both`), ensuring visitor face photos are never skipped.
- **C-05 Static SQL & Migration Safety**: Expanded static migration tests in `tests/supabase-migration-static.test.ts` to validate migrations 00800 and 00900.


## Targeted QR-email security checkpoint

- EMAIL-P0-01 through EMAIL-P1-07 are corrected in source, additive SQL, UI, and regression tests. The former internal-ID fallback and all direct `pass_email_verifications` fallback DML were removed.
- `passes.public_reference` and `passes.id` are distinct UUIDs. The email endpoint filters only by `public_reference`; internal foreign keys and reconciliation use `passes.id`.
- Stable browser request IDs are reused for the same logical operation. Only a user-visible deliberate retry after definitive rejection gets a new key.
- Verification-code and bearer-QR provider outcomes are `sent_to_provider`, `delivery_failed`, or `outcome_unknown`. A 2xx acknowledgement without provider ID, transport exception, worker/finalization ambiguity, or stale claim never becomes a fabricated inbox-delivery success.
- Reconciliation metadata contains only phase/outcome; it excludes recipient address, verification code, and QR bearer data. Reconciliation insertion failure is returned as `reconciliationRecorded: false` for operator visibility.
- Second adversarial review fixed provider 2xx acknowledgement ambiguity, inconsistent SQL lock ordering, stale-claim recovery, and remaining inbox-delivery wording.
- Local evidence: focused 4-file suite 92/92 PASS; full safe Vitest suite 166/166 PASS; API typecheck/build PASS; Edge startup 4/4 PASS; whitespace check PASS.
- `20261020001000_qr_email_security.sql` and `007_qr_email_security.test.sql` are AUTHORED / NOT RUN. Real SQL syntax, grants, locks, RLS, PostgREST `bytea`, Auth identities, Resend acceptance/delivery, and inbox receipt remain NOT TESTED / BLOCKED.

## OCR-First Kiosk, React Email & Confirmed Risk Resolutions Checkpoint

- **UX-01 (OCR-First Kiosk Registration)**: Default initial screen is "Scan Your Valid ID" with primary action "Scan My ID" and understated secondary link "Want to type manually instead?". Features camera ID capture (environment/back-camera preferred with file upload fallback), on-device local OCR via Tesseract.js using offline static assets in `public/tesseract/`, Philippine ID heuristics in `src/lib/ocr.ts`, prefilled editable form with explicit confirmation, single `idBlob` reuse for pass evidence, mandatory face photo, and zero Tesseract bundle leakage into general routes.
- **EMAIL-ARCH-01 (React Email + Resend Architecture)**: Installed `@react-email/components` and `@react-email/render`. Created accessible EARIST maroon/gold email templates in `server/templates/` (`VerificationCodeEmail.tsx`, `PassIssuedEmail.tsx`) rendered server-side in the Vercel API, with secure QR PNG attachment derived from server HMAC bearer.
- **EMAIL-H01 (Conservative Resend Error Classification)**: `server/email.ts` documents explicit mapping of provider HTTP responses. Deterministic client/auth errors (400, 401, 403, 422) are classified as `definitive_rejection`; rate limits (429), server errors (500, 502, 503), timeouts, and malformed 2xx are classified as `unknown`. Fenced unknown outcomes finalize `outcome_unknown` without automatic retry and enqueue sanitized reconciliation tasks.
- **EMAIL-H02 (Terminal State Conflict Rejection)**: Migration `20261020001100_email_security_and_abuse_controls.sql` updates `finalize_email_verification_code` and `finalize_email_dispatch` return contracts to distinguish `matched`, `already_finalized_same_status`, and `terminal_conflict`. `api/passes/email.ts` verifies exact match and fails closed on conflict.
- **EMAIL-M01 (Abuse Safeguards)**: Rate limits across distinct passes per recipient (max 5 challenges per 15 min) and per actor (max 10 challenges per 15 min) implemented in SQL RPCs and mapped to HTTP 429 in API.
- **EMAIL-M02 (Active Kiosk Device Enforcement)**: Kiosk email actions require caller actor to represent an active, non-deleted device of type `kiosk` in `devices` table. Revoked, deleted, or wrong-type devices fail with 403 `kiosk_device_revoked`.
- **PRIVACY-M03 (DB-Coordinated Purge Protocol)**: Implemented atomic `api.claim_evidence_for_purge` and `api.finalize_evidence_purge` RPCs in migration 01100. `api/purge-images.ts` claims rows with incident hold exclusion before storage deletion, and records finalize/reconciliation.
- **ADMIN-M04 (Staff List Keyset Pagination)**: Replaced silent 200 limit in `api/admin/users.ts` with stable cursor/keyset pagination (`limit`, `cursor`, `nextCursor`, `hasMore`) and bounded Auth user enrichment. Updated `AdminUsers.tsx` with "Load More Users" button.
- **DEPLOY-M05 (Vercel SPA vs API Rewrite Precedence)**: Updated `vercel.json` rewrite to `/((?!api/).*)` -> `/index.html` ensuring `/api/*` function routes are executed instead of returning SPA index HTML.
- **Verification Evidence**:
  - Full Vitest safe suite: 16 test files, 197 tests PASS (0 failures).
  - Behavioral mocked handler suite: 55/55 PASS.
  - Startup Playwright Edge E2E: 4/4 PASS.
  - TypeScript API compilation: `npm run typecheck:api` PASS (exit 0).
  - Production build: `npm run build` PASS (exit 0, 2537 modules).
  - Git whitespace: `git diff --check` PASS (exit 0).
  - Uncommitted `.env.example` strictly preserved without staging.

## Codex Targeted Root-Cause Correction, Supabase 404 Diagnosis & Vercel Preview Preflight Checkpoint

- **P0-A (Image Purge API↔SQL Contract & Authorization Hardening)**: Additive migration `20261020001200_concurrency_and_purge_contract_hardening.sql` updates `api.claim_evidence_for_purge` and `api.finalize_evidence_purge`. Enforces row locking (`FOR UPDATE`), exact claim verification (`ve.purge_claim_id = requested_claim_id`), lease expiry (5 minutes), revalidation of pass expiration/holds, and returns typed JSON `{ finalized: true, match_status: 'matched', purged: true, evidence_id: ... }`. `api/purge-images.ts` updated to check returned contract, require object path/bucket match, and reconcile failures.
- **P0-B (PostgreSQL pgTAP Fixture/Schema Corrections)**: Corrected `supabase/tests/008_email_security_and_abuse_controls.test.sql` to canonical schema (`user_id, alias, name, type, gate, status`) and `public.visitors` (`created_by_device_id`). Statically validated in `tests/supabase-migration-static.test.ts`. Total authored pgTAP assertions: 93 across 9 suites (all AUTHORED / NOT RUN).
- **P0-C (Cross-Pass Abuse Rate Limiting Advisory Locks)**: Additive migration 001200 adds transaction-scoped advisory locks (`pg_advisory_xact_lock`) on actor and recipient in `api.request_email_verification_code`. Authored `supabase/tests/009_cross_pass_abuse_concurrency.test.sql`. `api/passes/email.ts` updated to prioritize specific recipient/actor 429 codes.
- **P0-D (Localhost:5173 Supabase 404 Root-Cause Diagnosis & Vite Dev API Routing)**: Captured network trace: `GET https://nhoawvkfqblsgutdffie.supabase.co/rest/v1/app_settings` returning PostgREST HTTP 404 `PGRST205` ("Could not find the table 'public.app_settings' in the schema cache"). Root cause: `egatepass-dev` remote project lacks migrations 000100–001200. Fallback defaults and diagnostic logging added to `src/services/visitorRegistration.ts`. Stale Netlify proxy replaced with `vercelApiDevPlugin` in `vite.config.ts`, directly serving Vercel web handlers in local Vite dev.
- **P1-E (Vercel Preview Deployment Preflight)**: 10/10 endpoints probed successfully locally. OCR static assets verified. Server secrets isolated from client bundle. `docs/VERCEL_PREVIEW_PREFLIGHT.md` authored.
- **Verification Evidence**:
  - Full Vitest safe suite: 16 test files, 205 tests PASS (0 failures).
  - Behavioral mocked handler suite: 63/63 PASS.
  - Startup Playwright Edge E2E: 4/4 PASS.
  - TypeScript API compilation: `npm run typecheck:api` PASS (exit 0).
  - Production build: `npm run build` PASS (exit 0, 2537 modules).
  - Git whitespace: `git diff --check` PASS (exit 0).
  - Uncommitted `.env.example` strictly preserved without staging.

## Cross-Layer Root-Cause Remediation Checkpoint (P0-01–P0-04, EMAIL-01–EMAIL-04, HIGH-01–HIGH-05, MED-01–MED-10)

- **P0-01 (RLS Staff Eligibility Drift & Self-Profile Onboarding)**: Authored additive migration `20261020001300_cross_layer_root_cause_hardening.sql`. Redefined `private.current_staff_role()` requiring active account, verified email, `must_change_password = false`, and `privacy_accepted_at is not null`. Updated `staff_profiles_select` RLS policy so staff can read their own profile during first-login onboarding without deadlocks. Added `api.acknowledge_privacy()` RPC.
- **P0-02 (Passes↔Visitors Ownership Join in Verification Challenge)**: Repaired `api.request_email_verification_code` in migration 001300 to join `public.passes p` to `public.visitors v on v.id = p.visitor_id`, resolving `v.owner_id` and `v.source` under lock while preserving two-level transaction advisory locks.
- **P0-03 (Explicit Least-Privilege Schema Grants)**: In migration 001300, granted explicit usage on `api` and `public` to `authenticated` and `service_role`; revoked `private` from `public`, `anon`, and `authenticated`.
- **P0-04 (Atomic Incident Hold Create/Release & Storage Purge Protocol)**: Implemented atomic RPCs `api.create_incident_hold` (checks against in-progress purge claims and already-purged evidence) and `api.release_incident_hold` in migration 001300. Created `api/admin/holds.ts` handler for Super Admin incident hold operations with conflict handling.
- **EMAIL-01 (Supabase Auth Send Email Hook & React Email Architecture)**: Implemented full Supabase Auth Send Email Hook infrastructure: Standard Webhooks HMAC-SHA256 signature verification (`server/auth-email-hook.ts`), React Email + Resend templates (`SignupConfirmationEmail.tsx`, `PasswordResetEmail.tsx`, `StaffInviteEmail.tsx`, `EmailChangeEmail.tsx`), token mapping with secure email change inversion (`token_hash_new` for current email, `token_hash` for new email), Vercel Web Handler `/api/auth/send-email-hook`, and standalone Deno Edge Function in `supabase/functions/auth-send-email/index.ts`.
- **EMAIL-02 (Staff Onboarding & Identity Semantics)**: Audited onboarding lifecycle; default preserves existing administrator-supplied password creation with customized React Email confirmation template; documented optional one-time invitation token mechanism awaiting owner policy decision.
- **EMAIL-03 (Pre-Provider Rendering Protection)**: In `api/passes/email.ts`, wrapped `renderVerificationCodeEmail` in try/catch with `providerAttempted = false` so rendering errors finalize as `delivery_failed` instead of leaving challenges in orphaned `code_sending`.
- **EMAIL-04 (Visitor OTP/QR Delivery Verification)**: Validated visitor OTP/QR delivery regression suite with canonical UUIDs and timing-safe digest comparisons.
- **HIGH-01 (Pass Issuance Idempotent Replay)**: In `api/passes/issue.ts`, added safe idempotent replay check before inspecting upload intents. Replays committed passes with 200 OK while rejecting altered payloads (409), cross-actor replays (409), expired passes (422), and rotated secrets (409).
- **HIGH-02 (pgTAP 009 Fixture Purge Invariant)**: Corrected `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` by seeding dedicated visitor 913 with expired pass 923 for purge tests and visitor 911 with active pass 921 for negative invariant assertion (plan count 15).
- **HIGH-03 (Guard Approval Expired Pass Recheck)**: In migration 001300, updated `api.decide_visit` to re-check `target.valid_until <= statement_timestamp()` on approval, marking expired passes and raising `pass_has_expired`. Handled in `api/decide-visit.ts` returning 422.
- **HIGH-04 (Retention Maintenance Scheduling & API)**: Created `/api/admin/retention-maintenance.ts` supporting `CRON_SECRET` authentication, dry-run mode, and batch cleanup of expired unheld evidence, abandoned upload intents, and expired verification codes.
- **HIGH-05 (Evidence Access During Active Incident Holds)**: In `api/evidence.ts`, updated expired evidence check to permit Admin/Super Admin access when active incident hold exists, logging audit event `evidence.review_held`. Guards receive 410.
- **MED-01 (Guard Queue Pagination & Backlog Count)**: Added paginated `api.guard_dashboard(requested_limit, requested_offset)` overload returning `pendingTotal` and `hasMore`.
- **MED-02 (Real QR Sharing via Web Share API)**: In `src/pages/GetPassPage.tsx`, updated `shareQR` to share scannable QR PNG file via Web Share API when supported, falling back to download and instructions instead of plain mailto.
- **MED-03 (OCR Privacy Copy Correction)**: In `src/pages/KioskPage.tsx`, updated privacy notice to clarify that text recognition is on-device and ID image is uploaded only to private campus storage upon review and submission.
- **MED-04 (Upload Intent Quota)**: Added quota to `api.create_upload_intent` in migration 001300 (max 10 active pending intents per portal visitor).
- **MED-07 (Canonical UUID Test Fixtures)**: Aligned pass public reference fixture to canonical UUID in `tests/email-templates.test.ts`.
- **Verification Evidence**:
  - Full Vitest safe suite: 18 test files, 238 tests PASS (0 failures).
  - PGlite in-memory PostgreSQL 17.5 WASM: 4/4 tests PASS (all 13 migrations 000100–001300 execute sequentially from clean DB; RPC contracts, enum contracts, audit schema verified).
  - Behavioral mocked handler suite: 72/72 PASS.
  - Startup Playwright Edge E2E: 4/4 PASS.
  - TypeScript API compilation: `npm run typecheck:api` PASS (exit 0).
  - TypeScript frontend compilation: `npx tsc --noEmit` PASS (exit 0).
  - Production build: `npm run build` PASS (exit 0, 2538 modules transformed in 1.41s).
  - Git whitespace: `git diff --check` PASS (exit 0).
  - Uncommitted `.env.example` strictly preserved without staging.

## Comprehensive Root-Cause Repair & Recurring-Pattern Elimination Campaign (Repairs 1A–21)

All 21 confirmed defect groups and their recurring patterns across the codebase were repaired and verified:
1. **REPAIR 1A & 1B (Migration Chain & Audit Schema)**: Preserved canonical `api.acknowledge_privacy() RETURNS timestamptz`. Fixed all `audit_events` writes to canonical columns `(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state)` without invalid `details`.
2. **REPAIR 2A & 2B (QR Email DB State Machine)**: Restored `request_actor_id` in verification table queries/inserts. Enforced tuple-bound idempotency on `(pass_id, request_actor_id, recipient_email)`.
3. **REPAIR GROUP 3 (Incident Hold RPC Contract)**: Aligned `api.create_incident_hold` and `api.release_incident_hold` parameters (`requested_actor_id`, `requested_visitor_id`, `requested_pass_id`, `requested_reason`, `requested_request_id`) with `api/admin/holds.ts`. Handled 409 conflict responses.
4. **REPAIR GROUP 4 (Expired Guard Approval)**: Transaction updates `status = 'expired'`, writes `invalid_scan` visit event (`'expired'` is not in `visit_event_type`), writes audit record, commits, and returns `'expired'`. Handler returns 422.
5. **REPAIR GROUP 5 (Retention Maintenance)**: Canonical parameter `requested_success: true`, storage split-brain reconciliation, enforced `automatic_cleanup_enabled`, canonical audit outcomes (`success`, `partial`, `failure`, `denied`), and candidate oversampling to prevent starvation.
6. **REPAIR GROUP 6 (Supabase Auth Hook & Verification URLs)**: `buildAuthVerificationUrl` uses Supabase Auth base URL for `/auth/v1/verify` and `siteUrl`/`redirect_to` for application destination. Production hook fails closed (503) if `RESEND_API_KEY` is missing.
7. **REPAIR GROUP 7 (Unified Password Policy)**: Enforced 12-char min, upper, lower, digit, symbol across `server/password-policy.ts`, `src/lib/passwordPolicy.ts`, and Zod schemas.
8. **REPAIR GROUP 8 (Reset Password Session Security)**: `ResetPasswordPage` strictly requires `PASSWORD_RECOVERY` context or `type=recovery` URL.
9. **REPAIR GROUP 9 (System Settings Fail-Open UI)**: Eliminated writable fallback defaults on fetch failure; renders explicit error alert with retry button and locks Save.
10. **REPAIR GROUP 10 (Guard Queue Pagination)**: `fetchGuardDashboard` supports pagination (`limit`, `offset`, `pendingTotal`, `hasMore`). Header shows authoritative `pendingTotal`; loaded passes preserved across realtime updates.
11. **REPAIR GROUP 11 (Visitor Record Search)**: Debounced server-side search query parameter with cursor reset and server-filtered export.
12. **REPAIR GROUP 12 (Audit Filters)**: Passed all audit filters (`event`, `role`, `action`, `dateFrom`, `dateTo`) to `/api/admin/activity` with pagination reset.
13. **REPAIR GROUP 13 (Reconciliation Pagination)**: Keyset pagination with cursor, nextCursor, and authoritative total count.
14. **REPAIR GROUP 14 (Device List Pagination)**: Keyset pagination with cursor, total count, and direct per-device `getUserById` lookup.
15. **REPAIR GROUP 15 (Dashboard Completeness)**: Authoritative server-side aggregate queries for insights and month total.
16. **REPAIR GROUP 16 (Evidence Hold Access)**: Fail-closed audit handling; replaced `.maybeSingle()` with `.limit(1)` for multi-pass holds.
17. **REPAIR GROUP 17 (Environment Alignment)**: Supported `RESEND_FROM_EMAIL` with fallback to `EMAIL_FROM`; documented all variables.
18. **REPAIR GROUP 18 (Production Web Hardening)**: Full CSP, HSTS, nosniff, DENY frame-options, and Permissions-Policy in `vercel.json`.
19. **REPAIR GROUP 19 (ErrorBoundary Disclosure)**: Restricted componentStack and technical details to DEV mode.
20. **REPAIR GROUP 20 (404 Route)**: Catch-all `<Route path="*" element={<NotFoundPage />} />` with accessible EARIST branding.
21. **REPAIR GROUP 21 (Anonymous Abuse Controls)**: Transactional advisory lock in `api.create_upload_intent` serializing concurrent intent creation.
22. **REPAIR GROUP A (Password Recovery Session Security)**: Stripped trust from raw URL query parameters (`?type=recovery`); strictly requires genuine Supabase `PASSWORD_RECOVERY` event or unexpired `sessionStorage` token (15-minute window).
23. **REPAIR GROUPS B, C, D, E (Auth Email Architecture & Fail-Closed)**: Deleted duplicate `supabase/functions/auth-send-email/`, consolidated on Vercel Send Email Hook + React Email; updated GoTrue payload typing with inverted hashes (`token_hash_new` for current email, `token_hash` for new email); verified canonical Supabase Auth origin URL contract; fail-closed 503 if credentials missing in production.
24. **REPAIR GROUP F (Staff Onboarding Drift)**: Confirmed zero calls to `inviteUserByEmail`, `/invite`, or `user_invited` in active target codebase. Enforced temporary password + forced change model.
25. **REPAIR GROUPS H, I, J, K (Retention Enforcement, Error Handling, Starvation & Truthfulness)**: Persistent keyset cursor in `maintenance_state` (`job_name = 'retention_evidence_purge'`) advances through held items to guarantee forward progress without starvation; implemented visitor PII anonymization protecting active/held visitors; implemented audit and reconciliation pruning; reconciled partial storage/DB failures; truthful top-level statuses.
26. **REPAIR GROUP L (Unified Password Policy)**: Unified canonical `passwordSchema` (12-char min, upper, lower, digit, symbol) and helper text across `AdminUsers.tsx`, `DevicesPage.tsx`, `src/lib/passwordPolicy.ts`, and backend.
27. **REPAIR GROUP M (Incident Hold Relational Invariant)**: Added relational consistency check (`passes.visitor_id = requested_visitor_id`) in `api/admin/holds.ts` and in `api.create_incident_hold` RPC (migration 001400).
28. **REPAIR GROUP N (Dashboard Aggregates Completeness)**: Added database aggregate RPCs `dashboard_calendar_counts` and `dashboard_today_insights` in migration 001400; wired into `api/admin/dashboard.ts`, `useAdminDashboardData.ts`, `AdminDashboard.tsx`, and truthful totals in print export.
29. **REPAIR GROUP O (Environment Contract & Secret Isolation)**: Merged modern runtime names into `.env.example` while preserving owner entries; documented `docs/ENVIRONMENT.md`; added `tests/environment-contract.test.ts` (5/5 PASS).
30. **REPAIR GROUP P (Turnstile Bot Protection)**: Added Cloudflare Turnstile CAPTCHA widget for public Portal anonymous registration in `GetPassPage.tsx` and `visitorRegistration.ts`; updated CSP in `vercel.json`.
31. **REPAIR GROUP R, S & FINDING 2 (Closure Migration 001400 & Security Hardening)**: Created `20261020001400_closure_and_hardening.sql` with conditional `rls_auto_enable()` privilege hardening (revoked from public/anon/authenticated), incident hold mismatch check, and dashboard aggregate RPCs.
32. **FINAL CONFIRMED DEFECT REPAIR PASS (Groups A through N)**:
    - **Group A (Recovery Authorization & Device Governance)**: Server-controlled `/api/auth/reset-password` endpoint cryptographically verifying JWT `amr: [{ method: 'recovery' }]`. In-memory only in UI. Disallows device accounts and anonymous portal accounts. Added PostgreSQL trigger `public.protect_managed_credentials()` on `auth.users` blocking non-service-role password mutation on device/anonymous accounts. 10/10 test matrix PASS.
    - **Groups B, C, M (Send Email Hook Contract & Actions)**: Aligned with current Supabase GoTrue contract: modeled `user.new_email`, removed `email_data.new_email` and fake legacy action types. Handled canonical `email_change` (sending `token_hash_new` to current email and `token_hash` to new email). Handled all security notification actions without 500. 19/19 tests PASS.
    - **Groups D, E, F, G, L (Retention Maintenance Fail-Closed & Truthfulness)**: `app_settings` query errors fail closed with 500, zero mutations, and reconciliation. Retention protection query errors treat records as protected by uncertainty (`continue` without anonymizing). `maintenance_state.upsert(...)` errors are inspected, logged, and degrade status. Final maintenance status is computed strictly after audit event insert; `success === true` guarantees `metrics.errors.length === 0`. Full mocked handler suite PASS.
    - **Groups H, I, K (.env.example, Reproducibility & Turnstile Secret)**: Modern `.env.example` with blank placeholders committed; environment assertions verify zero secrets committed and prohibit Turnstile secret under `VITE_*`. 6/6 tests PASS.
    - **Group J (Turnstile Production Fail-Closed)**: `evaluateTurnstilePolicy` enforces that missing `VITE_TURNSTILE_SITE_KEY` or missing `captchaToken` in production fails closed with safe error. Kiosk device registration remains fully exempt. 7/7 tests PASS.

## Immediate blockers and next safe work

1. **Hosted Supabase Deployment Checkpoint**: As strictly mandated, hosted project `egatepass-dev` (`nhoawvkfqblsgutdffie`) remains untouched (`NOT APPLIED`), awaiting post-repair independent review.
2. **Pre-Deployment Gate Invariant**: All local regression suites PASS (288/288 Vitest tests pass across 21 test files, 7/7 PGlite migration tests pass, API and client TypeScript checks pass with 0 errors, production build passes, and 4/4 Playwright browser startup cases pass on Edge).
3. **Pending Live Configurations (To be performed after repository closure)**:
   - Supabase HTTPS Send Email Hook creation pointing to Vercel preview deployment.
   - Setting `SEND_EMAIL_HOOK_SECRET` in Vercel environment.
   - Configuring Cloudflare Turnstile private secret in hosted Supabase Auth Bot Protection.
   - Configuring Supabase Auth password policy (min length 12, uppercase, lowercase, digit, symbol).
   - Eventual `supabase db push` after independent approval.

## Maturity

Current product maturity is `IN PROGRESS (LEVEL 2+ / PRE-DEPLOYMENT VERIFIED)` — all confirmed root causes repaired, all recurring patterns eliminated across the repository, full regression suite passing (288 tests, 0 failures, 100% reproducible), .env.example modern and committed with zero secrets. Hosted Supabase remains unmutated pending independent owner authorization.

## Root-Cause Closure & Recurrence Elimination Status
- **Class A (Standard Webhooks)**: Fully resolved using `standardwebhooks` with canonical `v1,whsec_` support and multi-key rotation. Zero handwritten verifiers remain.
- **Class B (Portal Settings Decoupling)**: Settings reading decoupled from `authenticatedClient()`. Public anon SELECT policy added for only 6 safe columns. Kiosk unaffected.
- **Class C (Turnstile Token Lifecycle)**: Single-use credential lifecycle enforced. Widget recreation via `resetKey`. Tokens cleared on submission, expire, and error.
- **Class D (Device Credential Auth)**: Trigger upgraded to verify server-controlled `egatepass_device_credential_change_id` marker in `raw_app_meta_data`. Compromised self-password changes blocked. Compensating rollback authorized via second fresh marker. Trigger execution revoked from public roles.
- **Class E (Dashboard Authoritative Aggregates)**: Removed raw-row fallback. Fails closed with 503 on RPC error, null, or schema validation failure.
- **Class F (Supabase Returned Error Handling)**: All audit/reconciliation inserts inspect returned `.error`. Partial success semantics returned when irreversible mutations succeed but audit logging fails.
- **New Additive Migration**: `supabase/migrations/20261020204805_public_registration_settings_and_auth_hardening.sql`
- **Hosted Supabase Status**: **NOT APPLIED** (Clean offline migration chain verified through PGlite).
- **Test Metrics**:
  - `npm test`: 21 test files, 304 passed (0 failed).
  - `test:migrations`: 8/8 passed (PGlite sequential runner, upgrades, D1-D10 trigger contracts, safe anon settings RLS).
  - `test:contracts`: 16/16 passed.
  - `typecheck:api`: 0 errors.
  - `npx tsc --noEmit`: 0 errors.
  - `npm run build`: clean production build (2.13s).
  - `test:e2e:startup`: 4/4 passed (Playwright browser startup verification on Edge).


33. **AUTH / RLS CONTRACT REPAIR & AUTOMATIC RECURRENCE ELIMINATION PASS (October 2026)**:
    - **Group 1 (Dependency Exact Pin)**: `standardwebhooks: "1.1.1"` exact-pinned in `package.json` and `package-lock.json`. Contract test added.
    - **Group 2 (Turnstile Lifecycle Hardening)**: Callback props stored in refs in `TurnstileWidget.tsx`. Widget lifecycle decoupled from parent render state. 8/8 lifecycle tests pass.
    - **Group 3 (Dedicated PKCE Recovery Client)**: `requireRecoverySupabase()` with storage namespace `egatepass-recovery-auth` and PKCE flow. Operator client isolated. UI clears URL state, terminates recovery session on completion, and requires normal sign-in.
    - **Group 4 (Server Recovery Confinement)**: Centralized `getVerifiedSessionContext(admin, token)`. `requireStaffActor` strictly rejects recovery and anonymous sessions. Guard, Admin, and Pass APIs reject recovery tokens.
    - **Group 5 (PostgreSQL / RLS Identity Contract Hardening)**: Migration `20261021000100_auth_identity_contract_hardening.sql` deployed in offline chain. `private.is_portal_actor()` requires `auth.users.is_anonymous = true`. `private.current_staff_role()` blocks recovery sessions. `public.app_settings` restricts `anon` and `authenticated` to 6 safe columns only.
    - **Group 6 (PGlite 10-Actor Test Matrix)**: Full actor matrix verified in `tests/migration-chain-pglite.test.ts` across: (1) pre-auth anon, (2) anonymous Auth visitor, (3) permanent non-staff, (4) guard, (5) admin, (6) superadmin, (7) kiosk device, (8) entry device, (9) exit device, and (10) recovery staff session.

## Test Metrics (Current Pass)
- `npm test`: 22 test files, 320 passed (0 failed).
- `test:migrations`: 9/9 passed (PGlite sequential runner, upgrades, D1-D10 trigger contracts, safe anon settings RLS, 10-actor matrix).
- `test:contracts`: 17/17 passed.
- `typecheck:api`: 0 errors.
- `npx tsc --noEmit`: 0 errors.
- `npm run build`: clean production build (1.41s).
- `test:e2e:startup`: 4/4 passed (Playwright browser startup verification on Edge across dev configured/missing/malformed and preview configured).

## Documented Deployment Gates
1. **Pre-Turnstile Development Anonymous Accounts Checkpoint**: Enumerate and clean stale dev anonymous identities before production with owner approval; verify fresh anonymous sessions require valid Turnstile tokens.
2. **Hosted Data API Schema Exposure Gate**: Verify Data API exposed schemas include `public`, `graphql_public`, and `api`; perform canary RPC before production traffic.
3. **Hosted Supabase Status**: **NOT APPLIED** (All migrations and hardening verified locally/offline).


## Final Auth/RLS Recurrence Closure Status (October 2026)
- **Baseline Starting Commit**: `1d1633890dff98e79583276798c31ed95d2dac8e`
- **Branch**: `feat/runtime-migration`
- **Repairs Implemented**:
  1. `staff_profiles_select` RLS policy: excluded recovery sessions via `and not (select private.is_recovery_session())`.
  2. `devices_select` RLS policy: excluded recovery sessions via `and not (select private.is_recovery_session())`.
  3. `api.acknowledge_privacy()` RPC: rejects recovery sessions with `42501 recovery_session_forbidden`.
  4. `api.guard_dashboard(integer, integer)` RPC: rejects recovery sessions with `42501 recovery_session_forbidden` and enforces `caller_role := (select private.current_staff_role())`.
  5. `api/auth/reset-password.ts`: selects canonical columns `user_id, alias, type, status` from `public.devices` (no nonexistent `id`); inspects `deviceError` and `profileError` and fails closed with 503 `service_unavailable`.
  6. Migration `20261021000200_recovery_confinement_and_device_closure.sql` created and verified clean sequential and upgrade in PGlite. Hosted Supabase migration remains **NOT APPLIED**.
  7. Evidence classification updated: Mocked recovery tests accurately labeled; `REAL SUPABASE RECOVERY CANARY` documented as pending hosted stage.

## Test Metrics (Current Pass)
- `npm test`: 22 test files, 324 passed (0 failed).
- `test:migrations`: 9/9 passed (PGlite sequential runner, upgrades, D1-D10 trigger contracts, safe anon settings RLS, 10-actor matrix, recovery confinement).
- `test:contracts`: 17/17 passed.
- `typecheck:api`: 0 errors.
- `npx tsc --noEmit`: 0 errors.
- `npm run build`: clean production build (1.90s).
- `test:e2e:startup`: 4/4 passed (Playwright browser startup verification on Edge across dev configured/missing/malformed and preview configured).

## Documented Deployment Gates & Canaries
1. **Pre-Turnstile Development Anonymous Accounts Checkpoint**: Enumerate and clean stale dev anonymous identities before production with owner approval; verify fresh anonymous sessions require valid Turnstile tokens.
2. **Hosted Data API Schema Exposure Gate**: Verify Data API exposed schemas include `public`, `graphql_public`, and `api`; perform canary RPC before production traffic.
3. **Real Supabase Recovery Canary (Pending)**: Real end-to-end Supabase Auth PKCE recovery flow (request reset -> email delivery -> PKCE code exchange -> real token AMR -> password reset -> session termination -> normal login).
4. **Hosted Supabase Status**: **NOT APPLIED** (All migrations and hardening verified locally/offline).


34. **GUARD DASHBOARD CONTRACT / TIMEZONE REPAIR & PREDEPLOYMENT CLOSURE PASS (October 2026)**:
    - **Guard Dashboard Wire Contract Restoration**: Additive migration `20261021054710_guard_dashboard_contract_timezone_closure.sql` created via Supabase CLI. Restored canonical queue evidence IDs (`photoEvidenceId`, `idEvidenceId`), canonical pagination total (`pendingTotal`), canonical stats (`stats.total`, `stats.inside`, `stats.exited`, `stats.rejected`), and pagination flag (`hasMore`).
    - **Recovery Confinement Retained**: Recreated RPC strictly preserves recovery session rejection (`42501 recovery_session_forbidden`) and staff operational role check (`guard, admin, superadmin`).
    - **Explicit Asia/Manila Day Window**: Daily stats computed using deterministic Manila boundaries (`v_day_start` and `v_day_end` relative to `statement_timestamp() at time zone 'Asia/Manila'`). Invariance across session timezones verified in PGlite.
    - **Frontend Strict Contract Validation**: `src/services/guard.ts` validates exact canonical payload and rejects malformed shapes with descriptive errors.
    - **Local & PGlite Regression Coverage**: Added 5 frontend contract tests in `tests/guard-dashboard-contract.test.ts` and added Test J in `tests/migration-chain-pglite.test.ts` verifying contract, evidence resolution, pagination, and Manila boundaries.
    - **Predeployment Migration State Clarification**: Authoritative hosted Supabase migration history is **EMPTY** (0 tables); all **18 migrations** are pending and UNAPPLIED.

## Test Metrics (Current Pass)
- `npm test`: 23 test files, 330 passed (0 failed).
- `test:migrations`: 10/10 passed (PGlite sequential runner, upgrades, D1-D10 trigger contracts, safe anon settings RLS, 10-actor matrix, recovery confinement, Guard contract & Manila timezone).
- `test:contracts`: 17/17 passed.
- `typecheck:api`: 0 errors.
- `npx tsc --noEmit`: 0 errors.
- `npm run build`: clean production build (1.40s).
- `test:e2e:startup`: 4/4 passed (Playwright browser startup verification on Edge across dev configured/missing/malformed and preview configured).

## Documented Deployment Gates & Canaries
1. **Hosted Supabase Status**: **NOT APPLIED** (Live hosted migration history is EMPTY; 0 application tables; entire 18-migration chain pending).
2. **Pre-Turnstile Development Anonymous Accounts Checkpoint**: Enumerate and clean stale dev anonymous identities before production with owner approval; verify fresh anonymous sessions require valid Turnstile tokens.
3. **Hosted Data API Schema Exposure Gate**: Verify Data API exposed schemas include `public`, `graphql_public`, and `api`; perform canary RPC before production traffic.
4. **Real Supabase Recovery Canary (Pending)**: Real end-to-end Supabase Auth PKCE recovery flow (request reset -> email delivery -> PKCE code exchange -> real token AMR -> password reset -> session termination -> normal login).
5. **Real Guard Dashboard RPC Canary (Pending)**: Verify photo/ID evidence IDs, pagination > page limit, and Asia/Manila daily stats against live Supabase after migration push.
