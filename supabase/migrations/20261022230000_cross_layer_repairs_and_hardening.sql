-- Migration 20261022230000: Cross-Layer Security, Privacy, Lifecycle, and Retention Hardening

-- 1. Separate Photo and ID Retention Columns in App Settings
alter table public.app_settings
  add column if not exists photo_retention_days smallint not null default 7 check (photo_retention_days between 1 and 365),
  add column if not exists id_retention_days smallint not null default 30 check (id_retention_days between 1 and 365);

-- 2. Generalize Staff Password Change Finalization to all human staff roles
create or replace function api.finalize_staff_password_change(target_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_role public.staff_role;
  changed boolean := false;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into target_role
  from public.staff_profiles
  where user_id = target_user_id
  for update;

  if target_role is null or target_role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'eligible human staff identity required';
  end if;

  update public.staff_profiles
  set must_change_password = false
  where user_id = target_user_id
    and role in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role)
    and active
    and must_change_password
  returning true into changed;

  if not coalesce(changed, false) then
    raise exception using errcode = '42501', message = 'eligible human staff identity required';
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, after_state
  ) values (
    target_user_id, 'staff', target_role::text, 'staff.password_change_completed',
    'staff_profile', target_user_id::text, jsonb_build_object('mustChangePassword', false)
  );

  return true;
end;
$$;

revoke all on function api.finalize_staff_password_change(uuid) from public, anon, authenticated;
grant execute on function api.finalize_staff_password_change(uuid) to service_role;

-- Backwards-compatible alias for existing tests and callers
create or replace function api.finalize_guard_password_change(target_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return api.finalize_staff_password_change(target_user_id);
end;
$$;

revoke all on function api.finalize_guard_password_change(uuid) from public, anon, authenticated;
grant execute on function api.finalize_guard_password_change(uuid) to service_role;

-- 3. Require password change on first login for all new human staff accounts (admin and guard)
create or replace function api.create_staff_profile(
  requested_actor_id uuid, requested_user_id uuid, requested_name text, requested_role public.staff_role,
  requested_request_id uuid
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare actor_role public.staff_role;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service role required'; end if;
  select role into actor_role from public.staff_profiles where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;
  if actor_role = 'admin' and requested_role <> 'guard'::public.staff_role then raise exception using errcode = '42501', message = 'admins may create guards only'; end if;
  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then raise exception using errcode = '42501', message = 'administrator required'; end if;
  if requested_role = 'superadmin'::public.staff_role then raise exception using errcode = '42501', message = 'super admin creation requires a role-change review'; end if;
  insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, created_by)
  values (requested_user_id, btrim(requested_name), requested_role, true, true, requested_actor_id);
  insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
  values (requested_actor_id, 'staff', actor_role::text, 'staff.create', 'staff_profile', requested_user_id::text, requested_request_id,
    jsonb_build_object('role', requested_role, 'active', true, 'mustChangePassword', true));
end $$;

revoke all on function api.create_staff_profile(uuid,uuid,text,public.staff_role,uuid) from public, anon, authenticated;
grant execute on function api.create_staff_profile(uuid,uuid,text,public.staff_role,uuid) to service_role;

-- 4. Storage Authorization Hardening: Prevent direct storage reads of claimed visitor evidence
create or replace function private.can_read_storage_object(target_bucket text, target_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.upload_intents ui
    where ui.bucket_id = target_bucket
      and ui.object_path = target_path
      and ui.owner_id = (select auth.uid())
      and ui.status in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      and ui.expires_at > now()
  )
$$;

revoke all on function private.can_read_storage_object(text, text) from public, anon;
grant execute on function private.can_read_storage_object(text, text) to authenticated;

-- 5. Rate limiting RPC backed by public.rate_limit_buckets table
create or replace function api.consume_rate_limit(
  requested_key_hex text,
  requested_action text,
  requested_max_requests integer,
  requested_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  window_start timestamptz;
  bucket_expiry timestamptz;
  current_count integer;
  key_hash bytea;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  key_hash := decode(requested_key_hex, 'hex');
  window_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / requested_window_seconds) * requested_window_seconds);
  bucket_expiry := window_start + make_interval(secs => requested_window_seconds * 2);

  insert into public.rate_limit_buckets (key_digest, action, window_started_at, request_count, expires_at)
  values (key_hash, requested_action, window_start, 1, bucket_expiry)
  on conflict (key_digest, action, window_started_at)
  do update set request_count = public.rate_limit_buckets.request_count + 1
  returning request_count into current_count;

  return current_count <= requested_max_requests;
end;
$$;

revoke all on function api.consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function api.consume_rate_limit(text, text, integer, integer) to service_role;

