-- =============================================================================
-- Migration 90: Security Hardening, Human 15m Idle Sessions, Global Retention
-- Freeze, Transactional Office/Personnel/Calendar Audits & FK/RLS Advisor Cleanup
-- =============================================================================

-- 1. Global Institutional Retention Freeze columns on app_settings
alter table public.app_settings
  add column if not exists global_retention_freeze boolean not null default false,
  add column if not exists global_retention_freeze_reason text,
  add column if not exists global_retention_freeze_updated_by uuid references auth.users(id) on delete set null,
  add column if not exists global_retention_freeze_updated_at timestamptz;

-- 2. Foreign-key indexes for advisor cleanliness (including M88/M89/M90 FKs)
create index if not exists idx_offices_published_by on public.offices (published_by) where published_by is not null;
create index if not exists idx_offices_archived_by on public.offices (archived_by) where archived_by is not null;
create index if not exists idx_calendar_archived_by on public.campus_calendar_closures (archived_by) where archived_by is not null;
create index if not exists idx_app_settings_freeze_updated_by on public.app_settings (global_retention_freeze_updated_by) where global_retention_freeze_updated_by is not null;
create index if not exists idx_emergency_device_manifests_created_by on public.emergency_device_manifests (created_by) where created_by is not null;
create index if not exists idx_emergency_gate_records_reconciled_by on public.emergency_gate_records (reconciled_by) where reconciled_by is not null;
create index if not exists idx_emergency_gate_records_manifest_id on public.emergency_gate_records (manifest_id) where manifest_id is not null;
create index if not exists idx_emergency_sync_receipts_actor_id on public.emergency_sync_receipts (actor_id) where actor_id is not null;

-- 3. Server-enforced 15-minute Human Inactivity Session Table (separate from managed devices)
create table if not exists public.staff_sessions (
  session_id text primary key check (char_length(btrim(session_id)) between 8 and 200),
  user_id uuid not null references public.staff_profiles(user_id) on delete cascade,
  role public.staff_role not null,
  last_active_at timestamptz not null default now(),
  idle_timeout_seconds integer not null default 900 check (idle_timeout_seconds between 60 and 3600),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  expired_at timestamptz,
  expired_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_staff_sessions_user_created on public.staff_sessions (user_id, created_at desc);
create index if not exists idx_staff_sessions_active_expires on public.staff_sessions (expires_at) where expired_at is null;

alter table public.staff_sessions enable row level security;
revoke all on table public.staff_sessions from public, anon, authenticated;
grant select on table public.staff_sessions to authenticated, service_role;

drop policy if exists staff_sessions_select on public.staff_sessions;
create policy staff_sessions_select on public.staff_sessions
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_staff_role(array['superadmin']::public.staff_role[]))
  );

-- 4. RPC: api.touch_staff_session (server authoritative idle timeout tracking per session_id)
create or replace function api.touch_staff_session(
  requested_session_id text,
  requested_user_id uuid,
  requested_create_only boolean default false,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_staff public.staff_profiles%rowtype;
  v_sess public.staff_sessions%rowtype;
  v_now timestamptz := statement_timestamp();
  v_timeout_interval interval := interval '15 minutes';
  v_clean_sid text := btrim(coalesce(requested_session_id, ''));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if char_length(v_clean_sid) < 8 or requested_user_id is null then
    return jsonb_build_object('valid', false, 'expired', true, 'reason', 'invalid_session_identifier');
  end if;

  select * into v_staff
  from public.staff_profiles sp
  where sp.user_id = requested_user_id
    and sp.active = true;

  if not found then
    return jsonb_build_object('valid', false, 'expired', true, 'reason', 'staff_inactive_or_not_found');
  end if;

  select * into v_sess
  from public.staff_sessions s
  where s.session_id = v_clean_sid
  for update;

  if not found then
    insert into public.staff_sessions(
      session_id, user_id, role, last_active_at, idle_timeout_seconds, expires_at
    ) values (
      v_clean_sid, requested_user_id, v_staff.role, v_now, 900, v_now + v_timeout_interval
    )
    returning * into v_sess;

    return jsonb_build_object(
      'valid', true,
      'expired', false,
      'sessionId', v_sess.session_id,
      'lastActiveAt', v_sess.last_active_at,
      'expiresAt', v_sess.expires_at,
      'idleTimeoutSeconds', v_sess.idle_timeout_seconds
    );
  end if;

  if v_sess.user_id <> requested_user_id then
    return jsonb_build_object('valid', false, 'expired', true, 'reason', 'session_owner_mismatch');
  end if;

  if v_sess.expired_at is not null or v_now > v_sess.expires_at then
    if v_sess.expired_at is null then
      update public.staff_sessions
      set expired_at = v_now,
          expired_reason = coalesce(expired_reason, 'idle_timeout_15m'),
          updated_at = v_now
      where session_id = v_sess.session_id;

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
      ) values (
        requested_user_id,
        'staff',
        v_staff.role::text,
        'staff.session_idle_expired',
        'staff_session',
        left(v_clean_sid, 64),
        coalesce(requested_request_id, gen_random_uuid()),
        jsonb_build_object('lastActiveAt', v_sess.last_active_at, 'expiredAt', v_now, 'reason', 'idle_timeout_15m')
      );
    end if;

    return jsonb_build_object(
      'valid', false,
      'expired', true,
      'expiredAt', coalesce(v_sess.expired_at, v_now),
      'reason', coalesce(v_sess.expired_reason, 'idle_timeout_15m')
    );
  end if;

  if requested_create_only then
    return jsonb_build_object(
      'valid', true,
      'expired', false,
      'sessionId', v_sess.session_id,
      'lastActiveAt', v_sess.last_active_at,
      'expiresAt', v_sess.expires_at,
      'idleTimeoutSeconds', v_sess.idle_timeout_seconds
    );
  end if;

  update public.staff_sessions
  set last_active_at = v_now,
      expires_at = v_now + v_timeout_interval,
      role = v_staff.role,
      updated_at = v_now
  where session_id = v_sess.session_id
  returning * into v_sess;

  return jsonb_build_object(
    'valid', true,
    'expired', false,
    'sessionId', v_sess.session_id,
    'lastActiveAt', v_sess.last_active_at,
    'expiresAt', v_sess.expires_at,
    'idleTimeoutSeconds', v_sess.idle_timeout_seconds
  );
