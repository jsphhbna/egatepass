# Environment Configuration

Never commit values. `.env.local` is ignored. Validate presence and format without echoing secrets.

| Name | Scope | Required for | Trust |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Browser/build | Supabase client | Public project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser/build | Supabase client | Public publishable key; not authorization |
| `VITE_TURNSTILE_SITE_KEY` | Browser/build | Cloudflare Turnstile CAPTCHA on Portal (optional in local dev) | Public site key; not authorization |
| `SUPABASE_URL` | Vercel server | Privileged/admin operations | Server configuration |
| `SUPABASE_SECRET_KEY` | Vercel server | Service-role/admin operations | Secret; bypasses RLS |
| `PASS_TOKEN_SECRET` | Vercel server | HMAC derivation of retry-stable QR bearer values | Secret; minimum 32 characters; never browser-visible |
| `RESEND_API_KEY` | Vercel server | App transactional email and Supabase Auth email hook | Secret |
| `RESEND_FROM_EMAIL` | Vercel server | Approved sender identity (alias: `EMAIL_FROM`) | Non-secret address, server-owned |
| `SEND_EMAIL_HOOK_SECRET` | Vercel server | Verification of Supabase Auth Send Email Hook payloads | Secret; minimum 32 characters |
| `CRON_SECRET` | Vercel server/scheduler | Authorization for scheduled retention cleanup invocation | Secret |

Legacy Firebase/Cloudinary/Netlify names remain necessary only while their implementations remain active. Their presence does not authorize connecting the modernization target to production legacy resources.

S1 validation found both Supabase URL entries syntactically valid and matching after a private, value-free check. Connectivity, project identity, key validity, and environment ownership remain unverified.
