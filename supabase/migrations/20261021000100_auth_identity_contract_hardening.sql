-- =============================================================================
-- Migration: 20261021000100_auth_identity_contract_hardening.sql
-- Description: Recovery session confinement in RLS, genuine anonymous Portal actor classification,
--              disambiguation of upload intent expires_at, and restrictive app_settings grants.
-- =============================================================================

-- =============================================================================
-- 1. RECOVERY SESSION CONFINEMENT
-- =============================================================================

-- Helper to inspect verified JWT claims in PostgREST request context safely
create or replace function private.jwt_claims()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
    else current_setting('request.jwt.claims', true)::jsonb
  end
$$;

revoke all on function private.jwt_claims() from public, anon;
grant execute on function private.jwt_claims() to authenticated;

-- Helper to determine if current PostgREST request is authenticated via password recovery
create or replace function private.is_recovery_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof((select private.jwt_claims()) -> 'amr') = 'array'
        then (select private.jwt_claims()) -> 'amr'
        else '[]'::jsonb
      end
    ) as elem
    where elem ->> 'method' = 'recovery'
  )
$$;

revoke all on function private.is_recovery_session() from public, anon;
grant execute on function private.is_recovery_session() to authenticated;

-- Harden private.current_staff_role() to exclude recovery sessions:
-- A password recovery session must NOT resolve to an operational staff role.
create or replace function private.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select sp.role
  from public.staff_profiles sp
  join auth.users u on u.id = sp.user_id
  where sp.user_id = (select auth.uid())
    and sp.active = true
    and u.email_confirmed_at is not null
    and sp.must_change_password = false
    and sp.privacy_accepted_at is not null
    and not (select private.is_recovery_session())
  limit 1
$$;

revoke all on function private.current_staff_role() from public, anon;
grant execute on function private.current_staff_role() to authenticated;

-- =============================================================================
-- 2. GENUINE ANONYMOUS AUTH PORTAL ACTOR CLASSIFICATION & UPLOAD INTENTS
-- =============================================================================

-- Redefine private.is_portal_actor():
-- Must require genuine Supabase anonymous Auth user (auth.users.is_anonymous = true)
-- AND not a staff profile AND not a device. Permanent non-staff users are NOT portal visitors.
create or replace function private.is_portal_actor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from auth.users u
      where u.id = (select auth.uid())
        and coalesce(u.is_anonymous, false) = true
    )
    and not exists (select 1 from public.staff_profiles sp where sp.user_id = (select auth.uid()))
    and not exists (select 1 from public.devices d where d.user_id = (select auth.uid()))
$$;

revoke all on function private.is_portal_actor() from public, anon;
grant execute on function private.is_portal_actor() to authenticated;

-- Define api.current_actor() with security definer so authenticated callers can safely
-- resolve their actor identity without requiring direct schema privileges on private.*.
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
security definer
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

revoke all on function api.current_actor() from public, anon;
grant execute on function api.current_actor() to authenticated;

-- Hardened api.create_upload_intent with table-alias qualification to avoid ambiguous
-- column reference between upload_intents.expires_at and returns table output variable expires_at.
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
  pending_count integer;
begin
  if requested_source = 'kiosk'::public.pass_source then
    if caller_device_type is distinct from 'kiosk'::public.device_type then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  elsif requested_source = 'portal'::public.pass_source then
    if not (select private.is_portal_actor()) then
      raise exception using errcode = '42501', message = 'visitor identity required';
    end if;

    -- Serialize concurrent upload intent creations per caller
    perform pg_advisory_xact_lock(hashtext('upload_intent:' || caller_id::text));

    -- Cap active pending intents for anonymous portal callers
    select count(*) into pending_count
      from public.upload_intents ui
     where ui.owner_id = caller_id
       and ui.status = 'pending'::public.upload_intent_status
       and ui.expires_at > statement_timestamp();

    if pending_count >= 10 then
      raise exception using errcode = 'P0003', message = 'too_many_pending_intents';
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

revoke all on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) from public, anon;
grant execute on function api.create_upload_intent(public.pass_source, public.evidence_kind, text) to authenticated;

-- =============================================================================
-- 3. RESTRICTIVE APP_SETTINGS COLUMN-LEVEL GRANTS FOR AUTHENTICATED ROLE
-- =============================================================================

-- An anonymous Auth visitor acquires the PostgreSQL role 'authenticated'.
-- Broad table-level SELECT on app_settings leaks retention and security settings.
-- Revoke broad select and grant ONLY the 6 safe public registration columns to authenticated.
revoke all on public.app_settings from authenticated;
grant select (
  working_hours_start,
  working_hours_end,
  timezone,
  scheduling_days_ahead,
  peak_mode,
  visit_purposes
) on public.app_settings to authenticated;