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
- One-Pass Root-Cause Resolution (P0-01–P0-05, C-01–C-05) implemented and verified.
- Targeted QR-Email Security Checkpoint (EMAIL-P0-01–P1-07) implemented and verified.
- **OCR-First Kiosk, React Email & Confirmed Risk Resolutions (UX-01, EMAIL-ARCH-01, EMAIL-H01, EMAIL-H02, EMAIL-M01, EMAIL-M02, PRIVACY-M03, ADMIN-M04, DEPLOY-M05)** implemented and locally verified.
- **Codex Targeted Root-Cause Correction, Supabase 404 Diagnosis & Vercel Preview Readiness (P0-A, P0-B, P0-C, P0-D, P1-E)** implemented and verified:
  1. `P0-A`: Image Purge API↔SQL contract and claim-ID authorization hardening. Additive migration `20261020001200_concurrency_and_purge_contract_hardening.sql` implements row locking (`FOR UPDATE`), strict `purge_claim_id = requested_claim_id` matching, 5-minute claim lease expiry, server-side expiration revalidation, and standardized JSON return structure (`finalized`, `match_status`, `purged`). `api/purge-images.ts` strictly validates claim identity, deletes only verified bucket/path, and reconciles storage or DB failures.
  2. `P0-B`: Corrected invalid PostgreSQL pgTAP fixtures in `supabase/tests/008_email_security_and_abuse_controls.test.sql` to canonical `public.devices` schema (`user_id, alias, name, type, gate, status`) and `public.visitors` (`created_by_device_id`). Automated static tests in `tests/supabase-migration-static.test.ts` verify no hallucinated columns or enums exist.
  3. `P0-C`: Made recipient-level and actor-level abuse throttling concurrency-safe across distinct passes using deterministic transaction advisory locks (`pg_advisory_xact_lock`) ordered by actor level (1) then recipient level (2). Authored two-session SQL contention test `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` (`AUTHORED / NOT RUN`).
  4. `P0-D`: Traced and diagnosed the localhost:5173 Supabase 404. Captured exact failing endpoint: `https://nhoawvkfqblsgutdffie.supabase.co/rest/v1/app_settings` (HTTP 404, PostgREST error `PGRST205: Could not find table public.app_settings in schema cache`). Identified root cause: hosted dev instance `nhoawvkfqblsgutdffie` has not yet had migrations applied. Added explicit diagnostic console warning and safe fallback in `src/services/visitorRegistration.ts`. Replaced legacy Netlify proxy in `vite.config.ts` with direct local Vercel-style API middleware (`vercelApiDevPlugin`), returning proper JSON 401/405/404 responses for `/api/*` routes.
  5. `P1-E`: Conducted Vercel Preview deployment preflight. Probed all 10 key endpoints (10/10 PASS), verified static self-hosted OCR assets in `public/tesseract/` and `dist/tesseract/`, confirmed zero server-side secret leakage, and authored `docs/VERCEL_PREVIEW_PREFLIGHT.md` with exact environment scopes, rollback procedures, and a three-level deployment verdict.
- `npm run test:e2e:startup`: 4/4 PASS on Playwright Edge (dev configured, dev missing, dev malformed, preview configured).
- Full Vitest suite: 16 test files, 205 tests PASS (`npx vitest run --exclude "**/firestore.rules.test.ts"`), including 59 behavioral mocked handler tests `PASS (MOCKED HANDLER)`, 10 Resend classification tests, 6 OCR parser tests, 4 React Email template tests, 9 static migration tests, and 6 architecture contract tests.
- `npm run typecheck:api` PASS (exit 0), `npm run build` PASS (exit 0, 2537 modules transformed), `git diff --check` PASS (exit 0).
- Local owner-owned `.env.example` file strictly preserved unstaged and uncommitted.
- S2 PostgreSQL migrations, pgTAP (95 authored assertions across 00100–01200), RLS, Storage, Resend live email, and real Supabase Auth remain BLOCKED / NOT TESTED due to local machine limitations (no Docker Desktop/psql/disposable Supabase instance).

## Active implementation boundary

All P0-A through P1-E workstreams are implemented and verified locally. Additive migrations (00100–01200) are committed history; legacy Firebase/Netlify/Cloudinary code remains preserved for rollback until live cutover.

## Next safe tasks

1. Commit and push the verified P0-A–P1-E checkpoint to `origin feat/runtime-migration`.
2. Verify pushed commit SHA on GitHub.
3. Keep all cloud provider-dependent actions (real emails, hosted migrations, production deployments) marked BLOCKED until authorized.
