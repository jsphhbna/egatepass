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
| S7 | Resend/Auth SMTP, retention, holds, alerts | Real inbox tests; physical Storage deletion; hold/race/retry/scheduler-auth evidence | M5-F13 CODE COMPLETE — Optional QR email claim flow, verification code, mock adapter tested; real provider delivery BLOCKED |
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
