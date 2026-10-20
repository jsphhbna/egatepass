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

## Targeted QR-email security and integration-contract correction

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-EMAIL-001 | PRE-FIX NEGATIVE CONTROL | `npx vitest run tests/qr-email-security-regression.test.ts` at start SHA `dcc9854` | EXPECTED FAIL: 1 file, 7/7 failed | Reproduced all seven workstreams before correction: fallbacks, replay, rate lock, unknown outcome, UUID/digest, UI keys/copy, additive SQL hardening |
| EV-EMAIL-002 | FOCUSED LOCAL | `npx vitest run tests/handlers-mocked.test.ts tests/pure-services.test.ts tests/supabase-migration-static.test.ts tests/qr-email-security-regression.test.ts` | PASS: 4 files, 92/92 tests | Local unit, strict exported-handler mocks, provider adapter fault injection, and static SQL only; not real PostgreSQL/Resend |
| EV-EMAIL-003 | COMPLETE SAFE SUITE | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 13 files, 166/166 tests (3.15s) | Excludes legacy Firestore emulator suite as requested; no hosted service contacted |
| EV-EMAIL-004 | API TYPECHECK | `npm run typecheck:api` | PASS: exit 0 | TypeScript API/server compilation |
| EV-EMAIL-005 | PRODUCTION BUILD | `npm run build` | PASS: exit 0, 2514 modules | Client compile/bundle only; no deployment |
| EV-EMAIL-006 | ISOLATED BROWSER STARTUP | `npm run test:e2e:startup` | PASS: Edge 4/4 | dev/configured, dev/missing, dev/malformed, preview/configured; startup only, no hosted Supabase/Resend workflow |
| EV-EMAIL-007 | PATCH INTEGRITY | `git diff --check` | PASS: exit 0 | Line-ending warnings only; owner `.env.example` remains excluded from authored changes/staging |
| EV-EMAIL-008 | DATABASE TEST AUTHORING | `supabase/migrations/20261020001000_qr_email_security.sql`; `supabase/tests/007_qr_email_security.test.sql` | AUTHORED / NOT RUN | 18 pgTAP assertions plus a documented genuine two-session contention probe; blocked without isolated PostgreSQL/Supabase |
| EV-EMAIL-009 | LIVE PROVIDER/AUTH/RLS | Real Supabase sessions, PostgREST `bytea`, row locks, Resend acceptance/inbox | BLOCKED / NOT TESTED | Requires isolated local DB or explicitly authorized non-production target and approved inbox; no permission was assumed |
| EV-EMAIL-010 | SECOND ADVERSARIAL REVIEW | Changed call graph + forbidden-pattern scan | PASS after fixes | Found/fixed malformed 2xx acknowledgement classification, inconsistent parent/challenge lock order, stale-claim recovery, and residual inbox-delivery wording |

