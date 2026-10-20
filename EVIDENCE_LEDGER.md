# Evidence Ledger

S0 baseline revision: `f2f1a2b58ef19808c1be83865ee8537073b0dada`

S1 checkpoint: `babb8c5f5cd5c77f4bafe3a535fd03e54b05e2a4`

S2 implementation checkpoint: `80d861b8186418837ed0b862288da4e4b53e4637`

S2 documentation/pushed checkpoint: `86a455ede2adc68ef6e09794e3ad118b70f63162`

Date/time zone: 2026-10-20, Asia/Manila

## P0 runtime recovery and M1 start

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-P0-001 | STATIC / GIT / ENVIRONMENT | fetch, remote/upstream/status/rollback refs; sanitized env-name inventory | PASS | Local and `origin/main` both `86a455e`; lowercase origin only; `.env.example` remains owner-owned; Supabase names present and Firebase names absent; no values displayed |
| EV-P0-002 | CLEAN INSTALL | `npm ci` | PASS: 1,317 packages installed; audit reported 24 findings (22 high, 2 moderate) | Install reproducibility only; findings remain under documented triage |
| EV-P0-003 | BROWSER FAILURE REPRODUCTION | detached worktree at `86a455e`; Edge via Playwright/Vite with Firebase variables empty | FAIL as expected: empty `#root`; first runtime error `auth/invalid-api-key` at `src/lib/firebase.ts:13` | Proves the local white-screen root cause at the checkpoint; screenshot `docs/evidence/p0-white-screen/before-desktop.png` |
| EV-P0-004 | SOURCE / RUNTIME INVENTORY | `rg` across `src`, package and Vite configuration | FAIL migration gate: active Firebase/Firestore/Netlify/Cloudinary references remain | Proves S2 had not migrated the application runtime; full cutover not claimed |
| EV-P0-005 | STATIC BUILD | `npm run build` | PASS; Firebase remains a deferred 626.59 kB output chunk | Compilation and chunk inventory only; not provider integration |
| EV-P0-006 | BROWSER E2E | `npm run test:e2e:startup` | PASS: 4/4 isolated Edge runs (dev configured/missing/malformed; preview configured) | Original landing visible, no uncaught page/console errors, JS entrypoint served, 390px no horizontal overflow; screenshots retained |
| EV-P0-007 | NEGATIVE BROWSER | missing and malformed public Supabase variables in EV-P0-006 | PASS | Public page remains visible; `/login` shows actionable unavailable state and disabled submit; no Firebase fallback |
| EV-P0-008 | HARNESS FAILURE | first repaired browser rerun and first preview rerun | FAIL then corrected | CTA regex did not match preserved label; preview incorrectly required dev-only `/src/main.tsx`. Assertions were corrected and the complete matrix reran PASS |
| EV-P0-009 | SUPABASE DATABASE / AUTH / STORAGE | S2 migrations plus new Supabase Auth client | BLOCKED / NOT TESTED | No SQL was applied and no real Auth/RLS/Storage session was exercised; requires Docker-backed local Supabase or explicit isolated hosted-project authorization |
| EV-P0-010 | UNIT / STATIC CONTRACT | `npm run test:runtime`; `npm run test:architecture`; `npm run test:supabase:static` | PASS: 4/4, 3/3, and 5/5 assertions | Pure config/identity/bootstrap contracts plus existing architecture/SQL text contracts; not live provider evidence |
| EV-P0-011 | DEPENDENCY / CUTOVER INVENTORY | `npm audit --omit=dev --json`; target `rg` inventory | FAIL release gate: 4 high production findings; 67 legacy-match lines | Findings remain in reachable legacy Firebase chain; Firebase bundle still emitted and legacy cleanup is correctly deferred |
| EV-P0-012 | LEGACY E2E | `npm run test:e2e:legacy` | NOT RUN on migration branch | It provisions Firebase emulator users while the shared login now targets Supabase; running it would send synthetic credentials to the unidentified hosted Supabase URL. Replacement real Supabase E2E is BLOCKED pending an authorized isolated environment |

