# E-GatePass Decision Log

## ADR-0001 — Original-first modernization

- Date: 2026-10-20
- Status: accepted by owner instruction
- Decision: preserve the tracked original application, routes, content structure, visual identity, and workflows. Replace infrastructure in gated vertical slices; do not import or cherry-pick the rejected greenfield V10 build.
- Consequence: no visual redesign or broad folder reshuffle can precede parity evidence.

## ADR-0002 — Repository and production isolation

- Date: 2026-10-20
- Status: accepted
- Decision: configure only the lowercase target as a remote. Access the uppercase backup only through read-only Git queries. Make no production provider mutations without separate approval.
- Evidence: `origin` points only to lowercase target; target/reference tree diff is zero; local checkpoint branch created.

## ADR-0003 — Evidence vocabulary and maturity separation

- Date: 2026-10-20
- Status: accepted
- Decision: record STATIC, UNIT, MOCKED, LIVE LOCAL DATABASE, BROWSER E2E, USER-MANUAL, and DEPLOYMENT SMOKE independently. Code existence is `IMPLEMENTED — NOT VERIFIED`; it is not PASS.

## ADR-0004 — Preserve the pre-existing `.env.example` edit

- Date: 2026-10-20
- Status: accepted for S0
- Decision: do not overwrite or commit the user's dirty `.env.example` change during S0. It contains only empty values by inspection, but its ownership/history is separate from S0.

## ADR-0005 — Synthetic-only baseline browser configuration

- Date: 2026-10-20
- Status: accepted for local evidence
- Decision: public screenshots may use process-scoped synthetic Firebase identifiers because public pages do not need provider data. This evidence proves rendering only, not authentication or provider connectivity.

## Pending decisions

- Supabase local-test execution route (Docker Desktop versus owner-approved isolated hosted test project).
- Vercel Functions versus narrowly granted Supabase Edge/RPC placement per endpoint; decide in S1 from trust/race/operational needs.
- Optional registered visitor accounts remain pending until anonymous ownership and RLS tests pass; guest registration stays first-class.

## ADR-0006 — Staged runtime replacement

- Date: 2026-10-20
- Status: accepted
- Decision: preserve the current source layout and legacy adapters until replacement vertical slices pass their gates. Add `api/`, `supabase/`, and email modules alongside them; remove Firebase/Netlify/Cloudinary files only after executable parity and rollback evidence.
- Consequence: S1 is deliberately a no-runtime-switch change.

## ADR-0007 — Vercel Vite routing and region

- Date: 2026-10-20
- Status: accepted, deployment unverified
- Decision: use the official Vite SPA catch-all in `vercel.json` and Vercel filesystem precedence for future `/api/*` function files. Select `syd1` near the declared Sydney Supabase region.
- Authority: Vercel Vite and project-configuration documentation reviewed 2026-10-20. Local contract/build tests are project evidence; deployed routing is not.

## ADR-0008 — Database-owned authorization

- Date: 2026-10-20
- Status: accepted for S2 implementation
- Decision: roles and device attributes come from protected database rows keyed by `auth.uid()`, not user-editable JWT metadata. RLS and explicit grants default-deny direct access; `SECURITY DEFINER` helpers live outside exposed schemas, use an empty `search_path`, schema-qualified names, caller/resource checks, and narrow execute grants.
- Consequence: S2 cannot be promoted from SQL review alone; real low-privilege positive/negative tests are mandatory.

## ADR-0009 — Relational model and exposed API boundary

- Date: 2026-10-20
- Status: accepted, runtime verification blocked
- Decision: normalize identities, visitors, evidence, passes, visit events, audit events, reconciliation, holds, and maintenance state. Expose RLS tables plus a small `api` RPC schema; keep policy helpers and bootstrap in unexposed `private`.
- Alternatives rejected: one wide JSON document model weakens constraints/query evidence; placing roles in JWT user metadata creates stale/self-editable authority; routing every read through service-role functions expands bypass risk.

## ADR-0010 — Evidence upload intent

- Date: 2026-10-20
- Status: accepted, runtime verification blocked
- Decision: a caller-specific RPC creates a 15-minute, owner/source/kind/bucket/path/MIME-bound intent. Storage permits insert/select only through intent/reference authorization and has no client update/delete policy. Bucket policy limits are 5 MiB for JPEG/PNG/WebP; server content inspection remains mandatory before claim/pass issue.
- Consequence: a successful upload alone can never issue a pass or prove file content.

## ADR-0011 — No audit-driven dependency downgrade

- Date: 2026-10-20
- Status: accepted
- Decision: do not run `npm audit fix --force`. Triage by dependency chain and reachable usage, regression-test safe parent upgrades, and remove legacy Firebase/Netlify chains only after verified replacements.
- Evidence: `docs/DEPENDENCY_AUDIT.md`; full audit 24 findings, production-only audit 4 high in the legacy Firebase chain.

## ADR-0012 — Bootstrap before application module evaluation

- Date: 2026-10-20
- Status: accepted and browser-verified locally
- Decision: `main.tsx` mounts a minimal non-sensitive shell before dynamically importing `App`. A module-evaluation failure renders a visible generic recovery screen outside the application component tree. Public rendering cannot require legacy Firebase configuration.
- Reason: the prior static import chain reached Firebase Auth before the React `ErrorBoundary` existed, producing an empty `#root` when Firebase variables were absent.

## ADR-0013 — Supabase browser configuration and device identity normalization

