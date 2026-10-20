# Audit and Reconciliation Policy

## Log domains

- `visitLogs` records operational visitor and gate events. Guards and administrators may read these records.
- `auditLogs` records administrative and system actions. Administrators and Super Admins may read these records.
- `reconciliationTasks` records unresolved partial operations. It is never readable or writable directly from a browser. Only a Super Admin may retrieve a bounded, sanitized, read-only list through `/api/reconciliation-items`.

All three collections reject direct client writes. Trusted backend functions are the only mutation path.

## Administrative audit schema

New administrative records use these fields:

- `action`
- `actorUid` and `actorRole`
- `targetType`, `targetId`, and optional `targetUid`
- optional `previousRole`, `newRole`, `previousStatus`, and `newStatus`
- `result`: `pending`, `success`, `failure`, or `partial`
- server-authored `timestamp`
- optional `metadata` containing only bounded, non-secret operational context

Passwords, bearer tokens, session tokens, signing material, Cloudinary credentials, and raw authorization headers must never be written to any log.

## Success and failure policy

When an action consists only of Firestore changes, its audit record is written in the same transaction or batch as the protected change. A transaction failure therefore leaves neither the change nor a misleading success record.

When Firebase Auth, Cloudinary, or another external system makes a Firestore transaction impossible:

1. validate authorization, input, and known preconditions before mutation;
2. create a `pending` audit record with the reversible Firestore preparation where applicable;
3. perform the external mutation;
4. deterministically restore reversible state if the external mutation fails;
5. mark the audit `success`, `failure`, or `partial`; and
6. create a server-only reconciliation task when the final state cannot be proven consistent.

An irreversible password change is never described as rolled back. If later finalization or token revocation fails, the response identifies that reconciliation is required and the task tells the operator to treat the new password as effective.

Expected validation failures and unauthorized attempts are returned safely and logged through server diagnostics, not persisted in `auditLogs`. This avoids turning an attacker-controlled request stream into durable audit noise. Failures are persisted when a trusted mutation began, a destructive external action completed, or manual reconciliation may be required.

## Reconciliation operations

The Milestone D interface is deliberately read-only. It returns at most 50 unresolved items and exposes only a safe description, affected resource identifier, creation time, and bounded action checklist. Resolving a task requires investigation of the authoritative systems and a future backend-only resolution workflow; no browser-side mutation or public bootstrap endpoint exists.
