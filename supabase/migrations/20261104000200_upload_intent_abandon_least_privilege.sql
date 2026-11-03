-- Migration: 20261104000200_upload_intent_abandon_least_privilege.sql
-- Hardens api.abandon_upload_intent:
-- 1. Enforces least-privilege by revoking execute grant from service_role.
--    Only authenticated portal visitors (with genuine anonymous user JWT) are permitted.
-- 2. Refines idempotency for already-expired intents.
-- 3. Strictly prevents abandonment of claimed intents or evidence associated with a visitor.

create or replace function api.abandon_upload_intent(
  requested_intent_id uuid
)
returns table (
  ok boolean,
  code text,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target_intent public.upload_intents%rowtype;
begin
  -- 1. Actor verification: Must be a genuine anonymous portal visitor
  if not (select private.is_portal_actor()) then
    raise exception using errcode = '42501', message = 'visitor identity required';
  end if;

  -- 2. Transaction-level advisory lock per visitor to serialize intent modifications
  perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));

  -- 3. Row-level exclusive lock on the target upload intent
  select * into target_intent
    from public.upload_intents ui
   where ui.id = requested_intent_id
   for update;

  if not found then
    -- Idempotent return if already deleted or does not exist
    return query select true, 'not_found'::text, 'Intent not found or already removed'::text;
    return;
  end if;

  -- 4. Ownership verification: caller must own this intent
  if target_intent.owner_id <> caller_id then
    raise exception using errcode = '42501', message = 'intent ownership mismatch';
  end if;

  -- 5. Scope boundary: only portal intents may be abandoned through this path
  if target_intent.source <> 'portal'::public.pass_source then
    raise exception using errcode = '42501', message = 'unsupported intent source';
  end if;

  -- 6. Immutability guard: claimed evidence or evidence tied to a visitor pass must never be expired
  if target_intent.status = 'claimed'::public.upload_intent_status or target_intent.visitor_id is not null then
    raise exception using errcode = '22023', message = 'cannot abandon claimed intent';
  end if;

  -- 7. Idempotent short-circuit if intent is already expired
  if target_intent.status = 'expired'::public.upload_intent_status then
    return query select true, 'already_expired'::text, 'Intent was already expired'::text;
    return;
  end if;

  -- 8. Transition status to expired so it immediately frees active pending quota
  update public.upload_intents
     set status = 'expired'::public.upload_intent_status
   where id = requested_intent_id;

  return query select true, 'abandoned'::text, 'Intent abandoned successfully'::text;
end;
$$;

revoke all on function api.abandon_upload_intent(uuid) from public, anon, service_role;
grant execute on function api.abandon_upload_intent(uuid) to authenticated;

comment on function api.abandon_upload_intent(uuid) is
  'Expires an unclaimed, owner-bound portal upload intent on retake or rejection so pending intent quota is preserved.';