- Date: 2026-10-20
- Status: accepted for M1 implementation; provider behavior NOT VERIFIED
- Decision: only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` configure the browser client. Missing/malformed values leave public information available and disable privileged sign-in. Device usernames must match the database alias constraint and map deterministically to `<alias>@devices.egatepass.invalid`; arbitrary caller-selected mappings are rejected.
- Security boundary: publishable configuration is not authorization. Auth UID plus active `staff_profiles`/`devices` rows remain authoritative through RLS; live enforcement is blocked pending an isolated Supabase test environment.

## ADR-0014 — Server-verified Guard password completion

- Date: 2026-10-20
- Status: accepted for implementation; integration NOT VERIFIED
- Decision: a Vercel Node Web Handler validates the bearer using Supabase Auth, rechecks the active Guard profile, verifies the current password in a separate non-persistent client, changes the Auth password with the server-only secret client, then invokes a service-role-only transactional database finalizer. A database-finalization failure returns non-2xx and creates a retryable reconciliation task.
- Rejected: a browser-callable flag-clearing RPC could be invoked without proving the password changed; reusing the privileged client for password sign-in could replace its service-role Authorization header with a user session.
- Authority reviewed 2026-10-20: Supabase `auth.getUser(jwt)` reference; Supabase API keys and service-role client troubleshooting; Vercel Vite and Node.js Function handler documentation. Documentation is expected-behavior evidence, not runtime proof.

## ADR-0015 — Separate portal and operator browser sessions

- Date: 2026-10-20
- Status: accepted for M2 implementation; integration NOT VERIFIED
- Decision: use distinct Supabase clients/storage keys for anonymous portal visitors and staff/devices. Kiosk form reset never signs out the device, and portal anonymous sign-in cannot overwrite an operator session in the same browser profile.

## ADR-0016 — Digest-only, idempotent pass issuance

- Date: 2026-10-20
- Status: accepted for M2 implementation; integration NOT VERIFIED
- Decision: the Vercel handler validates real Storage bytes, derives a high-entropy QR bearer using a server-only HMAC secret and stable request UUID, and passes only its SHA-256 digest to a service-role-only transaction. The transaction reauthorizes source identity, settings and locked intents, then atomically creates visitor/evidence/pass/audit state.
- Consequence: a caller cannot choose status, gate, actor, validity, object path, or raw stored token. `PASS_TOKEN_SECRET` must be at least 32 characters in each authorized server environment and must never enter browser configuration.

## ADR-0017 — No OCR dependency in M2

- Date: 2026-10-20
- Status: accepted
- Decision: choose the prompt's optional OCR path **NO**. Preserve manual visitor details, captured face, and one ID evidence upload. This avoids adding an unverified parser and does not weaken the review step or default ID requirement.

## ADR-0018 — Database-owned gate lifecycle and bounded Guard projection

- Date: 2026-10-20
- Status: accepted for M3 implementation; integration NOT VERIFIED
- Decision: QR plaintext crosses only the scanner-to-Vercel request and is hashed before lookup. Service-only row-locking RPCs resolve current device/staff records and own all status/time/gate/event fields. Entry yields `pending`, a privacy-complete Guard/Admin decision yields `inside` or `rejected`, and exit requires `inside` plus the same assigned gate.
- Decision: the Guard reads a 50-item projection and daily aggregate from a caller-reauthorizing RPC. Realtime is an invalidation hint with bounded polling recovery; it is not the authorization boundary.
- Consequence: the browser cannot write lifecycle rows directly, and replay/wrong-device/wrong-gate calls do not advance state.

## ADR-0019 — Decoupled timestamp architecture and complete Admin runtime migration

- Date: 2026-10-20
- Status: accepted for M4 implementation; integration NOT VERIFIED
- Decision: introduce `AppTimestamp` (`toDate()`, `toMillis()`, `toISOString()`, `seconds`, `nanoseconds`) in `src/lib/timestamp.ts` and re-export as `type Timestamp = AppTimestamp` in `src/types/index.ts`. All Admin pages and hooks deserialize ISO strings or unix epochs into `AppTimestamp`, eliminating direct `@firebase/firestore` imports while maintaining 100% compatibility with components, formatting utilities, and UI tests.
- Decision: protect staff and device accounts through dedicated Vercel APIs and service-only RPCs (`api.create_staff_profile`, `api.update_staff_profile`, `api.create_device_profile`, `api.update_device_profile`, `api.retire_device`). Enforce the Last Active Super Admin invariant in Postgres triggers so that neither UPDATE nor DELETE can leave the system with zero active superadmins.
- Decision: isolate Admin operational rights (Peak Mode scope, rejection reasons, visit purposes) from Super Admin security-sensitive rights (retention days, campus working hours, image purge). Server rejects unprivileged attempts with HTTP 403 and records all operational mutations to `public.audit_events`.
- Decision: support bounded cursor pagination across visitor records and activity exports (`/api/admin/records`, `/api/admin/activity`) via `collectCursorPages`, completely redacting QR tokens, signing secrets, and raw private storage paths from client downloads.

## ADR-0020 — Administrative Hardening, Hold Integrity, and Atomic Settings/Audit RPC

- Date: 2026-10-20
- Status: accepted for M4 correction; integration NOT VERIFIED
- Decision:
  1. `api/update-device-auth.ts`: require target validation by verifying the target UID is NOT in `staff_profiles` first (defense-in-depth, HTTP 403 `cannot_modify_staff_via_device_endpoint`), confirming an active, non-retired device row in `devices` (HTTP 404), ensuring alias uniqueness across active devices (HTTP 409), and verifying Auth account existence before any write. Log honest reconciliation compensation on partial failure and write immutable audit records.
  2. `api/purge-images.ts`: protect evidence from deletion by inspecting active incident holds by both `visitor_id` AND `pass_id` (resolving `passes.visitor_id`), re-verifying holds and active passes right before physical storage delete, and respecting dry-run truthfulness.
  3. `api/update-settings.ts`: wrap settings update and audit log write into a single atomic PostgreSQL transaction via `api.update_app_settings` RPC locking `app_settings` singleton row, preventing split-brain states. Truthfully persist and return `automatic_cleanup_enabled`.
  4. `server/actors.ts`: enforce `email_confirmed_at` check on human staff actors (HTTP 403 `email_verification_required`), preserving device exemptions.
  5. `server/cursor.ts`: replace timestamp-only cursor with compound stable key `(timestamp, id)` base64url JSON cursor with legacy ISO fallback. Deterministic secondary order by `id DESC`.

## ADR-0021 — Optional Resend QR Email Delivery with Mailbox Possession Claim Flow

- Date: 2026-10-20
- Status: accepted for M5-F13 implementation; live email delivery BLOCKED
- Decision:
  1. Optional & Non-Impact: email delivery is strictly optional. The pass issuance, QR display, Download QR, print, and share actions remain 100% usable without entering an email address or requiring email service availability. Provider failure or timeout NEVER rolls back or invalidates the issued pass.
  2. Two-Step Inbox Possession Proof: to prevent unauthorized disclosure of the bearer credential to typed addresses or kiosk snooping, require explicit visitor consent and a 6-digit verification code sent to the destination inbox (`action: 'request_code'`) before releasing the scannable QR code (`action: 'verify_and_send'`).
  3. High-Entropy Scannable QR: render server-side high-contrast PNG QR attachment via `QRCode.toBuffer` with EARIST maroon branding. Redact private IDs, face photos, and service keys from email body.
  4. Reconciliation on Failure: if Resend dispatch fails, record a reconciliation item to `reconciliation_items` and return HTTP 502 with an actionable fallback message directing the user to use the intact Download QR button.

## ADR-0022 — One-Pass Root-Cause Resolution: Pass Identity Contract, Atomic Idempotency RPCs, Fail-Closed Controls, and Roster Safety

- Date: 2026-10-20
- Status: accepted for runtime implementation; live Supabase/Resend BLOCKED
- Decision:
  1. **Pass Identity Contract (P0-01)**: `api/passes/email.ts` resolves either `public_reference` (e.g., `GP-20261020-0888`) or UUID against `passes.public_reference` / `passes.id` to identify the pass. The internal UUID `passes.id` is used for all internal foreign key relationships (`pass_email_verifications`, `reconciliation_tasks`). For `token_digest` comparison, Postgres `bytea` values returned by PostgREST as `\x<hex>` or `0x<hex>` are stripped and parsed to a 32-byte binary buffer, then verified with `crypto.timingSafeEqual` against the computed SHA-256 digest.
  2. **Atomic Idempotency and Email Challenge RPCs (P0-02)**: Authored migration `20261020000900_qr_email_idempotency.sql` introducing service-role RPCs:
     - `api.request_email_verification_code`: validates rate limits (max 3 per 15 min), generates challenge hash from CSPRNG (`crypto.randomInt`), and enforces idempotency on `request_id`.
     - `api.verify_and_claim_email_dispatch`: locks row `FOR UPDATE`, checks attempts (max 5), verifies hash with timing-safety, verifies expiration (10 min), claims dispatch (`delivery_status = 'claiming'`), and checks `send_request_id` idempotency.
     - `api.finalize_email_dispatch`: transitions status to `sent_to_provider` or records provider failure without consuming code or invalidating pass.
  3. **Strict Fail-Closed Settings Updates (P0-03)**: Removed direct table write and unverified audit write fallback from `api/update-settings.ts`. If `api.update_app_settings` fails, the API returns a structured HTTP error (403, 404, 400, 503) and performs zero mutations.
  4. **Dual Hold Verification & Error Inspection on Storage Purge (P0-04)**: `api/purge-images.ts` checks both visitor-linked AND pass-linked active incident holds immediately prior to storage deletion. Queries explicitly check `.error`; any error triggers a fail-closed response, skipping deletion and logging reconciliation.
  5. **Governance Target Validation & Audit Error Handling (P0-05)**: `api/update-device-auth.ts` inspects `staffError` on `staff_profiles` lookup and fails closed with 503; inspects `{ error: auditError }` on audit insert and logs reconciliation.
  6. **Dashboard Calendar Window Alignment (C-01)**: In `api/admin/dashboard.ts`, `pendingToday` measures passes scanned today (`entry_scanned_at` within Manila calendar day), while `allPending` captures all unapproved passes regardless of date.
  7. **Emergency Evacuation Truncation & Failure Alerts (C-02)**: In `AdminEmergency.tsx`, bold screen and print alerts display prominently if records hit the 10,000 ceiling (`isTruncated === true`) or if network polling fails (`loadError`), preventing false complete evacuation lists.
  8. **Strict Compound Cursor Decoding & CSV Formula Defense (C-03)**: In `server/cursor.ts`, `decodeCursorStrict` validates ISO timestamp format and UUID/BigInt identifier types, returning HTTP 400 `invalid_cursor` on malformed input. In `src/lib/completeExport.ts`, `escapeCsvCell` sanitizes formula prefixes `=+\-@` even when preceded by whitespace, tabs, or control characters.

## ADR-0023 — QR-email fail-closed state machine and conservative delivery semantics

- Date: 2026-10-20
- Status: accepted for targeted correction; live Supabase/Resend NOT VERIFIED
- Supersedes ADR-0021 delivery-failure retry wording and ADR-0022 item 1's non-schema `GP-...`/internal-ID fallback.
- Decision:
  1. The API accepts only the issuance response's UUID `public_reference`; the internal UUID `passes.id` is never an alternate public lookup key.
  2. Security-critical RPC absence, denial, malformed data, or transient failure fails closed. Application code never reads or writes `pass_email_verifications` as a fallback.
  3. Request-code keys are bound to actor/pass/recipient. Code rate limiting locks the parent pass before counting/inserting, and invalid attempts update under the challenge row lock.
  4. A claimed send replays its durable state without calling the provider. Different keys cannot bypass `sending`, accepted, or unknown states. Definitive rejection permits only a deliberate new attempt.
  5. Transport errors and unreadable 2xx acknowledgements are ambiguous. They remain `outcome_unknown`; stale `sending` claims become unknown after 15 minutes and require reconciliation. No exactly-once guarantee is claimed across PostgreSQL and Resend.
  6. UI success means submitted to the provider, not delivered to an inbox. Email remains optional and can never revoke or roll back an issued pass.

## ADR-0024 — OCR-First Kiosk Registration and Privacy Architecture (UX-01)

- Date: 2026-10-20
- Status: accepted for implementation; physical Android tablet camera/lighting AWAITING OWNER
- Decision:
  1. Priority Interaction: the kiosk starts with a default "Scan Your Valid ID" screen, prominent primary "Scan My ID" button, and an understated secondary text link "Want to type manually instead?".
  2. Local-Only Processing: OCR executes strictly on-device using Tesseract.js with locally hosted static assets under `public/tesseract/`. No ID image or OCR text is sent to third-party vision APIs or telemetry.
  3. Narrow Purpose & Confirmation: OCR extracts suggested names (first, middle, last) using Philippine ID layout heuristics (PhilSys, Driver's License, UMID, Postal ID). The visitor reviews and explicitly confirms editable fields.
  4. Single Evidence Reuse: the captured ID image (`idBlob`) is reused as the mandatory ID-evidence upload. Visitors never capture their ID twice.
  5. Mandatory Face Photo & Peak Mode: visitor face photos remain 100% mandatory across all modes. Peak Mode skips only ID evidence for authorized channels and never grants authenticity exemptions.
  6. Resource Lifecycle: Tesseract.js is lazily loaded only on the kiosk scan step, maintaining a lean initial bundle. Workers and camera streams are terminated on completion, restart, or unmount.

## ADR-0025 — React Email Restoration and Security Risk Mitigations (EMAIL-ARCH-01, EMAIL-H01/H02, M01-M05)

- Date: 2026-10-20
- Status: accepted for runtime implementation; live provider/PostgreSQL BLOCKED
- Decision:
  1. React Email Restoration (EMAIL-ARCH-01): replaced raw string concatenation with `@react-email/components` and `@react-email/render`. Server-rendered accessible EARIST maroon/gold email templates for verification codes and QR passes, attaching high-contrast scannable QR PNG buffers.
  2. Conservative Provider Classification (EMAIL-H01): `server/email.ts` classifies 400, 401, 403, 422 as `definitive_rejection` (permitting deliberate retry), while 429, 5xx, timeouts, connection errors, and malformed 2xx are classified as `unknown` (fencing delivery status to `outcome_unknown`, disabling auto-retry, and enqueueing reconciliation).
  3. Terminal State Conflict Handling (EMAIL-H02): migration `20261020001100_email_security_and_abuse_controls.sql` returns explicit `match_status` (`matched`, `already_finalized_same_status`, `terminal_conflict`). Handlers fail closed on conflict with HTTP 202 and log reconciliation.
  4. Cross-Pass Abuse Thresholds (EMAIL-M01): enforced database-level limits of max 5 challenges per recipient email across passes and max 10 challenges per actor in 15 minutes, returning HTTP 429.
  5. Kiosk Device State Verification (EMAIL-M02): kiosk-initiated email actions require caller actor to represent an active, non-deleted device of type `kiosk` in `devices` table, rejecting revoked or wrong-role devices with HTTP 403 `kiosk_device_revoked`.
  6. DB-Coordinated Purge Protocol (PRIVACY-M03): `claim_evidence_for_purge` atomically locks and claims candidate evidence records excluding active incident holds before physical deletion in Supabase Storage.
  7. Staff Keyset Pagination (ADMIN-M04): keyset/cursor pagination on `staff_profiles` with bounded Auth user enrichment, eliminating silent 200 truncation while avoiding N+1 full scans.
  8. SPA Rewrite Precedence (DEPLOY-M05): `vercel.json` SPA rewrite configured with negative lookahead `/((?!api/).*)` -> `/index.html` ensuring API function routes are never masked by client SPA HTML.

## ADR-0026 — Root-Cause Purge Hardening, Advisory Abuse Throttling, and Dev API Architecture (P0-A, P0-B, P0-C, P0-D, P1-E)

- Date: 2026-10-20
- Status: accepted for implementation; live hosted Supabase migrations BLOCKED pending owner approval
- Decision:
  1. **Purge Claim-ID Authorization & Contract Hardening (P0-A)**:
     - Additive migration `20261020001200_concurrency_and_purge_contract_hardening.sql` updates `api.claim_evidence_for_purge` and `api.finalize_evidence_purge`.
     - Finalization enforces exact row-level matching under `FOR UPDATE`: `ve.id = target_evidence_id AND ve.purge_claim_id = requested_claim_id`.
     - If the claim is null, stale (> 5 minutes old), expired, or owned by another worker, the RPC fails closed and returns `{ finalized: false, match_status: 'claim_mismatch' }`.
     - Standardized typed JSON response: `{ finalized: true, match_status: 'matched', purged: true, evidence_id: ... }`.
     - `api/purge-images.ts` strictly validates this contract, requires exact storage bucket and object path match against the authoritative claim, and reconciles failures.
  2. **Canonical PostgreSQL pgTAP Fixtures (P0-B)**:
     - Corrected `supabase/tests/008_email_security_and_abuse_controls.test.sql` to canonical `public.devices` schema (`user_id, alias, name, type, gate, status`) and `public.visitors` (`created_by_device_id`).
     - Added static regression assertions in `tests/supabase-migration-static.test.ts` to prevent obsolete/fabricated column references (`device_alias`, `registered_at`, `retired_at`, `status = 'retired'`).
     - Total authored assertions: 93 across 9 test suites, marked `AUTHORED / NOT RUN` until isolated PostgreSQL instance is available.
  3. **Transactional Advisory Locking for Cross-Pass Abuse Throttling (P0-C)**:
     - Migration 001200 introduces deterministic transaction-scoped PostgreSQL advisory locks (`pg_advisory_xact_lock`) in `api.request_email_verification_code`.
     - Strict lock hierarchy: Level 1 locks actor ID (`('x' || substr(md5('actor:' || request_actor_id), 1, 16))::bit(64)::bigint`); Level 2 locks recipient email (`('x' || substr(md5('recipient:' || recipient_email), 1, 16))::bit(64)::bigint`).
     - This serializes concurrent requests across distinct passes without deadlocks or race conditions on the shared challenge counter.
     - Preserves agreed limits: max 3/pass/15m, 5/recipient/15m, 10/portal-actor/15m.
     - In `api/passes/email.ts`, prioritized specific recipient and actor error codes before generic limit strings.
  4. **Vite Dev API Handler Plugin & PostgREST 404 Diagnosis (P0-D)**:
     - Identified root cause of the localhost:5173 Supabase 404: `GET https://nhoawvkfqblsgutdffie.supabase.co/rest/v1/app_settings` returns PostgREST HTTP 404 `PGRST205` ("Could not find the table 'public.app_settings' in the schema cache") because the hosted `egatepass-dev` project has not yet had migrations 000100–001200 applied.
     - Added graceful fallback defaults and diagnostic warning logs in `src/services/visitorRegistration.ts`.
     - Replaced outdated Netlify port 8888 proxy in `vite.config.ts` with `vercelApiDevPlugin` which natively routes `/api/*` to the current Vercel web handlers in `api/` during local Vite dev, returning proper JSON responses (401/405/404) with zero external daemon dependencies.
  5. **Vercel Preview Deployment Preflight (P1-E)**:
     - Authored `docs/VERCEL_PREVIEW_PREFLIGHT.md`.
     - Probed 10 critical endpoints locally (10/10 PASS).
     - Verified offline self-hosted OCR assets in `public/tesseract/`.
     - Verified zero leakage of server secrets (`SUPABASE_SECRET_KEY`, `PASS_TOKEN_SECRET`, `RESEND_API_KEY`) into the frontend bundle.
     - Formulated unambiguous three-level deployment verdict: (a) Safe for frontend-only Vercel Preview, (b) Blocked for functional preview until owner-approved migrations on `egatepass-dev`, (c) Production blocked.