end $$;

create or replace function api.expire_staff_session(
  requested_session_id text,
  requested_user_id uuid,
  requested_reason text default 'idle_timeout_15m',
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_staff public.staff_profiles%rowtype;
  v_sess public.staff_sessions%rowtype;
  v_now timestamptz := statement_timestamp();
  v_clean_sid text := btrim(coalesce(requested_session_id, ''));
  v_clean_reason text := coalesce(nullif(btrim(requested_reason), ''), 'idle_timeout_15m');
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into v_staff from public.staff_profiles where user_id = requested_user_id;
  select * into v_sess from public.staff_sessions where session_id = v_clean_sid for update;

  if found and v_sess.user_id = requested_user_id and v_sess.expired_at is null then
    update public.staff_sessions
    set expired_at = v_now,
        expired_reason = v_clean_reason,
        updated_at = v_now
    where session_id = v_sess.session_id;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
    ) values (
      requested_user_id,
      'staff',
      coalesce(v_staff.role::text, 'staff'),
      case when v_clean_reason = 'idle_timeout_15m' then 'staff.session_idle_expired' else 'staff.session_signed_out' end,
      'staff_session',
      left(v_clean_sid, 64),
      coalesce(requested_request_id, gen_random_uuid()),
      jsonb_build_object('reason', v_clean_reason, 'expiredAt', v_now)
    );
  end if;

  return jsonb_build_object('expired', true);
end $$;

revoke all on function api.touch_staff_session(text, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function api.touch_staff_session(text, uuid, boolean, uuid) to service_role;

revoke all on function api.expire_staff_session(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.expire_staff_session(text, uuid, text, uuid) to service_role;

-- 5. RPC: api.save_system_settings_v2 (wraps save_system_settings + freeze/emergency/expected_gate atomically)
create or replace function api.save_system_settings_v2(
  requested_actor_id uuid,
  requested_peak_mode public.peak_mode_scope default null,
  requested_rejection_reasons jsonb default null,
  requested_visit_purposes jsonb default null,
  requested_visitor_instructions jsonb default null,
  requested_working_hours_start time default null,
  requested_working_hours_end time default null,
  requested_image_retention_days smallint default null,
  requested_photo_retention_days smallint default null,
  requested_id_retention_days smallint default null,
  requested_visitor_retention_days smallint default null,
  requested_audit_retention_days smallint default null,
  requested_reconciliation_retention_days smallint default null,
  requested_scheduling_days_ahead smallint default null,
  requested_automatic_cleanup_enabled boolean default null,
  requested_update_retention_policies boolean default false,
  requested_photo_enabled boolean default null,
  requested_policy_photo_days integer default null,
  requested_id_enabled boolean default null,
  requested_policy_id_days integer default null,
  requested_vehicle_enabled boolean default null,
  requested_vehicle_days integer default null,
  requested_visitor_enabled boolean default null,
  requested_policy_visitor_days integer default null,
  requested_returning_enabled boolean default null,
  requested_returning_days integer default null,
  requested_override_reason text default null,
  requested_request_id uuid default null,
  requested_global_retention_freeze boolean default null,
  requested_global_retention_freeze_reason text default null,
  requested_allow_emergency_exception boolean default null,
  requested_emergency_exception_policy_note text default null,
  requested_emergency_record_retention_enabled boolean default null,
  requested_emergency_record_retention_days smallint default null,
  requested_default_expected_gate text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_before public.app_settings%rowtype;
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_base jsonb;
  v_clean_freeze_reason text := nullif(btrim(coalesce(requested_global_retention_freeze_reason, '')), '');
  v_clean_emg_note text := nullif(btrim(coalesce(requested_emergency_exception_policy_note, '')), '');
  v_clean_default_gate text := nullif(regexp_replace(btrim(coalesce(requested_default_expected_gate, '')), '\s+', ' ', 'g'), '');
  v_next_freeze boolean;
  v_next_emg_exc boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if v_actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into v_before from public.app_settings where singleton = true for update;

  if v_actor_role <> 'superadmin'::public.staff_role and (
    requested_global_retention_freeze is not null
    or requested_allow_emergency_exception is not null
    or requested_emergency_record_retention_enabled is not null
    or requested_emergency_record_retention_days is not null
  ) then
    raise exception using errcode = '42501', message = 'super administrator required';
  end if;

  if requested_global_retention_freeze is true and char_length(coalesce(v_clean_freeze_reason, '')) < 5 then
    raise exception using errcode = '22023', message = 'global_retention_freeze_reason_required';
  end if;

  if requested_allow_emergency_exception is true and char_length(coalesce(v_clean_emg_note, coalesce(v_before.emergency_exception_policy_note, ''))) < 5 then
    raise exception using errcode = '22023', message = 'emergency_exception_policy_note_required';
  end if;

  v_base := api.save_system_settings(
    requested_actor_id,
    requested_peak_mode,
    requested_rejection_reasons,
    requested_visit_purposes,
    requested_visitor_instructions,
    requested_working_hours_start,
    requested_working_hours_end,
    requested_image_retention_days,
    requested_photo_retention_days,
    requested_id_retention_days,
    requested_visitor_retention_days,
    requested_audit_retention_days,
    requested_reconciliation_retention_days,
    requested_scheduling_days_ahead,
    requested_automatic_cleanup_enabled,
    requested_update_retention_policies,
    requested_photo_enabled,
    requested_policy_photo_days,
    requested_id_enabled,
    requested_policy_id_days,
    requested_vehicle_enabled,
    requested_vehicle_days,
    requested_visitor_enabled,
    requested_policy_visitor_days,
    requested_returning_enabled,
    requested_returning_days,
    requested_override_reason,
    v_req_id
  );

  v_next_freeze := coalesce(requested_global_retention_freeze, v_before.global_retention_freeze);
  v_next_emg_exc := coalesce(requested_allow_emergency_exception, v_before.allow_emergency_exception);

  update public.app_settings
  set
    global_retention_freeze = v_next_freeze,
    global_retention_freeze_reason = case
      when v_next_freeze is false and requested_global_retention_freeze is false then coalesce(v_clean_freeze_reason, global_retention_freeze_reason)
      when requested_global_retention_freeze_reason is not null then v_clean_freeze_reason
      else global_retention_freeze_reason
    end,
    global_retention_freeze_updated_by = case
      when v_next_freeze is distinct from v_before.global_retention_freeze then requested_actor_id
      else global_retention_freeze_updated_by
    end,
    global_retention_freeze_updated_at = case
      when v_next_freeze is distinct from v_before.global_retention_freeze then statement_timestamp()
      else global_retention_freeze_updated_at
    end,
    allow_emergency_exception = v_next_emg_exc,
    emergency_exception_policy_note = case
      when requested_emergency_exception_policy_note is not null then v_clean_emg_note
      else emergency_exception_policy_note
    end,
    emergency_record_retention_enabled = coalesce(requested_emergency_record_retention_enabled, emergency_record_retention_enabled),
    emergency_record_retention_days = coalesce(requested_emergency_record_retention_days, emergency_record_retention_days),
    default_expected_gate = case
      when requested_default_expected_gate is null then default_expected_gate
      else v_clean_default_gate
    end,
    updated_by = requested_actor_id,
    updated_at = statement_timestamp()
  where singleton = true;

  if v_next_freeze is distinct from v_before.global_retention_freeze then
    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id,
      'staff',
      v_actor_role::text,
      case when v_next_freeze then 'retention.freeze_enabled' else 'retention.freeze_disabled' end,
      'app_settings',
      'singleton',
      v_req_id,
      jsonb_build_object('globalRetentionFreeze', v_before.global_retention_freeze),
      jsonb_build_object('globalRetentionFreeze', v_next_freeze, 'reason', v_clean_freeze_reason)
    );
  end if;

  if v_next_emg_exc is distinct from v_before.allow_emergency_exception
     or (requested_emergency_exception_policy_note is not null and v_clean_emg_note is distinct from v_before.emergency_exception_policy_note) then
    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id,
      'staff',
      v_actor_role::text,
      'emergency.exception_policy_updated',
      'app_settings',
      'singleton',
      v_req_id,
      jsonb_build_object('allowEmergencyException', v_before.allow_emergency_exception),
      jsonb_build_object(
        'allowEmergencyException', v_next_emg_exc,
        'policyNote', coalesce(v_clean_emg_note, v_before.emergency_exception_policy_note)
      )
    );
  end if;

  if requested_default_expected_gate is not null
     and v_clean_default_gate is distinct from v_before.default_expected_gate then
    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id,
      'staff',
      v_actor_role::text,
      'settings.default_expected_gate_updated',
      'app_settings',
      'singleton',
      v_req_id,
      jsonb_build_object('defaultExpectedGate', v_before.default_expected_gate),
      jsonb_build_object('defaultExpectedGate', v_clean_default_gate)
    );
  end if;

  return coalesce(v_base, '{}'::jsonb) || jsonb_build_object(
    'globalRetentionFreeze', v_next_freeze,
    'allowEmergencyException', v_next_emg_exc,
    'defaultExpectedGate', coalesce(v_clean_default_gate, v_before.default_expected_gate)
  );
