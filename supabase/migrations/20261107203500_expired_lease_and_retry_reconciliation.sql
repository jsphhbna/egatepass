-- Migration 69: Expired Lease Transition to Reconciliation Required and Truthful Claim Invariants
-- 1. Updates api.claim_office_visit_email_for_delivery so that an expired processing lease
--    does NOT automatically become eligible for another delivery dispatch.
--    Instead, it transactionally transitions the row to 'reconciliation_required' (updating both
--    public.office_visit_email_outbox and public.office_visits, and logging an event) and returns
--    a row with claim_id = null (no claim granted) without raising an exception (which would roll back the update).
--    Subsequent claims are blocked by target_outbox.delivery_status in ('unknown', 'reconciliation_required').

create or replace function api.claim_office_visit_email_for_delivery(
  requested_visit_id uuid,
  requested_email_type text
)
returns table (
  outbox_id uuid,
  office_visit_id uuid,
  email_type text,
  recipient_email text,
  encrypted_token_payload text,
  rejection_reason text,
  attempt_count integer,
  claim_id uuid,
  idempotency_key text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_outbox public.office_visit_email_outbox%rowtype;
  new_claim_id uuid;
  v_lease_expiry timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into target_outbox
  from public.office_visit_email_outbox oveo
  where oveo.office_visit_id = requested_visit_id and oveo.email_type = requested_email_type
  for update;

  if not found then
    return;
  end if;

  if target_outbox.delivery_status in ('sent', 'delivered') then
    raise exception using errcode = '40900', message = 'email_already_sent_or_delivered';
  end if;

  if target_outbox.delivery_status in ('unknown', 'reconciliation_required') then
    raise exception using errcode = '40900', message = 'email_delivery_outcome_unknown_reconciliation_required';
  end if;

  if target_outbox.delivery_status = 'processing' then
    if target_outbox.lease_expires_at is not null and target_outbox.lease_expires_at > now() then
      raise exception using errcode = '40900', message = 'email_lease_active_in_progress';
    else
      -- Lease expired: Transition row transactionally to reconciliation_required
      -- Do NOT raise an exception immediately, as an exception rolls back the update.
      update public.office_visit_email_outbox set
        delivery_status = 'reconciliation_required',
        claim_id = null,
        lease_expires_at = null,
        last_error = coalesce(target_outbox.last_error, 'Processing lease expired; reconciliation required before retry.'),
        updated_at = now()
      where id = target_outbox.id;

      update public.office_visits set
        email_delivery_status = 'reconciliation_required',
        email_error = 'Processing lease expired; reconciliation required before retry.',
        updated_at = now()
      where id = target_outbox.office_visit_id;

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_outbox.office_visit_id,
        'email_lease_expired_reconciliation_required',
        null,
        'system',
        jsonb_build_object(
          'outbox_id', target_outbox.id,
          'previous_claim_id', target_outbox.claim_id,
          'lease_expired_at', target_outbox.lease_expires_at,
          'transitioned_at', now()
        )
      );

      -- Return row with claim_id = null: outbox row exists, but no claim granted.
      -- State transition to reconciliation_required is committed in the database.
      return query select
        target_outbox.id,
        target_outbox.office_visit_id,
        target_outbox.email_type,
        target_outbox.recipient_email,
        target_outbox.encrypted_token_payload,
        target_outbox.rejection_reason,
        target_outbox.retry_count,
        null::uuid,
        target_outbox.idempotency_key;
      return;
    end if;
  end if;

  new_claim_id := gen_random_uuid();
  v_lease_expiry := now() + interval '5 minutes';

  if target_outbox.idempotency_key is null then
    target_outbox.idempotency_key := 'office-email-' || target_outbox.id::text;
  end if;

  update public.office_visit_email_outbox set
    delivery_status = 'processing',
    claim_id = new_claim_id,
    claimed_at = now(),
    lease_expires_at = v_lease_expiry,
    retry_count = target_outbox.retry_count + 1,
    idempotency_key = target_outbox.idempotency_key,
    last_attempt_at = now(),
    updated_at = now()
  where id = target_outbox.id;

  update public.office_visits set
    email_delivery_status = 'processing',
    updated_at = now()
  where id = target_outbox.office_visit_id;

  return query select
    target_outbox.id,
    target_outbox.office_visit_id,
    target_outbox.email_type,
    target_outbox.recipient_email,
    target_outbox.encrypted_token_payload,
    target_outbox.rejection_reason,
    target_outbox.retry_count + 1,
    new_claim_id,
    target_outbox.idempotency_key;
end;
$$;

revoke all on function api.claim_office_visit_email_for_delivery(uuid, text) from public, anon, authenticated;
grant execute on function api.claim_office_visit_email_for_delivery(uuid, text) to service_role;