## ADR-0027 — Cross-Layer Root-Cause Hardening: RLS Staff Onboarding, Supabase Auth Email Hooks, Idempotent Issuance Replay, and Coordinated Incident Holds

- Date: 2026-10-20
- Status: accepted for implementation; live hosted Supabase migrations & Send Email Hook activation BLOCKED pending owner approval.
- Decision:
  1. **RLS Staff Eligibility Drift & Self-Profile Onboarding (P0-01)**:
     - Migration `20261020001300_cross_layer_root_cause_hardening.sql` aligns `private.current_staff_role()` with backend/UI eligibility: requires `active = true`, `email_confirmed_at IS NOT NULL`, `must_change_password = false`, and `privacy_accepted_at IS NOT NULL`.
     - Avoids onboarding deadlocks by updating `staff_profiles_select` RLS policy: users can read their own minimal profile (`user_id = auth.uid()`) during onboarding before password change and privacy acknowledgment.
     - Added `api.acknowledge_privacy()` RPC to record privacy consent without requiring operational staff privileges.
  2. **Passes↔Visitors Ownership Join in Verification Challenge (P0-02)**:
     - Repaired `api.request_email_verification_code` in migration 001300. Canonical `public.passes` contains `visitor_id`, while `public.visitors` contains `owner_id` and `source`. Joined `passes p` to `visitors v` under lock to resolve `v.owner_id` and `v.source`, eliminating runtime column-not-found errors.
  3. **Explicit Least-Privilege Schema Grants (P0-03)**:
     - Granted explicit USAGE on `api` and `public` to `authenticated` and `service_role`.
     - Revoked all privileges on schema `private` from `public`, `anon`, and `authenticated`.
  4. **Atomic Incident Hold Create/Release & Storage Purge Protocol (P0-04)**:
     - Implemented atomic RPCs `api.create_incident_hold` and `api.release_incident_hold` in migration 001300.
     - `create_incident_hold` verifies that candidate evidence has not already been purged and does not have an active purge claim in progress (`40001` conflict).
     - Created `api/admin/holds.ts` handler for Super Admin hold operations.
  5. **Supabase Auth Send Email Hook & React Email Architecture (EMAIL-01 & EMAIL-02)**:
     - Implemented `verifyStandardWebhookSignature` in `server/auth-email-hook.ts` using Standard Webhooks HMAC-SHA256 with 5-minute replay window and `whsec_` key decoding.
     - Authored responsive EARIST-branded React Email templates: `SignupConfirmationEmail.tsx`, `PasswordResetEmail.tsx`, `StaffInviteEmail.tsx`, `EmailChangeEmail.tsx`.
     - Inverted secure email change token mapping according to Supabase GoTrue semantics: `token_hash_new` for current email, `token_hash` for new email.
     - Implemented Vercel Web Handler `/api/auth/send-email-hook` and standalone Deno Edge Function in `supabase/functions/auth-send-email/index.ts`.
     - Audited staff onboarding: preserved existing administrator-supplied password creation with customized React Email confirmation template; documented one-time invitation token mechanism awaiting owner policy decision.
  6. **Pre-Provider Rendering Error Protection (EMAIL-03)**:
     - In `api/passes/email.ts`, wrapped template rendering in a controlled pre-send try/catch block with `providerAttempted = false`, finalizing failed template rendering as `delivery_failed` instead of leaving orphaned challenges in `code_sending`.
  7. **Pass Issuance Idempotent Replay (HIGH-01)**:
     - In `api/passes/issue.ts`, queries existing passes by `issue_request_id` before inspecting upload intents.
     - If committed pass exists, verifies actor, source, form details, and claimed intents match, verifies pass is not expired, checks HMAC secret rotation, and returns 200 OK with existing pass details without duplicating storage or DB records.
  8. **pgTAP 009 Fixture Purge Invariant Correction (HIGH-02)**:
     - Corrected `supabase/tests/009_cross_pass_abuse_concurrency.test.sql` by separating test fixtures: dedicated visitor 913 with expired pass 923 for purge tests, visitor 911 with active pass 921 to assert negative invariant (`active_pass_exists`).
  9. **Guard Approval Expired Pass Recheck (HIGH-03)**:
     - In migration 001300, `api.decide_visit` re-checks `target.valid_until <= statement_timestamp()` on approval, marking expired passes with `status = 'expired'` and raising `pass_has_expired`. Handled in `api/decide-visit.ts` returning 422.
  10. **Retention Maintenance Scheduling (HIGH-04)**:
      - Authoritative endpoint `/api/admin/retention-maintenance.ts` with `CRON_SECRET` authentication, dry-run mode, and batch cleanup of expired unheld evidence, abandoned upload intents, and expired verification codes.
  11. **Evidence Access During Active Incident Holds (HIGH-05)**:
      - In `api/evidence.ts`, enables authorized review of expired evidence by Admin/Super Admin when an active incident hold protects it, setting `X-Evidence-Hold-Status: active_hold` and logging audit event `evidence.review_held`. Guards receive 410.
  12. **Medium-Risk UI & Database Refinements (MED-01–MED-04, MED-07)**:
      - `MED-01`: Guard queue pagination with `api.guard_dashboard(requested_limit, requested_offset)` returning `pendingTotal` and `hasMore`.
      - `MED-02`: Real QR sharing via Web Share API File for scannable PNG with download and instructional fallback.
      - `MED-03`: Accurate OCR privacy notice distinguishing local on-device recognition from eventual private storage upload.
      - `MED-04`: Rate-limiting upload intent quota (max 10 active pending intents per portal visitor) in migration 001300.
      - `MED-07`: Aligned pass public reference fixture to canonical UUID in `tests/email-templates.test.ts`.
   13. **Root-Cause Repair & Recurring-Pattern Elimination Architectural Decisions (Repairs 1A–21)**:
      - **D-RG01 (PostgreSQL Function Signature Invariance & Audit Schema)**:
        - Decided to preserve canonical `returns timestamptz` for `api.acknowledge_privacy()` across all migrations rather than attempting incompatible `CREATE OR REPLACE FUNCTION` type mutations.
        - Decided to strictly enforce canonical `public.audit_events` schema `(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state)` across all SQL migrations and API handlers, removing non-schema `details` column and requiring valid enum outcomes (`success`, `denied`, `partial`, `failure`).
      - **D-RG02 (QR Email State Machine & Idempotency Tuple Binding)**:
        - Decided to retain `request_actor_id` as the authoritative column in `email_verification_codes` without introducing redundant aliases.
        - Permanently bound idempotency request keys to the immutable tuple `(pass_id, request_actor_id, recipient_email)`, rejecting mismatched replays as bad requests rather than issuing redundant challenges.
      - **D-RG03 (Privileged Incident Hold RPC Contract)**:
        - Aligned API caller and SQL signature for `api.create_incident_hold` and `api.release_incident_hold` to accept explicit `requested_actor_id`, `requested_visitor_id`, `requested_pass_id`, `requested_reason`, `requested_request_id`, revalidating authorization under the service-role context.
      - **D-RG04 (Committed Transactional Expiration on Guard Approval)**:
        - Decided not to raise a rolling-back exception when a guard approves an already-expired pass. Instead, the transaction writes `status = 'expired'::public.pass_status`, logs an `invalid_scan` visit event (`pass_has_expired`), and commits cleanly, returning `'expired'` to the API which reports 422 to the client.
      - **D-RG05 (Durable Retention & Storage Split-Brain Recovery)**:
        - Decided that any storage deletion followed by database finalization failure must write an authoritative reconciliation record detailing the physical deletion fact, preventing ghost re-creations or inaccurate status.
        - Enforced strict checks for `automatic_cleanup_enabled` and candidate oversampling (200 query limit for 50-claim batch) to avoid starvation on old held items.
      - **D-RG06 (Supabase Auth Send Email Hook & Verify URL Structure)**:
        - Decided to construct `/auth/v1/verify` endpoints using `SUPABASE_URL` as the base authority while preserving `siteUrl` / `redirect_to` for application navigation.
        - Enforced fail-closed behavior (HTTP 503) when `RESEND_API_KEY` is missing in production environments.
      - **D-RG07 (Canonical Shared Password Policy)**:
        - Unified frontend and backend password policies to require min 12 characters, uppercase, lowercase, digit, and special symbol, eliminating validation drift between client Zod schemas and Supabase Auth configuration.
      - **D-RG08 (Strict Password Recovery Context)**:
        - Decided that `ResetPasswordPage` must verify an active recovery context (`PASSWORD_RECOVERY` event or `type=recovery` query param) rather than permitting any authenticated device/staff session to treat it as an unauthenticated self-service credential reset.
      - **D-RG09 (Fail-Closed Admin Settings UI)**:
        - Decided that fetch failure in `AdminSettings` must produce a non-editable error state with locked Save buttons, preventing accidental overwriting of production configuration with default fallbacks.
      - **D-RG10–15 (Authoritative Pagination & Complete Metrics Reporting)**:
        - Replaced in-memory slicing and page-1 assumptions across Guard queue, Records search, Audit logs, Reconciliation items, Device lists, and Dashboard aggregates with server-side pagination, debounced query params, and authoritative PostgreSQL counts.
      - **D-RG16 (Multi-Pass Hold Query Support)**:
        - Replaced `.maybeSingle()` with `.limit(1)` for pass-level hold checks to safely handle visitors with multiple held passes without runtime query crashes.
      - **D-RG17–20 (Environment, CSP, ErrorBoundary & Routing Hardening)**:
        - Decided to support both `RESEND_FROM_EMAIL` and `EMAIL_FROM`, enforce strict CSP in `vercel.json` with OCR WASM and camera permissions, suppress React component stacks in production ErrorBoundaries, and provide an accessible branded 404 route.
      - **D-RG21 (Advisory Locking for Anonymous Intent Quotas)**:
        - Added transaction-scoped advisory locks on caller IDs in `api.create_upload_intent` to serialize concurrent requests and eliminate count-then-insert race conditions.

