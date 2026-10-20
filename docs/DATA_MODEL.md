# Supabase Data Model

Status: S2 `IMPLEMENTED — NOT VERIFIED`. The migrations have not executed against PostgreSQL.

## Identity and authorization

- `auth.users` owns authentication identity.
- `staff_profiles` maps a verified Auth UID to `guard`, `admin`, or `superadmin`, active state, and first-password-change state.
- `devices` maps an Auth UID to one provisioned `kiosk`, `entry`, or `exit` device, its gate, alias, and revocation state.
- An Auth user with neither row is a portal visitor identity. Anonymous Supabase Auth users use the `authenticated` database role; they are not the Postgres `anon` role.

Application role/type never comes from editable user metadata. Protected helpers resolve current rows on each query/RPC. The final active Super Admin is protected by a serialized database trigger for update and delete paths.

## Visitor, evidence, and pass data

| Table | Purpose | Primary invariants |
|---|---|---|
| `visitors` | PII, purpose, date, consent, portal/kiosk source | Owner Auth UID; kiosk creator required only for kiosk source |
| `upload_intents` | One-use, short-lived Storage authorization | Owner, source, kind, bucket/path, MIME, 5 MB maximum, expiry |
| `visitor_evidence` | Verified face/ID reference and lifecycle metadata | One evidence item per visitor/kind; SHA-256 and verified size/type |
| `passes` | Authoritative pass lifecycle and opaque-token digest | One pass per visitor; 32-byte digest; validity interval; constrained rejection state |
| `visit_events` | Operational append-only history | Server/RPC authored; request/event uniqueness prevents duplicates |

QR bearer tokens are never stored in plaintext; only a 32-byte digest is canonical. `public_reference` is a correlation identifier, not an authorization secret.

## Operations and recovery

- `app_settings` is a typed singleton for Asia/Manila hours, scheduling window, Peak Mode scope, lists, and retention periods.
- `audit_events` is administrative/security history and remains separate from operational `visit_events`.
- `reconciliation_tasks` exposes sanitized unresolved cross-system work only to Super Admins.
- `incident_holds` prevents retention work for a visitor/pass until an audited release.
- `rate_limit_buckets` and `maintenance_state` are server-only tables.

## Data classification

| Class | Examples | Storage/access |
|---|---|---|
| Restricted identity evidence | face photo, government/school ID image | Private Storage; owner during registration, pending-review Guard, Admin/Super Admin; no public URL/list/delete |
| Confidential visitor data | name, contact, email, purpose, visit date | Postgres RLS; owner and operationally necessary staff only |
| Security bearer material | QR token, session/access token | QR shown to holder; only digest in DB; tokens absent from logs/audit/docs |
| Internal operational | gate, pass status, visit events | Role-scoped Postgres reads; trusted writes only |
| Security administration | audit/reconciliation/holds | Admin/Super Admin or Super Admin only; no client writes |

Retention values are schema defaults, not a legal determination. Owner/institutional review is required before live personal data is processed.

## Migration and recovery

The ordered files in `supabase/migrations/` are the canonical schema. A clean disposable reset and an independently repeated clean installation must pass before promotion. No production data copy or destructive remote reset is authorized. Database backups do not include physical Storage objects, so recovery and retention evidence must treat them separately.
