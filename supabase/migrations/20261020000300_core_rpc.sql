-- Narrow browser-callable RPC surface. Privileged functions re-authorize callers
-- from protected rows and never trust JWT user metadata for application roles.

create schema if not exists api;
revoke all on schema api from public, anon, authenticated;
grant usage on schema api to authenticated;

create or replace function api.current_actor()
returns table (
  actor_id uuid,
  actor_kind text,
  staff_role public.staff_role,
  device_type public.device_type,
  active boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select (select auth.uid()), 'staff'::text, (select private.current_staff_role()), null::public.device_type, true
  where (select private.current_staff_role()) is not null
  union all
  select (select auth.uid()), 'device'::text, null::public.staff_role, (select private.current_device_type()), true
  where (select private.current_device_type()) is not null
  union all
  select (select auth.uid()), 'visitor'::text, null::public.staff_role, null::public.device_type, true
  where (select private.is_portal_actor())
$$;

create or replace function api.create_upload_intent(
  requested_source public.pass_source,
  requested_kind public.evidence_kind,
  requested_content_type text
)
returns table (
  intent_id uuid,
  bucket_id text,
  object_path text,
  expires_at timestamptz,
  max_bytes integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  caller_device_type public.device_type := (select private.current_device_type());
  new_intent_id uuid := gen_random_uuid();
  target_bucket text;
  target_extension text;
  target_path text;
  target_expiry timestamptz := now() + interval '15 minutes';
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if requested_source = 'kiosk'::public.pass_source then
    if caller_device_type is distinct from 'kiosk'::public.device_type then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  elsif requested_source = 'portal'::public.pass_source then
    if not (select private.is_portal_actor()) then
      raise exception using errcode = '42501', message = 'visitor identity required';
    end if;
  else
    raise exception using errcode = '22023', message = 'unsupported source';
  end if;

  target_bucket := case requested_kind
    when 'photo'::public.evidence_kind then 'visitor-photos'
    when 'id'::public.evidence_kind then 'visitor-ids'
  end;
  target_extension := case requested_content_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    else null
  end;
  if target_extension is null then
    raise exception using errcode = '22023', message = 'unsupported content type';
  end if;

  target_path := caller_id::text || '/' || new_intent_id::text || '/' || requested_kind::text || '.' || target_extension;
  insert into public.upload_intents (
    id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, expires_at
  ) values (
    new_intent_id, caller_id, requested_source, requested_kind, target_bucket,
    target_path, requested_content_type, 5242880, target_expiry
  );

  return query select new_intent_id, target_bucket, target_path, target_expiry, 5242880;
end;
$$;

revoke all on function api.current_actor() from public, anon;
revoke all on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) from public, anon;
grant execute on function api.current_actor() to authenticated;
grant execute on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) to authenticated;

comment on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) is
  'Creates a one-use, owner-bound, short-lived private Storage upload intent. File content is still server-validated before claim/pass issue.';
