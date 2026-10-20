# E-GatePass Modernization Build Plan

Last updated: 2026-10-20 (Asia/Manila)

Target: `jsphhbna/egatepass` only

Immutable reference: `jsphhbna/E-GATEPASS` (read-only)

## Outcome and boundaries

Modernize the original React/Vite E-GatePass to Supabase, Vercel, and Resend while preserving its routes, visual identity, actor journeys, and pass lifecycle. Completion requires executable database and browser evidence plus owner-signed manual QA. No production deployment, DNS change, live-data migration, remote schema mutation, or backup-repository write is authorized by this plan.

Sensitive data includes visitor names/contact details, face and ID images, QR bearer credentials, staff/device identities, and audit history. Browser input is untrusted. Durable authorization and lifecycle transitions must be enforced in Postgres/RLS, narrowly granted RPCs, Storage policies, and protected server functions.

## Stage gates

| Stage | Scope | Required promotion evidence | Current state |
|---|---|---|---|
| S0 | Repository safety, original inventory, baseline tooling, environment fingerprint, screenshots | Git isolation/tree parity; rollback ref; build/type checks; Firebase emulator suite or explicit blocker; baseline screens/static parity | PARTIAL — accepted checkpoint; external provider identity remained unavailable |
| S1 | Architecture/docs foundation, test harness, safe structure plan | Original routes/UI still build and render; target architecture and migration map reviewed; no backend switch | PASS — build/type/contract checks and 9-case legacy browser regression passed |
| S2 | Supabase schema, RLS, grants, RPC/storage core, synthetic fixtures | Clean disposable migration chain and clean install; real low-privilege RLS/storage negative matrix | BLOCKED FOR PROMOTION — implementation may proceed; isolated Supabase/Postgres unavailable |
| S3 | Shared staff/device auth and governance | Real Auth sessions and browser E2E for all staff/device roles, suspension/revocation/first-login/reset | PLANNED |
| S4 | Portal/kiosk registration, private evidence, optional local OCR, Peak Mode | Phone/portrait browser E2E, real uploads, session separation, source-forgery negative tests | PLANNED |
| S5 | Server QR issue, entry, Guard decision, exit | Actual DB state machine E2E plus duplicate/race/wrong-device/expired negative tests | PLANNED |
| S6 | Admin/operations parity | Browser and DB proof for records, complete export, users/devices, settings, emergency, audit/reconciliation | PLANNED |
| S7 | Resend/Auth SMTP, retention, holds, alerts | Real inbox tests; physical Storage deletion; hold/race/retry/scheduler-auth evidence | PLANNED |
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

## Resume rule

Read `PROJECT_STATE.md`, `DECISIONS.md`, `DEVKIT_FINDINGS.md`, and `EVIDENCE_LEDGER.md` before work. Do not promote a stage with a mandatory FAILED/BLOCKED category. Safe work in later stages may be prepared, but its status remains `IMPLEMENTED — NOT VERIFIED` until the required boundary test runs.
