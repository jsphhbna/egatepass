-- Migration: 20261023140000_resend_webhook_idempotency.sql
-- Description: Dedicated table for atomic database-level idempotency of Resend delivery webhooks
-- Canonical uniqueness enforced on signed provider event ID (svix-id / webhook-id)

CREATE TABLE IF NOT EXISTS public.resend_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  email_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resend_webhook_events_provider_id_unique UNIQUE (provider_event_id)
);

-- Enable Row Level Security (RLS) - default deny all public/anon/authenticated access
ALTER TABLE public.resend_webhook_events ENABLE ROW LEVEL SECURITY;

-- Explicitly grant service_role backend access only
GRANT SELECT, INSERT ON public.resend_webhook_events TO service_role;
