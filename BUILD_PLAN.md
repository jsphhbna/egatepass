# E-GatePass Modernization Build Plan

Last updated: 2026-10-20 (Asia/Manila)

Target: `jsphhbna/egatepass` only

Immutable reference: `jsphhbna/E-GATEPASS` (read-only)

## Outcome and boundaries

Modernize the original React/Vite E-GatePass to Supabase, Vercel, and Resend while preserving its routes, visual identity, actor journeys, and pass lifecycle. Completion requires executable database and browser evidence plus owner-signed manual QA. No production deployment, DNS change, live-data migration, remote schema mutation, or backup-repository write is authorized by this plan.

Sensitive data includes visitor names/contact details, face and ID images, QR bearer credentials, staff/device identities, and audit history. Browser input is untrusted. Durable authorization and lifecycle transitions must be enforced in Postgres/RLS, narrowly granted RPCs, Storage policies, and protected server functions.

## Stage gates

| Recovery milestone | Scope | Required evidence | Current state |
|---|---|---|---|
| P0 | Supabase-only boot, white-screen diagnosis, fail-safe configuration states | Exact pre-fix browser reproduction; dev + preview browser smoke; missing/malformed config negative cases; desktop/390px captures | PASS locally on feature branch; owner-machine confirmation AWAITING OWNER |

| Stage | Scope | Required promotion evidence | Current state |
|---|---|---|---|
| S0 | Repository safety, original inventory, baseline tooling, environment fingerprint, screenshots | Git isolation/tree parity; rollback ref; build/type checks; Firebase emulator suite or explicit blocker; baseline screens/static parity | PARTIAL — accepted checkpoint; external provider identity remained unavailable |
| S1 | Architecture/docs foundation, test harness, safe structure plan | Original routes/UI still build and render; target architecture and migration map reviewed; no backend switch | PASS — build/type/contract checks and 9-case legacy browser regression passed |
| S2 | Supabase schema, RLS, grants, RPC/storage core, synthetic fixtures | Clean disposable migration chain and clean install; real low-privilege RLS/storage negative matrix | IMPLEMENTED — NOT VERIFIED / BLOCKED: migration chain and pgTAP matrix authored; no isolated DB runtime |
| S3 | Shared staff/device auth and governance | Real Auth sessions and browser E2E for all staff/device roles, suspension/revocation/first-login/reset | IMPLEMENTED IN PART — Supabase session/profile, login/reset, privacy, logout, forced-password endpoint/RPC; provisioning/governance and all live integration NOT VERIFIED |
| S4 | Portal/kiosk registration, private evidence, optional local OCR, Peak Mode | Phone/portrait browser E2E, real uploads, session separation, source-forgery negative tests | IMPLEMENTED IN PART — M2 code/static checks PASS; live Auth/Storage/DB/API/browser workflow BLOCKED |
| S5 | Server QR issue, entry, Guard decision, exit | Actual DB state machine E2E plus duplicate/race/wrong-device/expired negative tests | IMPLEMENTED IN PART — M2/M3 code/static checks PASS; live lifecycle BLOCKED |
| S6 | Admin/operations parity | Browser and DB proof for records, complete export, users/devices, settings, emergency, audit/reconciliation | CORRECTIONS COMPLETE (F01–F12) — PASS (MOCKED HANDLER) & pure services; live Supabase integration blocked by unavailable runtime |
| S7 | Resend/Auth SMTP, retention, holds, alerts | Real inbox tests; physical Storage deletion; hold/race/retry/scheduler-auth evidence | QR-email targeted correction LOCALLY VERIFIED; real PostgreSQL concurrency, RLS and provider delivery BLOCKED |
| S8 | Original-faithful UX/accessibility polish and full docs rewrite | Before/after images, accessibility checks, no lost route/action, owner screen approval | PLANNED |
| S9 | Staging rehearsal and release gate | Exact-commit DB/browser matrix, rollback rehearsal, preview smoke, owner QA signoff | PLANNED |

## S0 bounded tasks

1. Verify lowercase target remote, branch, status, HEAD, tracked count, reference HEAD, and tree diff.
2. Create a local rollback ref without switching branches or touching the reference.
3. Inspect routes, roles, Firestore collections/rules/indexes, Netlify functions, Cloudinary image lifecycle, tests, and current docs.
4. Validate environment names and formats without exposing values; inventory Node/npm/Java/Docker/CLIs/browser.
5. Run `npm ci`, frontend build, functions typecheck, dependency audit, `git diff --check`, and Firebase emulator tests.
6. Capture public original screens; record authenticated/camera/manual evidence as blocked or awaiting owner.
7. Create the parity/migration inventories and persistent stage evidence.

Rollback: source code has not changed in S0. Delete only S0-authored docs/evidence and return to `checkpoint/s0-original-f2f1a2b-20261020` if the owner rejects the records. Preserve the pre-existing `.env.example` working-tree edit.

## Approval boundaries

Owner-approved: local analysis, local builds/tests, disposable local emulators, synthetic fixtures, repository refactoring, target-only commits, and the staged feature set in the DevKit V10 prompt.

Awaiting separate approval: remote Supabase schema changes/resets, Vercel project creation/link/deploy, DNS changes, email sends to real inboxes, credential rotation, production data migration, paid services, and any live cleanup/deletion.

## S1 result and rollback

S1 adds only target architecture/environment/test documentation, lowercase repository metadata, an executable configuration contract test, and Vercel SPA scaffolding. The legacy Firebase/Netlify/Cloudinary runtime is deliberately unchanged. Roll back S1 with a normal revert of its checkpoint commit; do not reset or delete S0 evidence.

## S2 implementation boundary

S2 adds an additive schema, least-privilege grants/RLS, private buckets, authorization helpers, an upload-intent RPC, bootstrap guard, and executable pgTAP tests. Static tests are not database proof. Promotion and S3 runtime migration remain blocked until `supabase db reset` and `supabase test db` pass against an isolated environment with real Auth/Data/Storage API negative tests.