end $$;

revoke all on function api.save_system_settings_v2(
  uuid, public.peak_mode_scope, jsonb, jsonb, jsonb, time, time, smallint, smallint, smallint, smallint, smallint, smallint, smallint, boolean, boolean, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text, uuid, boolean, text, boolean, text, boolean, smallint, text
) from public, anon, authenticated;
grant execute on function api.save_system_settings_v2(
  uuid, public.peak_mode_scope, jsonb, jsonb, jsonb, time, time, smallint, smallint, smallint, smallint, smallint, smallint, smallint, boolean, boolean, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text, uuid, boolean, text, boolean, text, boolean, smallint, text
) to service_role;

-- 6. Enforce global_retention_freeze inside api.claim_evidence_for_purge and api.anonymize_expired_emergency_gate_record
create or replace function api.claim_evidence_for_purge(
  requested_evidence_id uuid,
  requested_claim_id uuid,
  requested_override boolean default false,
  requested_actor_id uuid default null,
  requested_override_reason text default null,
  requested_override_categories text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evidence record;
  settings record;
  category_days integer;
  category_enabled boolean;
  category_cutoff timestamptz;
  effective_expiry timestamptz;
  actor_role public.staff_role;
  cat_item text;
begin
  if requested_evidence_id is null or requested_claim_id is null then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_argument');
  end if;

  select ve.id, ve.visitor_id, ve.bucket_id, ve.object_path, ve.purged_at, ve.expires_at,
         ve.created_at, ve.verified_at, ve.kind, ve.purge_claim_id, ve.purge_claimed_at
    into v_evidence
    from public.visitor_evidence ve
   where ve.id = requested_evidence_id
   for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'evidence_not_found');
  end if;

  if v_evidence.purged_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_purged');
  end if;

  if v_evidence.purge_claim_id is not null
     and v_evidence.purge_claim_id <> requested_claim_id
     and v_evidence.purge_claimed_at >= statement_timestamp() - interval '5 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'concurrent_purge_in_progress');
  end if;

  -- MANDATORY NON-BYPASSABLE SAFEGUARDS
  if exists (
    select 1 from public.incident_holds ih
     where ih.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_visitor_hold');
  end if;

  if exists (
    select 1 from public.incident_holds ih
     join public.passes p on p.id = ih.pass_id
     where p.visitor_id = v_evidence.visitor_id
       and ih.active = true
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_pass_hold');
  end if;

  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and (
         p.status in ('inside', 'pending')
         or (p.status = 'issued' and p.valid_until > statement_timestamp())
       )
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'active_or_future_pass_exists');
  end if;

  if exists (
    select 1 from public.passes p
     where p.visitor_id = v_evidence.visitor_id
       and p.status = 'inside'::public.pass_status
  ) then
    return jsonb_build_object('claimed', false, 'reason', 'visitor_currently_inside');
  end if;

  -- Authoritative global retention freeze gate (blocks both automated and routine manual purges)
  select photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled,
         photo_retention_days, id_retention_days, vehicle_photo_retention_days,
         image_retention_days, coalesce(global_retention_freeze, false) as global_retention_freeze
    into settings
    from public.app_settings
   where singleton = true;

  if not found or settings is null then
    return jsonb_build_object('claimed', false, 'reason', 'settings_unavailable');
  end if;

  if settings.global_retention_freeze then
    return jsonb_build_object('claimed', false, 'reason', 'global_retention_freeze_active');
  end if;

  if requested_override then
    if requested_actor_id is null then
      return jsonb_build_object('claimed', false, 'reason', 'unauthorized_override_missing_actor');
    end if;

    select role into actor_role from public.staff_profiles
    where user_id = requested_actor_id
      and active
      and not must_change_password
      and privacy_accepted_at is not null;

    if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
      return jsonb_build_object('claimed', false, 'reason', 'unauthorized_override_superadmin_required');
    end if;

    if requested_override_reason is null or length(btrim(requested_override_reason)) < 10 then
      return jsonb_build_object('claimed', false, 'reason', 'invalid_override_reason');
    end if;

    if requested_override_categories is null or cardinality(requested_override_categories) = 0 then
      return jsonb_build_object('claimed', false, 'reason', 'missing_override_categories');
    end if;

    foreach cat_item in array requested_override_categories loop
      if cat_item not in ('photo', 'id', 'vehicle_photo') then
        return jsonb_build_object('claimed', false, 'reason', 'invalid_override_categories');
      end if;
    end loop;

    if not (v_evidence.kind::text = any(requested_override_categories)) then
      return jsonb_build_object('claimed', false, 'reason', 'category_not_in_override');
    end if;
  else
    if v_evidence.kind = 'photo' then
      category_enabled := coalesce(settings.photo_retention_enabled, true);
      category_days := coalesce(settings.photo_retention_days, settings.image_retention_days, 7);
    elsif v_evidence.kind = 'id' then
      category_enabled := coalesce(settings.id_retention_enabled, true);
      category_days := coalesce(settings.id_retention_days, 30);
    elsif v_evidence.kind = 'vehicle_photo' then
      category_enabled := coalesce(settings.vehicle_photo_retention_enabled, true);
      category_days := coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7);
    else
      category_enabled := true;
      category_days := coalesce(settings.image_retention_days, 7);
    end if;

    if not category_enabled then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_disabled');
    end if;

    category_cutoff := statement_timestamp() - make_interval(days => category_days);
    if coalesce(v_evidence.created_at, v_evidence.verified_at) > category_cutoff then
      return jsonb_build_object('claimed', false, 'reason', 'category_retention_not_expired');
    end if;

    effective_expiry := coalesce(v_evidence.created_at, v_evidence.verified_at, statement_timestamp()) + make_interval(days => category_days);
    if effective_expiry > statement_timestamp() then
      return jsonb_build_object('claimed', false, 'reason', 'not_expired');
    end if;
  end if;

  update public.visitor_evidence
     set purge_claim_id = requested_claim_id,
         purge_claimed_at = statement_timestamp()
   where id = v_evidence.id;

  return jsonb_build_object(
    'claimed', true,
    'evidence_id', v_evidence.id,
    'visitor_id', v_evidence.visitor_id,
    'bucket_id', v_evidence.bucket_id,
    'object_path', v_evidence.object_path,
    'claim_id', requested_claim_id,
    'claimed_at', statement_timestamp()
  );
