# Environment Variables Contract

This document is the authoritative specification for all configuration and secrets across the client, serverless functions, and external integrations in the EARIST E-GatePass platform.

> **CRITICAL SECURITY RULE**: Never commit real secret values, credentials, or production tokens into version control. Local overrides belong in `.env.local`, which is strictly ignored by Git.

---

## 1. Authoritative Environment Variables Matrix

| Variable | Scope | Secret? | Consumer / Used By | Production Required? | Purpose & Format Specification |
|---|---|---|---|---|---|
| `APP_BASE_URL` | Production, Preview, Local | No | Transactional email template branding (`server/templates/branding.ts`) | **Yes** | `https://egatepass.tech` (Public canonical application origin used for externally loaded transactional-email branding assets) |
| `VITE_SUPABASE_URL` | Production, Preview, Local | No | Client application (`src/lib/supabase.ts`) | **Yes** | `https://<project-ref>.supabase.co` (Public Supabase API Gateway) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Production, Preview, Local | No | Client application (`src/lib/supabase.ts`) | **Yes** | `sb_publishable_...` (Supabase publishable browser key; intentionally public and safe for browser use when RLS is correctly enforced) |
| `VITE_TURNSTILE_SITE_KEY` | Production, Local | No | Cloudflare Turnstile widget (`src/pages/GetPassPage.tsx`, `LoginPage.tsx`) | **Yes** (Prod) | `0x4AAAAAAFeETebgPENH6hgH` (Public Cloudflare Turnstile Managed widget site key; scoped to Production in Vercel) |
| `SUPABASE_URL` | Production, Preview, Local | No | Serverless API Functions (`server/supabase.ts`) | **Yes** | `https://<project-ref>.supabase.co` (Backend Supabase endpoint) |
| `SUPABASE_SECRET_KEY` | Production Only | **Yes** | Serverless admin client (`server/supabase.ts`) | **Yes** | High-privilege Supabase service-role secret; strictly isolated to Production |
| `PASS_TOKEN_SECRET` | Production Only | **Yes** | QR bearer token derivation (`server/routes/passes/issue.ts`) | **Yes** | High-entropy cryptographic secret (**minimum 32 characters**) for HMAC-SHA256 QR tokens |
| `RETURNING_MATCH_TOKEN_SECRET` | Production Only | **Yes** | Returning preview tokens & biometric match tokens (`server/routes/passes/returning-photo-preview.ts`, `lookup-returning.ts`, `identify-returning.ts`, `returning-id-preview.ts`, `issue.ts`) | **Yes** | Dedicated high-entropy cryptographic secret (**minimum 32 characters**) strictly isolated from pass tokens |
| `RETURNING_VISITOR_TEMPLATE_KEY` | Retired | — | Legacy retired biometric encryption key (unused; persistent face templates disabled per Migration 103) | No | Retained in docs for historical context only; deleted from Production after `returning_face_templates` retirement |
| `RATE_LIMIT_HMAC_SECRET` | Production Only | **Yes** | Network abuse rate limiting (`server/routes/passes/issue.ts`, `lookup-returning.ts`) | **Yes** | Dedicated high-entropy key (**minimum 32 characters**) for hashing client IP/subnet |
| `RETURNING_FACE_THRESHOLD_MODE` | Production, Local | No | Biometric verification safety gate (`server/routes/passes/identify-returning.ts`) | No | `provisional` (default) or `calibrated`. Production runs strictly in `provisional` mode |
| `RETURNING_FACE_MIN_COSINE` | Production, Local | No | Cosine threshold override in calibrated workflows (`server/lib/face-engine.ts`) | No | Provisional mode uses fixed SFace baseline (`0.363`) |
| `RETURNING_VISITOR_ACTIVE_KEY_VERSION` | Retired | — | Legacy key-version selector (unused after biometric storage retirement) | No | Optional compatibility variable left unset |
| `RETURNING_FACE_CALIBRATION_ARTIFACT` | Production, Local | No | Ed25519 signed calibration envelope (`server/lib/calibration-verifier.ts`) | No | Complete JSON envelope signed by `EARIST_BIOMETRICS_CALIBRATION_AUTHORITY`. Required for `calibrated` mode |
| `RESEND_API_KEY` | Production Only | **Yes** | Resend REST API client (`server/email.ts`) | **Yes** | `re_...` provider-issued transactional email API key |
| `RESEND_FROM_EMAIL` | Production, Local | No | Sender identity (`server/email.ts`) | **Yes** | Authoritative sender: `EARIST E-GatePass <notifications@egatepass.tech>` |
| `SEND_EMAIL_HOOK_SECRET` | Production Only | **Yes** | Supabase Auth Send Email Hook (`server/routes/auth/send-email-hook.ts`) | **Yes** | Shared secret configured in Supabase Auth Webhook settings |
| `RESEND_WEBHOOK_SECRET` | Production Only | **Yes** | Resend Delivery Webhook (`server/routes/auth/resend-webhook.ts`) | **Yes** | `whsec_...` signing secret for Resend delivery event verification |
| `CRON_SECRET` | Production Only | **Yes** | Retention maintenance authorization (`server/routes/admin/retention-maintenance.ts`) | **Yes** | Shared bearer token (**minimum 32 characters**) for Vercel Cron invocations |
| `OFFICE_VISIT_HMAC_SECRET` | Production Only | **Yes** | Office portrait preview tokens & actor-bound email challenge verification tokens (`server/lib/office.ts`) | **Yes** | Dedicated high-entropy cryptographic secret (**minimum 32 characters**) strictly isolated from pass & returning tokens |
| `OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY` | Production Only | **Yes** | Office visit QR bearer token encryption & recovery outbox (`server/lib/encryption.ts`) | **Yes** | 32-byte (64-hex-character) dedicated AES-256-GCM key for pass token encryption in `public.office_visit_email_outbox` |
| `EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY` | Production, Local | **Yes** | Optional override for ECDSA P-256 emergency manifest signing (`server/lib/emergency-manifest.ts`) | No | Optional PKCS#8 PEM override. When unset, server auto-provisions/loads active P-256 keypair via `api.get_active_emergency_signing_key` in `private.emergency_signing_keys` |
| `SMS_GATEWAY_URL` | Production, Local | No | Cloud SMS Gateway endpoint (`server/sms.ts`) | No | Defaults to `https://api.sms-gate.app/3rdparty/v1/messages` |
| `SMS_GATEWAY_USERNAME` | Production Only | **Yes** | SMS Gateway Basic Auth username (`server/sms.ts`) | For SMS | Required to dispatch emergency/overdue SMS broadcasts |
| `SMS_GATEWAY_PASSWORD` | Production Only | **Yes** | SMS Gateway Basic Auth password (`server/sms.ts`) | For SMS | Required to dispatch emergency/overdue SMS broadcasts |
| `SMS_GATEWAY_DEVICE_ID` | Production Only | **Yes** | Bound Android gateway handset ID (`server/sms.ts`, `send-sms`) | For SMS | Required to target campus SIM handset fail-closed |
| `SEND_SMS_HOOK_SECRET` | Supabase Edge / Local | **Yes** | Supabase `send-sms` Edge Function Standard Webhook verification | For Hook | Verifies webhook signatures when Send SMS hook is active |
| `SMS_INTAKE_SIGNING_KEY` | Supabase Edge / Local | **Yes** | Android Gateway inbound `sms-intake` HMAC verification | For Intake | Verifies `X-Signature` on incoming `sms:received` events |