## P0 recovery result and rollback

The ordinary Supabase-only launch at exact checkpoint `86a455e` was reproduced in Edge with an empty `#root` and `FirebaseError: auth/invalid-api-key` at `src/lib/firebase.ts:13`. The legacy Playwright setup had hidden this by injecting synthetic Firebase values. The repaired boot renders a shell before dynamically importing the app, validates public Supabase configuration without throwing, keeps the public landing available, and fails staff/device access closed with a visible message. Roll back this slice by reverting its checkpoint commit; do not reset S0–S2 or the owner-owned `.env.example` edit.

## M2 implementation boundary

Portal and kiosk registration now use isolated Supabase browser sessions, private owner-bound Storage intents, actual uploaded-byte signature/size/SHA-256 inspection in `/api/passes/issue`, and a service-role-only atomic issuance RPC. The QR bearer value is HMAC-derived from a stable request ID and only its SHA-256 digest is stored. Scope-specific Peak Mode is rechecked in the transaction. OCR choice is **NO** for this checkpoint: original manual fields and one standard ID evidence upload are preserved; no unreviewed OCR dependency was introduced.

M2 remains `IMPLEMENTED — NOT VERIFIED`: no migration, Storage object, anonymous/kiosk Auth session, Vercel function, or issuance transaction has run against Supabase. Legacy upload/function files remain for rollback and must not be deleted until the live parity gates pass.

## M3 implementation boundary

Entry/exit scanners now send the opaque QR bearer to a Vercel handler that hashes it before a service-only RPC. The transaction resolves an active matching device and gate, locks the pass, records entry as pending, denies replay/wrong-gate use, and records exit only from inside. Guard queue/stats/settings use a bounded reauthorizing RPC with Realtime invalidation plus polling recovery. Guard decisions and private evidence reads are reauthorized server-side. All are `IMPLEMENTED — NOT VERIFIED` until the real database/Auth/API/browser lifecycle matrix runs.

## M4 implementation boundary (Admin and Operations Migration)

All Admin and operations pages (`AdminDashboard.tsx`, `AdminRecords.tsx`, `AdminUsers.tsx`, `DevicesPage.tsx`, `AdminSettings.tsx`, `AdminEmergency.tsx`, `AdminAuditLogs.tsx`, `AdminPage.tsx`) now run completely decoupled from Firebase, Firestore, and legacy Netlify functions.
1. Decoupled Timestamp: Introduced `AppTimestamp` and `asAppTimestamp()` in `src/lib/timestamp.ts`, eliminating `@firebase/firestore` types from `src/types/index.ts`.
2. Staff Governance: Provisioned through `/api/create-user`, `/api/update-user`, `/api/admin/users` and service-role RPCs `api.create_staff_profile` and `api.update_staff_profile`. Enforces last-superadmin protection via PostgreSQL trigger `protect_last_superadmin`.
3. Device Governance: Provisioned through `/api/create-device`, `/api/update-device`, `/api/update-device-auth`, `/api/delete-device`, `/api/admin/devices` and service-role RPCs `api.create_device_profile`, `api.update_device_profile`, `api.retire_device`. Enforces `@devices.egatepass.invalid` naming.
4. Dashboard Metrics: Real aggregation via `/api/admin/dashboard` returning bounded today passes, inside passes, exited passes, and decisions.
5. Emergency Evacuation: Queried via `/api/admin/emergency` for visitors currently inside, retaining 15-second polling and paper checklist print capability.
6. Records & Exports: Filtered, cursor-paginated records via `/api/admin/records` with complete CSV download via `collectCursorPages`. Credentials and private object paths redacted.
7. Audit & Reconciliation: Served via `/api/admin/activity` and `/api/reconciliation-items`, with cursor-based export.
8. Settings & Image Purge: Managed via `/api/admin/settings`, `/api/update-settings`, and `/api/purge-images`. Separates Admin operational rights from Super Admin security/retention rights. Supports dry-run and bounded storage deletion with reconciliation logging.
9. Verification: `tests/admin-governance-static.test.ts` (6/6 PASS), Vitest static suite (10 files, 79 tests PASS), `npm run typecheck:api` (PASS), `npm run build` (PASS), and Playwright startup suite (4/4 PASS). Integration remains `IMPLEMENTED — NOT VERIFIED / INTEGRATION BLOCKED` until an isolated Supabase database instance is available.

## M4 Corrections (F01–F12) & M5-F13 Implementation Boundary