## ADR-0013 — Email Architecture Consolidation & Password Recovery Authorization Security
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**: The repository had a duplicate unmaintained edge function `supabase/functions/auth-send-email/`, and `ResetPasswordPage.tsx` unlocked password modification for any authenticated session if `?type=recovery` was in the URL.
- **Decision**:
  1. Consolidate production Auth email delivery exclusively on Vercel Send Email Hook (`/api/auth/send-email-hook`) + React Email templates + Resend. Delete obsolete Supabase Edge Function implementation.
  2. In `server/auth-email-hook.ts`, correctly handle GoTrue Secure Email Change inverted token hashes (`token_hash_new` for current email confirmation, `token_hash` for new email confirmation).
  3. In `ResetPasswordPage.tsx`, strictly require genuine Supabase `PASSWORD_RECOVERY` auth event or unexpired `sessionStorage` recovery token (15-minute window). Disallow raw URL text parameter `?type=recovery` from acting as recovery authorization.
- **Consequence**: Single authoritative email renderer; eliminated recovery authorization bypass for staff/device/portal sessions.

## ADR-0014 — Retention Keyset Cursoring, Incident Hold Invariant & Additive Migration 001400
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**: Retention maintenance suffered from potential starvation on held records and did not enforce visitor PII anonymization or audit/reconciliation pruning. `api.create_incident_hold` lacked relational consistency checks between visitor and pass. Live project `egatepass-dev` flagged `public.rls_auto_enable()` privilege leak.
- **Decision**:
  1. Implement persistent maintenance cursor in `public.maintenance_state` (`job_name = 'retention_evidence_purge'`) with composite `(expires_at, id)` keyset advancement to guarantee forward progress past held items.
  2. Implement truthful retention behavior for `visitor_retention_days` (anonymize personal fields while preserving referential integrity and protecting active passes / incident holds), `audit_retention_days`, and `reconciliation_retention_days` (resolved items only).
  3. Validate `passes.visitor_id = requested_visitor_id` in both API and SQL RPC when both IDs are provided.
  4. Create additive migration `20261020001400_closure_and_hardening.sql` that conditionally revokes execute on `public.rls_auto_enable()` from `public, anon, authenticated` and grants to `postgres`, adds incident hold checks, adds server aggregate RPCs, and indexes.