## M1/S3 identity implementation

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-M1-001 | IMPLEMENTATION | Supabase Auth/session/login/reset/privacy/logout code; identity RPC migration; Vercel forced-password handler | IMPLEMENTED — NOT VERIFIED | Source exists and compiles; no provider/database claim |
| EV-M1-002 | STATIC / TYPECHECK | `npm run typecheck:api`; `npm run build` | PASS | Vercel TypeScript and frontend compile only; built output still includes Firebase deferred chunk |
| EV-M1-003 | STATIC CONTRACT | `npm run test:identity:static`; `npm run test:supabase:static` | PASS: 4/4 and 5/5 | Reviews source contracts only; 35 pgTAP assertions are authored, not executed |
| EV-M1-004 | BROWSER E2E | `npm run test:e2e:startup` | PASS: 4/4 Edge cases | Landing and reset unavailable/invalid-link behavior in dev/preview; no real Auth session or email link |
| EV-M1-005 | ENVIRONMENT / DATABASE | `npx --yes supabase@2.121.0 status` | BLOCKED: `StatusDbInspectError`; Docker and Podman not found; linked project null | No migration/RPC/Auth/Storage operation was run |
| EV-M1-006 | PROVIDER DOCUMENTATION | Official Supabase Auth/API-key/server-client and Vercel Vite/Node Function docs reviewed 2026-10-20 | REVIEWED | Supports design expectations only; not project runtime evidence |
| EV-M1-007 | CUTOVER INVENTORY | target `rg` scan | FAIL release gate: 50 legacy-provider match lines | Reduced from 67; Firebase chunk remains; cleanup prohibited until parity gates pass |

## M2/S4 registration and issuance implementation

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-M2-001 | IMPLEMENTATION | portal/kiosk Supabase service; private upload intents; `/api/passes/issue`; `20261020000500_pass_issuance.sql` | IMPLEMENTED — NOT VERIFIED | No real Auth, Storage, database, or Vercel request was executed |
| EV-M2-002 | STATIC / TYPECHECK | `npm run build`; `npm run typecheck:api` | PASS, exit 0 | Compilation only; Vite still emits a 621.99 kB deferred Firebase chunk from unmigrated stages |
| EV-M2-003 | STATIC CONTRACT | `npm run test:issuance:static` | PASS: 1 file / 7 tests | Source-level contracts only; not database proof |
| EV-M2-004 | DATABASE TEST AUTHORING | `supabase/tests/004_pass_issuance.test.sql` | NOT RUN / BLOCKED: 10 assertions authored | Requires Docker-backed local Supabase or authorized isolated non-production project; total authored pgTAP assertions now 45 |
| EV-M2-005 | DEPENDENCY AUDIT | `npm audit --omit=dev --json` | FAIL release gate: 4 high, 0 moderate/critical | Findings remain in legacy Firebase runtime chain; no forced upgrade |
| EV-M2-006 | CUTOVER INVENTORY | case-sensitive target `rg` scan | FAIL release gate: 48 matching lines | Down from M1's 50; portal/kiosk/new service/endpoint have zero matches; legacy scan/Guard/Admin/config remains |