All confirmed source-level findings F01 through F12 and product requirement M5-F13 are implemented, hardened, and verified with local unit/mocked-handler suites:
- **M4-F01 (Device Credential Target Validation & Atomicity)**: Hardened `api/update-device-auth.ts` and `api/update-device.ts`. Validates staff profile first (returns 403 `cannot_modify_staff_via_device_endpoint`), validates non-retired device target (returns 404), checks alias uniqueness, validates Auth existence before writes, logs honest compensation/reconciliation on partial failure, and writes mandatory immutable audit records.
- **M4-F02 (Image Purge Incident Hold Protection)**: Redesigned `api/purge-images.ts` to inspect active holds by both `visitor_id` AND `pass_id` (resolving `passes.visitor_id`), re-verifies holds and active/future passes right before physical storage delete, respects dry-run truthfulness, and records audit/reconciliation.
- **M4-F03 & M4-F10 (Trustworthy Audit & Settings Persistence)**: Created migration `20261020000800_admin_hardening.sql` adding atomic `api.update_app_settings` RPC locking the singleton row and inserting audit log within one PostgreSQL transaction; added `automatic_cleanup_enabled` column and truthful persistence.
- **M4-F04 (Staff Email Verification at Boundary)**: Updated `server/actors.ts` to enforce `email_confirmed_at` check on human staff actors (403 `email_verification_required`), preserving device exemptions.
- **M4-F05 (Device Alias Contract Alignment)**: Updated `src/pages/DevicesPage.tsx` to use `DEVICE_ALIAS_PATTERN` (`/^[a-z0-9][a-z0-9-]{2,62}$/`), accepting short alias or `@devices.egatepass.invalid`, matching backend `controlledDeviceEmail` and client `normalizeLoginIdentity`.
- **M4-F06 (Authoritative Dashboard Counters)**: Updated `api/admin/dashboard.ts`, `useAdminDashboardData.ts`, and `AdminDashboard.tsx` to query authoritative database counts (`{ count: 'exact', head: true }`) for today totals, inside, exited, rejected, and pending (`status = 'pending'`, unconstrained by null `decided_at`).
- **M4-F07 & M4-F12 (Complete Emergency Roster & Truthful UI)**: Replaced silent 500 limit in `api/admin/emergency.ts` with paginated fetch-to-completion (bounded by 10,000 ceiling and returning truthful `truncated` flag); removed all fabricated `new Date()` timestamps in `AdminEmergency.tsx`.
- **M4-F08 (Stable Compound Cursors & CSV Formula Escaping)**: Created `server/cursor.ts` supporting `(timestamp, id)` base64url JSON cursors with legacy ISO fallback. Updated `api/admin/records.ts` and `api/admin/activity.ts` with deterministic secondary sort by `id DESC` and PostgREST compound `.or(...)` filter. Hardened spreadsheet formula escaping in `src/lib/completeExport.ts` and `src/components/DashboardExportActions.tsx` for `/^[=+\-@\t\r]/`.
- **M4-F09 (Peak Mode Scope Selector in UI)**: Updated `src/pages/AdminSettings.tsx` to provide 4-way scope selector (`off`, `portal`, `kiosk`, `both`), truthful scope modal disclosure, and strict face photo retention.
- **M4-F11 (Staff List Scalability & Email Semantics)**: Updated `api/admin/users.ts` with per-user fallback lookup for profiles beyond page 1 and marked unconfirmed users as `confirmationPending: true`.
- **M5-F13 (Optional QR Code Email Delivery)**: Built two-step mailbox possession proof and delivery endpoint `api/passes/email.ts` with Resend adapter, QR PNG generation, recipient consent verification, 6-digit code verification, and reconciliation logging on provider failure without rolling back the issued pass. Built `src/components/EmailPassModal.tsx` and integrated into `src/pages/GetPassPage.tsx` and `src/pages/KioskPage.tsx`, fully preserving Download QR, print, and share actions with zero visual disruption.
- **Verification**: 12 test files, 119 tests PASS (`npx vitest run --exclude "**/firestore.rules.test.ts"`), `npm run typecheck:api` (PASS), `npm run build` (PASS), `npm run test:e2e:startup` (4/4 PASS on Edge), `git diff --check` (PASS). Real provider integration remains `IMPLEMENTED — NOT VERIFIED / INTEGRATION BLOCKED`.

## One-Pass Root-Cause Resolution & Independent Regression Audit (P0-01–P0-05, C-01–C-05)

- **P0-01 (Pass Identity Contract & Hex Bytea Serialization)**: In `api/passes/email.ts`, unified pass identifier lookup by resolving `public_reference` (e.g. `GP-20261020-0888`) or UUID to the authoritative internal row `passes.id` for verification and reconciliation tasks. Strips Postgres `\x` or `0x` bytea prefix on `token_digest` and uses `crypto.timingSafeEqual` with 32-byte SHA-256 buffer.
- **P0-02 (Email Challenge Atomicity, CSPRNG & Idempotency)**: Added migration `20261020000900_qr_email_idempotency.sql` creating atomic RPCs `api.request_email_verification_code`, `api.verify_and_claim_email_dispatch`, and `api.finalize_email_dispatch` with row locking (`FOR UPDATE`), unique idempotency indexes, and request ID deduplication. Replaced pseudo-random generator with Node `crypto.randomInt`. Enforces race-resistant rate limits, failure-safe retries without duplicate dispatches, and non-destructive reconciliation on provider failure.
- **P0-03 (Settings Atomic RPC Fail-Closed)**: Removed direct table update and unverified audit insert fallback from `api/update-settings.ts`. Strictly fails closed with mapped HTTP errors (403, 404, 400, 503) on RPC failure without partial mutations.
- **P0-04 (Image Purge Incident Hold Protection & Fail-Closed Checks)**: In `api/purge-images.ts`, checks both visitor-linked AND pass-linked active incident holds right before storage delete. Explicitly inspects `.error` outcomes on all queries and fails closed without deleting assets if any check fails.
- **P0-05 (Governance Target Validation & Error Inspection)**: In `api/update-device-auth.ts`, inspects `staffError` on `staff_profiles` check (fails closed with 503); inspects `{ error: auditError }` on audit insert and logs reconciliation on failure.
- **C-01 (Dashboard True Counts & Manila Window)**: Aligned `pendingToday` in `api/admin/dashboard.ts` to passes scanned today (`entry_scanned_at` within Manila day), distinct from all-time pending (`allPending`).
- **C-02 (Emergency Evacuation Roster Integrity)**: In `AdminEmergency.tsx`, added bold screen alert and print header (`print:block`) when `isTruncated === true` (10,000 ceiling), and prominent error banner on load failures.
- **C-03 (Compound Cursor Validation & CSV Formula Injection Defense)**: Hardened `server/cursor.ts` with `decodeCursorStrict` checking ISO timestamp and UUID/BigInt formats, rejecting malformed cursors with 400. In `src/lib/completeExport.ts`, sanitized formula prefixes `=+\-@` even after leading spaces, tabs, carriage returns, or control characters.
- **C-04 (Peak Mode & Roles Validation)**: Re-verified 4-way peak mode scope rules (`off`, `portal`, `kiosk`, `both`), ensuring visitor face photos are never skipped.
- **C-05 (Static SQL & Migration Safety)**: Expanded static migration tests in `tests/supabase-migration-static.test.ts` to validate migrations 00800 and 00900.
- **Verification**: 12 test files, 119 tests PASS, `typecheck:api` PASS, `build` PASS, Playwright startup 4/4 PASS, `git diff --check` PASS.