## OCR-First Kiosk, React Email & Security Risk Corrections Checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-UX01-001 | LOCAL OCR UNIT | `npx vitest run tests/ocr-parsing.test.ts` | PASS: 1 file, 6 tests (19ms) | Verifies Philippine ID layout heuristics (PhilSys, Driver's License, UMID, Postal ID) for first, middle, last name extraction, ambiguous rejection, and worker lifecycle |
| EV-UX01-002 | COMPONENT & WORKFLOW | `src/pages/KioskPage.tsx` | PASS (BUILD & BROWSER MOCK) | Default "Scan Your Valid ID" screen, prominent "Scan My ID", subordinate link "Want to type manually instead?", environment camera preference, single `idBlob` reuse, mandatory face photo, zero Tesseract leakage on portal/admin routes; real tablet camera QA AWAITING OWNER |
| EV-ARCH-001 | EMAIL TEMPLATES UNIT | `npx vitest run tests/email-templates.test.ts` | PASS: 1 file, 4 tests (118ms) | Verifies server-side rendering of `@react-email/components` templates for verification code and issued pass with EARIST maroon/gold branding, escaping, and scannable QR PNG attachment |
| EV-H01-001 | PROVIDER CLASSIFICATION | `npx vitest run tests/email-classification.test.ts` | PASS: 1 file, 10 tests (14ms) | Injects Resend fake fetch responses: 400/401/403/422 definitive rejection; 429/500/502/503/timeout/network unknown outcome; proves no auto-retry on unknown |
| EV-H02-001 | TERMINAL CONFLICT | `tests/handlers-mocked.test.ts` (EMAIL-H02 tests) | PASS (MOCKED HANDLER): 2 tests | Injects terminal conflict from verification and dispatch finalizers; verifies 202 `outcome_unknown`, `retryAllowed: false`, and `terminal_conflict` reconciliation |
| EV-M01-001 | ABUSE LIMITS | `tests/handlers-mocked.test.ts` (EMAIL-M01 tests) | PASS (MOCKED HANDLER): 2 tests | Tests recipient (max 5/15m) and actor (max 10/15m) challenge rate limits across passes; verifies 429 response |
| EV-M02-001 | KIOSK DEVICE ENFORCEMENT | `tests/handlers-mocked.test.ts` (EMAIL-M02 tests) | PASS (MOCKED HANDLER): 2 tests | Tests email requests from revoked kiosk and guard device masquerading as kiosk; verifies 403 `kiosk_device_revoked` |
| EV-M03-001 | STORAGE PURGE PROTOCOL | `tests/handlers-mocked.test.ts` (PRIVACY-M03 tests) | PASS (MOCKED HANDLER): 2 tests | Verifies atomic claim RPC before storage delete, skips delete when held, and finalizes on delete success |
| EV-M04-001 | STAFF LIST PAGINATION | `tests/handlers-mocked.test.ts` (ADMIN-M04 tests) | PASS (MOCKED HANDLER): 2 tests | Verifies keyset pagination with `nextCursor` and `hasMore` and 403 on unauthorized actor |
| EV-M05-001 | SPA REWRITE CONTRACT | `tests/architecture-contract.test.ts` | PASS: 1 file, 3 tests | Verifies `vercel.json` SPA rewrite uses `/((?!api/).*)` -> `/index.html` preventing API function route masking |
| EV-SAFE-001 | FULL VITEST SAFE SUITE | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 16 files, 197 tests (2.91s) | All local unit, mocked-handler, static migration, and template tests pass cleanly without contacting hosted services |
| EV-TYPE-001 | API TYPECHECK | `npm run typecheck:api` | PASS: exit code 0 | TypeScript strict compile for all Vercel Web Handlers, server helpers, and templates |
| EV-BUILD-001 | PRODUCTION BUILD | `npm run build` | PASS: exit code 0 (1.15s) | Full Vite bundle; transforms 2537 modules cleanly; kiosk chunk 25.48 kB |
| EV-E2E-001 | BROWSER STARTUP E2E | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge renders dev/configured, dev/missing, dev/malformed, preview/configured without uncaught errors |
| EV-DIFF-001 | GIT PATCH & WHITESPACE | `git diff --check` | PASS: exit code 0 | Verified zero whitespace errors, clean line endings, and owner `.env.example` unstaged |
| EV-DB-001 | ADDITIVE MIGRATION | `supabase/migrations/20261020001100_email_security_and_abuse_controls.sql` | AUTHORED / NOT RUN | 12 pgTAP assertions in `008_email_security_and_abuse_controls.test.sql`; live PostgreSQL execution BLOCKED |

