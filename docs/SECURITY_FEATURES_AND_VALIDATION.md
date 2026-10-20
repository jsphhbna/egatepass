# E-GatePass Security Features and Validation

## Purpose

This is a practical guide for school evaluators, advisers, and future school IT maintainers. It explains the major security controls in E-GatePass, why they exist, how they work, and what was actually validated for the audited application commit `ffa1cbb2c0960aada1947cadb05acd486baf918d`.

It describes an internal application review, not an external security certification. The companion [Internal Security Audit Certificate](SECURITY_AUDIT_CERTIFICATE.md) contains the formal scope and evidence table; [Audit Findings](SECURITY_AUDIT_FINDINGS.md) retains the historical remediation record.

## Authentication

### Security Feature

Firebase Authentication with verified, active identities.

### What It Protects

It prevents an unauthenticated, inactive, or incorrectly classified account from acting as staff or a registered device.

### How It Works

The application identifies a caller through Firebase Auth, then the backend resolves the caller's UID against the current Firestore user or device record. Client-side page visibility is only a convenience; the server performs the security decision.

### How We Validated It

Firebase emulator tests cover authenticated, anonymous, staff, device, and invalid callers. The code path was reviewed in `src/hooks/useAuth.tsx` and `netlify/functions/utils/auth.ts`.

### Evidence