## Resume rule

Read `PROJECT_STATE.md`, `DECISIONS.md`, `DEVKIT_FINDINGS.md`, and `EVIDENCE_LEDGER.md` before work. Do not promote a stage with a mandatory FAILED/BLOCKED category. Safe work in later stages may be prepared, but its status remains `IMPLEMENTED — NOT VERIFIED` until the required boundary test runs.

## Targeted QR-email correction (EMAIL-P0-01 through EMAIL-P1-07)

The earlier 00900 report above is superseded for QR-email behavior by additive migration `20261020001000_qr_email_security.sql`. The handler now accepts only the issuance `public_reference` UUID, resolves it to the distinct internal `passes.id`, strictly normalizes a 32-byte SHA-256 `bytea` representation, and performs no direct verification-table fallback. Request-code, claim, code-finalization, and QR-finalization RPC responses are mandatory and validated.

The database state machine serializes code limits on the parent pass, binds request keys to actor/pass/recipient, authorizes one dispatch claim, fences `sending` and `outcome_unknown`, and prevents stale finalizers from overwriting provider acceptance. A stale claim is promoted to operator-visible unknown after 15 minutes; automatic resend remains disabled until an operator establishes the provider outcome. This is an at-most-one automatic-attempt policy, not an exactly-once guarantee across PostgreSQL and Resend.

Local promotion evidence: pre-fix regression run 7/7 FAILED as expected; corrected focused suite 4 files/92 tests PASS; complete non-Firestore Vitest suite 13 files/166 tests PASS; API typecheck PASS; production build PASS; isolated Edge startup 4/4 PASS; `git diff --check` PASS. Migration 01000 and 18 pgTAP assertions are AUTHORED / NOT RUN. No hosted database, deployment, live inbox, Firebase/Netlify infrastructure, or production data was touched.

## OCR-First Kiosk, React Email & Security Risk Corrections (UX-01, EMAIL-ARCH-01, EMAIL-H01/H02, M01-M05)