end;
$$;

revoke all on function api.claim_evidence_for_purge(uuid, uuid, boolean, uuid, text, text[]) from public, anon, authenticated;
grant execute on function api.claim_evidence_for_purge(uuid, uuid, boolean, uuid, text, text[]) to service_role;

create or replace function api.anonymize_expired_emergency_gate_record(
  requested_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings public.app_settings%rowtype;
  v_rec public.emergency_gate_records%rowtype;
  v_cutoff timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into v_settings from public.app_settings where singleton = true;
  if not found then
    return jsonb_build_object('anonymized', false, 'reason', 'settings_unavailable');
  end if;

  if coalesce(v_settings.global_retention_freeze, false) then
    return jsonb_build_object('anonymized', false, 'reason', 'global_retention_freeze_active');
  end if;

  if coalesce(v_settings.emergency_record_retention_enabled, true) = false then
    return jsonb_build_object('anonymized', false, 'reason', 'category_retention_disabled');
  end if;

  select * into v_rec from public.emergency_gate_records where id = requested_record_id for update;
  if not found then
    return jsonb_build_object('anonymized', false, 'reason', 'not_found');
  end if;

  if v_rec.anonymized_at is not null then
    return jsonb_build_object('anonymized', false, 'reason', 'already_anonymized');
  end if;

  if v_rec.reconciliation_status in ('pending_sync', 'received', 'needs_review') then
    return jsonb_build_object('anonymized', false, 'reason', 'unresolved_reconciliation');
  end if;

  v_cutoff := statement_timestamp() - make_interval(days => coalesce(v_settings.emergency_record_retention_days, 90));
  if v_rec.local_recorded_at > v_cutoff then
    return jsonb_build_object('anonymized', false, 'reason', 'not_expired');
  end if;

  update public.emergency_gate_records
  set
    visitor_full_name = 'Anonymized Offline Record',
    declared_address = 'Anonymized per retention policy',
    anonymized_at = statement_timestamp(),
    updated_at = statement_timestamp()
  where id = v_rec.id;

  return jsonb_build_object('anonymized', true, 'recordId', v_rec.id);
end $$;

revoke all on function api.anonymize_expired_emergency_gate_record(uuid) from public, anon, authenticated;
grant execute on function api.anonymize_expired_emergency_gate_record(uuid) to service_role;

-- 7. Transactional Office, Personnel, and Campus Calendar mutation RPCs with immutable audit
create or replace function api.save_office_record(
  requested_actor_id uuid,
  requested_office_id uuid default null,
  requested_name text default null,
  requested_description text default null,
  requested_active boolean default null,
  requested_requires_approval_before_pass boolean default null,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_before public.offices%rowtype;
  v_after public.offices%rowtype;
  v_clean_name text := regexp_replace(btrim(coalesce(requested_name, '')), '\s+', ' ', 'g');
  v_clean_desc text := nullif(btrim(coalesce(requested_description, '')), '');
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_duplicate uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if v_actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_office_id is null then
    if char_length(v_clean_name) < 2 then
      raise exception using errcode = '22023', message = 'office_name_required';
    end if;

    select id into v_duplicate from public.offices
    where lower(btrim(name)) = lower(v_clean_name)
    limit 1;
    if found then
      raise exception using errcode = '23505', message = 'office_name_duplicate';
    end if;

    if requested_requires_approval_before_pass is not null and requested_requires_approval_before_pass = false and v_actor_role <> 'superadmin'::public.staff_role then
      raise exception using errcode = '42501', message = 'superadmin_required_for_approval_policy';
    end if;

    insert into public.offices(
      name,
      description,
      active,
      verified,
      publication_status,
      requires_approval_before_pass,
      created_by
    ) values (
      v_clean_name,
      v_clean_desc,
      coalesce(requested_active, true),
      false,
      'draft',
      coalesce(requested_requires_approval_before_pass, true),
      requested_actor_id
    )
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text, 'office.created', 'office', v_after.id::text, v_req_id,
      jsonb_build_object(
        'name', v_after.name,
        'publicationStatus', v_after.publication_status,
        'active', v_after.active,
        'requiresApprovalBeforePass', v_after.requires_approval_before_pass
      )
    );
  else
    select * into v_before from public.offices where id = requested_office_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'office_not_found';
    end if;

    if v_before.publication_status = 'archived' and requested_active is true then
      raise exception using errcode = '22023', message = 'archived_office_must_be_republished_first';
    end if;

    if requested_name is not null then
      if char_length(v_clean_name) < 2 then
        raise exception using errcode = '22023', message = 'office_name_required';
      end if;
      select id into v_duplicate from public.offices
      where lower(btrim(name)) = lower(v_clean_name)
        and id <> requested_office_id
      limit 1;
      if found then
        raise exception using errcode = '23505', message = 'office_name_duplicate';
      end if;
    end if;

    if requested_requires_approval_before_pass is not null
       and requested_requires_approval_before_pass is distinct from v_before.requires_approval_before_pass
       and v_actor_role <> 'superadmin'::public.staff_role then
      raise exception using errcode = '42501', message = 'superadmin_required_for_approval_policy';
    end if;

    update public.offices
    set
      name = case when requested_name is not null then v_clean_name else name end,
      description = case when requested_description is not null then v_clean_desc else description end,
      active = coalesce(requested_active, active),
      requires_approval_before_pass = coalesce(requested_requires_approval_before_pass, requires_approval_before_pass),
      updated_at = now()
    where id = requested_office_id
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text, 'office.updated', 'office', v_after.id::text, v_req_id,
      jsonb_build_object(
        'name', v_before.name, 'description', v_before.description, 'active', v_before.active,
        'requiresApprovalBeforePass', v_before.requires_approval_before_pass
      ),
      jsonb_build_object(
        'name', v_after.name, 'description', v_after.description, 'active', v_after.active,
        'requiresApprovalBeforePass', v_after.requires_approval_before_pass
      )
    );
  end if;

  return jsonb_build_object(
    'id', v_after.id,
    'name', v_after.name,
    'description', v_after.description,
    'active', v_after.active,
    'publicationStatus', v_after.publication_status,
    'requiresApprovalBeforePass', v_after.requires_approval_before_pass,
    'verified', v_after.verified
  );
