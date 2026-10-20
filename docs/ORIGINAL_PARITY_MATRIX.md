# Original E-GatePass Parity Matrix

Source baseline: `f2f1a2b58ef19808c1be83865ee8537073b0dada`. The target and uppercase reference tracked trees are identical. Status `STATIC` means source inspected but the workflow was not executed.

## Routes and screens

| Route | Actor | Original contract | S0 evidence | Modernization acceptance target |
|---|---|---|---|---|
| `/` | Public | White EARIST header; maroon hero; visitor-first CTA; process, requirements, verification, privacy, FAQ, footer; no operational links | Desktop/phone captures; phone clipping finding | Same identity/content hierarchy; no staff/device links at any viewport; responsive overflow fixed with approved diff |
| `/get-pass` | Anonymous visitor | Details → face photo → ID unless Peak Mode → review → server pass issue → QR download/share | STATIC | Anonymous remains first-class; private evidence; optional local OCR; no pass after upload failure |
| `/login` | Staff/device | One email/device identifier and password form; show/hide; human forgot-password; role redirect | Desktop capture + STATIC | One shared Supabase Auth journey; server-resolved role/device; no public nav link |
| `/forgot-password` | Human staff | Enumeration-resistant reset request and login return | STATIC | Verified callback/reset flow; device aliases do not use human reset |
| `/kiosk` | Active kiosk only | Portrait form/photo/ID/review; QR print; “Next visitor” clears fields while device stays signed in | STATIC/BLOCKED screenshot | Same workflow; optional OCR question; strict session/data separation |
| `/scan/entry` | Active entry device only | Full-screen dark scanner; assigned gate; valid issue → pending, never automatic approval | STATIC/BLOCKED screenshot | Server derives active device/gate/type; duplicate/early/expired/wrong gate denied atomically |
| `/scan/exit` | Active exit device only | Full-screen scanner; inside → exited | STATIC/BLOCKED screenshot | Same with atomic single transition and immutable visit event |
| `/guard` | Guard/Admin/Super Admin | Live pending queue, age, search, photo/ID review, approve/reject reason, daily counts, password/account controls | STATIC/BLOCKED screenshot | Scoped evidence access, realtime/poll fallback, server-only decision transaction |
| `/admin` | Admin/Super Admin | Dashboard metrics/activity and navigation | STATIC/BLOCKED screenshot | Preserve layout and truthful live metrics |
| `/admin/visitors` | Admin/Super Admin | Status/date filters, pagination, details, complete CSV and print | STATIC | Query all selected records, never claim loaded page is complete |
| `/admin/devices` | Admin/Super Admin with action differences | Create, activate/revoke, credential changes, delete with confirmation | STATIC | Real Auth identities and DB links; stricter Super Admin rotation/delete controls |
| `/admin/users` | Admin/Super Admin with role matrix | Create staff, verification email, activate/deactivate, role change restrictions | STATIC | Real Supabase invitation identity; Admin cannot create/promote privileged roles; last-SA invariant |
| `/admin/emergency` | Admin/Super Admin | Realtime list/count of `inside` passes | STATIC | Accurate server state and explicit offline/error status |
| `/admin/audit` | Admin/Super Admin | Paginated operational/admin activity; reconciliation visible only to Super Admin | STATIC | Preserve visit/audit/reconciliation separation and viewer matrix |
| `/admin/settings` | Admin/Super Admin | Purposes, reasons, Peak Mode, retention, working hours, purge/migration controls | STATIC | Typed DB settings; scoped writes and audit; retention/working hours/purge restricted |
| unknown route | Any | No explicit catch-all in baseline | STATIC finding S0-ROUTE-001 | Accessible 404 without leaking protected route information |

## Actors and authorization

| Actor | Original resolution | Preserved/strengthened target rule |
|---|---|---|
| Guest | Firebase anonymous user, treated as `visitor` | Supabase anonymous session; own upload intents/pass only; cannot enumerate PII |
| Kiosk | Firebase Auth + active `devices/{uid}` type `kiosk` | Provisioned Supabase Auth device, DB-bound type/gate/status; session survives visitor reset |
| Entry / Exit | Firebase Auth + active matching device type | Provisioned device, exact server-side type/gate check on every protected query/RPC |
| Guard | Verified Firebase user + active `users/{uid}` role | Verified active staff; forced first password change; only pending evidence and decisions |
| Admin | Verified active staff role | Operations and Guard/device creation only within final matrix; no privileged role/self-escalation |
| Super Admin | Verified active privileged role | Reserved role/credential/destructive/settings/reconciliation actions; last-active-SA protection |

## Pass and evidence lifecycle

`issued → pending (entry scan) → inside (Guard approval) → exited`, with `rejected` and `expired` terminal/invalid outcomes. QR scan does not approve entry. Default validity is the selected day, 08:00–17:00 Asia/Manila, up to 30 days ahead. Original functions use transactions for creation/scanning/decisions and keep operational `visitLogs` separate from `auditLogs` and `reconciliationTasks`.

Face photo and valid ID are current Cloudinary authenticated assets referenced by visitors/passes and proxied to authorized staff. Target parity means private Supabase Storage, intent-bound uploads, short-lived/scoped reads, seven-day default image retention with active-pass/hold protection, and proof of physical object deletion.

## Visual identity anchors

- EARIST seal: `public/earist-logo.png`.
- Colors: maroon `#7A0A0A`, action red `#E60000`, gold `#F2C94C`, white, canvas `#F7F8FA`, text `#172033`.
- Keep original landing copy structure in `src/content/landing.ts`, conventional Admin shell, portrait Kiosk, and dark scanner treatment.
- S0 screenshots are the initial public reference. Authenticated screen evidence is BLOCKED pending isolated accounts; source inspection must not be mislabeled as visual PASS.