-- 6. Super Admin Reconciliation Task Resolution RPC
create or replace function api.resolve_reconciliation_task(
  requested_actor_id uuid,
  requested_task_id uuid,
  requested_note text,
  requested_request_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_task public.reconciliation_tasks%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'super administrator required';
  end if;

  select * into target_task
  from public.reconciliation_tasks
  where id = requested_task_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'reconciliation task not found';
  end if;

  if target_task.status = 'resolved'::public.reconciliation_status then
    return true;
  end if;

  update public.reconciliation_tasks
  set status = 'resolved'::public.reconciliation_status,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      safe_context = coalesce(safe_context, '{}'::jsonb) || jsonb_build_object(
        'resolved_by', requested_actor_id,
        'resolution_note', nullif(btrim(requested_note), '')
      )
  where id = requested_task_id;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id, 'staff', 'superadmin', 'reconciliation.resolved',
    'reconciliation_task', requested_task_id::text, requested_request_id,
    jsonb_build_object('status', target_task.status),
    jsonb_build_object('status', 'resolved', 'resolved_by', requested_actor_id, 'note', nullif(btrim(requested_note), ''))
  );

  return true;
end;
$$;

revoke all on function api.resolve_reconciliation_task(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.resolve_reconciliation_task(uuid, uuid, text, uuid) to service_role;

-- 7. App Settings Update RPC: Peak Mode modification is Super Admin-only & separate retention days
create or replace function api.update_app_settings(
  requested_actor_id uuid,
  requested_peak_mode public.peak_mode_scope,
  requested_rejection_reasons jsonb,
  requested_visit_purposes jsonb,
  requested_working_hours_start time,
  requested_working_hours_end time,
  requested_image_retention_days smallint,
  requested_visitor_retention_days smallint,
  requested_audit_retention_days smallint,
  requested_reconciliation_retention_days smallint,
  requested_scheduling_days_ahead smallint,
  requested_automatic_cleanup_enabled boolean,
  requested_request_id uuid,
  requested_photo_retention_days smallint default null,
  requested_id_retention_days smallint default null
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_role public.staff_role;
  current_settings public.app_settings%rowtype;
  changes_security_settings boolean;
  new_peak_mode public.peak_mode_scope;
  new_reasons jsonb;
  new_purposes jsonb;
  new_start time;
  new_end time;
  new_image_ret smallint;
  new_photo_ret smallint;
  new_id_ret smallint;
  new_vis_ret smallint;
  new_audit_ret smallint;
  new_rec_ret smallint;
  new_sched smallint;
  new_cleanup boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into current_settings from public.app_settings where singleton for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'settings not found';
  end if;

  changes_security_settings := (
    (requested_peak_mode is not null and requested_peak_mode <> current_settings.peak_mode) or
    (requested_working_hours_start is not null and requested_working_hours_start <> current_settings.working_hours_start) or
    (requested_working_hours_end is not null and requested_working_hours_end <> current_settings.working_hours_end) or
    (requested_image_retention_days is not null and requested_image_retention_days <> current_settings.image_retention_days) or
    (requested_photo_retention_days is not null and requested_photo_retention_days <> current_settings.photo_retention_days) or
    (requested_id_retention_days is not null and requested_id_retention_days <> current_settings.id_retention_days) or
    (requested_visitor_retention_days is not null and requested_visitor_retention_days <> current_settings.visitor_retention_days) or
    (requested_audit_retention_days is not null and requested_audit_retention_days <> current_settings.audit_retention_days) or
    (requested_reconciliation_retention_days is not null and requested_reconciliation_retention_days <> current_settings.reconciliation_retention_days) or
    (requested_scheduling_days_ahead is not null and requested_scheduling_days_ahead <> current_settings.scheduling_days_ahead) or
    (requested_automatic_cleanup_enabled is not null and requested_automatic_cleanup_enabled <> current_settings.automatic_cleanup_enabled)
  );

  if changes_security_settings and actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'super administrator required for security settings';
  end if;

  new_peak_mode := coalesce(requested_peak_mode, current_settings.peak_mode);
  new_reasons := coalesce(requested_rejection_reasons, current_settings.rejection_reasons);
  new_purposes := coalesce(requested_visit_purposes, current_settings.visit_purposes);
  new_start := coalesce(requested_working_hours_start, current_settings.working_hours_start);
  new_end := coalesce(requested_working_hours_end, current_settings.working_hours_end);
  new_photo_ret := coalesce(requested_photo_retention_days, requested_image_retention_days, current_settings.photo_retention_days);
  new_id_ret := coalesce(requested_id_retention_days, current_settings.id_retention_days);
  new_image_ret := coalesce(requested_image_retention_days, new_photo_ret, current_settings.image_retention_days);
  new_vis_ret := coalesce(requested_visitor_retention_days, current_settings.visitor_retention_days);
  new_audit_ret := coalesce(requested_audit_retention_days, current_settings.audit_retention_days);
  new_rec_ret := coalesce(requested_reconciliation_retention_days, current_settings.reconciliation_retention_days);
  new_sched := coalesce(requested_scheduling_days_ahead, current_settings.scheduling_days_ahead);
  new_cleanup := coalesce(requested_automatic_cleanup_enabled, current_settings.automatic_cleanup_enabled);

  if new_start >= new_end then
    raise exception using errcode = '22023', message = 'start time must be earlier than end time';
  end if;

  update public.app_settings
  set
    peak_mode = new_peak_mode,
    rejection_reasons = new_reasons,
    visit_purposes = new_purposes,
    working_hours_start = new_start,
    working_hours_end = new_end,
    image_retention_days = new_image_ret,
    photo_retention_days = new_photo_ret,
    id_retention_days = new_id_ret,
    visitor_retention_days = new_vis_ret,
    audit_retention_days = new_audit_ret,
    reconciliation_retention_days = new_rec_ret,
    scheduling_days_ahead = new_sched,
    automatic_cleanup_enabled = new_cleanup,
    updated_at = clock_timestamp()
  where singleton;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  )
  values (
    requested_actor_id, 'staff', actor_role::text, 'settings_updated', 'app_settings', 'singleton', requested_request_id,
    to_jsonb(current_settings),
    jsonb_build_object(
      'peak_mode', new_peak_mode,
      'rejection_reasons', new_reasons,
      'visit_purposes', new_purposes,
      'working_hours_start', new_start,
      'working_hours_end', new_end,
      'image_retention_days', new_image_ret,
      'photo_retention_days', new_photo_ret,
      'id_retention_days', new_id_ret,
      'visitor_retention_days', new_vis_ret,
      'audit_retention_days', new_audit_ret,
      'reconciliation_retention_days', new_rec_ret,
      'scheduling_days_ahead', new_sched,
      'automatic_cleanup_enabled', new_cleanup
    )
  );
end $$;

revoke all on function api.update_app_settings(uuid,public.peak_mode_scope,jsonb,jsonb,time,time,smallint,smallint,smallint,smallint,smallint,boolean,uuid,smallint,smallint) from public, anon, authenticated;
grant execute on function api.update_app_settings(uuid,public.peak_mode_scope,jsonb,jsonb,time,time,smallint,smallint,smallint,smallint,smallint,boolean,uuid,smallint,smallint) to service_role;

-- 8. Atomic Pass Issuance with Separate Photo vs Valid-ID Retention
create or replace function api.issue_pass(
  requested_actor_id uuid,
  requested_source public.pass_source,
  requested_request_id uuid,
  requested_full_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid,
  requested_photo_bytes integer,
  requested_photo_sha256 text,
  requested_id_intent_id uuid,
  requested_id_bytes integer,
  requested_id_sha256 text,
  requested_token_digest text
)
returns table (
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  settings public.app_settings%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  id_is_required boolean;
  photo_retention_val integer;
  id_retention_val integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false)
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  elsif requested_source = 'kiosk'::public.pass_source then
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active kiosk identity required';
    end if;
  else
    raise exception using errcode = '22023', message = 'unsupported source';
  end if;

  -- Serialize retries so concurrent requests cannot race past the idempotency check.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));
  select p.id, p.public_reference, p.valid_from, p.valid_until
  into pass_id, public_reference, valid_from, valid_until
  from public.passes p
  join public.visitors v on v.id = p.visitor_id
  where p.issue_request_id = requested_request_id
    and v.owner_id = requested_actor_id
    and v.source = requested_source;
  if found then return next; return; end if;

  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
  end if;
  if char_length(btrim(requested_full_name)) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'invalid visitor details';
  end if;

  id_is_required := not (
    settings.peak_mode = 'both'::public.peak_mode_scope
    or (settings.peak_mode = 'portal'::public.peak_mode_scope and requested_source = 'portal'::public.pass_source)
    or (settings.peak_mode = 'kiosk'::public.peak_mode_scope and requested_source = 'kiosk'::public.pass_source)
  );
  if id_is_required and requested_id_intent_id is null then
    raise exception using errcode = '22023', message = 'identification image required';
  end if;

  select * into photo_intent from public.upload_intents
  where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id
    or photo_intent.source <> requested_source or photo_intent.kind <> 'photo'::public.evidence_kind
    or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents
    where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> requested_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    purpose, visit_date, consent_accepted_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number), btrim(requested_purpose),
    requested_visit_date, now()
  ) returning id into new_visitor_id;

  photo_retention_val := coalesce(settings.photo_retention_days, settings.image_retention_days, 7)::integer;
  id_retention_val := coalesce(settings.id_retention_days, 30)::integer;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), greatest(
      now() + make_interval(days => photo_retention_val),
      ends_at + interval '1 day'
    )
  );
  update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
  where id = photo_intent.id;

  if requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_bytes,
      requested_id_sha256, now(), greatest(
        now() + make_interval(days => id_retention_val),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  new_public_reference := gen_random_uuid();
  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id,
    public_reference
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), requested_source, 'issued',
    starts_at, ends_at, requested_request_id, new_public_reference
  ) returning id into new_pass_id;

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_pass(uuid,public.pass_source,uuid,text,text,text,date,uuid,integer,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function api.issue_pass(uuid,public.pass_source,uuid,text,text,text,date,uuid,integer,text,uuid,integer,text,text) to service_role;