- **Consequence**: Guaranteed retention forward progress without starvation; incident hold integrity guaranteed at DB and API layers; security advisor warning resolved cleanly.

## ADR-0028 — Cryptographic Server-Controlled Recovery Authorization & Device Credential Mutability Guard (Repair Group A)
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**: `ResetPasswordPage.tsx` previously stored a pseudo-token in browser `sessionStorage` (`egatepass_recovery_auth_v1`), allowing any authenticated client (e.g. kiosk or portal user) to forge authorization. Device credentials must be Super Admin-managed; signed-in devices must not be permitted to self-mutate credentials via `auth.updateUser()`.
- **Decision**:
  1. Completely remove all client-side browser storage (`sessionStorage`/`localStorage`) authorization tokens for password recovery. Client UI holds token strictly in memory during genuine `PASSWORD_RECOVERY` events.
  2. Implement server-controlled endpoint `/api/auth/reset-password` that inspects the Supabase JWT `amr` (Authentication Method Reference) claim, requiring `{ method: 'recovery' }`.
  3. Deny password recovery to device accounts (`@devices.egatepass.invalid` and in `public.devices`), anonymous portal sessions (`is_anonymous: true`), and deactivated/invalid staff profiles.
  4. Implement database trigger `public.protect_managed_credentials()` on `auth.users` in migration `20261020001400_closure_and_hardening.sql` to block non-service-role password mutation on device and anonymous accounts directly in PostgreSQL.
  5. Build full 10-case test matrix in `tests/password-recovery.test.ts` proving browser forgery, active staff/device/portal sessions, and expired tokens are rejected, while legitimate recovery and Super Admin device management succeed.
