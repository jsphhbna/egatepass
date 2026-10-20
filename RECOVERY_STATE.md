# E-GatePass recovery state

Updated: 2026-10-20 Asia/Manila

## Resume identity

- Repository: lowercase `jsphhbna/egatepass` only
- Branch: `feat/runtime-migration`
- Base and remote main at start: `86a455ede2adc68ef6e09794e3ad118b70f63162`
- Rollback ref: `checkpoint/s0-original-f2f1a2b-20261020`
- Preserve without staging: owner-owned `.env.example` modification

## Current verified boundary

P0 local white-screen recovery is browser-verified at pushed commit `e3fc3ce119602403281f09c7d31f6c3712f55da5`. `npm run test:e2e:startup` exercises configured, missing, malformed, and preview startup cases. Evidence is under `docs/evidence/p0-white-screen/`.

S2 PostgreSQL migrations, pgTAP, RLS, Storage, and real Supabase Auth remain BLOCKED / NOT TESTED. No remote schema, Vercel deployment, Resend delivery, production service, or backup repository was mutated.

## Active implementation boundary

M1 identity and M2 portal/kiosk registration are implemented but not integration-verified. Supabase shared login/recovery/session resolution is active. Registration now uses separate portal/operator sessions, private Storage intents, a Vercel issuance handler with content inspection, and an atomic database issuance RPC. Legacy Firebase scan/Guard/Admin pages are still present in deferred chunks and must be migrated before deletion or a full-migration claim.

## Next safe tasks

1. Commit and push the M2 registration/issuance checkpoint after all local checks pass.
2. Implement M3 entry scan, Guard decision, exit scan, evidence delivery, and visit events against trusted RPCs.
3. Add trusted provisioning/revocation operations; keep them NOT VERIFIED without a database.
4. Request only one of: Docker-backed disposable local Supabase, or explicit permission naming a non-production hosted Supabase project after read-only identity/no-real-data preflight.
