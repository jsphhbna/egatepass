# E-GatePass Project State

Updated: 2026-10-20 Asia/Manila

Current stage: P0 recovery PASS locally; M1–M3 runtime slices IMPLEMENTED IN PART — provider integration NOT VERIFIED; S2 database promotion remains BLOCKED

## Repository identity

- Working copy: `C:\Users\Administrator\Downloads\egatepass`
- Branch: `main`
- S0 checkpoint HEAD: `2e3b342ad313e926a19be7eecd995aa2a862f3f7`
- S1 checkpoint commit: `babb8c5` (`docs: establish S1 target architecture`)
- S2 implementation commit: `80d861b8186418837ed0b862288da4e4b53e4637` (`feat: implement Supabase security core`)
- Working branch: `feat/runtime-migration`, based on `86a455ede2adc68ef6e09794e3ad118b70f63162`
- `origin/main`: `86a455ede2adc68ef6e09794e3ad118b70f63162`; S0–S2 commits are pushed
- Target origin: `https://github.com/jsphhbna/egatepass.git`
- Read-only reference main: `6906b91f9a1c4910f6bdfa14ee62aa3e3d46da7c`
- S0 baseline target/reference tracked files: 126/126; tree diff: 0 files before modernization commits
- Local rollback branch: `checkpoint/s0-original-f2f1a2b-20261020`
- Pre-existing user change preserved and not owned by S0: `.env.example` (12 additions, 31 deletions)

## Baseline capability state

| Capability | Implementation | Verification |
|---|---|---|
| Original React/Vite UI | Present | Build PASS; public and isolated authenticated role-route browser captures PASS; phone overflow finding remains |
| Firebase/Firestore/Netlify/Cloudinary backend | Present (legacy target baseline) | 238 emulator/unit tests PASS; production behavior NOT TESTED |
| Supabase target | Three canonical migrations, local config, pgTAP authorization suite, private-bucket/RPC/bootstrap design | Static contract PASS; clean reset, RLS, Auth, Data API and Storage behavior BLOCKED because Docker/Postgres/authorized test project are unavailable |
| Vercel target | `vercel.json` SPA/region scaffold; no functions yet | Local config contract PASS; provider link/deploy NOT TESTED |
| Resend target | Environment names present | NOT TESTED; no real email sent |
| Browser E2E | Playwright 1.64.1 harness added for legacy baseline | 9 isolated Edge tests PASS for public-nav exposure, all six actor redirects, wrong-role denial, and Admin tabs |
| Owner manual QA | Runbook initialized | AWAITING OWNER |

## P0 white-screen recovery

- Exact pre-fix revision `86a455e` reproduced a blank document in Edge: `#root` had zero children and Firebase Auth threw `auth/invalid-api-key` from `src/lib/firebase.ts:13` before React mounted.
- Ordinary `.env.local` contains the Supabase browser variable names and no `VITE_FIREBASE_*` names; values were not displayed.
- The runtime now mounts a fail-safe shell before dynamically loading `App`, validates the Supabase URL/key without throwing, and isolates still-legacy privileged modules behind lazy routes.
- Shared Auth session/profile resolution, login, verification resend, and password-reset request now use `@supabase/supabase-js`. Real hosted/local Auth actors remain NOT TESTED because no authorized isolated Supabase environment is available.
- `npm run test:e2e:startup`: PASS for dev configured, dev missing, dev malformed, and built preview configured; each exercises Edge, the original landing, no page/console error, JavaScript entrypoint response, and 390px no-overflow check.
- Legacy Firebase remains in deferred feature chunks and operational pages. The build still emits `firebase-*.js`; full runtime cutover is not claimed.
- Current deterministic inventory: 67 matching legacy-provider lines across the target runtime/config scan; production-only audit remains 4 high findings in the legacy dependency chain.

## M1/S3 identity slice

- Implemented Supabase session/profile/device resolution, controlled device-alias normalization, shared login, verification resend, recovery request/callback, staff privacy acknowledgement, logout, and token acquisition.
- Implemented `/api/auth/complete-password-change` as a Vercel Web Handler plus `20261020000400_identity_rpcs.sql`. It revalidates bearer/current password/active Guard state and records partial completion for reconciliation.
- Official Supabase and Vercel docs were reviewed on 2026-10-20 for network-authenticated `getUser(token)`, server-only secret keys/BYPASSRLS, separate privileged/user-session clients, and Vite `/api` TypeScript handlers.
- Local checks PASS: API typecheck; frontend build; identity static 4/4; existing Supabase static 5/5; four-case startup browser matrix including reset-route unavailable behavior.
- Real Auth users, email delivery, RLS queries, RPC execution, password mutation, Vercel routing, and revocation are BLOCKED / NOT TESTED. `supabase status` reports Docker and Podman absent; no project is linked.
- Legacy inventory is now 50 matching lines, down from 67, but the Firebase output chunk remains. M1 is not complete and cutover is not claimed.