> **Turnstile Architecture Note**: The Cloudflare Turnstile Secret Key is configured in the Supabase Dashboard under **Authentication > Bot Protection / CAPTCHA** for `signInAnonymously`. It is handled directly by Supabase Auth and is NEVER required or exposed in Vercel serverless runtime environments. Public Turnstile widget availability is reported via `/api/passes/capabilities` (`turnstile.siteKeyConfigured`).

---

## 2. Preview Environment Isolation Architecture

Generic Vercel Preview deployments are protected by Vercel Deployment Protection (SSO). However, to prevent experimental preview code or pull request builds from accessing live production data or services:

```text
Production Scope (egatepass.tech)
├─ Public / Non-sensitive configuration (APP_BASE_URL, VITE_SUPABASE_URL, SUPABASE_URL, etc.)
└─ Full external provider credentials (SUPABASE_SECRET_KEY, RESEND_API_KEY, PASS_TOKEN_SECRET,
     CRON_SECRET, RATE_LIMIT_HMAC_SECRET, RETURNING_MATCH_TOKEN_SECRET, OFFICE_VISIT_HMAC_SECRET,
     OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY, SEND_EMAIL_HOOK_SECRET, RESEND_WEBHOOK_SECRET, SMS_GATEWAY_*)

Generic Preview Scope (*.vercel.app)
├─ VITE_SUPABASE_URL
├─ VITE_SUPABASE_PUBLISHABLE_KEY
├─ SUPABASE_URL
└─ ZERO Production Privileged Server Credentials (no service_role, no Resend key, no signing keys)
```