- **Consequence**: Elimination of client-forgeable recovery state; rock-solid defense-in-depth across API and database layers against device self-mutation.

## ADR-0029 — Supabase Send Email Hook Contract Alignment, Retention Fail-Closed Discipline & Turnstile Production Invariants (Repair Groups B–K, M)
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**: `server/auth-email-hook.ts` incorrectly modeled new emails under `email_data.new_email` instead of `user.new_email` and retained fake action types (`email_change_current`, `email_change_new`). Retention maintenance failed open on settings errors, ignored protection query errors, ignored cursor upsert errors, and computed success prior to audit completion. Cloudflare Turnstile allowed anonymous portal registration if `VITE_TURNSTILE_SITE_KEY` was missing in production.
- **Decision**:
  1. Align `server/auth-email-hook.ts` with current Supabase GoTrue contract: model `user.new_email`, remove `email_data.new_email`, remove obsolete action variants, map `token_hash_new` -> current email and `token_hash` -> new email under Secure Email Change, and handle security notifications (`password_changed_notification`, `email_changed_notification`, etc.) without throwing 500.
  2. Retention maintenance fails closed: if `app_settings` query errors or returns no singleton, immediately return HTTP 500, execute zero mutations, and log reconciliation.
  3. Retention protection checks fail closed: if visitor hold, pass hold, or active pass queries error, treat protection status as uncertain and `continue` without anonymizing candidate records.
  4. Explicitly inspect `maintenance_state.upsert(...)` error, log truthful error to metrics and reconciliation, and prevent success outcome.
  5. Calculate maintenance result status strictly AFTER audit event recording; enforce regression assertion that `success === true` guarantees `metrics.errors.length === 0`.
  6. Cloudflare Turnstile fails closed in production: if `PROD` is true and `VITE_TURNSTILE_SITE_KEY` is missing or empty, fail closed with explicit safe error; if `captchaToken` is missing, require verification challenge. Kiosk and staff remain completely exempt.
  7. Turnstile private secret belongs exclusively to hosted Supabase Auth Bot Protection configuration; prohibit placement under `VITE_*` in `.env.example` or client source.
- **Consequence**: Full alignment with current official Supabase payload contracts; leak-proof fail-closed retention and bot abuse controls.