- **UX-01 (OCR-First Kiosk Registration)**: Starts by default at "Scan Your Valid ID" screen with prominent "Scan My ID" and subordinate "Want to type manually instead?" link. Uses rear-facing camera with file upload fallback; runs browser-local offline Tesseract.js with self-hosted assets in `public/tesseract/`; parses Philippine IDs (PhilSys, Driver's License, UMID, Postal ID) in `src/lib/ocr.ts` to prefill editable name fields; reuses initial `idBlob` for required ID evidence; mandatory face photo; zero Tesseract bundle leakage into portal/admin routes.
- **EMAIL-ARCH-01 (React Email + Resend Architecture)**: Installed `@react-email/components` and `@react-email/render`. Created EARIST maroon/gold accessible responsive templates in `server/templates/` (`VerificationCodeEmail.tsx`, `PassIssuedEmail.tsx`) rendered server-side in Vercel API, with secure QR PNG buffer attachment.
- **EMAIL-H01 (Conservative Resend Error Classification)**: Implemented `classifyResendHttpStatus` in `server/email.ts`. Deterministic errors (400, 401, 403, 422) map to `definitive_rejection`; 429, 5xx, timeouts, connection errors, and malformed 2xx map to `unknown`. Unknown outcomes finalize `outcome_unknown`, disable automatic retry, and record reconciliation.
- **EMAIL-H02 (Terminal State Conflict Rejection)**: Authored additive migration `20261020001100_email_security_and_abuse_controls.sql` updating finalizers to return `matched`, `already_finalized_same_status`, and `terminal_conflict`. In `api/passes/email.ts`, status mismatches fail closed with 202 `outcome_unknown` and reconciliation logging.
- **EMAIL-M01 (Abuse Safeguards)**: Enforced atomic limits of max 5 verification challenges per recipient email across all passes and max 10 challenges per actor in 15 minutes.
- **EMAIL-M02 (Active Kiosk Device Enforcement)**: Kiosk email actions require caller actor to represent an active, non-deleted device of type `kiosk` in `devices` table; revoked/guard devices rejected with 403.
- **PRIVACY-M03 (DB-Coordinated Purge Protocol)**: Implemented atomic `api.claim_evidence_for_purge` and `api.finalize_evidence_purge` RPCs in migration 01100, excluding active incident holds before storage deletion.
- **ADMIN-M04 (Staff List Keyset Pagination)**: Keyset/cursor pagination (`limit`, `cursor`, `nextCursor`, `hasMore`) implemented in `api/admin/users.ts` with "Load More Users" button in `AdminUsers.tsx`.
- **DEPLOY-M05 (Vercel SPA vs API Rewrite Precedence)**: Updated `vercel.json` SPA rewrite to `/((?!api/).*)` -> `/index.html` ensuring API function routes are never masked by client SPA HTML.
- **Verification Evidence**: Full Vitest safe suite: 16 test files, 197 tests PASS; behavioral mocked-handler suite: 55/55 PASS; isolated Edge startup 4/4 PASS; API typecheck PASS; production build PASS (2537 modules); git whitespace check PASS. Owner `.env.example` strictly preserved without staging. Migration 01100 and pgTAP 008 (12 assertions, total 81) AUTHORED / NOT RUN on live DB.

## Codex Targeted Root-Cause Correction, Supabase 404 Diagnosis & Vercel Preview Readiness (P0-A, P0-B, P0-C, P0-D, P1-E)

- **P0-A (Image Purge API↔SQL Contract & Authorization Hardening)**: Created additive migration `20261020001200_concurrency_and_purge_contract_hardening.sql`. Added `api.finalize_evidence_purge` and `api.claim_evidence_for_purge` with row locking (`FOR UPDATE`), exact claim ID verification (`ve.purge_claim_id = requested_claim_id`), 5-minute lease expiry, server-side expiration revalidation, and standardized JSON return structure (`{ finalized: true, match_status: 'matched', purged: true, evidence_id: ... }`). In `api/purge-images.ts`, updated handler to strictly validate the contract, require verified bucket/path identity matching the authoritative claim, and reconcile failures.
- **P0-B (PostgreSQL pgTAP Fixture/Schema Corrections & Static Contract Tests)**: Corrected `supabase/tests/008_email_security_and_abuse_controls.test.sql` to match canonical `public.devices` schema (`user_id, alias, name, type, gate, status`) and `public.visitors` (`created_by_device_id`). Updated `tests/supabase-migration-static.test.ts` to statically assert that obsolete/non-existent columns (`device_alias`, `registered_at`, `retired_at`, `status = 'retired'`) do not appear in tests or migrations.
- **P0-C (Cross-Pass Email Abuse Throttling Concurrency-Safe Serialization)**: Added deterministic transaction advisory locking (`pg_advisory_xact_lock`) in `api.request_email_verification_code` across distinct passes in additive migration 001200 (Level 1: Actor lock, Level 2: Recipient lock with hash conversion). Preserved limits: max 3/pass/15m, 5/recipient/15m, 10/portal-actor/15m. Authored `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` (`AUTHORED / NOT RUN`). Fixed `api/passes/email.ts` to prioritize specific `too_many_requests_recipient` and `too_many_requests_actor` over generic `too_many_requests`.
- **P0-D (Localhost:5173 Supabase 404 Root-Cause Diagnosis & Vite Dev API Routing)**: Captured failing network trace: `GET https://nhoawvkfqblsgutdffie.supabase.co/rest/v1/app_settings?select=...&singleton=eq.true` returning PostgREST HTTP 404 `PGRST205` ("Could not find the table 'public.app_settings' in the schema cache"). Identified root cause: hosted development project `egatepass-dev` has not yet had migrations 000100–001200 applied. Hardened `src/services/visitorRegistration.ts` with explicit diagnostic logging and safe fallback defaults. Replaced stale Netlify port 8888 proxy in `vite.config.ts` with `vercelApiDevPlugin` which natively routes `/api/*` requests to Vercel handlers in `api/` during local Vite dev, returning proper JSON responses (401/405/404) without 502 or SPA HTML fallback.
- **P1-E (Vercel Preview Deployment Preflight)**: Verified static OCR assets (`public/tesseract/worker.min.js`, `tesseract-core.wasm.js`, `eng.traineddata.gz`). Verified server secrets isolation (no service keys in client bundle). Probed all 10 endpoints against local dev (10/10 PASS). Authored `docs/VERCEL_PREVIEW_PREFLIGHT.md` detailing environment variable requirements, framework settings, branch/commit metadata, and three-level deployment verdict.
- **Verification Evidence**: 16 test files, 205 tests PASS in Vitest; API typecheck PASS; production build PASS (2537 modules); startup Playwright Edge 4/4 PASS; git diff whitespace check PASS; owner `.env.example` untracked and unstaged.

## Cross-Layer Root-Cause Remediation (P0-01–P0-04, EMAIL-01–EMAIL-04, HIGH-01–HIGH-05, MED-01–MED-10)

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
- **Verification Evidence**: 17 test files, 233 tests PASS in Vitest (`npx vitest run --exclude "**/firestore.rules.test.ts"`); behavioral mocked-handler suite: 72/72 PASS; API typecheck PASS (`npm run typecheck:api`); production build PASS (`npm run build`, 2537 modules); startup Playwright Edge 4/4 PASS (`npm run test:e2e:startup`); git whitespace check PASS (`git diff --check`). Owner `.env.example` strictly preserved without staging. Migrations 00100–001300 and pgTAP 001–009 AUTHORED / NOT RUN on live DB.

## Root-Cause Repair, Recurring-Pattern Elimination & Full Regression Campaign (Repairs 1A through 21)

### REPAIR GROUP 1 — Final SQL Migration Chain & Schema Contracts (1A & 1B)
- **Fixed**:
  - **1A**: Preserved canonical `api.acknowledge_privacy() RETURNS timestamptz` in both migration 000400 and migration 001300; preserved default `requested_provider_delivery_id text default null` in migration 001100.
  - **1B**: Corrected all writes to `public.audit_events` across migrations, handlers, and tests to match canonical schema: `(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state)`; removed invalid `details` column and enforced mandatory `actor_kind`.
- **Files**: `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`, `supabase/migrations/20261020001100_email_security_and_abuse_controls.sql`, `tests/migration-chain-pglite.test.ts`.
- **Root Cause**: `CREATE OR REPLACE FUNCTION` in PostgreSQL cannot change return types. Schema drift occurred between early migrations and hardening migrations regarding audit column definitions.
- **Recurrence Search**: Searched entire repository for `CREATE OR REPLACE FUNCTION` return type mismatches and all writes to `audit_events`.
- **Additional Findings**: Discovered in migration 001100 that `finalize_email_dispatch` signature had dropped the default parameter clause. Corrected it to maintain contract compatibility.
- **Tests**: Permanent PGlite test `tests/migration-chain-pglite.test.ts` executes all 13 migrations sequentially against in-memory PostgreSQL 17.5 WASM, verifying schema integrity, function signatures, and check constraints (PASS).

### REPAIR GROUP 2 — QR Email Database State Machine (2A & 2B)
- **Fixed**:
  - **2A**: Restored `request_actor_id` (not `actor_id`) consistently in `api.request_email_verification_code` queries and inserts.
  - **2B**: Enforced strict idempotency binding: request ID is permanently bound to `(pass_id, request_actor_id, recipient_email)`. Conflicting replays fail immediately with clear domain errors instead of issuing duplicate challenges or mutating request identity.
- **Files**: `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`, `api/passes/email.ts`.
- **Root Cause**: Variable naming confusion between authentication caller (`actor_id`) and table column (`request_actor_id`) in `email_verification_codes`.
- **Recurrence Search**: Searched repository for all references to `actor_id` vs `request_actor_id` in email verification tables and mocks.
- **Additional Findings**: Ensured index `email_verification_codes_request_id_idx` and rate-limiting queries use `request_actor_id`.
- **Tests**: Mocked handler idempotency suite (72/72 PASS) and PGlite RPC signature verification.

### REPAIR GROUP 3 — Incident Hold RPC Contract
- **Fixed**: Aligned parameters of `api.create_incident_hold` and `api.release_incident_hold` with API handler `api/admin/holds.ts` (`requested_actor_id`, `requested_visitor_id`, `requested_pass_id`, `requested_reason`, `requested_request_id`). Handled 409 conflict states (`purge_in_progress`, `evidence_already_purged`).
- **Files**: `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`, `api/admin/holds.ts`.
- **Root Cause**: SQL migration and API handler were authored with differing parameter naming conventions.
- **Recurrence Search**: Programmatically enumerated all `.rpc()` calls across `api/` and `src/` to confirm caller and callee parameter alignment.
- **Additional Findings**: Hold release revalidates authorization and writes structured audit record.
- **Tests**: Vitest mocked-handler hold suite and PGlite RPC parameter validation.

### REPAIR GROUP 4 — Expired Guard Approval Transaction Semantics
- **Fixed**: In `api.decide_visit`, when an expired pass is approved by guard, the transaction now updates `status = 'expired'::public.pass_status`, writes a valid `invalid_scan` visit event (`expired` is not a valid `visit_event_type`), writes an audit record, commits the state, and returns `'expired'`. In `api/decide-visit.ts`, handled status `'expired'` returning HTTP 422 with structured failure.
- **Files**: `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`, `api/decide-visit.ts`.
- **Root Cause**: Raising an exception in PostgreSQL aborted the transaction, preventing the intended `'expired'` state from persisting. Furthermore, `'expired'` was not a valid member of `public.visit_event_type`.
- **Recurrence Search**: Searched migrations for `UPDATE ... RAISE EXCEPTION` anti-patterns and searched all enum casts across SQL files.
- **Additional Findings**: `visit_event_type` valid values are `invalid_scan`, `scan_entry`, `approved`, `rejected`, `scan_exit`.
- **Tests**: PGlite test confirms enum values; Vitest test validates 422 response.

### REPAIR GROUP 5 — Retention and Physical Storage Maintenance (5A through 5G)
- **Fixed**:
  - **5A**: Canonical parameter `requested_success: true` in `api.finalize_evidence_purge`.
  - **5B**: Split-brain handling: if storage deletion succeeds but DB finalization fails, durable reconciliation record is written with exact evidence ID, claim ID, bucket, path, and storage deletion fact.
  - **5C**: Enforced `automatic_cleanup_enabled` for cron tasks; skips destructive operations with truthful skipped response when disabled.
  - **5D**: Enforced retention policies for images, visitors, audit events, and reconciliation items based on `app_settings`.
  - **5E**: Canonical audit outcomes: restricted to `'success' | 'partial' | 'failure' | 'denied'`, eliminating invalid `'partial_failure'`.
  - **5F**: Handled destructive storage deletion errors and audit insert errors explicitly.
  - **5G**: Prevented retention starvation by oversampling candidates (querying 200 candidates to claim batch size of 50).
- **Files**: `api/admin/retention-maintenance.ts`, `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`.
- **Root Cause**: Maintenance scripts lacked guard checks for configuration flags, used mismatched parameter names, and ignored potential storage/database partial failures.
- **Recurrence Search**: Searched for `.error` handling across all destructive operations and audit outcome string values.
- **Additional Findings**: Fixed audit outcome check constraint compliance in PGlite.
- **Tests**: Mocked handler tests for purge protocol and PGlite audit check constraint verification.

### REPAIR GROUP 6 — Supabase Auth, React Email & Resend (6A through 6F)
- **Fixed**:
  - **6A**: Preserved Send Email Hook with Resend as authoritative email provider.
  - **6B**: Corrected `buildAuthVerificationUrl` in `server/auth-email-hook.ts`: verification endpoint `/auth/v1/verify` is built from Supabase Auth base URL (`SUPABASE_URL` / `VITE_SUPABASE_URL`), while `siteUrl` / `redirect_to` is used as application destination.
  - **6C**: Fail-closed in `api/auth/send-email-hook.ts`: returns HTTP 503 (`provider_unconfigured`) if `RESEND_API_KEY` is missing in production.
  - **6D**: Consolidated on single canonical React Email templates (`SignupConfirmationEmail`, `PasswordResetEmail`, `StaffInviteEmail`, `EmailChangeEmail`).
  - **6E**: Preserved admin temporary-password workflow with branded signup confirmation email and forced first password change.
  - **6F**: Audited all email actions (signup, recovery, email change, QR OTP).
- **Files**: `server/auth-email-hook.ts`, `api/auth/send-email-hook.ts`, `tests/auth-email-hook.test.ts`.
- **Root Cause**: Building verification URLs from frontend site URL resulted in 404s because `/auth/v1/verify` is a Supabase GoTrue endpoint, not a Vite frontend route.
- **Recurrence Search**: Searched all verification and redirect URL builders across `server/` and `api/`.
- **Additional Findings**: Updated tests in `tests/auth-email-hook.test.ts` to assert that Supabase URL is the origin for the verify URL and frontend site URL is in the `redirect_to` query parameter.
- **Tests**: 15/15 tests PASS in `tests/auth-email-hook.test.ts`.

### REPAIR GROUP 7 — Unified Password Policy
- **Fixed**: Created unified password policy in `server/password-policy.ts` and updated `src/lib/passwordPolicy.ts`: minimum 12 characters, requiring uppercase, lowercase, digit, and symbol. Applied shared Zod `passwordSchema` across staff creation, device provisioning, device credential updates, and forced password changes.
- **Files**: `server/password-policy.ts`, `src/lib/passwordPolicy.ts`, `api/create-user.ts`, `api/create-device.ts`, `api/update-device-auth.ts`, `api/auth/complete-password-change.ts`.
- **Root Cause**: Drift between frontend regex (`>= 12`, letter, digit) and Supabase Auth backend configuration (requiring uppercase, lowercase, digits, symbols).
- **Recurrence Search**: Searched repository for all password validation regexes and Zod string schemas.
- **Additional Findings**: Helper text updated in UI components to accurately reflect all 4 character classes.
- **Tests**: API typecheck and Vitest pure service tests PASS.

### REPAIR GROUP 8 — Reset Password Session Security
- **Fixed**: In `src/pages/ResetPasswordPage.tsx`, recovery context is now strictly required (`PASSWORD_RECOVERY` event or URL `type=recovery`). Disallowed normal authenticated staff/devices from accessing recovery as a self-service credential reset without recovery tokens.
- **Files**: `src/pages/ResetPasswordPage.tsx`.
- **Root Cause**: Page previously checked only `session !== null`, allowing active sessions to bypass recovery token checks.
- **Recurrence Search**: Searched all auth pages for session-check logic.
- **Additional Findings**: Added `PASSWORD_POLICY_HELPER_TEXT` display.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 9 — System Settings Fail-Open UI Prevention
- **Fixed**: In `src/pages/AdminSettings.tsx`, removed silent fallback to editable default values when `/api/admin/settings` fails. Rendered explicit error banner with `AlertTriangle`, disabled Save button, and added a "Retry Loading Settings" button.
- **Files**: `src/pages/AdminSettings.tsx`.
- **Root Cause**: Fetch errors previously triggered catch block that populated form with default settings, risking accidental overwrite of production settings.
- **Recurrence Search**: Searched all admin pages for error fallbacks that could overwrite authoritative data.
- **Additional Findings**: Guarded against null settings payload.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 10 — Guard Queue Pagination (>50 passes)
- **Fixed**: In `src/services/guard.ts`, added `limit`, `offset`, `pendingTotal`, and `hasMore` to `fetchGuardDashboard`. In `src/pages/GuardPage.tsx`, displayed authoritative `pendingTotal` in badge, preserved loaded passes across realtime/poll updates using dynamic limit, and added "Load More Pending Passes" pagination.
- **Files**: `src/services/guard.ts`, `src/pages/GuardPage.tsx`.
- **Root Cause**: UI previously requested fixed 50 records and displayed `passes.length` instead of total pending backlog.
- **Recurrence Search**: Searched for `.limit(` and list length displays across guard and admin views.
- **Additional Findings**: Guarded realtime update subscriptions to preserve pagination depth.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 11 — Visitor Record Server-Side Search
- **Fixed**: In `src/pages/AdminRecords.tsx`, added server-side `search` query parameter with 300ms debounce, cursor reset on search change, and aligned CSV export filter.
- **Files**: `src/pages/AdminRecords.tsx`.
- **Root Cause**: Search input was applied only as a client-side filter over the current loaded page.
- **Recurrence Search**: Searched all table search inputs in `src/pages/`.
- **Additional Findings**: Resetting cursor on search/filter changes ensures complete pagination from page 1.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 12 — Server-Side Audit Filters
- **Fixed**: In `src/hooks/useAuditActivity.ts`, updated `useVisitorActivity` and `useAdministrativeAudit` to pass filter parameters (`event`, `role`, `action`, `dateFrom`, `dateTo`) to `/api/admin/activity`. Connected debounced filters and pagination reset in `src/pages/AdminAuditLogs.tsx`.
- **Files**: `src/hooks/useAuditActivity.ts`, `src/pages/AdminAuditLogs.tsx`.
- **Root Cause**: Filter dropdowns were not passed to backend queries, filtering only in-memory records.
- **Recurrence Search**: Searched for filter dropdown controls in admin interfaces.
- **Additional Findings**: Debounced action text search input by 300ms to avoid query flooding.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 13 — Reconciliation Pagination & Total Count
- **Fixed**: In `api/reconciliation-items.ts`, implemented keyset pagination with `cursor`, `pageSize`, `hasMore`, `nextCursor`, and authoritative count query (`select('id', { count: 'exact', head: true })`). In `src/hooks/useAuditActivity.ts` and `src/pages/AdminAuditLogs.tsx`, surfaced paginated state, authoritative count in tab header, and "Load more" button.
- **Files**: `api/reconciliation-items.ts`, `src/hooks/useAuditActivity.ts`, `src/pages/AdminAuditLogs.tsx`.
- **Root Cause**: Query was hardcoded to `.limit(50)` without pagination or total count.
- **Recurrence Search**: Searched for hardcoded operational limits.
- **Additional Findings**: Tab label displays exact total unresolved items.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 14 — Device List Keyset Pagination & Direct Email Resolution
- **Fixed**: In `api/admin/devices.ts`, implemented keyset pagination (`cursor`, `pageSize`, `hasMore`, `nextCursor`, `total`). Replaced 200-user `listUsers` scan with direct per-device `admin.auth.admin.getUserById(id)` lookup, eliminating cross-page email resolution cutoffs. In `src/pages/DevicesPage.tsx`, added pagination state and "Load More Devices" button.
- **Files**: `api/admin/devices.ts`, `src/pages/DevicesPage.tsx`.
- **Root Cause**: Device list relied on `listUsers({ perPage: 200 })`, which omitted devices whose Auth users were beyond page 1.
- **Recurrence Search**: Searched all admin identity queries for fixed user list queries.
- **Additional Findings**: Direct user lookup is immune to page size limits and respects RLS.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 15 — Dashboard Data Completeness & Server Aggregates
- **Fixed**: In `api/admin/dashboard.ts`, replaced client-side sampling with authoritative server-side aggregate queries for `topPurpose`, `busiestGate`, `topRejection`, `avgApprovalTime`, and added `monthTotal` count query. Updated `src/components/DashboardExportActions.tsx` to clearly distinguish complete monthly aggregates from recent sample lists.
- **Files**: `api/admin/dashboard.ts`, `src/hooks/useAdminDashboardData.ts`, `src/pages/AdminDashboard.tsx`, `src/components/DashboardExportActions.tsx`.
- **Root Cause**: Insights were derived from the first 100 recent passes, misrepresenting monthly totals.
- **Recurrence Search**: Searched for statistics derived from `.slice(0, 100)` or `.limit(100)` arrays.
- **Additional Findings**: CSV and print views now display truthful server-computed month totals.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 16 — Evidence Hold Access Audit & Multi-Pass Hold Queries
- **Fixed**:
  - **16A**: Handled audit insert error in `api/evidence.ts` with fail-closed behavior, ensuring unauthorized access without audit cannot occur.
  - **16B**: Replaced `.maybeSingle()` with `.limit(1)` in `activePassHold` query to support visitors with multiple held passes without query exceptions.
- **Files**: `api/evidence.ts`.
- **Root Cause**: `maybeSingle()` in Supabase PostgREST throws an error if more than 1 record matches, which occurs when multiple passes are under hold for the same visitor.
- **Recurrence Search**: Searched entire codebase for `.maybeSingle()` calls on non-unique columns.
- **Additional Findings**: Verified hold queries across all endpoints.
- **Tests**: Mocked handler hold tests (3/3 PASS) and production build PASS.

### REPAIR GROUP 17 — Environment Variable Alignment
- **Fixed**: Supported `RESEND_FROM_EMAIL` with fallback to `EMAIL_FROM` in `server/email.ts`. Updated `docs/ENVIRONMENT.md` documenting all required variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `PASS_TOKEN_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SEND_EMAIL_HOOK_SECRET`, `CRON_SECRET`). Preserved owner `.env.example` unstaged.
- **Files**: `server/email.ts`, `docs/ENVIRONMENT.md`.
- **Root Cause**: Variable naming disparity between documentation (`EMAIL_FROM`) and Resend configuration (`RESEND_FROM_EMAIL`).
- **Recurrence Search**: Programmatically compared referenced environment names in source code against documentation.
- **Additional Findings**: Zero secrets committed; all variables validated.
- **Tests**: Typecheck and Vitest suite PASS.