**Rule for Operators**: Never copy Production privileged secrets into generic Vercel Preview. If preview branch end-to-end testing is required, provision isolated staging infrastructure.

---

## 3. Dedicated Email Hooks Architecture

The platform utilizes two distinct, decoupled webhook flows:

```text
1. Outbound Auth Dispatch: Supabase Auth Send Email Hook
   Supabase Auth
       ↓ signed standard webhook
   POST /api/auth/send-email-hook
       ↓ (verified via SEND_EMAIL_HOOK_SECRET)
   React Email template rendering
       ↓
   Resend REST API (via RESEND_API_KEY)
   Purpose: Dispatches transactional system emails (staff invites, password resets, magic links).

2. Inbound Delivery Feedback: Resend Delivery Observability Webhook
   Resend Event System
       ↓ signed delivery event
   POST /api/webhooks/resend  (rewritten to /api/auth/resend-webhook)
       ↓ (verified via RESEND_WEBHOOK_SECRET)
   Atomic deduplication (public.resend_webhook_events)
       ↓
   Audit logging (public.audit_events with masked recipient)
   Purpose: Observability of delivery outcome (sent, delivered, delayed, bounced, complained).
```

> **IMPORTANT**: Neither endpoint is an inbound email inbox or interactive reply mailbox. `notifications@egatepass.tech` does not receive inbound user correspondence.

---

## 4. Cryptographic Key Separation

Each cryptographic purpose strictly requires its own dedicated environment variable. Cross-variable fallbacks and hardcoded default secrets are strictly prohibited:

- **`PASS_TOKEN_SECRET`**: Used solely to derive visitor QR bearer tokens (`createHmac('sha256', PASS_TOKEN_SECRET)`). Rotating this key invalidates unexpired active passes. Must be >= 32 characters.
- **`RETURNING_MATCH_TOKEN_SECRET`**: Used exclusively for signing V3 actor-bound preview tokens and computing biometric match token digests. It NEVER falls back to `PASS_TOKEN_SECRET`. In Production, if missing or fewer than 32 characters, endpoints fail closed with HTTP 503.
- **`RATE_LIMIT_HMAC_SECRET`**: Used exclusively for hashing client network identifiers in rate limiting. It NEVER falls back to `PASS_TOKEN_SECRET` or test strings. In Production, if missing or fewer than 32 characters, pass issuance and lookup fail closed with HTTP 503 `abuse_control_unavailable`.
- **`RETURNING_VISITOR_TEMPLATE_KEY`**: Legacy 32-byte encryption key previously used when returning face embeddings were persisted. Persistent template storage has been retired in Migration 103 (`20261114000200`) and live verification compares transient RAM portraits directly against historical selfie uploads.
- **SMS Gateway Credentials**: See [SMS_INTEGRATION.md](./SMS_INTEGRATION.md) for `SMS_GATEWAY_URL`, `SMS_GATEWAY_USERNAME`, `SMS_GATEWAY_PASSWORD`, `SMS_GATEWAY_DEVICE_ID`, `SEND_SMS_HOOK_SECRET`, and `SMS_INTAKE_SIGNING_KEY`.
- **`OFFICE_VISIT_HMAC_SECRET`**: Used exclusively for signing portrait preview tokens and email challenge verification proof tokens in the office visit workflow (`server/lib/office.ts`). It NEVER falls back to other secrets. In Production, if missing or fewer than 32 characters, endpoints fail closed with HTTP 503.
- **`OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY`**: Used exclusively for authenticated AES-256-GCM encryption of raw QR bearer token payloads in `public.office_visit_email_outbox` (`server/lib/encryption.ts`). Guarantees zero plaintext pass tokens are stored in the database while enabling idempotent email retry. Must be a valid 32-byte (64-hex) key.

