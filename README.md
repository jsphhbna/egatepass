# E-GatePass

E-GatePass is a school visitor-management system for QR gate passes, arrival screening, Guard decisions, and exit records. It serves public visitors, Guards, Admins, Super Admins, Kiosk devices, and Entry/Exit Scanner devices.

## Visitor lifecycle

Get Pass or Kiosk creates a visitor and pass. Entry scanning moves a valid QR pass to pending; a Guard approves or rejects it; approved visitors become inside; Exit scanning records exited. Expired, malformed, wrongly routed, or already-used passes are rejected by the protected scanner workflow.

## Stack and runtime

React, TypeScript, Vite, Firebase Authentication, Firestore, Netlify Functions, Cloudinary, and browser QR scanning. Production uses Node 24, `firebase-admin@14.5.0`, and `NODE_OPTIONS=--experimental-require-module`; this known-working Firebase Admin / `jwks-rsa` / `jose` combination must not be casually changed.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/pages`, `src/components` | React interface |
| `src/hooks/useAuth.tsx`, `src/components/ProtectedRoute.tsx` | session loading and route UX guards |
| `src/lib/firebase.ts`, `src/lib/permissions.ts` | Firebase client and UI permissions |
| `netlify/functions` | authoritative mutations, Firebase Admin, image handling |
| `firestore.rules`, `firestore.indexes.json` | Firestore authorization and indexes |
| `tests` | emulator-backed validation |
| `docs` | technical handoff guides |

## Local development

Requires Node 24, Java for emulator tests, and dependencies installed with `npm install`. Keep values only in `.env.local`.

```bash
npm run dev
npm run netlify:dev
npm run build
npm test
npx tsc --noEmit
npm run typecheck:functions
```

## Environment configuration

Copy `.env.example` to `.env` or `.env.local` for local work, then supply local values; the template is tracked but local files are ignored. The four `VITE_FIREBASE_*` values are public Firebase browser configuration. Firebase Admin, Cloudinary, and `CRON_SECRET` values are server-only and must never be prefixed with `VITE_`, committed, or exposed to a Super Admin browser session.

Production Functions use Node 24 and `NODE_OPTIONS=--experimental-require-module`; both non-secret runtime values are canonical in `netlify.toml`. Netlify also stores the production server secrets. See [Environment and Scheduled Cleanup Handoff](docs/ENVIRONMENT_AND_CRON.md) for the complete inventory, CRON setup/rotation, and school-IT handoff procedure.

## Deployment and roles

GitHub `main` is the intended production branch and Netlify deploys it. Firestore rules and indexes are separate and must be deployed explicitly. Client role checks are UX only; Firestore Rules and Netlify Functions are authoritative. Admins operate day-to-day administration; Super Admins retain Admin abilities plus security-sensitive controls; Guards are limited to visit work; devices are limited by active status, type, and gate.

## Security Status

- Internal Security Audit: **PASSED**
- Overall: **8.6/10**; Security: **8.7/10**
- Production Readiness: **8.5/10**; School Handoff Readiness: **8.4/10**
- Audited application commit: `ffa1cbb2c0960aada1947cadb05acd486baf918d`
- Audit date: 2026-10-06 (Asia/Manila)

Read the [Internal Security Audit Certificate](docs/SECURITY_AUDIT_CERTIFICATE.md), [Security Features and Validation](docs/SECURITY_FEATURES_AND_VALIDATION.md), and [Audit Findings](docs/SECURITY_AUDIT_FINDINGS.md).

This is an internal project audit, not an external security certification or legal compliance certification.

## Documentation

- [Deployment](docs/DEPLOYMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Super Admin Bootstrap / Recovery](docs/SUPER_ADMIN_BOOTSTRAP.md)
- [Clean Data Handoff](docs/CLEAN_DATA_HANDOFF.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Working Hours and Exports](docs/WORKING_HOURS_AND_EXPORTS.md)
- [Image Security](docs/IMAGE_SECURITY.md)
- [Audit and Reconciliation](docs/AUDIT_POLICY.md)
- [Environment and Scheduled Cleanup Handoff](docs/ENVIRONMENT_AND_CRON.md)
