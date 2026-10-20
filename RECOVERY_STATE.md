# E-GatePass recovery state

Updated: 2026-10-20 Asia/Manila

## Resume identity

- Repository: lowercase `jsphhbna/egatepass` only
- Branch: `feat/runtime-migration`
- Base and remote main at start: `86a455ede2adc68ef6e09794e3ad118b70f63162`
- Rollback ref: `checkpoint/s0-original-f2f1a2b-20261020`
- Preserve without staging: owner-owned `.env.example` modification

## Current verified boundary

P0 local white-screen recovery is browser-verified. `npm run test:e2e:startup` exercises configured, missing, malformed, and preview startup cases. Evidence is under `docs/evidence/p0-white-screen/`.

S2 PostgreSQL migrations, pgTAP, RLS, Storage, and real Supabase Auth remain BLOCKED / NOT TESTED. No remote schema, Vercel deployment, Resend delivery, production service, or backup repository was mutated.

## Active implementation boundary

M1/S3 is in progress. `src/lib/supabase.ts`, `src/lib/runtimeConfig.ts`, `src/lib/identity.ts`, `src/hooks/useAuth.tsx`, `src/pages/LoginPage.tsx`, and `src/pages/ForgotPasswordPage.tsx` are the target Auth path. Legacy Firebase operational pages are still present in deferred chunks and must be migrated before deletion or a full-migration claim.

## Next safe tasks

1. Commit and push the P0 recovery checkpoint after all local static/browser checks pass.
2. Add trusted backend operations needed for forced-password completion, privacy acknowledgement, provisioning, and revocation; keep them NOT VERIFIED without a database.
3. Migrate Admin/Guard/device logout and credential flows, then portal/kiosk evidence and issuance in stage order.
4. Request only one of: Docker-backed disposable local Supabase, or explicit permission naming a non-production hosted Supabase project after read-only identity/no-real-data preflight.
