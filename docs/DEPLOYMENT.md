# Deployment Guide

## Before deployment

Verify `git status`, the intended branch (`main` for production), `git rev-parse HEAD`, Netlify login/site link, and required environment variable names. Record the pre-release rollback commit and exclude `.tmp/` artifacts.

```bash
npm test
npm run build
npx tsc --noEmit
npm run typecheck:functions
git diff --check
npm audit
npm ls firebase-admin jwks-rsa jose
```

Review audit findings; never run `npm audit fix --force`. Incompatible dependency changes require deliberate testing.

## Netlify production environment

Use [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md) for setup and rotation detail. Do not print or commit values.

| Variable | Purpose | Classification | Required in production? | Where configured | Safe in browser? | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase client config | Public client config | Yes | Netlify environment | Yes | Deliberately browser-visible. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase client config | Public client config | Yes | Netlify environment | Yes | Deliberately browser-visible. |
| `VITE_FIREBASE_PROJECT_ID` | Firebase client config | Public client config | Yes | Netlify environment | Yes | Deliberately browser-visible. |
| `VITE_FIREBASE_APP_ID` | Firebase client config | Public client config | Yes | Netlify environment | Yes | Deliberately browser-visible. |
| `FIREBASE_PROJECT_ID` | Firebase Admin project selection | Server configuration | Yes | Netlify environment | No | Used by Functions. |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin service account | Server credential material | Yes | Netlify environment | No | Keep with the private key. |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin credential | Server secret | Yes | Netlify environment | No | Never source-control. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account selection | Server configuration | Yes | Netlify environment | No | Not a destructive secret. |
| `CLOUDINARY_API_KEY` | Cloudinary service identifier | Server configuration | Yes | Netlify environment | No | Not the destructive secret. |
| `CLOUDINARY_API_SECRET` | Cloudinary destructive API credential | Server secret | Yes | Netlify environment | No | Never browser-visible. |
| `CRON_SECRET` | Internal scheduled-cleanup authorization | Server secret | Yes, when automatic cleanup is enabled | Netlify environment | No | Rotate without code changes. |
| `AWS_LAMBDA_JS_RUNTIME` | Function runtime | Build/runtime configuration | Yes | `netlify.toml` | N/A | Value: `nodejs24.x`; Netlify UI must not conflict. |
| `NODE_OPTIONS` | Node compatibility option | Build/runtime configuration | Yes | `netlify.toml` | N/A | Value: `--experimental-require-module`; do not remove without testing. |
| `VITE_USE_FIREBASE_EMULATORS` | Opt-in local client emulators | Development only | No | Local ignored file | No | Must be unset or `false` in production. |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`, `GCLOUD_PROJECT` | Local test/emulator setup | Development only | No | Test/local environment | No | Never use emulator hosts in production. |

## Firestore and Netlify

Project: `e-gatepass-c1870`.

```bash
npx firebase-tools@13.10.0 deploy --only firestore:indexes --project e-gatepass-c1870
npx firebase-tools@13.10.0 deploy --only firestore:rules --project e-gatepass-c1870
```

Deploy indexes first and wait for required indexes to be **READY**, including `imageUploads(status ASC, expiresAt ASC)`, `visitors(imagesPurgedAt ASC, imagesExpireAt ASC)`, and `reconciliationTasks(status ASC, createdAt ASC)`. Deploy rules near application cutover. Push the reviewed commit to `main` without force-pushing, then verify Netlify auto-deploy, build/functions, and runtime logs. Node 24 plus `NODE_OPTIONS=--experimental-require-module` and the known `firebase-admin@14.5.0` / `jwks-rsa@4.1.0` / `jose@6.2.12` chain are required. `CRON_SECRET` is required by scheduled retention. Secret scanning stays enabled; `SECRETS_SCAN_OMIT_KEYS` omits only the four public Firebase `VITE_*` values, never server secrets.

## Rollback and smoke test

Netlify can redeploy a prior successful deploy; Firestore rules can be redeployed from a reviewed prior commit. Index creation is asynchronous. Auth password changes, account deletion, and Cloudinary deletion are not generally reversible.

Smoke test public flow, Admin, Super Admin, Guard, Kiosk, Entry, Exit, and one authorized controlled lifecycle: issue → entry → Guard decision → inside → exit. Inspect Netlify logs, Firestore permission errors, index status, and Cloudinary failures.
