# Security

Frontend checks improve UX only. Firestore Rules and Netlify Functions are authoritative. Firebase Admin and Cloudinary secrets live in Netlify variables only: never use `VITE_*`, source control, audit data, or browser code for secrets.

There is no public Super Admin bootstrap endpoint. Use the authorized manual procedure in [Super Admin Bootstrap](SUPER_ADMIN_BOOTSTRAP.md); protected updates preserve at least one active Super Admin. Devices are authenticated accounts constrained by status, type, and gate.

Cloudinary destructive credentials stay server-side. New identity images use Cloudinary `authenticated` delivery, and an authorized application reference is required before the backend proxies a signed asset. Legacy `upload` assets remain compatible but require the bounded Super Admin migration documented in [Image Security](IMAGE_SECURITY.md). Trusted mutations record audit information; unresolved external partial operations create server-only reconciliation tasks. Review dependency advisories before releases; do not force upgrades or downgrades without compatibility testing.

Anonymous visitor upload-signing and pass-creation requests are validated before transactional UID and hashed-client-address rate limits are consumed. Limits return HTTP 429 with retry guidance and are not client-controlled. `rateLimits` and cleanup cursor state are denied to all clients by the default Firestore Rules boundary.

Automatic retention permanently protects bootstrap, user role/status, Admin creation/deletion, device creation/deletion/credential, and Settings-change audit actions. Only ordinary old audit events may expire. Unresolved reconciliation tasks never expire automatically.

## Human identities, server credentials, and runtime configuration

A Super Admin account is a privileged human identity used for authorized administration. `CRON_SECRET` is separate: it authorizes only the server-to-server scheduled cleanup path and is never a user login/password. `FIREBASE_PRIVATE_KEY` is the backend Firebase Admin credential, while `CLOUDINARY_API_SECRET` is the backend Cloudinary credential. A compromised Super Admin browser session must not reveal any of these server secrets.

`AWS_LAMBDA_JS_RUNTIME=nodejs24.x` and `NODE_OPTIONS=--experimental-require-module` are runtime configuration, not secrets. They are source-controlled in `netlify.toml` because the current Node 24 / Firebase Admin dependency chain needs them. See [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md).