## M3/S5 gate lifecycle implementation

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-M3-001 | IMPLEMENTATION | `/api/scan-pass`, `/api/decide-visit`, `/api/evidence`, Guard Supabase service, `20261020000600_gate_lifecycle.sql` | IMPLEMENTED — NOT VERIFIED | No request reached Vercel/Supabase and no lifecycle row changed in a database |
| EV-M3-002 | STATIC / TYPECHECK | `npm run build`; `npm run typecheck:api` | PASS, exit 0 | Compilation only; Firebase deferred chunk remains 621.99 kB |
| EV-M3-003 | STATIC CONTRACT | `npm run test:lifecycle:static` | PASS: 1 file / 6 tests | Source-level digest/device/gate/transition/evidence contracts only |
| EV-M3-004 | DATABASE TEST AUTHORING | `supabase/tests/005_gate_lifecycle.test.sql` | NOT RUN / BLOCKED: 14 assertions authored | Real row locks, concurrent/replay behavior, Realtime/RLS and full lifecycle remain unproven; total pgTAP authored is 59 |
| EV-M3-005 | CUTOVER INVENTORY | case-sensitive target `rg` scan | FAIL release gate: 46 matching lines | Down from 48; Guard page no longer imports Firebase, but Admin/config/type/runtime legacy remains |

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-S0-001 | STATIC / GIT | `git remote -v`; branch/status/HEAD checks; `git ls-remote` for both main refs | PASS | Lowercase target only is configured; backup queried read-only |
| EV-S0-002 | STATIC / GIT | `git ls-tree` and `git diff --name-only HEAD 6906b91...` | PASS: 126 files each, zero differences | Tracked Git tree only; untracked/ignored developer tools excluded |
| EV-S0-003 | ENVIRONMENT | PowerShell `Get-Command` plus version commands | PASS inventory | Docker/Supabase/Vercel/Playwright absent is an observed blocker, not product failure |
| EV-S0-004 | ENVIRONMENT / SECRET HYGIENE | `git check-ignore .env.local`; names/status/URI validation script | PARTIAL | Ignore/names PASS; both Supabase URLs invalid; values never printed |
| EV-S0-005 | STATIC BUILD | `npm run build` | PASS, exit 0 | TypeScript + Vite build only; 500 kB chunk warning remains |
| EV-S0-006 | STATIC BUILD | `npm run typecheck:functions` | PASS, exit 0 | Legacy Netlify function TypeScript only |
| EV-S0-007 | STATIC | `git diff --check` | PASS, exit 0 with CRLF warning for pre-existing `.env.example` | Whitespace check only |
| EV-S0-008 | DEPENDENCY AUDIT | `npm audit --json` summarized without package payloads | FAIL: 24 total, 22 high, 2 moderate, 0 critical | Findings not remediated in S0 |
| EV-S0-009 | UNIT + LIVE LOCAL EMULATOR | Firebase CLI 13.10.0 Auth/Firestore `emulators:exec` running Vitest JSON reporter | PASS: 22/22 suites; 238/238 tests; 0 failed/pending | Legacy Firebase baseline only; not Supabase, production, or browser E2E |
| EV-S0-010 | BROWSER RENDER | Edge 155 headless against local Vite; screenshots under `docs/evidence/s0-baseline/` | PARTIAL | Landing desktop/login PASS visually; 390px landing exposes clipping |
| EV-S0-013 | BROWSER E2E / LIVE LOCAL EMULATORS | Playwright 1.64.1 with installed Edge 155, Firebase Auth/Firestore emulators, synthetic in-process credentials | PASS: 9 listed tests, `.last-run.json` passed with zero failed IDs | Proves original role route rendering/public-nav absence/wrong-role redirect/Admin tab rendering locally; not production/provider proof |
| EV-S0-011 | USER MANUAL | `docs/MANUAL_QA_RUNBOOK.md` | AWAITING OWNER | Actual/observed/evidence/signoff fields intentionally blank |
| EV-S0-012 | PROVIDER | Supabase/Vercel/Resend remote identity/config | BLOCKED / NOT TESTED | Malformed URL and missing CLIs/link; no provider mutation attempted |

## Baseline command notes

- `npm ci`: PASS; installed 1,314 packages and audited 1,316 packages.
- Java emulator runtime: 25.0.4.1 LTS.
- The first emulator run downloaded the pinned Firebase CLI/emulator assets. Subsequent runs reproduced an orphaned Firestore emulator process; only the verified local emulator PID was stopped.
- Generated Firebase debug logs containing synthetic emulator action links were removed and are ignored by Git.
- The first E2E run failed diagnostically on an ambiguous Password locator. The regression uses `#login-password` and semantic role-page headings; the complete rerun passed.

Evidence is tied to the working-tree baseline plus S0 documentation/screenshots. It does not establish deployment, real email, camera, Supabase RLS, Storage deletion, or production readiness.

## S1 architecture checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-S1-001 | ENVIRONMENT / SECRET HYGIENE | private `.env.local` URL validation; `git check-ignore -v .env.local` | PASS for syntax/match/ignore | Two matching HTTPS URL entries; no values printed; connectivity/project identity NOT TESTED |
| EV-S1-002 | UNIT / CONFIG CONTRACT | `npm run test:architecture` | PASS: 1 file, 2 tests | Lowercase repository metadata and local `vercel.json` structure only |
| EV-S1-003 | STATIC BUILD | `npm run build` | PASS | React/TypeScript/Vite build; existing >500 kB chunk warning remains |
| EV-S1-004 | STATIC BUILD | `npm run typecheck:functions` | PASS | Unchanged legacy Netlify function source only |
| EV-S1-005 | BROWSER E2E / LIVE LOCAL EMULATORS | `npm run test:e2e:legacy`; Playwright `.last-run.json` | PASS: status passed, 0 failed; existing 9-case suite | Preserved local legacy routes/roles/Admin tabs; not target Supabase/Vercel proof |
| EV-S1-006 | STATIC | `git diff --check` | PASS with expected pre-existing `.env.example` line-ending warning | Working tree whitespace only |
| EV-S1-007 | DOCUMENTATION AUTHORITY | Supabase RLS/functions/Storage and Vercel Vite/Functions/config docs reviewed 2026-10-20 | REVIEWED | Establishes expected design, not runtime/project behavior |

User manual S1 screen comparison remains AWAITING OWNER. Supabase clean migration/RLS/Storage integration remains BLOCKED pending an isolated executable environment.

