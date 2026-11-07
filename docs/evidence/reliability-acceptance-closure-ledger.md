# Reliability Acceptance Closure Ledger
## True PostgreSQL Concurrency, Canonical Approval Integrity & Durable Email Recovery

### 1. Baseline and Context
- **Repository:** `jsphhbna/egatepass`
- **Branch:** `main`
- **Initial Baseline SHA:** `6833cff8e4cdb50dc527b9ed74773cd4e280b954`
- **Intermediate Baseline SHA:** `baa3c28990c91a717fc93313a5f355125838b781`
- **Production Alias:** `https://egatepass.tech`
- **Supabase Project:** `egatepass-dev` (`nhoawvkfqblsgutdffie`)
- **PostgreSQL Version:** 17.11
- **Vercel Project:** `egatepass`
- **Total Migrations:** 69

---

### 2. Files Modified & Reasons for Changes

1. **`server/lib/officeDelivery.ts` (New)**:
   - Unified email delivery and persistence engine for office visits (`deliverOfficeEmail`).
   - Implements strict positive confirmation validation (`isPositiveRpcSuccess`) ensuring database responses contain `ok === true` without error before acknowledging persistence.
   - When Resend accepts the email dispatch (returns a provider message ID), executes a primary write to persist status `sent`.
   - On primary write failure (transient connection drop or expired claim lease), executes a bounded fallback write to persist status `reconciliation_required` alongside provider message ID and a sanitized error message.
   - On double write failure, preserves provider acceptance outcome in the API response (`ok: true, status: 'sent', reconciliationRequired: true`) without creating duplicate passes, duplicate outbox rows, or emitting duplicate emails on subsequent retries.
   - Emits structured non-PII diagnostic logs.

2. **`server/routes/office/decide.ts`**:
   - Replaced duplicated approval and rejection email-dispatch code with calls to `deliverOfficeEmail`.
   - Enforced strict positive confirmation verification on `decide_office_visit` RPC responses (`isPositiveRpcSuccess`).
   - Preserves canonical pass token and outbox association without double-dispatch.

3. **`server/routes/office/retry-email.ts`**:
   - Replaced duplicate email dispatch and direct database update with `deliverOfficeEmail`.
   - Replaced relaxed validation with strict positive confirmation (`isPositiveRpcSuccess`) on `api.reconcile_office_visit_email`.
   - Preserves provider acceptance with `reconciliationRequired: true` when database writes fail, preventing subsequent duplicate dispatches.

4. **`server/routes/office/visits.ts`**:
   - Added explicit error inspection on the `office_visit_email_outbox` query.
   - When the outbox lookup fails, sets `effectiveEmailStatus = 'unavailable'` and `effectiveConfirmationSource = null` rather than silently displaying stale fallback data from `office_visits.email_delivery_status`.
   - Emits a warning `outbox_lookup_failed` and `emailStatusDegraded: true` in the API response.

5. **`supabase/migrations/20261107203500_expired_lease_and_retry_reconciliation.sql` (Migration 69)**:
   - **Expired Lease Protection in `api.claim_office_visit_email_for_delivery`**:
     - When an outbox row is in `processing` status and its lease has expired (`lease_expires_at <= now()`), it is transactionally transitioned to `reconciliation_required` in `office_visit_email_outbox`, sets `office_visits.email_delivery_status = 'reconciliation_required'`, logs an `email.lease_expired_reconciliation_required` event in `audit_events`, and returns a single row with `claim_id = null`.
     - Because it returns rather than raises an exception, the PostgreSQL transaction commits the state transition.
     - Subsequent calls to claim the row encounter `delivery_status in ('unknown', 'reconciliation_required')` and are cleanly rejected with `email_delivery_outcome_unknown_reconciliation_required`.
   - **Manual Reconciliation Support in `api.reconcile_office_visit_email`**:
     - Supports `permit_retry` action for staff, resetting `reconciliation_required` / `unknown` rows to `pending` with cleared `claim_id`, reset lease, and preserved failure reason history so staff can safely retry delivery after investigation.
   - **Correlation Backfill in `api.record_resend_delivery_event`**:
     - Supports correlating inbound Resend webhooks by `outbox_id` (`requested_outbox_id = id`) even when `provider_message_id` was previously null on the outbox row (due to initial write timeout following provider acceptance), automatically backfilling `provider_message_id = requested_email_id`.

