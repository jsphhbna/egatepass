# E-GatePass Modernization Build Plan

Last updated: 2026-10-20 (Asia/Manila)

Target: `jsphhbna/egatepass` only

Immutable reference: `jsphhbna/E-GATEPASS` (read-only)

## Outcome and boundaries

Modernize the original React/Vite E-GatePass to Supabase, Vercel, and Resend while preserving its routes, visual identity, actor journeys, and pass lifecycle. Completion requires executable database and browser evidence plus owner-signed manual QA. No production deployment, DNS change, live-data migration, remote schema mutation, or backup-repository write is authorized by this plan.

Sensitive data includes visitor names/contact details, face and ID images, QR bearer credentials, staff/device identities, and audit history. Browser input is untrusted. Durable authorization and lifecycle transitions must be enforced in Postgres/RLS, narrowly granted RPCs, Storage policies, and protected server functions.

## Stage gates

| Recovery milestone | Scope | Required evidence | Current state |
|---|---|---|---|
| P0 | Supabase-only boot, white-screen diagnosis, fail-safe configuration states | Exact pre-fix browser reproduction; dev + preview browser smoke; missing/malformed config negative cases; desktop/390px captures | PASS locally on feature branch; owner-machine confirmation AWAITING OWNER |

| Stage | Scope | Required promotion evidence | Current state |
|---|---|---|---|
| S0 | Repository safety, original inventory, baseline tooling, environment fingerprint, screenshots | Git isolation/tree parity; rollback ref; build/type checks; Firebase emulator suite or explicit blocker; baseline screens/static parity | PARTIAL — accepted checkpoint; external provider identity remained unavailable |
| S1 | Architecture/docs foundation, test harness, safe structure plan | Original routes/UI still build and render; target architecture and migration map reviewed; no backend switch | PASS — build/type/contract checks and 9-case legacy browser regression passed |
| S2 | Supabase schema, RLS, grants, RPC/storage core, synthetic fixtures | Clean disposable migration chain and clean install; real low-privilege RLS/storage negative matrix | IMPLEMENTED — NOT VERIFIED / BLOCKED: migration chain and pgTAP matrix authored; no isolated DB runtime |
| S3 | Shared staff/device auth and governance | Real Auth sessions and browser E2E for all staff/device roles, suspension/revocation/first-login/reset | IMPLEMENTED IN PART — Supabase session/profile, login/reset, privacy, logout, forced-password endpoint/RPC; provisioning/governance and all live integration NOT VERIFIED |
| S4 | Portal/kiosk registration, private evidence, optional local OCR, Peak Mode | Phone/portrait browser E2E, real uploads, session separation, source-forgery negative tests | IMPLEMENTED IN PART — M2 code/static checks PASS; live Auth/Storage/DB/API/browser workflow BLOCKED |
| S5 | Server QR issue, entry, Guard decision, exit | Actual DB state machine E2E plus duplicate/race/wrong-device/expired negative tests | IMPLEMENTED IN PART — M2/M3 code/static checks PASS; live lifecycle BLOCKED |
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

## S2 implementation boundary

S2 adds an additive schema, least-privilege grants/RLS, private buckets, authorization helpers, an upload-intent RPC, bootstrap guard, and executable pgTAP tests. Static tests are not database proof. Promotion and S3 runtime migration remain blocked until `supabase db reset` and `supabase test db` pass against an isolated environment with real Auth/Data/Storage API negative tests.

## P0 recovery result and rollback

The ordinary Supabase-only launch at exact checkpoint `86a455e` was reproduced in Edge with an empty `#root` and `FirebaseError: auth/invalid-api-key` at `src/lib/firebase.ts:13`. The legacy Playwright setup had hidden this by injecting synthetic Firebase values. The repaired boot renders a shell before dynamically importing the app, validates public Supabase configuration without throwing, keeps the public landing available, and fails staff/device access closed with a visible message. Roll back this slice by reverting its checkpoint commit; do not reset S0–S2 or the owner-owned `.env.example` edit.

## M2 implementation boundary

Portal and kiosk registration now use isolated Supabase browser sessions, private owner-bound Storage intents, actual uploaded-byte signature/size/SHA-256 inspection in `/api/passes/issue`, and a service-role-only atomic issuance RPC. The QR bearer value is HMAC-derived from a stable request ID and only its SHA-256 digest is stored. Scope-specific Peak Mode is rechecked in the transaction. OCR choice is **NO** for this checkpoint: original manual fields and one standard ID evidence upload are preserved; no unreviewed OCR dependency was introduced.

M2 remains `IMPLEMENTED — NOT VERIFIED`: no migration, Storage object, anonymous/kiosk Auth session, Vercel function, or issuance transaction has run against Supabase. Legacy upload/function files remain for rollback and must not be deleted until the live parity gates pass.

## M3 implementation boundary

Entry/exit scanners now send the opaque QR bearer to a Vercel handler that hashes it before a service-only RPC. The transaction resolves an active matching device and gate, locks the pass, records entry as pending, denies replay/wrong-gate use, and records exit only from inside. Guard queue/stats/settings use a bounded reauthorizing RPC with Realtime invalidation plus polling recovery. Guard decisions and private evidence reads are reauthorized server-side. All are `IMPLEMENTED — NOT VERIFIED` until the real database/Auth/API/browser lifecycle matrix runs.

## Resume rule

Read `PROJECT_STATE.md`, `DECISIONS.md`, `DEVKIT_FINDINGS.md`, and `EVIDENCE_LEDGER.md` before work. Do not promote a stage with a mandatory FAILED/BLOCKED category. Safe work in later stages may be prepared, but its status remains `IMPLEMENTED — NOT VERIFIED` until the required boundary test runs.
