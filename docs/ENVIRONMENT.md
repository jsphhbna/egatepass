# Environment Configuration

Never commit values. `.env.local` is ignored. Validate presence and format without echoing secrets.

| Name | Scope | Required for | Trust |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Browser/build | Supabase client | Public project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser/build | Supabase client | Public publishable key; not authorization |
| `SUPABASE_URL` | Vercel server | Privileged/admin operations | Server configuration |
| `SUPABASE_SECRET_KEY` | Vercel server | Service-role/admin operations | Secret; bypasses RLS |
| `RESEND_API_KEY` | Vercel server | App transactional email | Secret |
| `EMAIL_FROM` | Vercel server | Approved sender identity | Non-secret address, server-owned |
| `RESEND_SUPABASE_SMTP_KEY` | Owner workstation/dashboard only | Configure Supabase Auth SMTP | Secret; application must not read it |
| `CRON_SECRET` | Vercel server/scheduler | Future cleanup invocation | Secret; add only when scheduler exists |

Legacy Firebase/Cloudinary/Netlify names remain necessary only while their implementations remain active. Their presence does not authorize connecting the modernization target to production legacy resources.

S1 validation found both Supabase URL entries syntactically valid and matching after a private, value-free check. Connectivity, project identity, key validity, and environment ownership remain unverified.