end $$;

revoke all on function api.save_office_record(uuid, uuid, text, text, boolean, boolean, uuid) from public, anon, authenticated;
grant execute on function api.save_office_record(uuid, uuid, text, text, boolean, boolean, uuid) to service_role;

create or replace function api.save_office_personnel_record(
  requested_actor_id uuid,
  requested_personnel_id uuid default null,
  requested_office_id uuid default null,
  requested_name text default null,
  requested_title text default null,
  requested_active boolean default null,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_before public.office_personnel%rowtype;
  v_after public.office_personnel%rowtype;
  v_target_office_id uuid;
  v_clean_name text := btrim(coalesce(requested_name, ''));
  v_clean_title text := nullif(btrim(coalesce(requested_title, '')), '');
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_assigned boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if v_actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role, 'office_staff'::public.staff_role) then
    raise exception using errcode = '42501', message = 'insufficient permissions';
  end if;

  if requested_personnel_id is null then
    v_target_office_id := requested_office_id;
    if v_target_office_id is null or char_length(v_clean_name) < 2 then
      raise exception using errcode = '22023', message = 'invalid_personnel_fields';
    end if;
    if v_actor_role = 'office_staff'::public.staff_role then
      select exists (
        select 1 from public.office_staff_assignments a
        where a.user_id = requested_actor_id and a.office_id = v_target_office_id
      ) into v_assigned;
      if not v_assigned then
        raise exception using errcode = '42501', message = 'not_assigned_to_office';
      end if;
    end if;

    insert into public.office_personnel(office_id, name, title, active)
    values (v_target_office_id, v_clean_name, v_clean_title, coalesce(requested_active, true))
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text, 'office_personnel.created', 'office_personnel', v_after.id::text, v_req_id,
      jsonb_build_object('officeId', v_after.office_id, 'name', v_after.name, 'title', v_after.title, 'active', v_after.active)
    );
  else
    select * into v_before from public.office_personnel where id = requested_personnel_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'personnel_not_found';
    end if;

    if v_actor_role = 'office_staff'::public.staff_role then
      select exists (
        select 1 from public.office_staff_assignments a
        where a.user_id = requested_actor_id and a.office_id = v_before.office_id
      ) into v_assigned;
      if not v_assigned then
        raise exception using errcode = '42501', message = 'not_assigned_to_office';
      end if;
    end if;

    update public.office_personnel
    set
      name = case when requested_name is not null and char_length(v_clean_name) >= 2 then v_clean_name else name end,
      title = case when requested_title is not null then v_clean_title else title end,
      active = coalesce(requested_active, active),
      updated_at = now()
    where id = requested_personnel_id
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text, 'office_personnel.updated', 'office_personnel', v_after.id::text, v_req_id,
      jsonb_build_object('name', v_before.name, 'title', v_before.title, 'active', v_before.active),
      jsonb_build_object('name', v_after.name, 'title', v_after.title, 'active', v_after.active)
    );
  end if;

  return jsonb_build_object(
    'id', v_after.id,
    'officeId', v_after.office_id,
    'name', v_after.name,
    'title', v_after.title,
    'active', v_after.active
  );
