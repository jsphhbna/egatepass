-- Migration: 20261104000100_upload_intent_abandon_lifecycle.sql
-- Enables authenticated portal visitors to safely abandon / release their own unclaimed upload intents.
-- Prevents accumulation of pending upload intents across retakes and preflight rejections, protecting against P0003 quota exhaustion.

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
  if not (select private.is_portal_actor()) then
    raise exception using errcode = '42501', message = 'visitor identity required';
  end if;

  perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));

  select * into target_intent
    from public.upload_intents ui
   where ui.id = requested_intent_id
   for update;

  if not found then
    -- Idempotent return if already deleted or does not exist
    return query select true, 'not_found'::text, 'Intent not found or already removed'::text;
    return;
  end if;

  if target_intent.owner_id <> caller_id then
    raise exception using errcode = '42501', message = 'intent ownership mismatch';
  end if;

  if target_intent.source <> 'portal'::public.pass_source then
    raise exception using errcode = '42501', message = 'unsupported intent source';
  end if;

  if target_intent.status = 'claimed'::public.upload_intent_status or target_intent.visitor_id is not null then
    raise exception using errcode = '22023', message = 'cannot abandon claimed intent';
  end if;

  -- Update status to expired so it no longer counts against active pending intents
  update public.upload_intents
     set status = 'expired'::public.upload_intent_status
   where id = requested_intent_id;

  return query select true, 'abandoned'::text, 'Intent abandoned successfully'::text;
end;
$$;

revoke all on function api.abandon_upload_intent(uuid) from public, anon;
grant execute on function api.abandon_upload_intent(uuid) to authenticated;
grant execute on function api.abandon_upload_intent(uuid) to service_role;

comment on function api.abandon_upload_intent(uuid) is
  'Expires an unclaimed, owner-bound portal upload intent on retake or rejection so pending intent quota is preserved.';