`tests/firestore.rules.test.ts`; 238/238 emulator tests passed; [Firebase Authentication documentation](https://firebase.google.com/docs/auth).

## Role-Based Access Control

### Security Feature

Separate Guard, Admin, and Super Admin permissions.

### What It Protects

It limits everyday operational access and reserves security-sensitive actions for Super Admins.

### How It Works

Functions re-check the caller's current role and active state. Regular Admins cannot promote users to Super Admin, and the final active Super Admin cannot be removed or demoted by mistake.

### How We Validated It

Rules/emulator tests exercise role-scoped access, and `netlify/functions/update-user.ts` was reviewed for allowed transitions and final-active-Super-Admin protection.

### Evidence

`netlify/functions/utils/auth.ts`, `netlify/functions/update-user.ts`, `tests/firestore.rules.test.ts`.

## Server-Side Authorization

### Security Feature

Sensitive changes are processed by Netlify Functions, not trusted browser writes.

### What It Protects

It prevents a modified client interface from assigning roles, changing pass state, altering retention policies, or invoking destructive operations directly.

### How It Works

Protected Functions verify Firebase ID tokens and read current Firestore records before they act. They validate request bodies and use transactions or reconciliation records where multiple systems are involved.

### How We Validated It

The emulator suite rejects direct forged writes; production protected-endpoint probes returned expected unauthenticated denials.

### Evidence

`firestore.rules`, `netlify/functions/create-pass.ts`, `netlify/functions/decide-visit.ts`, `netlify/functions/scan-pass.ts`.

## Firestore Security Rules

### Security Feature

Default-deny Firestore Rules with role-scoped reads and server-only security collections.

### What It Protects

It stops client code from fabricating audit logs, reconciliation records, image upload ownership, rate-limit state, or privileged mutations.

### How It Works

`firestore.rules` allows only the documented operational reads. `auditLogs`, `reconciliationTasks`, `imageUploads`, `rateLimits`, and maintenance state remain server-authored.

### How We Validated It

Firestore emulator Rules tests cover allow/deny behavior for visitors, staff, devices, audit records, and server-only collections.

### Evidence

`firestore.rules`, `tests/firestore.rules.test.ts`, [Firestore Security Rules documentation](https://firebase.google.com/docs/firestore/security/get-started).

## Super Admin Protections

### Security Feature

Super Admin-only controls for role changes, device credentials/deletion, retention policy, image purge, migration, and reconciliation review.

### What It Protects

It prevents ordinary operational administrators from making high-impact security or lifecycle changes.

### How It Works

The backend requires the Super Admin role for these functions and writes administrative audit information. The bootstrap procedure is manual and has no public endpoint.

### How We Validated It

Role and reconciliation endpoint tests verify the distinction between Admin and Super Admin; the production legacy-image migration required a real Super Admin session.

### Evidence

`netlify/functions/migrate-image-delivery.ts`, `netlify/functions/reconciliation-items.ts`, `docs/SUPER_ADMIN_BOOTSTRAP.md`.

## Device Security

### Security Feature

Server-managed scanner and kiosk device accounts.

### What It Protects

It prevents a browser from inventing a scanner identity or changing a device's gate/type/active status.

### How It Works

Device creation, credential replacement, revocation, and deletion run through protected Functions. Entry and exit scanning derives the device type and gate from server records. Multi-system failures are auditable and reconciled where possible.

### How We Validated It

Emulator tests cover gate binding, type restrictions, invalid scans, and device authorization; lifecycle functions were code-reviewed.

### Evidence

`netlify/functions/scan-pass.ts`, `netlify/functions/delete-device.ts`, `netlify/functions/update-device-auth.ts`, `tests/firestore.rules.test.ts`.

## Anonymous Abuse Protection / Rate Limiting

### Security Feature

Temporary server-side anti-spam state in `rateLimits`.

### What It Protects

It limits bursts of upload-sign and visitor pass-creation requests without treating the browser as a trusted enforcement point.

### How It Works

The backend records fixed-window state by user and a hashed address bucket, returns HTTP 429 when a limit is exceeded, and does not keep a raw address in the rate-limit document. Expired entries are removed in bounded batches by scheduled maintenance. Firestore TTL was deliberately not used, so the design remains free-tier compatible.

### How We Validated It

Focused tests verify normal limits, separate identities, no raw-address storage, 55-record bounded cleanup progression, active-window preservation, and idempotent repeated cleanup.

### Evidence

`netlify/functions/utils/rate-limit.ts`, `netlify/functions/utils/retention-maintenance.ts`, `tests/firestore.rules.test.ts`.

## Cloudinary Image Security

### Security Feature

Authenticated Cloudinary delivery with an authorized backend image proxy.

### What It Protects

It prevents a public Cloudinary asset identifier alone from being enough to retrieve a sensitive visitor image.

### How It Works

New uploads use Cloudinary `authenticated` delivery. `/api/image` checks the caller's staff role and a permitted Firestore reference, fetches a signed asset server-side, and returns image bytes. The browser does not receive `CLOUDINARY_API_SECRET` or a reusable signed Cloudinary URL.

### How We Validated It

The emulator verifies authenticated image metadata and proxy behavior. In production, the authorized proxy returned HTTP 200 and `image/webp`; the former unsigned path was checked after migration and returned HTTP 404.

### Evidence

`netlify/functions/cloudinary-sign.ts`, `netlify/functions/image.ts`, `netlify/functions/utils/image-security.ts`, [Cloudinary media access control](https://cloudinary.com/documentation/control_access_to_media).

## Legacy Image Migration

### Security Feature

A bounded, Super Admin-only migration for historical Cloudinary assets that were created before authenticated delivery was introduced.

### What It Protects

It removes the remaining public-delivery exposure without mass-editing unrelated Cloudinary assets.

### How It Works

The migration supports a non-mutating dry run, requires an exact confirmation for live work, scans at most five visitors per batch, converts only legacy `upload` assets to `authenticated`, updates bounded pass references, audits the result, and records reconciliation work on a partial failure.

### How We Validated It

Production evidence: dry-run scanned one visitor and found two legacy images; the live batch migrated two, with zero failures, zero reconciliation, and no continuation cursor. The migration administrative audit recorded success. The protected reconciliation list was empty. Authorized image access returned HTTP 200/image-webp, while the old unsigned `image/upload` request returned HTTP 404.

### Evidence

`netlify/functions/migrate-image-delivery.ts`; production migration/audit/reconciliation results recorded in [Audit Findings](SECURITY_AUDIT_FINDINGS.md).

## Pass-Aware Image Retention

### Security Feature

Images stay available while an active or future-valid pass needs them, then return to the normal retention policy when the pass is closed.

### What It Protects

It avoids deleting a required image before staff can safely complete the visit workflow, without retaining images forever.

### How It Works

Image expiry has a base policy and an effective deadline. Creation and pass transitions maintain the protection window; rejected, exited, or expired records return to ordinary retention behavior.

### How We Validated It

Emulator tests cover active/future pass protection and later purge eligibility.

### Evidence

`netlify/functions/utils/image-lifecycle.ts`, `netlify/functions/create-pass.ts`, `tests/firestore.rules.test.ts`.

## Retention and Scheduled Cleanup

### Security Feature

Configurable visitor, image, audit, and resolved-reconciliation retention with daily bounded maintenance.

### What It Protects

It reduces long-lived data while preserving active visits, unresolved reconciliation work, and security-sensitive history.

### How It Works

`retention-cleanup` runs at `@daily`, reads the configured policy, and processes bounded pages. It does not automatically delete protected security events, pending reconciliation, or active pass data.

### How We Validated It

Retention/purge tests passed; production deploy metadata confirms the daily function registration and the Firestore index is READY. No destructive production cleanup was run merely for testing.

### Evidence

`netlify/functions/retention-cleanup.ts`, `netlify/functions/utils/retention-maintenance.ts`, `docs/OPERATIONS.md`, [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/).

## Cleanup Reliability

### Security Feature

Cursor-driven, bounded, retry-safe cleanup.

### What It Protects

It prevents an old blocked record from permanently starving later eligible records and keeps scheduled work within bounded execution.

### How It Works

Each cleanup category stores a deterministic cursor. Pages advance on completed scans, preserve protected records, and capture external-operation failures as reconciliation tasks instead of falsely reporting completion.

### How We Validated It

The emulator suite includes cleanup progression, protection, and repeated-run idempotency checks, including the 55-record rate-limit cleanup case.

### Evidence

`netlify/functions/utils/retention-maintenance.ts`, `netlify/functions/purge-images.ts`, `tests/firestore.rules.test.ts`.

## Reconciliation System

### Security Feature

Server-only records for operations that cannot be made fully atomic across Firebase Auth, Firestore, and Cloudinary.

### What It Protects

It prevents partial external operations from becoming invisible operational failures.

### How It Works

Functions create a pending reconciliation task with a specific reference and follow-up action when an external operation cannot be safely finalized. Direct Firestore access is denied; a Super Admin has a protected, bounded, read-only view.

### How We Validated It

Rules and Function tests verify server-only writes and Super Admin-only retrieval. The production migration ended with zero unresolved reconciliation items.

### Evidence

`netlify/functions/utils/reconciliation.ts`, `netlify/functions/reconciliation-items.ts`, `firestore.rules`.

## Audit Logging

### Security Feature

Separate operational visit logs and administrative/security audit records.

### What It Protects

It preserves a trustworthy record of sensitive actions without allowing browser clients to forge history.

### How It Works

Protected Functions write administrative events for important lifecycle operations. Firestore Rules make `auditLogs` immutable and server-authored.

### How We Validated It

Rules tests deny client audit writes. The production migration audit displayed a successful `image delivery migration` action performed by a Super Admin.

### Evidence

`netlify/functions/utils/audit.ts`, `firestore.rules`, `docs/AUDIT_POLICY.md`.

## Secrets Management

### Security Feature

Server-only Firebase Admin, Cloudinary, and scheduled-cleanup secrets.

### What It Protects

It stops browser code and source control from receiving destructive credentials.

### How It Works

Only public Firebase client configuration uses `VITE_*`. `FIREBASE_PRIVATE_KEY`, `CLOUDINARY_API_SECRET`, and `CRON_SECRET` are Netlify server environment values. Secret scan exclusions are narrowly limited to confirmed public values.

### How We Validated It

`.env.example` contains names/placeholders only; `netlify.toml` contains no secret values; hosted Netlify secret scanning passed. Secret values were not printed or retrieved.

### Evidence

`.env.example`, `netlify.toml`, `docs/ENVIRONMENT_AND_CRON.md`.

## Production Deployment Safety

### Security Feature

Controlled GitHub `main` to Netlify production deployment with separate Firestore index deployment and rollback awareness.

### What It Protects

It limits release changes, avoids speculative fixes in production, and keeps application rollback separate from irreversible external operations.

### How It Works

The audited application deploy is immutable. Firestore indexes/rules are reviewed/deployed separately. Production verification uses safe requests and logs rather than destructive cleanup tests.

### How We Validated It

The production deploy is ready, 19 Functions run on Node 24, hosted secret scanning passed, and no `ERR_REQUIRE_ESM` or configuration error was found in the reviewed logs.

### Evidence

Netlify deploy `6ac3be488913450008db6a2f`, `netlify.toml`, [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/).

## Validation Snapshot

- 238/238 Firebase emulator tests passed.
- Frontend TypeScript passed.
- Functions TypeScript passed.
- Vite production build passed.
- Netlify production-equivalent build passed.
- `git diff --check` passed for the audited release.
- Firestore index is READY.
- Hosted Netlify secret scan passed.
- 19 Functions deployed on Node 24.
- Scheduled retention function is registered at `@daily`.
- `/api/image` returned HTTP 200 for the migrated image; `Content-Type` was `image/webp`.
- The legacy unsigned Cloudinary upload URL returned HTTP 404.
- The reconciliation endpoint returned count 0.
- The migration administrative audit result was success.
- H-1 through H-5 are FIXED.

## Security Feature Matrix

| Security Area | Protection | Validation | Production Evidence |
|---|---|---|---|
| Authentication | Verified active identity | Emulator/RBAC tests | Protected Functions reject unauthenticated requests |
| RBAC | Guard/Admin/Super Admin separation | Rules and Function tests | Super Admin completed controlled migration |
| Firestore Rules | Default deny and server-only records | Emulator Rules suite | Audited release configuration |
| Device management | Server-managed device lifecycle | Scanner/device tests | Deployed protected Functions |
| Rate limiting | Server-side temporary anti-spam state | Focused rate-limit/cleanup tests | Deployed release; no TTL dependency |
| Image delivery | Authenticated assets through proxy | Image proxy/migration tests | HTTP 200 image-webp; unsigned legacy URL HTTP 404 |
| Legacy migration | Bounded, audited conversion | Emulator migration tests | 2/2 migrated; zero failure/reconciliation |
| Retention | Configurable, protected cleanup | Retention/purge tests | READY index and daily function registered |
| Cleanup progression | Cursor-driven and idempotent pages | 55-record progression/repeat tests | Deployed maintenance implementation |
| Reconciliation | Visible, server-only partial-failure record | Rules/endpoint tests | Migration list count 0 |
| Audit logging | Immutable administrative history | Rules tests | Migration audit success |
| Secrets | Server-only credentials and narrow scanner exclusions | Template/config review | Hosted secret scan passed |
| Deployment | Immutable reviewed production release | Build and log review | Ready deploy, Node 24, 19 Functions |

## What This Validation Does Not Claim

- It is not an external penetration test.
- It is not ISO certification.
- It is not SOC 2 certification.
- It is not government certification.
- It is not legal compliance certification.
- It is not proof of zero vulnerabilities.
- It is not a replacement for future maintenance, security updates, monitoring, or periodic review.

Privacy controls were designed with data minimization, restricted access, and retention in mind; they should not be read as a legal compliance determination. For broader privacy principles, see the [National Privacy Commission IRR for Republic Act No. 10173](https://privacy.gov.ph/implementing-rules-regulations-data-privacy-act-2012/).

## For School IT / Future Maintainers

- Preserve the Firebase Auth UID to `users/{uid}` or `devices/{uid}` mapping.
- Use the normal administrative interface for role changes after bootstrap, and keep at least one active Super Admin.
- Never expose Netlify server secrets or add them to `VITE_*` variables.
- Do not manually delete Cloudinary assets outside documented server-side workflows.
- Review Super Admin reconciliation items and scheduled-cleanup logs routinely.
- Review retention settings before changing policy; keep the required Firestore indexes deployed.
- Retain server-side rate limiting and do not re-enable public image delivery.
- Follow [Clean Data Handoff](CLEAN_DATA_HANDOFF.md) and [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md) before production turnover.