end $$;

revoke all on function api.save_office_personnel_record(uuid, uuid, uuid, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function api.save_office_personnel_record(uuid, uuid, uuid, text, text, boolean, uuid) to service_role;

create or replace function api.save_campus_calendar_closure(
  requested_actor_id uuid,
  requested_closure_id uuid default null,
  requested_title text default null,
  requested_closure_type text default null,
  requested_start_date date default null,
  requested_end_date date default null,
  requested_description text default null,
  requested_active boolean default null,
  requested_published boolean default null,
  requested_archive boolean default false,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_before public.campus_calendar_closures%rowtype;
  v_after public.campus_calendar_closures%rowtype;
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_clean_title text := btrim(coalesce(requested_title, ''));
  v_clean_desc text := nullif(btrim(coalesce(requested_description, '')), '');
  v_eff_start date;
  v_eff_end date;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  if requested_closure_id is null then
    if char_length(v_clean_title) < 2
       or requested_closure_type not in ('holiday', 'campus_closure', 'emergency_suspension')
       or requested_start_date is null or requested_end_date is null
       or requested_end_date < requested_start_date then
      raise exception using errcode = '22023', message = 'invalid_calendar_closure_fields';
    end if;

    insert into public.campus_calendar_closures(
      title, closure_type, start_date, end_date, description, active, published, created_by, updated_by
    ) values (
      v_clean_title,
      requested_closure_type,
      requested_start_date,
      requested_end_date,
      v_clean_desc,
      coalesce(requested_active, true),
      coalesce(requested_published, true),
      requested_actor_id,
      requested_actor_id
    )
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text, 'campus_calendar.created', 'campus_calendar_closure', v_after.id::text, v_req_id,
      jsonb_build_object(
        'title', v_after.title, 'closureType', v_after.closure_type,
        'startDate', v_after.start_date, 'endDate', v_after.end_date,
        'active', v_after.active, 'published', v_after.published
      )
    );
  else
    select * into v_before from public.campus_calendar_closures where id = requested_closure_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'closure_not_found';
    end if;

    v_eff_start := coalesce(requested_start_date, v_before.start_date);
    v_eff_end := coalesce(requested_end_date, v_before.end_date);
    if v_eff_end < v_eff_start then
      raise exception using errcode = '22023', message = 'invalid_date_range';
    end if;

    update public.campus_calendar_closures
    set
      title = case when requested_title is not null and char_length(v_clean_title) >= 2 then v_clean_title else title end,
      closure_type = coalesce(requested_closure_type, closure_type),
      start_date = v_eff_start,
      end_date = v_eff_end,
      description = case when requested_description is not null then v_clean_desc else description end,
      active = case when requested_archive then false else coalesce(requested_active, active) end,
      published = case when requested_archive then false else coalesce(requested_published, published) end,
      archived_at = case when requested_archive then now() else case when coalesce(requested_published, false) is true then null else archived_at end end,
      archived_by = case when requested_archive then requested_actor_id else case when coalesce(requested_published, false) is true then null else archived_by end end,
      updated_by = requested_actor_id,
      updated_at = now()
    where id = requested_closure_id
    returning * into v_after;

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
    ) values (
      requested_actor_id, 'staff', v_actor_role::text,
      case when requested_archive then 'campus_calendar.archived' else 'campus_calendar.updated' end,
      'campus_calendar_closure', v_after.id::text, v_req_id,
      jsonb_build_object(
        'title', v_before.title, 'closureType', v_before.closure_type,
        'startDate', v_before.start_date, 'endDate', v_before.end_date,
        'active', v_before.active, 'published', v_before.published, 'archivedAt', v_before.archived_at
      ),
      jsonb_build_object(
        'title', v_after.title, 'closureType', v_after.closure_type,
        'startDate', v_after.start_date, 'endDate', v_after.end_date,
        'active', v_after.active, 'published', v_after.published, 'archivedAt', v_after.archived_at
      )
    );
  end if;

  return jsonb_build_object(
    'id', v_after.id,
    'title', v_after.title,
    'closureType', v_after.closure_type,
    'startDate', v_after.start_date,
    'endDate', v_after.end_date,
    'description', v_after.description,
    'active', v_after.active,
    'published', v_after.published,
    'archivedAt', v_after.archived_at
  );