## Codex Targeted Root-Cause Correction, Supabase 404 Diagnosis & Vercel Preview Preflight Checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-P0A-001 | PURGE CONTRACT & CLAIM VALIDATION | `npx vitest run tests/handlers-mocked.test.ts` (P0-A tests) | PASS (MOCKED HANDLER): 4 tests | Verifies: (1) claim_evidence_for_purge lease and contract, (2) finalize_evidence_purge contract validation and rejection on missing finalized, (3) wrong claim ID authorization rejection, (4) DB finalize failure after storage delete reconciliation |
| EV-P0A-002 | ADDITIVE PURGE MIGRATION | `supabase/migrations/20261020001200_concurrency_and_purge_contract_hardening.sql` | AUTHORED / NOT RUN | Row lock FOR UPDATE, exact claim ID match, 5-minute lease expiry, revalidation of pass expiration/holds; execution blocked by lack of isolated database |
| EV-P0B-001 | PGTAP FIXTURE CORRECTION | `supabase/tests/008_email_security_and_abuse_controls.test.sql` | FIXED / STATIC VERIFIED | Corrected fixture to canonical public.devices schema (user_id, alias, name, type, gate, status) and public.visitors (created_by_device_id) |
| EV-P0B-002 | STATIC SCHEMA RECURRENCE DEFENSE | `npx vitest run tests/supabase-migration-static.test.ts` | PASS: 1 file, 8 tests (16ms) | Statically asserts no non-existent/obsolete device columns (device_alias, registered_at, retired_at, status='retired') exist across pgTAP suites and migrations |
| EV-P0C-001 | ADVISORY LOCK SERIALIZATION | `supabase/migrations/20261020001200_concurrency_and_purge_contract_hardening.sql` | AUTHORED / NOT RUN | Adds pg_advisory_xact_lock on actor and recipient in api.request_email_verification_code, preventing concurrency limits race across passes |
| EV-P0C-002 | CONCURRENCY SQL TEST SUITE | `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` | AUTHORED / NOT RUN | 12 pgTAP assertions testing multi-pass recipient sharing, actor concurrency, and lock ordering; live PostgreSQL execution BLOCKED |
| EV-P0C-003 | EMAIL HANDLER ABUSE ERROR MAPPING | `tests/handlers-mocked.test.ts` (P0-C tests) | PASS (MOCKED HANDLER): 2 tests | Verifies that api/passes/email.ts correctly returns 429 too_many_requests_recipient and too_many_requests_actor without falling through to generic error strings |
| EV-P0D-001 | NETWORK TRACE & 404 ROOT CAUSE | Chromium/Edge DevTools trace against `http://localhost:5173/get-pass` | CONFIRMED ROOT CAUSE | GET https://nhoawvkfqblsgutdffie.supabase.co/rest/v1/app_settings returns PostgREST HTTP 404 PGRST205 ("Could not find table 'public.app_settings' in schema cache") due to unapplied migrations on egatepass-dev |
| EV-P0D-002 | APP SETTINGS FALLBACK | `src/services/visitorRegistration.ts` | PASS (BUILD & RUNTIME) | Graceful fallback defaults and diagnostic logging on PGRST205, preventing unhandled exceptions in UI |
| EV-P0D-003 | VITE DEV API ROUTING PLUGIN | `vite.config.ts` (`vercelApiDevPlugin`) | PASS (LOCAL INTEGRATION) | Replaced dead Netlify port 8888 proxy; directly invokes Vercel web handlers in api/ during local Vite dev, returning valid JSON responses (401/405/404) |
| EV-P1E-001 | PREVIEW ENDPOINT PROBE | 10 local dev endpoint requests | PASS (10/10) | /, /login, /get-pass, /kiosk (protected 403 without device session), /tesseract/worker.min.js, /tesseract/eng.traineddata.gz, /api/passes/issue, /api/passes/email, /api/admin/users, /api/purge-images |
| EV-P1E-002 | STATIC OCR ASSETS VERIFICATION | Direct filesystem & HTTP asset check | PASS | public/tesseract/worker.min.js (75 kB), tesseract-core.wasm.js (601 kB), eng.traineddata.gz (2.1 MB) serve with correct binary/js content types without SPA index.html rewrites |
| EV-P1E-003 | SECRET ISOLATION CHECK | Frontend bundle inspection in `dist/` | PASS | Zero occurrence of SUPABASE_SECRET_KEY, PASS_TOKEN_SECRET, RESEND_API_KEY, or other service credentials in client assets |
| EV-P1E-004 | PREVIEW PREFLIGHT DOCUMENT | `docs/VERCEL_PREVIEW_PREFLIGHT.md` | AUTHORED | Complete preflight checklist, environment variable mapping, architecture decisions, and unambiguous 3-level deployment verdict |
| EV-SAFE-002 | FULL SAFE VITEST SUITE | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 16 files, 205 tests (3.08s) | Complete safe test suite pass with zero failures |
| EV-TYPE-002 | API TYPECHECK | `npm run typecheck:api` | PASS: exit code 0 | Strict TypeScript check across all api/ and server/ files |
| EV-BUILD-002 | PRODUCTION BUILD | `npm run build` | PASS: exit code 0 (1.84s) | Clean production Vite bundle; 2537 modules transformed; 0 errors |
| EV-E2E-002 | BROWSER STARTUP E2E | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge browser startup verification (dev configured/missing/malformed, preview configured) |
| EV-DIFF-002 | GIT PATCH INTEGRITY | `git diff --check` | PASS: exit code 0 | Clean whitespace; owner .env.example strictly preserved unstaged |