## Baseline toolchain

- Windows PowerShell 5.1.19041.7725
- Git 2.56.0.windows.2
- Node v26.11.1; npm 11.20.0
- Java 25.0.4.1 LTS
- Edge 155.0.4283.62
- Docker, Supabase CLI, Vercel CLI, global Firebase CLI, global Netlify CLI, and Playwright command: not found
- Firebase CLI 13.10.0 is reproducibly obtained through `npx` by the existing scripts.

## S1 evidence

- `npm run test:architecture`: PASS, 1 file / 2 tests.
- `npm run build`: PASS; existing chunk-size warning remains.
- `npm run typecheck:functions`: PASS for unchanged legacy functions.
- `npm run test:e2e:legacy`: PASS; Playwright last-run status passed with zero failed tests. The known emulator orphan was identity-checked, stopped, and ports were verified clear.
- `npm test`: PASS after adding an explicit Vitest/Playwright discovery boundary; the initial runner-overlap failure is preserved in EV-S2-008.
- Exact S2 implementation commit rerun: architecture 3/3, Supabase static 5/5, build PASS, legacy function typecheck PASS.
- Owner visual/manual QA remains AWAITING OWNER.

## M2/S4 registration and issuance slice

- Portal and kiosk visible forms, photo/ID previews, consent, success QR, download/share/print, and default scheduling presentation are preserved.
- Portal anonymous Auth uses `egatepass-portal-auth`; staff/device Auth uses `egatepass-operator-auth`, preventing a portal registration from replacing a kiosk/operator session.
- The registration service requests short-lived owner/source/kind-bound intents and uploads only to server-derived private Storage paths.
- `/api/passes/issue` authenticates the bearer, downloads actual objects, enforces JPEG/PNG/WebP magic bytes and 5 MiB limits, hashes them, and invokes the service-only transaction.
- Migration `20261020000500_pass_issuance.sql` validates source identity, scheduling/Peak Mode/evidence, locks and claims intents, and creates visitor/evidence/pass/audit rows atomically. Stable request IDs make successful retries idempotent.
- Local checks PASS: frontend build, API typecheck, issuance static 7/7, existing Supabase static 5/5, identity static 4/4. Ten issuance pgTAP assertions are authored but NOT RUN.
- Live anonymous/kiosk Auth, RLS, Storage, API routing, transaction behavior, private reads, source-forgery rejection, phone/camera, and QR scan compatibility remain BLOCKED / NOT TESTED. The production build still includes a deferred Firebase chunk.
- The case-sensitive cutover scan reports 48 matching lines in `src`, `api`, `package.json`, `vite.config.ts`, and `index.html`; the release gate remains FAILED.

## M3/S5 gate lifecycle slice

- Entry and exit pages preserve the original scanner UI and now call Vercel `/api/scan-pass`; the raw QR bearer is hashed before database lookup and never logged or stored.
- Migration `20261020000600_gate_lifecycle.sql` implements locked entry/pending, Guard approve/reject, and gate-matched exit transitions with operational events and version increments.
- Guard queue, daily summary, rejection reasons, and Realtime invalidation now use Supabase. A five-second refresh remains as delivery recovery.
- `/api/evidence` revalidates the staff session/profile/privacy/password state, restricts Guard reads to currently pending visitors, rejects expired/purged evidence, and returns private no-store responses.
- Local checks PASS: lifecycle static 6/6, frontend build, and API typecheck. Fourteen lifecycle pgTAP assertions are authored but NOT RUN; total authored database assertions are 59.
- Deterministic case-sensitive legacy scan is 46 lines, down from 48. Admin/config/type modules still produce the 621.99 kB Firebase chunk; cleanup remains prohibited.

## Immediate blockers and next safe work

1. Provide one isolated executable route for the S2 promotion gate: make Docker Desktop available for local Supabase, or explicitly authorize a separate non-production hosted Supabase project after identity confirmation.
2. Run two clean migrations, all 59 authored pgTAP assertions, real Auth bearer-session Data API/RPC denials, actual private Storage operations, and the full issue→entry→decision→exit browser lifecycle. Fix any defect before promotion.
3. Continue M4 Admin/governance implementation without using an unidentified hosted database.
4. Do not link/deploy Vercel, use the hosted database, or send email without owner authorization.

## Maturity

Current product maturity is `IN PROGRESS`, not defense-ready and not deployment-ready. The S2 files are reviewed source with static guardrail evidence only; PostgreSQL/Supabase behavior is not proven.
