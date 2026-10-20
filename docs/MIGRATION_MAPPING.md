# Firebase/Netlify/Cloudinary to Supabase/Vercel/Resend Mapping

This is a planning inventory, not proof that the target exists. Canonical SQL will live in versioned `supabase/migrations/`; no schema is to be copied from this document by hand.

## Data and identity

| Original | Current purpose | Target counterpart | Mandatory controls/evidence |
|---|---|---|---|
| Firebase Auth anonymous | Guest registration owner | Supabase anonymous Auth user | Own-intent/own-pass only; no staff/device privilege; session collision tests |
| Firebase Auth staff + `users/{uid}` | Guard/Admin/Super Admin profile, active/verified/first-login | `auth.users` + protected `staff_profiles` | Verified email, suspension, role RPCs, last-SA constraints/tests |
| Firebase Auth devices + `devices/{uid}` | Kiosk/entry/exit identity, gate, status | `auth.users` + protected `devices`/gate assignment | Actual identity before success; revocation checked on next query/RPC |
| `visitors` | Identity/contact/purpose/date/evidence refs/consent | `visitors` plus evidence references | Owner isolation; staff operational scope; retention/anonymization |
| `gatePasses` | Opaque pass/state/times/device/guard/gate | `passes` | Unique high-entropy token digest/identifier; constraints; atomic state functions |
| `visitLogs` | Entry/decision/exit/invalid operational events | append-only `visit_events` | Server time/actor/gate attribution; no client writes |
| `auditLogs` | Administrative/security changes | append-only `audit_events` | Trusted server/RPC writes; previous/new value; no secrets |
| `reconciliationTasks` | Partial-operation recovery | `reconciliation_tasks` | Server-only writes; Super Admin sanitized reads; unresolved retention protection |
| `settings/app` | Working hours, purposes/reasons, Peak Mode, retention | typed singleton/settings tables or validated JSONB | Scoped updates, audit, timezone and value constraints |
| `imageUploads` | Short-lived Cloudinary upload reservation/claim | `upload_intents` + private Storage object refs | One-use path/owner/expiry/MIME/size/magic/quota enforcement |
| `rateLimits` | Server quota buckets | `rate_limit_buckets` or trusted backend limiter state | No public writes; hashed/non-PII keys; bounded cleanup |
| `maintenanceState` | Cleanup cursors | `maintenance_state` | Scheduler-only mutation; truthful failure/retry state |
| Cloudinary authenticated images | Face/ID evidence | private buckets `visitor-photos`, `visitor-ids` | No list/public URL/arbitrary delete; scoped signed/proxy read; hold-aware delete |

## Function/API inventory

| Original function | Target endpoint/RPC responsibility |
|---|---|
| `create-pass` | Atomic validation/claim/visitor/pass issue; server-derived source/validity; idempotency |
| `scan-pass` | Device/gate/type lookup and atomic entry/exit transition + visit event |
| `decide-visit` | Guard/admin pending-only approve/reject transaction + evidence expiry update |
| `create-user` | Supabase Admin invitation/create plus staff profile transaction/reconciliation |
| `update-user` | Restricted status/role change with last-SA enforcement and audit |
| `clear-password-flag` | `/api/auth/complete-password-change` plus service-role-only transactional finalizer — IMPLEMENTED, NOT INTEGRATION-VERIFIED |
| `create-device` | Real Auth identity + device/gate link; return credentials only after both exist |
| `update-device` | Allowed label/gate/status changes with actor matrix/audit |
| `update-device-auth` | Super Admin credential rotation; invalidate/deny old session on next operation |
| `delete-device` | Super Admin Auth + DB deletion with reconciliation and audit |
| `update-settings` | Typed role-scoped settings transaction + prior/new audit |
| `cloudinary-sign` | Replace with single-use Storage upload-intent creation |
| `cleanup-upload` | Expired/unclaimed object + intent cleanup with retry/reconciliation |
| `image` | Authorized short-lived evidence delivery/proxy; never path-only authorization |
| `purge-images` | Hold/active-pass-aware physical Storage deletion and metadata update |
| `retention-cleanup` | Authenticated scheduled 7/7/30/365/90 cleanup with non-2xx partial failure |
| `migrate-image-delivery` | Legacy-only provenance; no live Firebase/Cloudinary migration without separate approval |
| `reconciliation-items` | Sanitized Super Admin list/filter/detail endpoint |

## Frontend adapters

| Current module | Planned target |
|---|---|
| `src/lib/firebase.ts` | `src/lib/supabase.ts` is active for bootstrap/Auth; Firebase remains only for unmigrated feature chunks |
| `src/hooks/useAuth.tsx` | Supabase session listener + authoritative protected profile/device resolution — IMPLEMENTED, NOT LIVE-VERIFIED |
| direct Firestore reads/listeners | typed API/RPC or narrowly scoped RLS views/realtime subscriptions |
| `/api/*` and `/.netlify/functions/*` mix | stable `/api/*` Vercel Functions or explicitly documented RPC calls |
| `src/lib/cloudinary.ts` | Storage intent/upload/claim client; no server secret or broad bucket access |

## Configuration mapping

Legacy `VITE_FIREBASE_*`, Firebase Admin, Cloudinary, and Netlify variables remain active only until their replacements pass the appropriate stage gate. Target browser variables are `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Server-only variables include `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, and later `CRON_SECRET` if implemented. `RESEND_SUPABASE_SMTP_KEY` is an owner-side dashboard convenience and not application runtime configuration.

No old configuration is removed merely because a target file compiles. Removal occurs only after executable replacement and rollback evidence.

## S2 implementation status

- Canonical tables/types/constraints/indexes/triggers: `supabase/migrations/20261020000100_core_schema.sql` — IMPLEMENTED, NOT EXECUTED.
- Explicit grants, RLS helpers/policies, private Storage buckets: `20261020000200_rls_and_storage.sql` — IMPLEMENTED, NOT EXECUTED.
- Current-actor and upload-intent RPCs: `20261020000300_core_rpc.sql` — IMPLEMENTED, NOT EXECUTED.
- Privacy acknowledgement and Guard password finalization: `20261020000400_identity_rpcs.sql` plus `/api/auth/complete-password-change` — IMPLEMENTED, NOT EXECUTED.
- One-time non-public Super Admin bootstrap: `supabase/bootstrap/README.md` — PROCEDURE AUTHORED, NOT TESTED.
- Real database/schema matrix: `supabase/tests/*.test.sql` — 35 ASSERTIONS AUTHORED, BLOCKED.

Shared login, recovery, privacy acknowledgement, logout, and bearer-token acquisition have target implementations. No database/provider behavior is declared replaced until the isolated integration matrix passes; Firebase collection/Cloudinary operational paths remain present.
