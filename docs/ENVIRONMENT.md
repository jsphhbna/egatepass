# Environment Variables Contract

This document is the authoritative specification for all configuration and secrets across the client, serverless functions, and external integrations in the EARIST E-GatePass platform.

> **CRITICAL SECURITY RULE**: Never commit real secret values, credentials, or production tokens into version control. Local overrides belong in `.env.local`, which is strictly ignored by Git.

---

## 1. Authoritative Environment Variables Matrix

| Variable | Scope | Secret? | Consumer / Used By | Production Required? | Purpose & Format Specification |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | Production, Preview, Local | No | Client application (`src/lib/supabase.ts`) | **Yes** | `https://<project-ref>.supabase.co` (Public Supabase API Gateway) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Production, Preview, Local | No | Client application (`src/lib/supabase.ts`) | **Yes** | `sb_publishable_...` (Supabase publishable browser key; intentionally public and safe for browser use when RLS is correctly enforced) |
| `VITE_TURNSTILE_SITE_KEY` | Production, Local | No | Cloudflare Turnstile widget (`src/pages/GetPassPage.tsx`, `LoginPage.tsx`) | **Yes** (Prod) | `0x4AAAAAA...` (Public Cloudflare Turnstile Managed widget site key; scoped to Production in Vercel) |
| `SUPABASE_URL` | Production, Preview, Local | No | Serverless API Functions (`server/supabase.ts`) | **Yes** | `https://<project-ref>.supabase.co` (Backend Supabase endpoint) |
| `SUPABASE_SECRET_KEY` | Production Only | **Yes** | Serverless admin client (`server/supabase.ts`) | **Yes** | High-privilege Supabase service-role secret; strictly isolated to Production |
| `PASS_TOKEN_SECRET` | Production Only | **Yes** | QR bearer token derivation (`server/routes/passes/issue.ts`) | **Yes** | High-entropy cryptographic secret (**minimum 32 characters**) for HMAC-SHA256 QR tokens |
| `RATE_LIMIT_HMAC_SECRET` | Production Only | **Yes** | Network abuse rate limiting (`server/routes/passes/issue.ts`) | **Yes** | Dedicated high-entropy key (**minimum 32 characters**) for hashing client IP/subnet |
| `RESEND_API_KEY` | Production Only | **Yes** | Resend REST API client (`server/email.ts`) | **Yes** | `re_...` provider-issued transactional email API key |
| `RESEND_FROM_EMAIL` | Production, Local | No | Sender identity (`server/email.ts`) | **Yes** | Authoritative sender: `EARIST E-GatePass <notifications@egatepass.tech>` |
| `SEND_EMAIL_HOOK_SECRET` | Production Only | **Yes** | Supabase Auth Send Email Hook (`server/routes/auth/send-email-hook.ts`) | **Yes** | Shared secret configured in Supabase Auth Webhook settings |
| `RESEND_WEBHOOK_SECRET` | Production Only | **Yes** | Resend Delivery Webhook (`server/routes/auth/resend-webhook.ts`) | **Yes** | `whsec_...` signing secret for Resend delivery event verification |
| `CRON_SECRET` | Production Only | **Yes** | Retention maintenance authorization (`server/routes/admin/retention-maintenance.ts`) | **Yes** | Shared bearer token (**minimum 32 characters**) for Vercel Cron invocations |

> **Turnstile Private Key Note**: The Cloudflare Turnstile Secret Key is configured directly inside the Supabase Dashboard under **Authentication > Bot Protection / CAPTCHA**, where Supabase Auth verifies tokens for `signInAnonymously`. It is NEVER exposed to Vercel or frontend bundles.

---

## 2. Preview Environment Isolation Architecture

Generic Vercel Preview deployments are protected by Vercel Deployment Protection (SSO). However, to prevent experimental preview code or pull request builds from accessing live production data or services:

```text
Production Scope (egatepass.tech)
├─ Public / Non-sensitive configuration (VITE_SUPABASE_URL, SUPABASE_URL, etc.)
└─ Full external provider credentials (SUPABASE_SECRET_KEY, RESEND_API_KEY, PASS_TOKEN_SECRET,
     CRON_SECRET, RATE_LIMIT_HMAC_SECRET, SEND_EMAIL_HOOK_SECRET, RESEND_WEBHOOK_SECRET)

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

- **`PASS_TOKEN_SECRET`**: Used solely to derive visitor QR bearer tokens (`createHmac('sha256', PASS_TOKEN_SECRET)`). Rotating this key invalidates unexpired active passes.
- **`RATE_LIMIT_HMAC_SECRET`**: Used exclusively for hashing client network identifiers in rate limiting. It NEVER falls back to `PASS_TOKEN_SECRET`. In Production, if `RATE_LIMIT_HMAC_SECRET` is missing or fewer than 32 characters, pass issuance fails closed with HTTP 503 `abuse_control_unavailable`.

---

## 5. Legacy Resend SMTP Credential Notice & Action

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

## 6. Node.js Production Runtime Policy

Production runtime policy: Node.js 24.x.

Vercel manages patch-level runtime updates within the selected Node.js major line.