## Cross-Layer Root-Cause Remediation Checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-P001-001 | RLS STAFF ELIGIBILITY & ONBOARDING | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` | AUTHORED / STATIC PASS | Redefined private.current_staff_role() requiring active, email confirmed, must_change_password=false, privacy_accepted_at is not null; updated staff_profiles_select policy for self-profile read during onboarding; added api.acknowledge_privacy() |
| EV-P002-001 | PASSES/VISITORS OWNERSHIP JOIN | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` | AUTHORED / STATIC PASS | Repaired api.request_email_verification_code to join public.passes p to public.visitors v on v.id = p.visitor_id, resolving v.owner_id and v.source under advisory lock |
| EV-P003-001 | SCHEMA GRANTS | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` | AUTHORED / STATIC PASS | Explicit USAGE on api and public to authenticated and service_role; private schema revoked from public/anon/authenticated |
| EV-P004-001 | ATOMIC INCIDENT HOLD RPCS | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` & `api/admin/holds.ts` | PASS (MOCKED HANDLER) | Implemented api.create_incident_hold (with check against in-progress purge claims and purged evidence) and api.release_incident_hold; tested Super Admin hold lifecycle in tests/handlers-mocked.test.ts (4 tests) |
| EV-EMAIL01-001 | SUPABASE AUTH EMAIL HOOK & TEMPLATES | `server/auth-email-hook.ts`, `server/templates/*`, `api/auth/send-email-hook.ts`, `supabase/functions/auth-send-email/` | PASS (UNIT & BEHAVIORAL): 14/14 tests in `tests/auth-email-hook.test.ts` | Standard Webhooks HMAC-SHA256 signature verification, 5-minute replay window, whsec_ decoding, signup/reset/invite/email-change templates, GoTrue secure email change inverted token mapping |
| EV-EMAIL03-001 | PRE-PROVIDER RENDERING PROTECTION | `api/passes/email.ts` | PASS (BEHAVIORAL) | Wrapped renderVerificationCodeEmail in try/catch with providerAttempted = false, finalizing template rendering failures as delivery_failed without leaving orphaned code_sending challenges |
| EV-HIGH01-001 | PASS ISSUANCE IDEMPOTENT REPLAY | `api/passes/issue.ts` & `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER): 5/5 tests | Replays committed pass with 200 OK before inspectUpload; rejects altered form details (409), cross-actor replays (409), expired passes (422), and rotated secrets (409) |
| EV-HIGH02-001 | PGTAP 009 FIXTURE INVARIANT | `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` | AUTHORED / STATIC PASS | Corrected fixture contradiction: dedicated visitor 913 with expired pass 923 for purge testing; visitor 911 with active pass 921 for negative invariant assertion (plan count 15) |
| EV-HIGH03-001 | GUARD APPROVAL EXPIRED RECHECK | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` & `api/decide-visit.ts` | PASS (MOCKED HANDLER) | api.decide_visit marks expired pass with status = 'expired' and raises pass_has_expired; handler returns 422 Pass has expired and cannot be approved |
| EV-HIGH04-001 | RETENTION MAINTENANCE ENDPOINT | `api/admin/retention-maintenance.ts` | PASS (MOCKED HANDLER) | Protected endpoint with CRON_SECRET authentication and dry-run mode; performs batch cleanup of expired unheld evidence, abandoned upload intents, and expired verification codes |
| EV-HIGH05-001 | EVIDENCE ACCESS DURING ACTIVE HOLDS | `api/evidence.ts` & `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER): 3/3 tests | Ordinary guards receive 410 on expired evidence; Admin/Super Admin granted review access when active incident hold exists, logging audit event evidence.review_held |
| EV-MED01-001 | GUARD QUEUE PAGINATION | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` | AUTHORED / STATIC PASS | Added api.guard_dashboard(requested_limit, requested_offset) returning queue, stats, pendingTotal, and hasMore |
| EV-MED02-001 | REAL QR SHARING | `src/pages/GetPassPage.tsx` | PASS (BUILD & RUNTIME) | shareQR uses Web Share API File for scannable QR PNG with download and instructional toast fallback; never exposes raw bearer in mailto or URL |
| EV-MED03-001 | OCR PRIVACY COPY CORRECTION | `src/pages/KioskPage.tsx` | PASS (BUILD & RUNTIME) | Clarified privacy copy: "Using local on-device recognition. The ID image is uploaded only to private campus storage upon your review and submission." |
| EV-MED04-001 | UPLOAD INTENT RATE LIMITING | `supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql` | AUTHORED / STATIC PASS | Capped active pending intents for anonymous portal callers at 10 |
| EV-MED07-001 | CANONICAL UUID TEST FIXTURES | `tests/email-templates.test.ts` | PASS: 4/4 tests | Aligned pass public reference fixture to canonical UUID 10000000-0000-4000-a000-000000000888 |
| EV-SAFE-003 | FULL SAFE VITEST SUITE | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 17 files, 233 tests (4.58s) | Complete safe test suite pass with zero failures |
| EV-TYPE-003 | API TYPECHECK | `npm run typecheck:api` | PASS: exit code 0 | Strict TypeScript compilation across all api/, server/, and templates |
| EV-BUILD-003 | PRODUCTION BUILD | `npm run build` | PASS: exit code 0 (2.47s) | Clean production Vite bundle; 2537 modules transformed; 0 errors |
| EV-E2E-003 | BROWSER STARTUP E2E | `npm run test:e2e:startup` | PASS: 4/4 cases | Playwright Edge browser startup verification (dev configured/missing/malformed, preview configured) |
| EV-DIFF-003 | GIT PATCH INTEGRITY | `git diff --check` | PASS: exit code 0 | Clean whitespace; owner .env.example strictly preserved unstaged |
| EV-PGMIG-001 | PGLITE SEQUENTIAL MIGRATION CHAIN | `tests/migration-chain-pglite.test.ts` | PASS: 4/4 tests (5.09s) | Executed all 13 PostgreSQL migrations (000100 through 001300) sequentially in real in-memory PostgreSQL 17.5 WASM from clean database |
| EV-RPC-001 | PERMANENT RPC CONTRACT VALIDATION | `tests/migration-chain-pglite.test.ts` | PASS | Verified pg_proc signatures for decide_visit, create_incident_hold, guard_dashboard, request_email_verification_code, create_upload_intent, acknowledge_privacy (timestamptz) |
| EV-ENUM-001 | ENUM CONTRACT INTEGRITY | `tests/migration-chain-pglite.test.ts` | PASS | Verified visit_event_type and pass_status; confirmed 'expired' is not a visit_event_type |
| EV-AUDIT-001 | AUDIT SCHEMA & OUTCOME CONTRACT | `tests/migration-chain-pglite.test.ts` | PASS | Verified canonical audit columns; confirmed 'details' absent; valid insert resolves; 'partial_failure' rejected by check constraint |
| EV-EMAIL-002 | AUTH EMAIL HOOK RESEND FAIL-CLOSED | `tests/auth-email-hook.test.ts` | PASS: 15/15 tests | Verified /auth/v1/verify URL composition using SUPABASE_URL origin, redirect_to app destination, and 503 fail-closed when RESEND_API_KEY missing |
| EV-SAFE-004 | EXPANDED VITEST SAFE SUITE | `npx vitest run --exclude "**/firestore.rules.test.ts"` | PASS: 18 files, 238 tests (7.86s) | Complete test suite pass including real PostgreSQL migration runner and schema contract tests |
| EV-TYPE-004 | API & CLIENT TYPECHECK | `npm run typecheck:api` & `npx tsc --noEmit` | PASS: exit code 0 | Strict TypeScript compilation across both API/server and React client with zero errors |
| EV-BUILD-004 | PRODUCTION BUILD INTEGRITY | `npm run build` | PASS: exit code 0 (1.41s) | Vite v8.3.1 production build (2538 modules transformed; clean CSS and JS chunks; 0 errors) |
| EV-DIFF-004 | WORKING TREE PRESERVATION | `git status --short` | PASS | Owner .env.example strictly preserved unstaged byte-for-byte; zero secrets committed |