---

## 5. Biometric Calibration Authority & Operational Thresholds

Biometric verification modes are governed cryptographically:

1. **Provisional Mode (Active Production Baseline)**:
   - Cosine similarity threshold: `0.363` (`SFACE_PROVISIONAL_COSINE_THRESHOLD`).
   - Requires physical guard station manual verification of the visitor.
   - Historical identification document preview is strictly denied (`403 provisional_mode_cannot_authorize_id_access`).
2. **Calibrated Mode**:
   - Requires an authentic Ed25519-signed envelope in `RETURNING_FACE_CALIBRATION_ARTIFACT`.
   - Verified against pinned authority public key (`PINNED_CALIBRATION_PUBLIC_KEY`).
   - Issued by `EARIST_BIOMETRICS_CALIBRATION_AUTHORITY` with target model `yunet_sface` and inference engine `onnxruntime-node`.
   - If unverified or missing, the system fails closed gracefully.

---

## 6. Legacy Resend SMTP Credential Notice & Action

The historical Resend SMTP API credential (`RESEND_SUPABASE_SMTP_KEY`) was created during initial setup prior to enabling the Supabase Auth Send Email Hook. In the current architecture:
- Supabase Auth dispatches all authentication emails directly to the Send Email Hook via HTTPS.
- SMTP is completely bypassed.
- No application code consumes `RESEND_SUPABASE_SMTP_KEY`, and it has been retired from active configuration.

> [!IMPORTANT]
> **MANUAL OWNER ACTION REQUIRED**
> - **Provider**: Resend
> - **Resource**: API key named `egatepass-supabase-smtp`
> - **Action**: Revoke/delete the legacy key in the Resend dashboard after verifying no SMTP fallback is intentionally retained.
> - **Impact**: Current Send Email Hook + Resend REST API architecture remains unaffected.
> - **Verification afterward**: Confirm Supabase Auth Send Email Hook still succeeds and test invitation/password-reset email delivers.

---

## 7. Node.js Production Runtime Policy

Production runtime policy: Node.js 24.x.

Vercel manages patch-level runtime updates within the selected Node.js major line.

---

## 8. Bundled Font Typography & Static Assets

The platform bundles official Google Noto Sans fonts in `public/fonts/`:
- `public/fonts/NotoSans-Regular.ttf`
- `public/fonts/NotoSans-Bold.ttf`
- `public/fonts/OFL.txt` (SIL Open Font License 1.1)

In `vercel.json`, `api/passes/[...route].ts` bundles required assets via:
```json
  "functions": {
    "api/passes/[...route].ts": {
      "includeFiles": "{public/earist-logo.png,public/fonts/**,server/models/**,node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**}"
    }
  }
```
No external Google Fonts API requests or runtime CDN connections are permitted. All serverless rendering (via `sharp` and `fontconfig`) and client-side PDF exports consume the local bundled fonts.
