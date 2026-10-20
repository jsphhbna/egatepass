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