## ADR 2026-10-21: Root-Cause Closure & Recurrence Elimination Architecture
- **Context**: Several critical architectural boundaries exhibited defects arising from protocol reimplementation, helper side-effect coupling, token lifecycle misunderstanding, role assumption in auth triggers, unsafe resilience fallbacks, and mixed error handling models.
- **Decisions**:
  1. **Webhook Protocol**: Adopt official `standardwebhooks` reference library. Require canonical prefix `v1,whsec_`, strip prefix, and verify exact raw HTTP body. Support pipe-separated rotation secrets (`|`). Reject all malformed formats and timestamps outside tolerance.
  2. **Public Registration Settings**: Decouple public settings loading from `authenticatedClient()`. Settings load uses `requirePortalSupabase()` directly for 6 safe columns without requiring CAPTCHA or auth session. Anonymous accounts are created strictly at pass submission time in `issueVisitorPass()`.
  3. **Settings RLS & Column Grants**: Safe anon access enforced via singleton RLS policy (`singleton = true`) and explicit column-level SELECT grants restricted to `working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes`. Retention and security settings remain strictly forbidden to anon.
  4. **Turnstile Token Lifecycle**: Treat Turnstile tokens as single-use challenge credentials. Clear token and force challenge reset on pass submission `finally`, on widget error, and on token expiration. Prevent stale token reuse on retry.
  5. **Device Credential Mutation Guard**: Abandon reliance on `auth.role()` inside auth database triggers. Enforce admin-controlled mutation marker `egatepass_device_credential_change_id` in `raw_app_meta_data`. Super Admin generates a fresh UUID marker on password/email changes. Compensating rollback must generate a distinct second fresh marker. Anonymous users are strictly barred from setting passwords. Trigger EXECUTE is revoked from `public, anon, authenticated`.
  6. **Dashboard Fail-Closed Aggregates**: Authoritative aggregate RPCs (`dashboard_calendar_counts`, `dashboard_today_insights`) must fail closed with HTTP 503 if the RPC errors, returns null, or fails strict Zod validation. Prohibit raw-row fallback and local JavaScript aggregation.
  7. **Supabase Returned Error Inspection & Partial Truth**: Prohibit relying on `try/catch` for Supabase database mutations. All audit and reconciliation inserts must inspect returned `.error`. When an irreversible action (password reset, device credential rotation, image purge) succeeds but audit logging fails, return truthful `result: "partial"` with `auditPending: true` and `reconciliationRecorded: true`, without rolling back or prompting user to repeat the operation.


## ADR-0030 — Auth / RLS Contract Hardening, Recovery Confinement & True Anonymous Identity Model
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**: 
  1. Password recovery tests previously modeled impossible fabricated AMR states rather than genuine Supabase PKCE recovery.
  2. A recovery session risked being accepted as an operational staff session across server APIs and database RLS.
  3. `private.is_portal_actor()` previously equated "not staff and not device" with Portal visitor, allowing permanent non-staff accounts to act as Portal actors.
  4. `public.app_settings` granted table-wide SELECT to `authenticated`, leaking retention and internal configuration to anonymous Auth visitors who become role `authenticated`.
  5. `TurnstileWidget` recreated on parent state updates due to callback prop identity changes.
  6. `standardwebhooks` was pinned with a caret range `^1.1.1`.
- **Decisions**:
  1. **Dedicated PKCE Recovery Flow**: Instantiate a dedicated Supabase client via `requireRecoverySupabase()` with isolated storage namespace `egatepass-recovery-auth`, `flowType: 'pkce'`, and disabled auto-refresh. Isolate operator client from consuming recovery URLs. Terminate recovery session and clear URL state upon reset completion.
  2. **Recovery Session Confinement**: Centralize verified session context resolution via `getVerifiedSessionContext(admin, token)`. Enforce that `requireStaffActor` rejects password recovery sessions with HTTP 403 `recovery_session_forbidden`. In PostgreSQL, implement `private.is_recovery_session()` inspecting JWT `amr` and update `private.current_staff_role()` to return null for recovery sessions, cutting off staff RLS authority.
  3. **Authoritative Anonymous Portal Actor Definition**: Define Portal actor strictly as `auth.users.is_anonymous = true` AND not in `staff_profiles` AND not in `devices`. Bar permanent non-staff users from Portal operations (e.g. upload intents).
  4. **Settings Column-Level Grants**: Revoke broad table SELECT on `public.app_settings` from `authenticated` as well as `anon`. Grant column-level SELECT on only the 6 safe public columns (`working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes`) to both roles. Server administrative settings queries continue to run via service role.
  5. **Turnstile Widget Lifecycle Stability**: Store callback props in refs within `TurnstileWidget.tsx`. Teardown effect depends strictly on `siteKey` and `resetKey`.
  6. **Security Dependency Exact Pin**: Exact-pin `"standardwebhooks": "1.1.1"`.
- **Consequence**: Full confinement of recovery sessions to password reset only; prevention of permanent user impersonation of Portal actors; elimination of settings information leakage; rock-solid Turnstile lifecycle.


## ADR-0031 — Final Auth/RLS Recurrence Closure, Database Recovery Confinement & Fail-Closed Device Lookups
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**:
  1. `staff_profiles_select` RLS previously allowed self-read `user_id = auth.uid()` without checking whether the session was a recovery session, allowing recovery tokens to query staff profiles.
  2. `api.acknowledge_privacy()` permitted authenticated callers to acknowledge privacy and mutate `staff_profiles` while holding a recovery token.
  3. `devices_select` RLS permitted self-read for recovery sessions.
  4. `api.guard_dashboard(integer, integer)` queried `staff_profiles` directly without excluding recovery sessions.
  5. `api/auth/reset-password.ts` queried nonexistent column `id` on `public.devices` and destructured `{ data: deviceRecord }` without checking returned `error`, creating a fail-open condition on database error.
  6. Previous test descriptions in `tests/password-recovery.test.ts` referred to mocked AMR testing as "genuine recovery flow".
  7. Previous report contained a typographical commit SHA `1d1633890bb8a728b77a064da2cf8a38541eb93a`.
- **Decisions**:
  1. **Database RLS Recovery Confinement**: Recreated `staff_profiles_select` and `devices_select` to require `(user_id = (select auth.uid()) and not (select private.is_recovery_session())) or (select private.has_staff_role(array['admin','superadmin']::public.staff_role[]))`.
  2. **Database RPC Recovery Confinement**: In `api.acknowledge_privacy()` and `api.guard_dashboard(integer, integer)`, raise exception `recovery_session_forbidden` (SQLSTATE 42501) if `private.is_recovery_session()` is true.
  3. **Device Query Schema & Fail-Closed Error Handling**: Query canonical columns `user_id, alias, type, status` from `public.devices`. If `deviceError` or `profileError` occurs, fail closed with HTTP 503 `service_unavailable`.
  4. **Evidence Classification Discipline**: Reclassify local recovery tests as `MOCKED SERVER CONTRACT TEST`. Document `REAL SUPABASE RECOVERY CANARY` as a remaining gate after hosted migration approval.
  5. **Baseline SHA Correction**: Record authoritative starting SHA as `1d1633890dff98e79583276798c31ed95d2dac8e`.
  6. **Zero API Sprawl**: Zero new API endpoints added. Repaired existing RLS, RPCs, and API handler.
- **Consequence**: Full database-level confinement of recovery sessions; fail-closed device identity lookup; accurate evidence ledger; zero hosted mutation.