### REPAIR GROUP 18 — Production Web Hardening & Content Security Policy
- **Fixed**: In `vercel.json`, configured comprehensive security headers: CSP (supporting camera, scanner, OCR WASM, fonts, Supabase storage blobs, WebSockets), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- **Files**: `vercel.json`.
- **Root Cause**: Missing production HTTP security headers for browser hardening against clickjacking, MIME-sniffing, and cross-site scripting.
- **Recurrence Search**: Verified camera, scanner, and WebAssembly operational requirements against CSP directives.
- **Additional Findings**: WASM `wasm-unsafe-eval` included for client-side Tesseract.js OCR.
- **Tests**: JSON syntax validation and architecture contract tests PASS.

### REPAIR GROUP 19 — ErrorBoundary Disclosure Hardening
- **Fixed**: In `src/components/ErrorBoundary.tsx`, restricted internal React component stack and raw error messages to `import.meta.env.DEV`. In production, displays user-friendly error UI with refresh/retry actions and zero internal component trace disclosures.
- **Files**: `src/components/ErrorBoundary.tsx`.
- **Root Cause**: ErrorBoundary previously rendered raw error and component stack in all environments.
- **Recurrence Search**: Searched for error disclosure patterns across UI components.
- **Additional Findings**: Retry button cleans local state and reloads gracefully.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 20 — Catch-All 404 Route
- **Fixed**: Created `src/pages/NotFoundPage.tsx` with accessible EARIST branding, clear message, and navigation buttons. Added `<Route path="*" element={<NotFoundPage />} />` in `src/App.tsx`.
- **Files**: `src/pages/NotFoundPage.tsx`, `src/App.tsx`.
- **Root Cause**: Missing 404 route in React Router caused invalid URLs to render a blank page or default route.
- **Recurrence Search**: Verified all declared routes and sub-routes in `App.tsx`.
- **Additional Findings**: Deep links rewritten safely via `vercel.json` SPA rule `/((?!api/).*)`.
- **Tests**: Production build PASS; TypeScript validation PASS.