## S2 implementation checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-S2-001 | TOOLING | `npx --yes supabase@2.121.0 --version` | PASS: 2.121.0 | CLI availability only; Docker and `psql` are not found |
| EV-S2-002 | STATIC / UNIT | `npm run test:supabase:static` | PASS: 1 file, 5 tests | Checks RLS coverage/grants/definer hardening/private-bucket/kiosk-isolation policy text; explicitly not SQL execution |
| EV-S2-003 | STATIC BUILD | `npm run build` | PASS | Existing UI compiles; target backend is not connected; >500 kB warning remains |
| EV-S2-004 | CONFIG REGRESSION | `npm run test:architecture` | PASS: 1 file, 2 tests | S1 repository/Vercel config contract retained |
| EV-S2-005 | LIVE LOCAL DATABASE | `npx --yes supabase@2.121.0 db reset --local` | BLOCKED: `LocalDbRunningError: failed to inspect service` | No Docker engine/local Postgres; no migration was applied anywhere |
| EV-S2-006 | DATABASE/RLS | `supabase/tests/*.test.sql` | NOT RUN / BLOCKED | 27 pgTAP assertions authored across authorization and schema contracts; no database boundary evidence |
| EV-S2-007 | DEPENDENCY AUDIT | `npm audit --json`; `npm audit --omit=dev --json`; `npm ls ...`; `npm outdated --long` | TRIAGED: 24 total; production-only 4 high, 0 moderate/critical | No forced upgrade; reachability and removal plan in `docs/DEPENDENCY_AUDIT.md` |
| EV-S2-008 | TEST HARNESS NEGATIVE / REGRESSION | `npm test` before and after `vitest.config.ts` | Initial FAIL: Playwright spec collected by Vitest; exact rerun PASS, exit 0 | First rerun was blocked by the known orphaned Firestore process; PID/command was verified, stopped, and final ports were clear |

Exact-commit verification at `80d861b`: `npm run test:architecture` PASS 3/3; `npm run test:supabase:static` PASS 5/5; `npm run build` PASS; `npm run typecheck:functions` PASS. The only working-tree change during those commands was the preserved, pre-existing `.env.example` edit.

## M4 / S6 Admin and operations runtime checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-M4-001 | STATIC / UNIT | `npx vitest run tests/admin-governance-static.test.ts` | PASS: 1 file, 6 tests | Verifies decoupling of all Admin pages from Firebase, bearer auth on all 16 admin endpoints, Super Admin privilege boundaries, controlled device aliases, cursor exports, and audit logging |
| EV-M4-002 | STATIC / UNIT | `npx vitest run tests/*.test.ts` (10 test files) | PASS: 10 files, 79 tests | Complete unit and static test suite covering architecture, exports, gate lifecycle, identity, issuance, retention, runtime config, Supabase static, and admin governance |
| EV-M4-003 | STATIC BUILD | `npm run typecheck:api` | PASS: exit code 0 | Type checks all Vercel Web Handlers in `api/` and helpers in `server/` against `@supabase/supabase-js` and Zod schemas |
| EV-M4-004 | STATIC BUILD | `npm run build` | PASS: exit code 0 | React + Vite client compilation producing production bundles without any runtime syntax or type errors |
| EV-M4-005 | BROWSER E2E / STARTUP | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge browser tests for dev/configured, dev/missing, dev/malformed, and preview/configured startup without synthetic Firebase variables |
| EV-M4-006 | DATABASE/RLS | `supabase/tests/006_admin_governance.test.sql` | NOT RUN / BLOCKED | 10 pgTAP assertions authored for staff/device RPCs and last-superadmin protection; blocked by lack of local Docker/Postgres environment |

