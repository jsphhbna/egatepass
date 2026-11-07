# Reliability Acceptance Closure Ledger
## True PostgreSQL Concurrency, Canonical Approval Integrity & Durable Email Recovery

### 1. Baseline and Context
- **Repository:** `jsphhbna/egatepass`
- **Branch:** `main`
- **Initial Baseline SHA:** `6833cff8e4cdb50dc527b9ed74773cd4e280b954`
- **Production Alias:** `https://egatepass.tech`
- **Supabase Project:** `egatepass-dev` (`nhoawvkfqblsgutdffie`)
- **PostgreSQL Version:** 17.11
- **Vercel Project:** `egatepass`

---

### 2. Files Modified & Reasons for Changes

1. **`server/routes/office/decide.ts`**:
   - Refactored duplicated email-sending and outbox-recording blocks in approval and rejection branches into a unified helper `deliverOfficeEmail`.
   - Guaranteed that when Resend accepts the email (returns a provider message ID), the route attempts a primary write to persist status `sent`.
   - If the primary write fails (transient DB glitch or expired claim lease), executes a bounded fallback write to persist status `reconciliation_required` along with the provider message ID and a sanitized failure reason.
   - If the fallback write also fails, preserves the provider-accepted outcome in the route response (`emailDelivery: { status: 'sent', providerMessageId, error: 'persistence_failed_awaiting_webhook_reconciliation' }`), ensuring callers know the email was sent, and emits a structured non-PII diagnostic log.
   - Strictly prevents overwriting a successful provider dispatch with `failed` or `unknown`.
   - Explicitly checks `{ data, error }` on all outbox queries and RPC calls.

2. **`server/routes/office/visits.ts`**:
   - Added explicit error inspection on the `office_visit_email_outbox` query.
   - When the outbox lookup fails, sets `effectiveEmailStatus = 'unavailable'` and `effectiveConfirmationSource = null` rather than silently displaying stale fallback data from `office_visits.email_delivery_status`.
   - Emits a warning `outbox_lookup_failed` and `emailStatusDegraded: true` in the API response.

3. **`supabase/migrations/20261107081936_email_recovery_and_webhook_reconciliation.sql` (Migration 67)**:
   - Recreates `api.claim_office_visit_email_for_delivery` to block claiming rows in `reconciliation_required`.
   - Recreates `api.record_office_visit_email_result` returning `jsonb`, allowing `reconciliation_required` even if the claim lease expired.
   - Recreates `api.record_resend_delivery_event` so that an authenticated, correlated `email.sent` webhook event transitions outbox records in `('pending', 'processing', 'unknown', 'reconciliation_required')` to `sent`.

4. **`supabase/migrations/20261107084036_decide_office_visit_column_resolution.sql` (Migration 68)**:
   - Reconciles `api.decide_office_visit` vehicle photo evidence column resolution, replacing invalid references to `upload_intents.byte_size` and `upload_intents.sha256_hex` with `target_visit.vehicle_photo_bytes` and `target_visit.vehicle_photo_sha256`.
   - Resolves remote Supabase linter error and ensures fail-closed evidence validation.

5. **`tests/postgres-concurrency.test.ts`**:
   - Implemented independent-session PostgreSQL 17 concurrency and recovery test suite.
   - Uses coordinated start barriers (`createBarrier`) to release multiple independent `pg.Client` sessions simultaneously.
   - Covers:
     - Scenario 1 (Actor limit): 10 concurrent requests -> exactly 5 accepted, 5 rejected with `too_many_actor_requests`.
     - Scenario 2 (Normalized email limit): 10 concurrent requests with case variants -> exactly 5 accepted, 5 rejected with `too_many_email_requests`.
     - Scenario 3 (IP HMAC limit): 20 concurrent requests -> exactly 15 accepted, 5 rejected with `too_many_ip_requests`.
     - Scenario 4 (Overlapping lock dimensions): 12 concurrent requests -> zero deadlocks, all complete within bounded timeout.
     - Database-level approval race: 2 concurrent sessions propose different tokens -> single canonical pass created, single outbox row, canonical token matches pass token digest, concurrent claim allows only 1 active claim.
     - Route-level approval race: 2 concurrent requests to `/api/office/decide` -> provider mock called at most once, QR PNG decoded using `pngjs` + `jsQR`, decoded string matches canonical token and passes SHA-256 digest check.
     - Fault-injection & recovery cases 1–10: Resend acceptance with primary write failure -> fallback to `reconciliation_required`; webhook reconciliation (`email.sent` -> `sent`, `email.delivered` -> `delivered`); late failure cannot regress delivered state; duplicate webhooks handled idempotently.

6. **`package.json` & `package-lock.json`**:
   - Added `"test:integration:postgres": "vitest run tests/postgres-concurrency.test.ts"`.
   - Installed `pg` and `@types/pg` devDependencies.

7. **`.github/workflows/ci.yml`**:
   - Added PostgreSQL 17 service container (`services.postgres`, image `postgres:17`) with health checks.
   - Added `Run PostgreSQL Concurrency & Recovery Integration Tests` step running `npm run test:integration:postgres`.

8. **`tests/migration-chain-pglite.test.ts`**:
   - Updated migration count to 68.
   - Added contract tests `X` (Migration 67) and `Y` (Migration 68).

---

### 3. Remote Database Migration Synchronization
- Remote Supabase project: `egatepass-dev` (`nhoawvkfqblsgutdffie`).
- Total migrations in chain: 68.
- Migrations 67 and 68 applied to remote Supabase via `npx supabase db push --remote --yes`.
- Remote migration status: `Remote database is up to date` (all 68 migrations synchronized).
- Remote Supabase linter (`npx supabase db lint --linked`): 0 errors across all schemas (`api`, `extensions`, `private`, `public`).

---

### 4. Verification Evidence Matrix
| Verification Gate | Command | Result |
| :--- | :--- | :--- |
| TypeScript Server & API | `npm run typecheck:api` | **PASS** (0 errors) |
| Architecture & Migration Contracts | `npm run test:contracts` | **PASS** (25/25 passed) |
| Documentation & Mermaid Truthfulness | `npm run test:docs` | **PASS** (37/37 passed) |
| PGlite Migration Chain (1–68) | `npm run test:migrations` | **PASS** (38/38 passed) |
| Unit & Integration Suite | `npm run test:unit` | **PASS** |
| Production Frontend Build | `npm run build` | **PASS** (Vite build in 5.91s) |
| Remote Supabase Synchronization | `npx supabase migration list --remote` | **PASS** (68/68 applied) |
| Remote Database Linter | `npx supabase db lint --linked` | **PASS** (0 errors) |
| Physical Function Ceiling | Directory inspection (`api/`) | **PASS** (Exactly 6 entrypoints) |
