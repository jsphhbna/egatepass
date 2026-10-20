# E-GatePass recovery state

Updated: 2026-10-20 Asia/Manila

## Resume identity

- Repository: lowercase `jsphhbna/egatepass` only
- Branch: `feat/runtime-migration`
- Base and remote main at start: `86a455ede2adc68ef6e09794e3ad118b70f63162`
- Rollback ref: `checkpoint/s0-original-f2f1a2b-20261020`
- Preserve without staging: owner-owned `.env.example` modification

## Current verified boundary

- P0 local white-screen recovery is browser-verified at pushed commit `e3fc3ce119602403281f09c7d31f6c3712f55da5`.
- M1 identity pushed at `33a35047c479545f5d62932fb5a4c285a1e8e39a`.
- M2 registration/issuance pushed at `14171ee56683b2c2594734cef67fcde92f6d773c`.
- M3 gate lifecycle pushed at `6239cd79de4ee51c4515b144804661bc4f4a506f`.
- M4 Admin and operations runtime migration implemented.
- M4 Corrections (F01–F12) and M5-F13 (Optional QR Email Delivery with inbox verification claim flow) implemented and verified.
- One-Pass Root-Cause Resolution (P0-01–P0-05, C-01–C-05) implemented and verified: pass identifier contract unified across issuance and email endpoints; `\x` bytea digest handling with timing-safe comparison; additive migration `20261020000900_qr_email_idempotency.sql` with atomic RPCs (`api.request_email_verification_code`, `api.verify_and_claim_email_dispatch`, `api.finalize_email_dispatch`) and CSPRNG; fail-closed settings update without direct write fallback; dual hold checks and error inspection on purge; governance target checks and audit error handling; Manila day window for pending counts; emergency evacuation screen and print truncation alerts; strict cursor validation; formula injection defense.
- `npm run test:e2e:startup` exercises 4 cases (dev/configured, dev/missing, dev/malformed, preview/configured): 4/4 PASS on Playwright Edge.
- Vitest suite: 12 test files, 119 tests PASS (`npx vitest run --exclude "**/firestore.rules.test.ts"`), including 18 behavioral mocked handler tests `PASS (MOCKED HANDLER)` and 21 pure-service unit tests.
- `npm run typecheck:api` PASS, `npm run build` PASS, `git diff --check` PASS.
- S2 PostgreSQL migrations, pgTAP, RLS, Storage, Resend live email, and real Supabase Auth remain BLOCKED / NOT TESTED due to local machine limitations (no Docker Desktop/psql/disposable Supabase instance).

## Active implementation boundary

M1 identity, M2 registration/issuance, M3 scanner/Guard lifecycle, M4 Admin & operations, M4 corrections (F01–F12), M5-F13 (optional QR email), and One-Pass Root-Cause Resolution (P0-01–P0-05, C-01–C-05) are implemented and locally verified. Entry, pending decision, approval/rejection, gate-matched exit, bounded Guard reads, private evidence delivery, staff governance, device accounts, dashboard metrics, emergency list, records/complete exports, audit/activity, settings/storage purge, and optional Resend QR email with inbox claim proof all have target Supabase/Vercel code, additive migrations (00100–00900), and local tests. Legacy code remains in the repository for rollback safety and must not be deleted until live parity gates pass.

## Next safe tasks

1. Commit and push the One-Pass Root-Cause Resolution (P0-01–P0-05, C-01–C-05) checkpoint to `origin feat/runtime-migration`.
2. Verify actual remote HEAD SHA and declare truthfulness matrix.
3. Keep every provider-dependent path NOT VERIFIED / INTEGRATION BLOCKED until the isolated database and browser lifecycle run.
4. Prepare M5/S7 remaining items (scheduled retention execution, incident hold UI management, operational alerts) and staging readiness.
5. Request only one of: Docker-backed disposable local Supabase, or explicit permission naming a non-production hosted Supabase project after read-only identity/no-real-data preflight.

## Targeted QR-email correction handoff (supersedes older QR-email claims above)

- Start checkpoint: `dcc9854d22c1aeec1c87d3a1dac55f183741b993` on `feat/runtime-migration`.
- Pre-fix security contract: 7/7 expected failures. Corrected local evidence: focused 4 files/92 tests PASS; complete safe suite 13 files/166 tests PASS; API typecheck PASS; production build PASS; isolated Edge startup 4/4 PASS; whitespace PASS.
- Additive migration `20261020001000_qr_email_security.sql` and pgTAP `007_qr_email_security.test.sql` are AUTHORED / NOT RUN. They supersede 00900 behavior without rewriting history.
- QR-email now fails closed on RPC faults, binds stable keys to actor/pass/recipient, serializes code limits, fences ambiguous/stale provider outcomes, and accepts only the public-reference UUID returned by issuance.
- Owner `.env.example` remains modified only by the owner and must stay unstaged. No uppercase backup, hosted database, deployment, live inbox, or legacy infrastructure was touched.
- Next: verify the pushed feature-branch SHA, then wait for an isolated database or explicitly authorized non-production test target. Run 00100–01000, all pgTAP including genuine two-session contention, real portal/kiosk Auth/RPC tests, and approved inbox tests. Owner modal/workflow QA remains AWAITING OWNER. Do not begin unrelated M5 work before this handoff is accepted.
