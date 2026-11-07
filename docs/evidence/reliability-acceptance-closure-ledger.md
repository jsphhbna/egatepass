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

9. **`server/privilege-contract.ts`**:
   - Registered `server/lib/officeDelivery.ts` direct table access to `office_visit_email_outbox` for failure outbox claim lookup under the authoritative service-role table privilege contract.

10. **`tests/postgres-concurrency.test.ts`**:
    - Concurrency synchronization barrier (`createBarrier`) executing across independent `pg.Client` sessions.
    - Route-level approval test unconditionally asserts mock provider dispatch count of exactly 1 (`expect(dispatchedEmails.length).toBe(1)`).
    - Unconditionally decodes QR PNG via `pngjs` + `jsQR`, verifies decrypted token matches canonical outbox decrypted token, and SHA-256 digest matches stored pass `token_digest`.
    - Asserts second concurrent request cannot create a second pass (`pass_count === 1`).
    - Normalized all test UUIDs to strict RFC 4122 v4 format compatible with Zod request validation and aligned `public.passes` test insertion schema (`source = 'portal'`, `status = 'issued'`, `public_reference = gen_random_uuid()`).
    - Regression suites:
      - Expired-lease protection & webhook correlation backfill.
      - Approval retry fault injection (primary write fails, fallback to `reconciliation_required`).
      - Rejection retry fault injection (primary write fails, fallback to `reconciliation_required`).
      - Both-write failure preserves provider acceptance, dispatches only once, and blocks subsequent claim.
      - Strict positive confirmation unit tests (`isPositiveRpcSuccess`).

11. **`tests/office-email-outbox-and-webhooks.test.ts`**:
    - Updated Test 4 to assert that expired leases transition to `reconciliation_required` and require `permit_retry` before re-claiming.

12. **`tests/migration-chain-pglite.test.ts`**:
    - Updated migration count to 70 across 10 test assertions.
    - Added Test `Z. Migration 69 contract: Expired lease transition to reconciliation required and truthful claim invariants`.
    - Added Test `AA. Migration 70 contract: Office email auth, canonical lock ordering, and retry state-machine closure`.

13. **`supabase/migrations/20261107223000_office_email_auth_and_retry_state_machine.sql` (Migration 70)**:
    - **Canonical Lock Ordering**: Enforces strict lock hierarchy across `office_visits` (FOR UPDATE first) and `office_visit_email_outbox` (FOR UPDATE second) in all mutation RPCs (`api.claim_office_visit_email_for_delivery`, `api.reconcile_office_visit_email`, `api.record_office_visit_email_result`, `api.record_resend_delivery_event`), mathematically eliminating deadlock inversions (`40P01`).
    - **Strict State Transitions & Mandatory Audit Note**: Recreates `api.reconcile_office_visit_email` such that `permit_retry` strictly accepts only rows in `('failed', 'unknown', 'reconciliation_required')`, explicitly rejecting `pending`, active `processing`, `sent`, and unrecognized states (`only_for_unknown_or_failed` / 40900), and `delivered` (`email_already_delivered` / 40900). Enforces mandatory non-empty trimmed note of >= 3 characters (`char_length(btrim(requested_note)) >= 3`). Records full audit trail in `office_visit_events` with actor, prior state, new state, and note.
    - **Outbox RLS Lifecycle Enforcement**: Replaces `outbox_staff_read` policy to evaluate `private.current_staff_role()`, ensuring only active staff accounts with confirmed email, completed password change, accepted privacy consent, non-recovery session, and matching office assignment can read outbox records. Global read granted to admin/superadmin roles; service role access preserved.

14. **`server/routes/office/retry-email.ts`**:
    - Enforces Zod `.superRefine` requiring a trimmed note of at least 3 characters for `permit_retry` and `mark_delivered` before dispatching RPC.
    - Aligns route error responses with database error messages: `only_for_unknown_or_failed` (400), `already_delivered` (409), `reconciliation_note_required` (400), and database error code `40900` (409).

15. **`tests/postgres-concurrency.test.ts` (Findings D, E, F)**:
    - Added **Finding D**: State-Transition & Audit-Note Closure (`api.reconcile_office_visit_email`): tests asserting rejection of `pending`, active `processing`, `sent`, and `delivered` rows, rejection of short/empty notes, and allowed transitions for `failed`, `unknown`, and `reconciliation_required` with valid notes.
    - Added **Finding E**: Canonical Lock Ordering & Independent-Session Concurrency Races: barrier-synchronized races between concurrent delivery claim and staff permit_retry, and concurrent delivery claim and provider webhook reconciliation.
    - Added **Finding F**: Outbox RLS Full Staff Lifecycle Enforcement Matrix: verifies all 9 required identity lifecycle states against live RLS.

---

### 3. Remote Database Migration Synchronization
- Remote Supabase project: `egatepass-dev` (`nhoawvkfqblsgutdffie`).
- Total migrations in chain: 70.
- Migration 70 (`20261107223000_office_email_auth_and_retry_state_machine.sql`) applied to remote Supabase via `npx supabase db push --linked --yes`.
- Remote migration status: `Remote database is up to date` (all 70 migrations synchronized).
- Remote Supabase linter (`npx supabase db lint --linked`): 0 errors across all schemas (`api`, `extensions`, `private`, `public`).

---

### 4. Verification Evidence Matrix
| Verification Gate | Command | Result |
| :--- | :--- | :--- |
| TypeScript Server & API | `npm run typecheck:api` | **PASS** (0 errors) |
| Architecture & Migration Contracts | `npm run test:contracts` | **PASS** (25/25 passed) |
| Documentation & Mermaid Truthfulness | `npm run test:docs` | **PASS** (37/37 passed) |
| PGlite Migration Chain (1–70) | `npx vitest run tests/migration-chain-pglite.test.ts` | **PASS** (40/40 passed) |
| Complete Unit Test Suite | `npm run test:unit` | **PASS** (167 files passed, 1995 passed) |
| Production Frontend Build | `npm run build` | **PASS** (Vite build in 9.68s) |
| Remote Supabase Synchronization | `npx supabase migration list --linked` | **PASS** (70/70 applied) |
| Remote Database Linter | `npx supabase db lint --linked` | **PASS** (0 errors) |
| Physical Function Ceiling | Directory inspection (`api/`) | **PASS** (Exactly 6 entrypoints) |
