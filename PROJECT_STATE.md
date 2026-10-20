# E-GatePass Project State

Updated: 2026-10-20 Asia/Manila

Current stage: P0 recovery PASS; M1–M4 runtime slices IMPLEMENTED — static/build/browser PASS; provider integration BLOCKED (no isolated DB runtime)

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


## Immediate blockers and next safe work

1. Provide one isolated executable route for the S2 promotion gate: make Docker Desktop available for local Supabase, or explicitly authorize a separate non-production hosted Supabase project after identity confirmation.
2. Run clean migrations, all authored pgTAP assertions, real Auth bearer-session Data API/RPC denials, actual private Storage operations, and the full issue→entry→decision→exit browser lifecycle.
3. Keep every provider-dependent path NOT VERIFIED / INTEGRATION BLOCKED until the isolated database and browser lifecycle run.
4. Do not link/deploy Vercel, use the hosted database, or send real emails without owner authorization.

## Maturity

Current product maturity is `IN PROGRESS` (Level 2 — reproducible local execution, complete static contracts, zero Firebase dependencies in Admin/operational UI, full build passing, comprehensive behavioral mocked-handler tests passing). Awaiting isolated Supabase database instance for Level 3 promotion; not defense-ready and not deployment-ready until PostgreSQL/Supabase behavior is live proven.
