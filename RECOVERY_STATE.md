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
- **OCR-First Kiosk, React Email & Confirmed Risk Resolutions (UX-01, EMAIL-ARCH-01, EMAIL-H01, EMAIL-H02, EMAIL-M01, EMAIL-M02, PRIVACY-M03, ADMIN-M04, DEPLOY-M05)** implemented and locally verified:
  1. `UX-01`: OCR-First kiosk with default screen "Scan Your Valid ID", primary "Scan My ID", subordinate "Want to type manually instead?" link, offline local Tesseract.js engine with Philippine ID heuristics, single `idBlob` evidence reuse, mandatory face photo, and zero Tesseract bundle leakage into portal/admin routes.
  2. `EMAIL-ARCH-01`: Restored `@react-email/components` and `@react-email/render` architecture with EARIST maroon/gold accessible responsive templates in `server/templates/`, server-side rendered HTML, and QR attachment PNG buffer.
  3. `EMAIL-H01`: Documented conservative Resend HTTP status classification in `server/email.ts` (400/401/403/422 definitive rejection; 429/5xx/network/timeout unknown outcome fenced with non-retryable reconciliation).
  4. `EMAIL-H02`: Additive migration `20261020001100_email_security_and_abuse_controls.sql` with finalizer contract distinguishing `matched`, `already_finalized_same_status`, and `terminal_conflict`. `api/passes/email.ts` fails closed on conflict.
  5. `EMAIL-M01`: Per-recipient (max 5/15m) and per-actor (max 10/15m) challenge abuse limits enforced in migration and handler.
  6. `EMAIL-M02`: Kiosk email requests enforce active, non-deleted device of type `kiosk` in `devices` table; revoked/guard devices rejected with 403.
  7. `PRIVACY-M03`: DB-coordinated purge protocol via `claim_evidence_for_purge` and `finalize_evidence_purge` RPCs excluding incident holds.
  8. `ADMIN-M04`: Keyset pagination in `api/admin/users.ts` and `src/pages/AdminUsers.tsx` with "Load More Users" button.
  9. `DEPLOY-M05`: Corrected Vercel SPA rewrite in `vercel.json` to `/((?!api/).*)` -> `/index.html` preventing API route masking.
- `npm run test:e2e:startup`: 4/4 PASS on Playwright Edge (dev configured, dev missing, dev malformed, preview configured).
- Full Vitest suite: 16 test files, 197 tests PASS (`npx vitest run --exclude "**/firestore.rules.test.ts"`), including 55 behavioral mocked handler tests `PASS (MOCKED HANDLER)`, 10 Resend classification tests, 6 OCR parser tests, 4 React Email template tests, 8 static migration tests, and 3 architecture contract tests.
- `npm run typecheck:api` PASS (exit 0), `npm run build` PASS (exit 0, 2537 modules transformed), `git diff --check` PASS (exit 0).
- Local owner-owned `.env.example` file strictly preserved unstaged and uncommitted.
- S2 PostgreSQL migrations, pgTAP (81 authored assertions across 00100–01100), RLS, Storage, Resend live email, and real Supabase Auth remain BLOCKED / NOT TESTED due to local machine limitations (no Docker Desktop/psql/disposable Supabase instance).

## Active implementation boundary

All 9 workstreams are implemented and verified locally. Additive migrations (00100–01100) are committed history; legacy Firebase/Netlify/Cloudinary code remains preserved for rollback until live cutover.

## Next safe tasks

1. Commit and push the verified UX-01, EMAIL-ARCH-01, EMAIL-H01/H02, and M01-M05 checkpoint to `origin feat/runtime-migration`.
2. Verify pushed commit SHA on GitHub.
3. Keep all cloud provider-dependent actions (real emails, hosted migrations, production deployments) marked BLOCKED until authorized.
