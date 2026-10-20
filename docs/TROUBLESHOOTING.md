# Troubleshooting

## Netlify CLI

```bash
npx netlify login
npx netlify link
npx netlify status
```

Confirm the linked site before deployment.

## Permission denied or controls missing

Check the correct Firebase project, deployed rules, role, `active` flag, and stale session (sign out/in). For Super Admin UI, verify Firebase Auth UID equals `users/{uid}`, role is `superadmin`, and the current frontend is deployed. For devices check active status, type, gate, network, and camera permission.

## Index, function, or image errors

Wait for a required Firestore index to become **READY**; do not rewrite a query simply because it is building. Check Netlify function logs first. Historical `ERR_REQUIRE_ESM` requires Node 24, `NODE_OPTIONS=--experimental-require-module`, `firebase-admin@14.5.0`, `jwks-rsa@4.1.0`, and `jose@6.2.12`; do not randomly downgrade packages. For images, verify the referenced asset, allowed application reference, `imageUploads` metadata when applicable, Cloudinary variable names, and function logs.

## Scheduled cleanup not working

Check that `CRON_SECRET` exists in the Netlify production environment, the scheduled retention function is deployed, and the latest deploy can see its environment variables. Then inspect Netlify Function logs for authorization failures, Firebase errors, and Cloudinary errors. Confirm the required Firestore indexes are **READY** and automatic cleanup is enabled in Super Admin Settings.

For runtime/module errors, confirm `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` and `NODE_OPTIONS=--experimental-require-module`. Do not casually downgrade the known-working Node 24 / Firebase Admin dependency chain. See [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md) for safe configuration and rotation steps.