## M4 Corrections (F01–F12) & M5-F13 Runtime Hardening Checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-M4-007 | PURE SERVICES UNIT | `npx vitest run tests/pure-services.test.ts` | PASS: 1 file, 16 tests | Pure unit tests for compound base64url cursors, legacy ISO fallback, controlled device email aliases, CSV formula injection defense (`=+\-@\t\r`), incident hold protection (visitor and pass_id holds), and 4-way peak mode scope rules |
| EV-M4-008 | BEHAVIORAL MOCKED HANDLER | `npx vitest run tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER): 1 file, 12 tests | Behavioral tests with mock Supabase Admin and email adapters: F01 staff target rejection (403), missing device (404), alias conflict (409), device password update + audit; F04 unconfirmed staff email rejected (403); F03 & F10 settings atomic persistence via RPC; F02 image purge hold protection; F13 two-step QR email claim flow, consent validation, QR attachment delivery, and reconciliation logging on delivery failure |
| EV-M4-009 | TEST SUITE RUN | `npx vitest run tests/*.test.ts` (12 test files) | PASS: 12 files, 107 tests (3.81s) | Complete test suite covering architecture, static contracts, pure services, retention, and behavioral mocked handlers |
| EV-M4-010 | STATIC TYPECHECK | `npm run typecheck:api` | PASS: exit code 0 | TypeScript strict typecheck for all Vercel Web Handlers in `api/` and helpers in `server/` |
| EV-M4-011 | STATIC BUILD | `npm run build` | PASS: exit code 0 (1.77s) | TypeScript compilation and Vite client bundling producing clean production distribution |
| EV-M4-012 | BROWSER E2E STARTUP | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge browser startup for dev/configured, dev/missing, dev/malformed, and preview/configured without Firebase environment injection |
| EV-M4-013 | GIT WHITESPACE | `git diff --check` | PASS: exit code 0 | Verifies no whitespace or patch corruptions across modified source files |
| EV-M5-001 | DATABASE MIGRATION EXECUTION | `supabase/migrations/20261020000800_admin_hardening.sql` | IMPLEMENTED — NOT VERIFIED / BLOCKED | Authored atomic `api.update_app_settings` RPC and `pass_email_verifications` table; execution blocked by lack of local Docker/Postgres instance |
| EV-M5-002 | LIVE RESEND EMAIL DELIVERY | `api/passes/email.ts` to real inboxes | BLOCKED / NOT TESTED | Real email dispatch deferred until authorized staging environment with verified domain and production Resend API key |

## One-Pass Root-Cause Resolution (P0-01–P0-05, C-01–C-05) Checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-P0-014 | PURE SERVICES UNIT | `npx vitest run tests/pure-services.test.ts` | PASS (LOCAL UNIT): 1 file, 21 tests (29ms) | Pure unit tests for pass lookup identity normalization, \x hex bytea stripping, timing-safe buffer comparison, compound base64url cursors, ISO timestamp fallback, device aliases, CSV formula escaping (`=+\-@\t\r`), dual incident holds, and 4-way peak mode |
| EV-P0-015 | BEHAVIORAL MOCKED HANDLER | `npx vitest run tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER): 1 file, 18 tests (238ms) | Behavioral mocked-handler tests: P0-01 public reference vs UUID pass lookup; P0-01 bytea \x digest timing-safe match; P0-02 CSPRNG 6-digit code; P0-02 rate limiting; P0-02 idempotent replay with 200 without duplicate email; P0-02 claim with lock; P0-02 non-destructive delivery failure; P0-03 settings RPC error fails closed with 503 and zero direct table write; P0-04 dual hold check; P0-04 fail closed on query error; P0-05 staff check error fails closed with 503; P0-05 audit insert error logs reconciliation; C-01 dashboard Manila calendar window |
| EV-P0-016 | STATIC MIGRATION INTEGRITY | `npx vitest run tests/supabase-migration-static.test.ts` | PASS: 1 file, 6 tests (16ms) | Validates SQL syntax, RLS enable, table revokes, security definer paths, unique idempotency indexes for 00800 and 00900 |
| EV-P0-017 | TEST SUITE RUN | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 12 files, 119 tests (2.07s) | Complete test suite covering all architecture, contracts, pure services, retention, and behavioral mocked handlers (excluding legacy Firestore rules requiring emulator) |
| EV-P0-018 | STATIC TYPECHECK | `npm run typecheck:api` | PASS: exit code 0 (4.5s) | Strict TypeScript compiler check across all Vercel Web Handlers in `api/` and `server/` |
| EV-P0-019 | STATIC BUILD | `npm run build` | PASS: exit code 0 (1.64s) | Production TypeScript compilation and Vite bundling producing clean distribution bundle |
| EV-P0-020 | BROWSER E2E STARTUP | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge browser startup for dev/configured (14.0s), dev/missing (14.4s), dev/malformed (14.7s), and preview/configured (5.3s) without Firebase environment injection |
| EV-P0-021 | GIT WHITESPACE | `git diff --check` | PASS: exit code 0 | Clean whitespace across all modified and newly created source/SQL/test files |
| EV-P0-022 | DATABASE MIGRATION EXECUTION | `supabase/migrations/20261020000900_qr_email_idempotency.sql` | IMPLEMENTED — NOT VERIFIED / BLOCKED | Authored additive migration with atomic RPCs `api.request_email_verification_code`, `api.verify_and_claim_email_dispatch`, `api.finalize_email_dispatch`; execution blocked by lack of local Docker/Postgres instance |
