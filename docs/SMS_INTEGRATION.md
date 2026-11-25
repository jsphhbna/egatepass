# SMS Gateway & Alerts Integration

EARIST E-GatePass integrates SMS emergency broadcasts, overdue-exit warnings, and inbound emergency SMS intake using the free **SMS Gateway for Android (Cloud Mode via `api.sms-gate.app`)**, paired with Supabase Edge Functions (`send-sms`, `sms-intake`), Vercel admin endpoints (`/api/admin/sms`), and PostgreSQL atomic quota accounting.

---

## 1. Architecture Overview

- **Outbound Admin Broadcasts (`POST /api/admin/sms?action=send`):**
  - Authenticated Super Admins and Admins trigger `emergency`, `overdue`, or single-number `test` broadcasts from `/admin/settings` (or Admin emergency controls).
  - Server handler (`server/routes/admin/sms.ts`) normalizes Philippine mobile numbers (`09xxxxxxxxx`, `639xxxxxxxxx`, `+639xxxxxxxxx`) to E.164 `+639xxxxxxxxx`, deduplicates recipients, reserves daily capacity atomically via `api.check_and_reserve_sms_quota`, dispatches batches of up to 50 numbers via `server/sms.ts` (`sendGatewaySms`), and finalizes quota (`api.finalize_sms_quota`) with exact parameters `(p_campaign_id, p_outcome, requested_actor_id)`.
- **Supabase Auth Send SMS Hook (`supabase/functions/send-sms`):**
  - Deno Edge Function verifying Standard Webhook signatures (`SEND_SMS_HOOK_SECRET`) with constant-time byte comparison and a 5-minute replay window (`webhook-id`, `webhook-timestamp`).
- **Inbound Emergency SMS Intake (`supabase/functions/sms-intake`):**
  - Deno Edge Function receiving Android Gateway `sms:received` events authenticated via `SMS_INTAKE_SIGNING_KEY` (`X-Signature` / `X-Timestamp`).
  - Parses compact `EG1|<msgId>|<type>|<lat>|<lon>|<timestamp>` emergency payloads into `public.emergency_inbound_reports` using replay-safe durable deduplication.

---

## 2. Environment Configuration

| Variable | Storage Location | Purpose |
|---|---|---|
| `SMS_GATEWAY_URL` | Vercel (Production) | Cloud API endpoint (defaults to `https://api.sms-gate.app/3rdparty/v1/messages`; HTTPS required outside localhost dev) |
| `SMS_GATEWAY_USERNAME` | Vercel (Production) | SMS Gateway account username for Basic Auth |
| `SMS_GATEWAY_PASSWORD` | Vercel (Production) | SMS Gateway account password (rotate carefully in Vercel; never commit or expose) |
| `SMS_GATEWAY_DEVICE_ID` | Vercel (Production) | Explicit target Android device ID bound to campus SIM |
| `SEND_SMS_HOOK_SECRET` | Vercel / Supabase Edge Functions | Standard Webhook signing secret for `send-sms` |
| `SMS_INTAKE_SIGNING_KEY` | Supabase Edge Functions / Gateway Webhook | HMAC signing key for inbound `sms-intake` (`X-Signature`) |

> All credentials must remain outside client bundles and `.env.example` stays secret-free.

---

## 3. Operational & Free-Tier Limitations

Administrators and testers must treat SMS dispatch metrics accurately:

1. **Gateway Acceptance ≠ Handset Delivery:** HTTP `200`/`201` from `api.sms-gate.app` records status as `accepted_by_gateway` (queued to the bound Android device). Carrier delivery receipts and SIM transmission happen downstream on the Android phone.
2. **15-Second Dispatch Timeout:** Gateway requests time out after 15 seconds (`AbortSignal`), recording status `unknown` (counted against quota as `timeout` rather than `released` to prevent double-broadcast bypasses).
3. **Atomic Daily Quota Ceiling:** `public.sms_daily_quotas` and `public.sms_quota_reservations` enforce a daily safety cap (`asia/manila` date boundary) in PostgreSQL so carrier/SIM limits cannot be exhausted by concurrent admin retries.
4. **Device Online Prerequisite:** Because Cloud Mode relays messages through a physical Android device running SMS Gateway with an active Philippine SIM load/promo, messages remain queued or fail if the handset loses power, cellular signal, or Wi-Fi/mobile data.
5. **Privacy-Safe Logging:** `public.sms_logs` stores masked phone numbers (`0917 ••• 4567`) and masked device IDs (`_3D0f ••• 9KM`), omitting raw PII bodies and redacting Basic Auth / URL credentials via `sanitizeErrorMessage`.