## Final Confirmed Defect Repair Pass (Groups A through N)
| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-RECOV-A01 | PASSWORD RECOVERY AUTHORIZATION INTEGRITY | `api/auth/reset-password.ts`, `tests/password-recovery.test.ts` | PASS: 10/10 tests | Server-controlled endpoint verifying JWT `amr: [{ method: 'recovery' }]`; rejects forged browser storage, query params, staff/device/portal accounts, and expired tokens |
| EV-DEV-A02 | DEVICE CREDENTIAL MUTATION GUARD | `supabase/migrations/20261020001400_closure_and_hardening.sql`, `tests/password-recovery.test.ts`, `tests/migration-chain-pglite.test.ts` | PASS (PGLITE & UNIT) | PostgreSQL trigger `public.protect_managed_credentials()` blocks non-service-role password mutations on device and anonymous accounts |
| EV-EMAIL-B02 | AUTH EMAIL HOOK NEW_EMAIL CONTRACT | `server/auth-email-hook.ts`, `tests/auth-email-hook.test.ts` | PASS: 19/19 tests | Payload accurately models `user.new_email`; maps `token_hash_new` to current email and `token_hash` to new email under Secure Email Change; canonical Supabase Auth origin URL |
| EV-EMAIL-C01 | FAKE ACTION TYPES REMOVAL | `server/auth-email-hook.ts` | PASS | Removed `email_change_current` and `email_change_new` from canonical model; handled canonical `email_change` and all security notification events |
| EV-RET-D01 | RETENTION SETTINGS FAIL-CLOSED | `api/admin/retention-maintenance.ts`, `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER) | If `app_settings` query errors or missing singleton, immediately returns 500, performs 0 destructive changes, and logs reconciliation |
| EV-RET-E01 | RETENTION PROTECTION UNCERTAINTY | `api/admin/retention-maintenance.ts`, `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER) | Protection query errors on visitor holds, pass holds, or active passes treat candidates as protected by uncertainty (`continue` without anonymizing) |
| EV-RET-F01 | MAINTENANCE CURSOR UPSERT INSPECTION | `api/admin/retention-maintenance.ts`, `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER) | Explicitly checks `error` on cursor upsert, logs error to metrics, records reconciliation, and prevents success outcome |
| EV-RET-G01 | TRUTHFUL MAINTENANCE RESULT STATUS | `api/admin/retention-maintenance.ts`, `tests/handlers-mocked.test.ts` | PASS (MOCKED HANDLER) | Result status computed strictly after audit insert; regression assertion enforces `success === true` implies `metrics.errors.length === 0` |
| EV-ENV-H01 | MODERNIZED .ENV.EXAMPLE CONTRACT | `.env.example`, `tests/environment-contract.test.ts` | PASS: 6/6 tests | Clean template containing blank placeholders only; matches tested contract; zero committed secrets |
| EV-TURN-J01 | TURNSTILE PRODUCTION FAIL-CLOSED | `src/services/visitorRegistration.ts`, `tests/pure-services.test.ts` | PASS: 7/7 tests | Production anonymous portal account creation strictly fails closed if `VITE_TURNSTILE_SITE_KEY` or `captchaToken` is missing; Kiosk unaffected |
| EV-TURN-K01 | TURNSTILE SECRET ISOLATION | `tests/environment-contract.test.ts` | PASS | Asserts Turnstile private secret is never under `VITE_*` in `.env.example` or referenced in client source |
| EV-SAFE-006 | FULL REGRESSION SUITE | `npm test` | PASS: 21 files, 288 tests | Complete test suite pass with zero failures and zero emulator requirements |
| EV-PGLITE-002 | PGLITE MIGRATION CHAIN WITH CREDENTIAL GUARD | `tests/migration-chain-pglite.test.ts` | PASS: 7/7 tests (15.8s) | Clean sequential execution (000100 through 001400), upgrade test (001300 -> 001400), and credential guard trigger test |
| EV-TYPE-006 | API & CLIENT TYPECHECK | `npm run typecheck:api` & `npx tsc --noEmit` | PASS: exit code 0 | Strict TypeScript compilation across both API/server and React client with zero errors |
| EV-BUILD-006 | PRODUCTION BUILD INTEGRITY | `npm run build` | PASS: exit code 0 (1.15s) | Vite v8.3.1 production build (2539 modules transformed; clean CSS and JS chunks; 0 errors) |
| EV-E2E-004 | PLAYWRIGHT STARTUP BROWSER E2E | `npm run test:e2e:startup` | PASS: 4/4 cases | Browser startup verification on Edge (dev configured/missing/malformed, preview configured) |
