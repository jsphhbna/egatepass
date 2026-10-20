# E-GatePass Architecture

Last reviewed: 2026-10-20 (Asia/Manila)

## Status and invariant

This document separates the partially migrated feature branch from the approved final target. Public startup and shared staff/device identity now use Supabase configuration/Auth, and the first Vercel Auth endpoint is implemented. Operational visitor, Guard, Admin, Storage, and pass-lifecycle features still contain Firebase/Netlify/Cloudinary code in deferred chunks. Supabase SQL and Vercel behavior remain **not integration-verified**.

Invariant: no browser-controlled role, source, device type, gate, pass status, timestamp, object path, or audit payload may authorize or manufacture a privileged outcome. The database or a trusted server function must resolve current actor/resource state and fail closed.

## System context

```text
Public/guest browser ─┐
Kiosk browser ────────┼── HTTPS ── React/Vite UI
Scanner browser ──────┤                 │
Staff browser ────────┘                 ├── Supabase Auth session
                                        ├── scoped PostgREST/RPC/Realtime
                                        ├── private Supabase Storage
                                        └── /api/* Vercel Functions
                                                   ├── Supabase privileged API
                                                   └── Resend transactional email

GitHub lowercase target ── owner-approved release ── Vercel preview/production
Versioned SQL migrations ── owner-approved apply ─── isolated/staging/production Supabase
```

The uppercase `jsphhbna/E-GATEPASS` repository and its Firebase/Netlify/Cloudinary resources are a read-only disaster-recovery reference and are outside the mutation boundary.

## Components and authority

| Component | Responsibility | Trusted for |
|---|---|---|
| React/Vite UI | Preserve original routes, forms, QR, queue, dashboards, kiosk and scanner ergonomics | Presentation and input collection only |
| Supabase Auth | Human, device, registered/anonymous visitor sessions | Authenticated subject identity; not application role metadata supplied by a client |
| PostgreSQL + RLS | Canonical profiles/devices/visitors/passes/settings/events and row visibility | Ownership, role/device status, grants, constraints |
| Narrow RPCs | Atomic issue/scan/decision/exit and privileged settings/governance | State transitions after re-resolving current actor |
| Private Storage | Face/ID objects in `visitor-photos` and `visitor-ids` | Object persistence; authorization comes from policies/intents/reference state |
| Vercel Functions | Multi-provider operations, Auth admin operations, email, cleanup orchestration | Server-only keys and reconciliation |
| Resend | Optional application email | Delivery attempt/result only; never proof of pass ownership by itself |

## Trust boundaries

1. Browser input is untrusted, including JWT custom/user metadata, route state, QR content, source, gate, clock, file metadata, and claimed recipient.
2. A publishable Supabase key identifies the project, not a privileged caller. RLS, grants, and current DB records remain mandatory.
3. Supabase secret/service-role keys and Resend keys exist only in server environments. Service-role access bypasses RLS, so each function must authorize before querying or mutating.
4. Storage paths and signed URLs are bearer material, not permission records. Private download is allowed only through an applicable policy or a server-authorized short-lived URL.
5. Email and Storage are non-transactional external systems. Partial failure produces an explicit retry/reconciliation state, never a false success.

## Canonical data and lifecycle

Internal IDs are UUIDs. A pass exposes a separate high-entropy opaque token whose digest is stored for lookup; possession never bypasses lifecycle/device checks.

```text
issued ── valid entry-device scan ──> pending
pending ── Guard approve ───────────> inside ── valid exit-device scan ──> exited
pending ── Guard reject ────────────> rejected
issued ── validity elapsed ─────────> expired
```

Only RPCs may change pass status. Each successful transition and its visit event occur in one database transaction. Duplicate or concurrent calls lock/re-check the row and either return the already-known result where explicitly idempotent or deny without a second event.

## Data flows and failure behavior

### Registration and evidence

An anonymous visitor or active kiosk requests a one-use upload intent. The Storage object path is server-derived and owner-bound. Bucket limits restrict MIME and size; server validation must additionally inspect content before pass issue. Pass issue fails if required evidence is missing/unclaimed, consent is absent, date/hours are invalid, or Peak Mode does not apply to the resolved source.

### Staff/device login

The shared `/login` authenticates through Supabase Auth. The application resolves either an active `staff_profile` or active `device` record by Auth UID. It never accepts role/type from user metadata. Revocation/suspension is checked on the next protected DB query/RPC even if a JWT has not expired.

Device aliases are normalized only when they satisfy the database alias constraint and map to a fixed non-routable Auth email domain; arbitrary caller-provided alias-to-email mappings are not accepted. Password recovery uses Supabase Auth links. Guard first-login password completion uses `/api/auth/complete-password-change`: the function validates the access token with Auth, rechecks the active Guard row, verifies the current password in an isolated client, changes the Auth password, then calls a service-role-only transactional finalizer. A post-Auth database failure remains explicit and creates a reconciliation task.

### Scanning and Guard decision

The RPC resolves the scanner's type and gate from its device row. Entry creates `pending`, not approval. Guard/Admin/Super Admin may inspect only operationally required pending evidence and decide a still-pending pass. Exit accepts only `inside` at the authorized gate policy.

### Email and retention

Pass issue is durable independently of optional email. Email retry uses a stable idempotency key and recipient ownership proof. Retention first records eligibility/hold decisions in Postgres, then deletes through the Storage API; metadata is not treated as physical deletion proof. Failures remain retryable and visible.

## Deployment topology

- Vercel region: `syd1`, selected near the declared Supabase Sydney region; deployment remains unverified.
- Vite static files and `/api/*` functions share one Vercel project. Vercel's filesystem precedence means the documented SPA catch-all does not replace a real function file.
- Supabase migrations under `supabase/migrations/` are the only schema source. Remote apply/reset needs owner authorization and an identity check.
- `vercel.json` is repository configuration only; no Vercel project was linked or deployed in S1.

## Current transition boundary

Legacy files stay until replacement slices pass their gates. `firebase.json`, Firestore rules/indexes, `netlify/`, and Cloudinary code must not be removed based on architecture intent alone. P0 removed Firebase from startup; M1 migrates identity; M2 migrates registration/issuance; M3 migrates scanner transitions, Guard queue/decision, and evidence reads. Admin data/governance, cleanup, and account/device administration remain legacy and block cutover. All provider behavior remains unverified.

## Evidence and authority

Current provider behavior was reviewed on 2026-10-20 against Supabase Auth `getUser`, API-key/RLS, and server-client guidance plus Vercel Vite and Node Function handler documentation. Those sources define expected behavior; they do not prove this repository or a deployed environment behaves correctly. Project proof is recorded in `EVIDENCE_LEDGER.md`.