6. **`supabase/migrations/20261107081936_email_recovery_and_webhook_reconciliation.sql` (Migration 67)**:
   - Recreates `api.claim_office_visit_email_for_delivery` to block claiming rows in `reconciliation_required`.
   - Recreates `api.record_office_visit_email_result` returning `jsonb`, allowing `reconciliation_required` even if the claim lease expired.
   - Recreates `api.record_resend_delivery_event` so that an authenticated, correlated `email.sent` webhook event transitions outbox records in `('pending', 'processing', 'unknown', 'reconciliation_required')` to `sent`.

7. **`supabase/migrations/20261107084036_decide_office_visit_column_resolution.sql` (Migration 68)**:
   - Reconciles `api.decide_office_visit` vehicle photo evidence column resolution, replacing invalid references to `upload_intents.byte_size` and `upload_intents.sha256_hex` with `target_visit.vehicle_photo_bytes` and `target_visit.vehicle_photo_sha256`.
   - Resolves remote Supabase linter error and ensures fail-closed evidence validation.

8. **`tests/postgres-concurrency.test.ts`**:
   - Concurrency synchronization barrier (`createBarrier`) executing across independent `pg.Client` sessions.
   - Route-level approval test unconditionally asserts mock provider dispatch count of exactly 1 (`expect(dispatchedEmails.length).toBe(1)`).
   - Unconditionally decodes QR PNG via `pngjs` + `jsQR`, verifies decrypted token matches canonical outbox decrypted token, and SHA-256 digest matches stored pass `token_digest`.
   - Asserts second concurrent request cannot create a second pass (`pass_count === 1`).
   - Regression suites:
     - Expired-lease protection & webhook correlation backfill.
     - Approval retry fault injection (primary write fails, fallback to `reconciliation_required`).
     - Rejection retry fault injection (primary write fails, fallback to `reconciliation_required`).
     - Both-write failure preserves provider acceptance, dispatches only once, and blocks subsequent claim.
     - Strict positive confirmation unit tests (`isPositiveRpcSuccess`).

9. **`tests/office-email-outbox-and-webhooks.test.ts`**:
   - Updated Test 4 to assert that expired leases transition to `reconciliation_required` and require `permit_retry` before re-claiming.

10. **`tests/migration-chain-pglite.test.ts`**:
    - Updated migration count to 69 across 10 test assertions.
    - Added Test `Z. Migration 69 contract: Expired lease transition to reconciliation required and truthful claim invariants`.

---

### 3. Remote Database Migration Synchronization
- Remote Supabase project: `egatepass-dev` (`nhoawvkfqblsgutdffie`).
- Total migrations in chain: 69.
- Migration 69 (`20261107203500_expired_lease_and_retry_reconciliation.sql`) applied to remote Supabase via `npx supabase db push --linked --yes`.
- Remote migration status: `Remote database is up to date` (all 69 migrations synchronized).
- Remote Supabase linter (`npx supabase db lint --linked`): 0 errors across all schemas (`api`, `extensions`, `private`, `public`).

---

### 4. Verification Evidence Matrix
| Verification Gate | Command | Result |
| :--- | :--- | :--- |
| TypeScript Server & API | `npm run typecheck:api` | **PASS** (0 errors) |
| Architecture & Migration Contracts | `npm run test:contracts` | **PASS** (25/25 passed) |
| Documentation & Mermaid Truthfulness | `npm run test:docs` | **PASS** (37/37 passed) |
| PGlite Migration Chain (1–69) | `npm run test:migrations` | **PASS** (39/39 passed) |
| Office Outbox & Webhooks Suite | `npx vitest run tests/office-email-outbox-and-webhooks.test.ts` | **PASS** (10/10 passed) |
| Production Frontend Build | `npm run build` | **PASS** (Vite build in 9.12s) |
| Remote Supabase Synchronization | `npx supabase migration list --linked` | **PASS** (69/69 applied) |
| Remote Database Linter | `npx supabase db lint --linked` | **PASS** (0 errors) |
| Physical Function Ceiling | Directory inspection (`api/`) | **PASS** (Exactly 6 entrypoints) |
