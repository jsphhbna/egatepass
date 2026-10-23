-- Migration: 20261023160000_resend_webhook_transactional_rpc.sql
-- Description: Transactional RPC for atomic Resend delivery webhook processing
-- Enforces that claiming provider_event_id and inserting delivery audit commit atomically.
-- If audit insertion fails or errors out, the claim rolls back, enabling safe provider retry.

CREATE OR REPLACE FUNCTION api.record_resend_delivery_event(
  requested_provider_event_id text,
  requested_event_type text,
  requested_email_id text,
  requested_outcome text,
  requested_recipient_masked text,
  requested_subject_sanitized text,
  requested_occurred_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted_id uuid;
  v_audit_id bigint;
  v_occurred timestamptz;
  v_outcome text;
BEGIN
  IF requested_provider_event_id IS NULL OR trim(requested_provider_event_id) = '' THEN
    RAISE EXCEPTION 'missing_provider_event_id' USING errcode = '22023';
  END IF;

  IF requested_event_type IS NULL OR trim(requested_event_type) = '' THEN
    RAISE EXCEPTION 'missing_event_type' USING errcode = '22023';
  END IF;

  v_occurred := coalesce(requested_occurred_at, now());
  v_outcome := CASE
    WHEN requested_outcome IN ('success', 'denied', 'partial', 'failure') THEN requested_outcome
    ELSE 'failure'
  END;

  -- 1. Atomically attempt to claim the provider event ID
  BEGIN
    INSERT INTO public.resend_webhook_events (
      provider_event_id,
      event_type,
      email_id,
      created_at
    )
    VALUES (
      trim(requested_provider_event_id),
      trim(requested_event_type),
      trim(requested_email_id),
      v_occurred
    )
    RETURNING id INTO v_inserted_id;
  EXCEPTION WHEN unique_violation THEN
    -- Replayed or duplicate webhook event: already processed
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_processed',
      'duplicate', true,
      'provider_event_id', trim(requested_provider_event_id),
      'event_type', trim(requested_event_type),
      'email_id', trim(requested_email_id)
    );
  END;

  -- 2. Within the same transaction, insert delivery outcome into audit_events.
  -- If this insert fails, the transaction aborts and the insert into resend_webhook_events rolls back.
  INSERT INTO public.audit_events (
    action,
    actor_kind,
    actor_role,
    target_type,
    target_id,
    outcome,
    after_state,
    occurred_at
  )
  VALUES (
    'resend.delivery_event',
    'system',
    'webhook',
    'email',
    trim(requested_email_id),
    v_outcome,
    jsonb_build_object(
      'eventType', trim(requested_event_type),
      'emailId', trim(requested_email_id),
      'providerEventId', trim(requested_provider_event_id),
      'recipientMasked', requested_recipient_masked,
      'subjectSanitized', requested_subject_sanitized,
      'timestamp', to_char(v_occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    v_occurred
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'processed',
    'duplicate', false,
    'provider_event_id', trim(requested_provider_event_id),
    'event_id', v_inserted_id,
    'audit_id', v_audit_id,
    'email_id', trim(requested_email_id),
    'event_type', trim(requested_event_type),
    'outcome', v_outcome
  );
END;
$$;

-- Restrict execution to service_role (backend serverless functions only)
REVOKE ALL ON FUNCTION api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.record_resend_delivery_event(text, text, text, text, text, text, timestamptz) TO service_role;