end $$;

create or replace function api.delete_campus_calendar_closure(
  requested_actor_id uuid,
  requested_closure_id uuid,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_before public.campus_calendar_closures%rowtype;
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into v_actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active = true
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required';
  end if;

  select * into v_before from public.campus_calendar_closures where id = requested_closure_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'closure_not_found';
  end if;

  -- Only unused draft closures (not published and not active) may be physically deleted
  if v_before.published or v_before.active then
    raise exception using errcode = '42501', message = 'published_or_active_closure_must_be_archived';
  end if;

  delete from public.campus_calendar_closures where id = requested_closure_id;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state
  ) values (
    requested_actor_id, 'staff', v_actor_role::text, 'campus_calendar.draft_deleted', 'campus_calendar_closure',
    requested_closure_id::text, v_req_id,
    jsonb_build_object(
      'title', v_before.title, 'closureType', v_before.closure_type,
      'startDate', v_before.start_date, 'endDate', v_before.end_date
    )
  );

  return jsonb_build_object('deleted', true, 'id', requested_closure_id);
end $$;

revoke all on function api.save_campus_calendar_closure(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, uuid) from public, anon, authenticated;
grant execute on function api.save_campus_calendar_closure(uuid, uuid, text, text, date, date, text, boolean, boolean, boolean, uuid) to service_role;

revoke all on function api.delete_campus_calendar_closure(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_campus_calendar_closure(uuid, uuid, uuid) to service_role;

-- 8. Tighten public.app_settings column-level SELECT for anon & authenticated
-- Retention intervals, freeze status, emergency policy internals, and rejection reasons
-- belong strictly behind server-side authorized endpoints (/api/admin/settings) or safe summary capabilities.
revoke all on public.app_settings from public, anon, authenticated;
grant select (
  working_hours_start,
  working_hours_end,
  timezone,
  scheduling_days_ahead,
  peak_mode,
  visit_purposes,
  visitor_instructions
) on public.app_settings to anon, authenticated;

-- 9. Clean unnecessary default/table privileges in schema public (Sec 14.2)
do $$
declare
  rec record;
  has_maintain boolean := current_setting('server_version_num')::int >= 170000;
begin
  -- Revoke excessive non-operational table privileges on all existing public tables
  for rec in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'revoke truncate, references, trigger on table public.%I from public, anon, authenticated',
      rec.tablename
    );
    if has_maintain then
      execute format(
        'revoke maintain on table public.%I from public, anon, authenticated',
        rec.tablename
      );
    end if;
  end loop;

  -- Clean default privileges for current role and common Supabase table owner roles
  execute 'alter default privileges in schema public revoke all on tables from public, anon, authenticated';
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    begin
      execute 'alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated';
    exception when insufficient_privilege then null;
    end;
  end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from public, anon, authenticated';
    exception when insufficient_privilege then null;
    end;
  end if;
end $$;

-- 10. Consolidate RLS policies & wrap auth helper calls in (select ...) to resolve
-- all auth_rls_initplan and multiple_permissive_policies advisors while hardening office visibility.

-- public.offices: require active = true AND publication_status = 'published' for public visibility
drop policy if exists offices_public_read on public.offices;
drop policy if exists offices_admin_manage on public.offices;
drop policy if exists offices_select on public.offices;
drop policy if exists offices_admin_insert on public.offices;
drop policy if exists offices_admin_update on public.offices;
drop policy if exists offices_admin_delete on public.offices;

create policy offices_select on public.offices
  for select to anon, authenticated
  using (
    (active = true and publication_status = 'published')
    or (select private.has_staff_role(array['admin', 'superadmin', 'office_staff']::public.staff_role[]))
  );

create policy offices_admin_insert on public.offices
  for insert to authenticated
  with check ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

create policy offices_admin_update on public.offices
  for update to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])))
  with check ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- public.office_personnel: public read requires active personnel in active + published office
drop policy if exists personnel_public_read on public.office_personnel;
drop policy if exists personnel_staff_manage on public.office_personnel;
drop policy if exists personnel_select on public.office_personnel;
drop policy if exists personnel_staff_insert on public.office_personnel;
drop policy if exists personnel_staff_update on public.office_personnel;

create policy personnel_select on public.office_personnel
  for select to anon, authenticated
  using (
    (
      active = true
      and exists (
        select 1 from public.offices o
        where o.id = office_personnel.office_id
          and o.active = true
          and o.publication_status = 'published'
      )
    )
    or (select private.has_staff_role(array['admin', 'superadmin', 'office_staff']::public.staff_role[]))
  );

create policy personnel_staff_insert on public.office_personnel
  for insert to authenticated
  with check (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or (
      (select private.has_staff_role(array['office_staff']::public.staff_role[]))
      and exists (
        select 1 from public.office_staff_assignments a
        where a.office_id = office_personnel.office_id
          and a.user_id = (select auth.uid())
      )
    )
  );

create policy personnel_staff_update on public.office_personnel
  for update to authenticated
  using (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or (
      (select private.has_staff_role(array['office_staff']::public.staff_role[]))
      and exists (
        select 1 from public.office_staff_assignments a
        where a.office_id = office_personnel.office_id
          and a.user_id = (select auth.uid())
      )
    )
  )
  with check (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or (
      (select private.has_staff_role(array['office_staff']::public.staff_role[]))
      and exists (
        select 1 from public.office_staff_assignments a
        where a.office_id = office_personnel.office_id
          and a.user_id = (select auth.uid())
      )
    )
  );