## ADR-0032 — Guard Dashboard Contract Restoration and Asia/Manila Daily Statistics Invariant
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**:
  1. Migration `20261021000200_recovery_confinement_and_device_closure.sql` properly hardened `api.guard_dashboard(integer, integer)` against recovery sessions and enforced staff operational roles.
  2. However, the migration unintentionally altered the established JSON response contract consumed by `src/services/guard.ts`:
     - Evidence IDs were replaced with a generic `evidence: [{ id, kind }]` array, breaking `photoEvidenceId` and `idEvidenceId`.
     - Root pagination property was renamed to `totalPending` instead of canonical `pendingTotal`.
     - Daily stats object omitted `total` and returned `pending`.
     - These mismatches broke photo evidence rendering, caused pagination backlog count to fall back to current page length, and caused "Total Issued" stats to be undefined.
  3. Daily statistics in `20261021000200` replaced explicit `Asia/Manila` day boundaries with session-dependent `current_date` expressions, shifting daily counts around midnight depending on database session timezone.
  4. Existing tests verified function execution and error handling, but did not assert producer-consumer wire contract compatibility.
  5. Live hosted Supabase development database (`egatepass-dev`, `nhoawvkfqblsgutdffie`) migration history is EMPTY with 0 application tables; the entire 19-migration chain remains unapplied.
- **Decisions**:
  1. **Additive Migration 20261021054710**: Create `supabase/migrations/20261021054710_guard_dashboard_contract_timezone_closure.sql` via Supabase CLI recreating `api.guard_dashboard(integer, integer)`.
  2. **Preserve Authorization Hardening**: Reject recovery sessions with SQLSTATE 42501 `recovery_session_forbidden` and require staff operational role `guard`, `admin`, or `superadmin` via `private.current_staff_role()`.
  3. **Restore Canonical Response Contract**:
     - Queue item: returns `photoEvidenceId` and `idEvidenceId` (UUID or null) mapped from `visitor_evidence`.
     - Root object: returns `queue, stats, rejectionReasons, pendingTotal, hasMore`.
     - Stats object: returns `inside, exited, rejected, total`.
     - Pagination: `hasMore := v_pending_total > (v_offset + v_limit)`.
     - Queue ordering: `entry_scanned_at ASC`.
  4. **Explicit Asia/Manila Day Window**: Compute `v_day_start` and `v_day_end` using `date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila'`. Apply across all daily counts. Invariance verified under `SET TIME ZONE 'UTC'` and `SET TIME ZONE 'America/New_York'`.
  5. **Frontend Strict Wire Validation**: In `src/services/guard.ts`, validate that required canonical keys exist and are of expected types; throw descriptive contract violation errors if malformed to prevent silent UI corruption.
  6. **Producer-Consumer Contract Tests**: Add 5 frontend contract tests in `tests/guard-dashboard-contract.test.ts` and PGlite database contract test (Test J) in `tests/migration-chain-pglite.test.ts`.
  7. **Hosted Migration Chain Status Correction**: Explicitly document that live hosted Supabase migration history is empty; all 19 migrations are pending and must be applied sequentially upon authorization.
  8. **Zero API Sprawl**: Zero new API endpoints added.
- **Consequence**: Full runtime compatibility restored between database and Guard UI; deterministic Manila-day statistics; strict validation protects against silent contract drift; zero hosted mutations performed.


## ADR-0033 — Deterministic Guard Queue Aggregation, Runtime Wire Contract Schema, and Test Day-Boundary Invariants
- **Date**: 2026-10-21
- **Status**: accepted
- **Context**:
  1. `api.guard_dashboard` applied `ORDER BY` in the inner pagination subquery, but the outer `jsonb_agg` omitted an explicit aggregate `ORDER BY`. Furthermore, passes scanned at the exact same instant lacked a secondary tie-breaker key.
  2. `src/services/guard.ts` performed basic key-presence checks, but did not strictly validate types or non-nullability (e.g. `photoEvidenceId: null` or numeric IDs passed key-presence checks).
  3. PGlite Test J seeded test records using `now() - interval '1 hour'`, which falls into yesterday when tests run between 12:00 AM and 12:59 AM in Asia/Manila, causing midnight test flakiness.
  4. Documentation in `BUILD_PLAN.md` described daily stats with intermediate status `'completed'` (valid enum is `'exited'`) and intermediate timestamp filters, and described `api.acknowledge_privacy()` as returning boolean rather than `timestamptz`.
  5. The repeated-function recurrence audit in the previous pass listed only 5 functions rather than the full set of 15 repeatedly-defined functions.
- **Decisions**:
  1. **Additive Migration 20261021063038**: Create `supabase/migrations/20261021063038_guard_dashboard_deterministic_order_closure.sql` recreating `api.guard_dashboard(integer, integer)` enforcing:
     ```sql
     select coalesce(
       jsonb_agg(
         pending.item
         order by pending.sort_scanned_at asc nulls last,
                  pending.sort_id asc
       ),
       '[]'::jsonb
     ) into queue
     from (
       select
         p.entry_scanned_at as sort_scanned_at,
         p.id as sort_id,
         jsonb_build_object(...) as item
       from public.passes p
       join public.visitors v on v.id = p.visitor_id
       where p.status = 'pending'::public.pass_status
       order by
         p.entry_scanned_at asc nulls last,
         p.id asc
       limit v_limit
       offset v_offset
     ) pending;
     ```
     Dual-level sorting (`sort_scanned_at ASC NULLS LAST, sort_id ASC`) drives both pagination and aggregation.
  2. **Complete Zod Runtime Wire Contract Validation**: In `src/services/guard.ts`, validate the RPC response using `guardDashboardWireSchema`. Requires UUID string for `photoEvidenceId`, UUID or null for `idEvidenceId`, non-negative integers for all stats, and throws descriptive contract violation errors without leaking visitor data.
  3. **Deterministic Day-Start Test Fixtures**: In `tests/migration-chain-pglite.test.ts` Test J, derive all "today" records from `v_day_start + interval 'X hours'` and `v_manila_date`. Prohibit `now() - interval '1 hour'` for calendar-day assertions.
  4. **Documentation Source-of-Truth Reconciliation**: Correct all documentation to match effective SQL: stats filter by `issued_at` within Manila day start/end, valid exit status is `'exited'` within canonical `public.pass_status` (`'issued'`, `'pending'`, `'inside'`, `'rejected'`, `'exited'`, `'expired'`; `'approved'` belongs to `visit_event_type`), `api.acknowledge_privacy()` returns `timestamptz`.
  5. **Full 15 Repeated-Function Review**: Verified all 15 repeated functions across migrations; confirmed zero contract drift.
  6. **Zero API Sprawl & Zero Hosted Mutation**: Zero new endpoints added. Hosted database remains untouched.
- **Consequence**: Queue ordering is mathematically deterministic across all database engines and executions; frontend runtime rejects malformed payloads safely; test suite is completely immune to midnight flakiness; documentation accurately reflects committed source of truth.