### REPAIR GROUP 21 — Anonymous Abuse Controls & Advisory Locking
- **Fixed**: In migration 001300 `api.create_upload_intent`, added transactional advisory lock `perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));` before quota evaluation, serializing concurrent requests and preventing race conditions that bypass intent limits.
- **Files**: `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql`.
- **Root Cause**: Count-then-insert pattern without serialization allowed concurrent requests to exceed the 10-intent quota.
- **Recurrence Search**: Searched for count-then-insert patterns across all API endpoints and SQL functions.
- **Additional Findings**: Transaction-scoped advisory locks automatically release on transaction commit or rollback without deadlocks.
- **Tests**: PGlite sequential migration test PASS.

---

### Campaign Validation Summary
- **Migration Chain**: 13/13 migrations apply sequentially in real PostgreSQL 17.5 WASM (PGlite) with 0 errors.
- **RPC Contracts**: All 6 critical RPC signatures verified against database dictionary.
- **Enum Contracts**: Validated `visit_event_type` and `pass_status` values; verified `'expired'` is not in `visit_event_type`.
- **Audit Schema**: Canonical audit table columns and check constraints verified with positive and negative tests.
- **Vitest Suite**: 18 test files, 238 tests PASS (0 failures).
- **TypeScript Typechecks**: `npm run typecheck:api` PASS; `npx tsc --noEmit` PASS.
- **Production Build**: `npm run build` PASS (2538 modules transformed in 1.41s).
- **Git State**: `.env.example` preserved byte-for-byte unstaged.
