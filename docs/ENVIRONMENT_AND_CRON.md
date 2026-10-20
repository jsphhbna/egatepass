# Environment and Scheduled Cleanup Handoff

## `.env.example`

`.env.example` is a tracked template of the variable names E-GatePass expects. It contains comments, names, and safe defaults only; it never contains real credentials. For local work, copy it to `.env` or `.env.local` and populate local values. `.env`, `.env.local`, and `.env.*.local` are ignored by Git; `.env.example` remains tracked.

Netlify Environment Variables may contain both configuration and secrets. A Netlify variable is not automatically a password: classify it by what it controls and who can safely see it.

## Environment inventory

| Category | Variables | Handling |
| --- | --- | --- |
| Public browser Firebase configuration | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Included in the browser bundle. They identify the Firebase client project; Firebase Rules and server authorization protect data. |
| Server configuration | `FIREBASE_PROJECT_ID`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` | Configure Netlify Functions only. Do not prefix with `VITE_`; `CLOUDINARY_API_KEY` is an identifier, not the destructive secret. |
| Server secrets | `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, `CLOUDINARY_API_SECRET`, `CRON_SECRET` | Store only in Netlify/local ignored files. Treat the Firebase service-account email as credential material with its private key. Never put these in Git, documentation, or browser code. |
| Build/runtime configuration | `AWS_LAMBDA_JS_RUNTIME`, `NODE_OPTIONS` | Non-secret compatibility settings source-controlled in `netlify.toml`. |
| Development only | `VITE_USE_FIREBASE_EMULATORS`, `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST`, `GCLOUD_PROJECT` | Local emulator/test configuration. Do not use emulator hosts in production. |

## Known-working runtime

E-GatePass production Functions use this tested combination:

- Node 24 through `AWS_LAMBDA_JS_RUNTIME=nodejs24.x`.
- `firebase-admin@14.5.0`, `jwks-rsa@4.1.0`, and `jose@6.2.12`.
- `NODE_OPTIONS=--experimental-require-module`.

`AWS_LAMBDA_JS_RUNTIME` forces Netlify Functions onto Node 24. `NODE_OPTIONS` is a Node runtime option required by the current Firebase Admin/module dependency combination. Neither is a credential, and both are safe to document, but neither should be casually removed or changed without the full Netlify build and runtime validation.

Both values are already canonical in source-controlled `netlify.toml`. The Netlify UI can show duplicate values for operational visibility, but they must match the file; avoid conflicting UI overrides.

## Scheduled cleanup in plain language

Cron means a scheduled automatic task. E-GatePass has a daily scheduled retention cleanup. It reads retention settings, finds expired eligible images/records, performs bounded cleanup, and records an audit result. It does not delete active visits, unresolved reconciliation work, or protected security history.

`CRON_SECRET` is a private machine-to-machine password for the protected cleanup path. It is not a Super Admin password, Firebase password, or user sign-in password. Netlify stores one configured value. Server code reads `process.env.CRON_SECRET`; the scheduled function passes that value only to the protected internal cleanup handler, which compares it in a timing-safe way with its configured value. A matching value allows the internal cleanup call; a missing or wrong value is denied. Browser sessions never receive it, including Super Admin sessions.

The secret can be random because it is a machine password. Do not use memorable text such as `cron123`, `egatepass`, or `school2026`; use a long, random, unguessable value.

### Generate and configure `CRON_SECRET`

1. Open PowerShell. You may do this in the E-GatePass project folder for convenience; the folder does not affect the generated secret.
2. Run:

   ```powershell
   [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
   ```

3. Copy the generated random string.
4. In Netlify, open the E-GatePass project, then **Project configuration → Environment variables**.
5. Add or replace `CRON_SECRET` with the generated value and save.
6. Redeploy Functions/site if Netlify requires a deploy for the new environment value to be available.
7. Verify the scheduled cleanup and inspect Netlify Function logs.

Generating a value does not upload it to Netlify. Generation and Netlify configuration are separate steps. A trusted password-manager generator, OpenSSL, or another cryptographically secure random generator are also acceptable.

### Rotate `CRON_SECRET`

1. Generate a new random value.
2. Replace `CRON_SECRET` in Netlify.
3. Redeploy/restart Functions if required.
4. Verify scheduled cleanup and Function logs.
5. Treat the old value as invalid.

No application-code change is required for secret rotation.

## Netlify secret scanning

Secret scanning stays enabled. `SECRETS_SCAN_OMIT_KEYS` is deliberately narrow and omits only the four public Firebase browser configuration keys listed above. It must never omit `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, `CLOUDINARY_API_SECRET`, `CRON_SECRET`, or any other server secret. The separate `.firebaserc` path omission applies only to that non-secret Firebase project-alias file.

## School-IT ownership handoff

The incoming school technician needs approved access to GitHub, Netlify, Firebase, and Cloudinary. During handoff:

1. Review required variable names using `.env.example`; never copy real values into GitHub or documentation.
2. Rotate secrets where policy requires, including generating a new `CRON_SECRET` and storing it in Netlify.
3. Confirm `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` and `NODE_OPTIONS=--experimental-require-module` still match `netlify.toml`.
4. Redeploy if changed environment values require it.
5. Verify scheduled retention cleanup, Firebase Admin Functions, Cloudinary Functions, and their logs.