-- public.office_staff_assignments
drop policy if exists assignments_staff_read on public.office_staff_assignments;
drop policy if exists assignments_admin_manage on public.office_staff_assignments;
drop policy if exists assignments_select on public.office_staff_assignments;
drop policy if exists assignments_admin_insert on public.office_staff_assignments;
drop policy if exists assignments_admin_delete on public.office_staff_assignments;

create policy assignments_select on public.office_staff_assignments
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
  );

create policy assignments_admin_insert on public.office_staff_assignments
  for insert to authenticated
  with check ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

create policy assignments_admin_delete on public.office_staff_assignments
  for delete to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- public.office_visits
drop policy if exists visits_office_staff_read on public.office_visits;
drop policy if exists visits_admin_manage on public.office_visits;
drop policy if exists visits_select on public.office_visits;
drop policy if exists visits_admin_update on public.office_visits;

create policy visits_select on public.office_visits
  for select to authenticated
  using (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or (
      (select private.has_staff_role(array['office_staff']::public.staff_role[]))
      and exists (
        select 1 from public.office_staff_assignments a
        where a.office_id = office_visits.office_id
          and a.user_id = (select auth.uid())
      )
    )
  );

create policy visits_admin_update on public.office_visits
  for update to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])))
  with check ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- public.office_visit_events
drop policy if exists events_office_staff_read on public.office_visit_events;
drop policy if exists events_select on public.office_visit_events;

create policy events_select on public.office_visit_events
  for select to authenticated
  using (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or (
      (select private.has_staff_role(array['office_staff']::public.staff_role[]))
      and exists (
        select 1
        from public.office_visits v
        join public.office_staff_assignments a on a.office_id = v.office_id
        where v.id = office_visit_events.office_visit_id
          and a.user_id = (select auth.uid())
      )
    )
  );

-- public.campus_calendar_closures
drop policy if exists closures_superadmin_all on public.campus_calendar_closures;
drop policy if exists closures_admin_read on public.campus_calendar_closures;
drop policy if exists closures_public_read on public.campus_calendar_closures;
drop policy if exists closures_select on public.campus_calendar_closures;
drop policy if exists closures_superadmin_insert on public.campus_calendar_closures;
drop policy if exists closures_superadmin_update on public.campus_calendar_closures;
drop policy if exists closures_superadmin_delete on public.campus_calendar_closures;

create policy closures_select on public.campus_calendar_closures
  for select to anon, authenticated
  using (
    (published = true and active = true and archived_at is null)
    or (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
  );

create policy closures_superadmin_insert on public.campus_calendar_closures
  for insert to authenticated
  with check ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

create policy closures_superadmin_update on public.campus_calendar_closures
  for update to authenticated
  using ((select private.has_staff_role(array['superadmin']::public.staff_role[])))
  with check ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

create policy closures_superadmin_delete on public.campus_calendar_closures
  for delete to authenticated
  using ((select private.has_staff_role(array['superadmin']::public.staff_role[])));

-- public.visit_vehicle_declarations
drop policy if exists visit_vehicle_declarations_staff_select on public.visit_vehicle_declarations;
drop policy if exists visit_vehicle_declarations_select_policy on public.visit_vehicle_declarations;
drop policy if exists visit_vehicle_declarations_select on public.visit_vehicle_declarations;

create policy visit_vehicle_declarations_select_policy on public.visit_vehicle_declarations
  for select to authenticated
  using (
    (select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[]))
    or ((select private.current_device_type()) is not null)
  );

-- 11. Include office_staff in api.finalize_staff_password_change onboarding completion
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

  if target_role is null or target_role not in (
    'guard'::public.staff_role,
    'admin'::public.staff_role,
    'superadmin'::public.staff_role,
    'office_staff'::public.staff_role
  ) then
    raise exception using errcode = '42501', message = 'eligible human staff identity required';
  end if;

  update public.staff_profiles
  set must_change_password = false
  where user_id = target_user_id
    and role in (
      'guard'::public.staff_role,
      'admin'::public.staff_role,
      'superadmin'::public.staff_role,
      'office_staff'::public.staff_role
    )
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
end $$;

revoke all on function api.finalize_staff_password_change(uuid) from public, anon, authenticated;
grant execute on function api.finalize_staff_password_change(uuid) to service_role;


-- 12. Service-role-only ECDSA P-256 signing key RPC accessors (never exposing private schema over PostgREST)
create or replace function api.get_active_emergency_signing_key()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row private.emergency_signing_keys%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into v_row
  from private.emergency_signing_keys
  order by created_at desc
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'algorithm', v_row.algorithm,
    'publicKeySpki', v_row.public_key_spki,
    'privateKeyPkcs8', v_row.private_key_pkcs8
  );
end $$;

create or replace function api.store_emergency_signing_key(
  requested_id text,
  requested_public_key_spki text,
  requested_private_key_pkcs8 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.emergency_signing_keys%rowtype;
  v_clean_id text := btrim(coalesce(requested_id, ''));
begin
  if (select auth.role()) <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if char_length(v_clean_id) < 3 then
    raise exception using errcode = '22023', message = 'invalid_signing_key_id';
  end if;

  insert into private.emergency_signing_keys (
    id, algorithm, public_key_spki, private_key_pkcs8
  ) values (
    v_clean_id, 'ECDSA_P256_SHA256', requested_public_key_spki, requested_private_key_pkcs8
  )
  on conflict (id) do nothing;

  select * into v_row
  from private.emergency_signing_keys
  where id = v_clean_id;

  return jsonb_build_object(
    'id', v_row.id,
    'algorithm', v_row.algorithm,
    'publicKeySpki', v_row.public_key_spki,
    'privateKeyPkcs8', v_row.private_key_pkcs8
  );
end $$;

revoke all on function api.get_active_emergency_signing_key() from public, anon, authenticated;
grant execute on function api.get_active_emergency_signing_key() to service_role;

revoke all on function api.store_emergency_signing_key(text, text, text) from public, anon, authenticated;
grant execute on function api.store_emergency_signing_key(text, text, text) to service_role;
