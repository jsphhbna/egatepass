-- =============================================================================
-- Migration 86: Phase 1 Reliability Repairs
-- Description:
--   1. Durable office provisioning operation journal (public.office_provisioning_operations)
--      plus service-role RPCs (api.claim_office_provisioning_operation,
--      api.update_office_provisioning_operation) and idempotent provenance-checked
--      api.provision_office_staff_account recovery.
--   2. Atomic staff office assignment replacement RPC (api.replace_staff_office_assignments)
--      aligned to office_staff_assignments(id, user_id, office_id, created_at, created_by).
--   3. Atomic unified system settings save RPC (api.save_system_settings) consolidating
--      operational settings, visitor_instructions, granular retention policies,
--      visitor_evidence.expires_at synchronization, and audit logging in a single transaction,
--      while preserving legacy RPC signatures for existing contracts.
-- =============================================================================

-- 1. Durable Office Provisioning Journal Table (no secrets/passwords stored)
create table if not exists public.office_provisioning_operations (
  operation_id uuid primary key,
  office_id uuid not null references public.offices(id) on delete cascade,
  actor_id uuid not null references public.staff_profiles(user_id) on delete restrict,
  target_email text not null check (char_length(btrim(target_email)) between 3 and 320),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 100),
  auth_user_id uuid,
  status text not null check (status in (
    'started',
    'auth_created',
    'completed',
    'compensated',
    'compensation_failed',
    'failed'
  )),
  email_delivery_status text not null default 'pending' check (email_delivery_status in (
    'pending',
    'sent',
    'failed',
    'not_attempted'
  )),
  last_error_code text,
  last_error_message text,
  reconciliation_recorded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_office_provisioning_ops_office_id
  on public.office_provisioning_operations (office_id, created_at desc);

create index if not exists idx_office_provisioning_ops_actor_id
  on public.office_provisioning_operations (actor_id);

create index if not exists idx_office_provisioning_ops_email_office
  on public.office_provisioning_operations (lower(target_email), office_id);

drop trigger if exists office_provisioning_operations_set_updated_at on public.office_provisioning_operations;
create trigger office_provisioning_operations_set_updated_at
  before update on public.office_provisioning_operations
  for each row execute function private.set_updated_at();

alter table public.office_provisioning_operations enable row level security;
revoke all on public.office_provisioning_operations from public, anon, authenticated;
grant select on public.office_provisioning_operations to service_role;

-- 2. RPC: api.claim_office_provisioning_operation
create or replace function api.claim_office_provisioning_operation(
  requested_actor_id uuid,
  requested_operation_id uuid,
  requested_office_id uuid,
  requested_email text,
  requested_display_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_office public.offices%rowtype;
  existing_op public.office_provisioning_operations%rowtype;
  prior_op public.office_provisioning_operations%rowtype;
  normalized_email text;
  trimmed_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  normalized_email := lower(btrim(coalesce(requested_email, '')));
  if char_length(normalized_email) < 3 or char_length(normalized_email) > 320 then
    raise exception using errcode = '22023', message = 'invalid staff email';
  end if;

  trimmed_name := btrim(coalesce(requested_display_name, ''));
  if char_length(trimmed_name) < 2 or char_length(trimmed_name) > 100 then
    raise exception using errcode = '22023', message = 'display name must be between 2 and 100 characters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('office_provision_op:' || requested_operation_id::text, 0)
  );

  select * into target_office
  from public.offices
  where id = requested_office_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'office not found';
  end if;

  if not target_office.active then
    raise exception using errcode = '42501', message = 'office is inactive';
  end if;

  select * into existing_op
  from public.office_provisioning_operations
  where operation_id = requested_operation_id
  for update;

  if found then
    if existing_op.office_id <> requested_office_id or lower(btrim(existing_op.target_email)) <> normalized_email then
      return jsonb_build_object(
        'action', 'operation_mismatch',
        'officeName', target_office.name,
        'operation', to_jsonb(existing_op)
      );
    end if;

    if existing_op.status = 'completed' then
      return jsonb_build_object(
        'action', 'replay_completed',
        'officeName', target_office.name,
        'operation', to_jsonb(existing_op)
      );
    end if;

    if existing_op.status = 'compensation_failed' then
      return jsonb_build_object(
        'action', 'compensation_failed',
        'officeName', target_office.name,
        'operation', to_jsonb(existing_op)
      );
    end if;

    if existing_op.status in ('started', 'auth_created') then
      return jsonb_build_object(
        'action', 'resume_incomplete',
        'officeName', target_office.name,
        'operation', to_jsonb(existing_op)
      );
    end if;

    -- Status was 'compensated' or 'failed': allow clean retry attempt under this operationId
    update public.office_provisioning_operations
    set actor_id = requested_actor_id,
        display_name = trimmed_name,
        auth_user_id = null,
        status = 'started',
        email_delivery_status = 'pending',
        last_error_code = null,
        last_error_message = null,
        reconciliation_recorded = false,
        completed_at = null
    where operation_id = requested_operation_id
    returning * into existing_op;

    return jsonb_build_object(
      'action', 'proceed',
      'officeName', target_office.name,
      'operation', to_jsonb(existing_op)
    );
  end if;

  select * into prior_op
  from public.office_provisioning_operations
  where lower(target_email) = normalized_email
    and office_id = requested_office_id
  order by created_at desc
  limit 1;

  insert into public.office_provisioning_operations (
    operation_id,
    office_id,
    actor_id,
    target_email,
    display_name,
    status,
    email_delivery_status
  )
  values (
    requested_operation_id,
    requested_office_id,
    requested_actor_id,
    normalized_email,
    trimmed_name,
    'started',
    'pending'
  )
  returning * into existing_op;

  return jsonb_build_object(
    'action', 'proceed',
    'officeName', target_office.name,
    'operation', to_jsonb(existing_op),
    'priorOperation', case when prior_op.operation_id is not null then to_jsonb(prior_op) else null end
  );
end;
$$;

revoke all on function api.claim_office_provisioning_operation(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.claim_office_provisioning_operation(uuid, uuid, uuid, text, text) to service_role;

-- 3. RPC: api.update_office_provisioning_operation
create or replace function api.update_office_provisioning_operation(
  requested_actor_id uuid,
  requested_operation_id uuid,
  requested_auth_user_id uuid default null,
  requested_status text default null,
  requested_email_delivery_status text default null,
  requested_error_code text default null,
  requested_error_message text default null,
  requested_reconciliation_recorded boolean default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  updated_op public.office_provisioning_operations%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  update public.office_provisioning_operations
  set auth_user_id = coalesce(requested_auth_user_id, auth_user_id),
      status = coalesce(requested_status, status),
      email_delivery_status = coalesce(requested_email_delivery_status, email_delivery_status),
      last_error_code = case
        when requested_error_code is not null then nullif(btrim(requested_error_code), '')
        else last_error_code
      end,
      last_error_message = case
        when requested_error_message is not null then nullif(btrim(requested_error_message), '')
        else last_error_message
      end,
      reconciliation_recorded = coalesce(requested_reconciliation_recorded, reconciliation_recorded),
      completed_at = case
        when coalesce(requested_status, status) = 'completed' and completed_at is null then now()
        else completed_at
      end
  where operation_id = requested_operation_id
  returning * into updated_op;

  if not found then
    raise exception using errcode = 'P0002', message = 'provisioning operation not found';
  end if;

  return to_jsonb(updated_op);
end;
$$;

revoke all on function api.update_office_provisioning_operation(uuid, uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function api.update_office_provisioning_operation(uuid, uuid, uuid, text, text, text, text, boolean) to service_role;

-- 4. Update api.provision_office_staff_account (preserve exact 5-arg void signature, add provenance-checked idempotency)
create or replace function api.provision_office_staff_account(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_office_id uuid,
  requested_name text,
  requested_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_office public.offices%rowtype;
  existing_profile public.staff_profiles%rowtype;
  existing_op public.office_provisioning_operations%rowtype;
  provenance_ok boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into target_office from public.offices
  where id = requested_office_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'office not found';
  end if;

  if not target_office.active then
    raise exception using errcode = '42501', message = 'office is inactive';
  end if;

  if char_length(btrim(coalesce(requested_name, ''))) < 2 then
    raise exception using errcode = '22023', message = 'display name too short';
  end if;

  select * into existing_profile
  from public.staff_profiles
  where user_id = requested_user_id
  for update;

  if found then
    if requested_request_id is not null then
      select * into existing_op
      from public.office_provisioning_operations
      where operation_id = requested_request_id
      for update;

      provenance_ok := (
        existing_profile.role = 'office_staff'::public.staff_role
        and (
          (
            existing_op.operation_id is not null
            and existing_op.office_id = requested_office_id
            and (existing_op.auth_user_id is null or existing_op.auth_user_id = requested_user_id)
          )
          or exists (
            select 1 from public.audit_events ae
            where ae.request_id = requested_request_id
              and ae.action = 'office.account_provisioned'
              and ae.target_id = requested_user_id::text
          )
        )
      );
    end if;

    if not provenance_ok then
      raise exception using errcode = '23505', message = 'staff_profile_already_exists';
    end if;

    insert into public.office_staff_assignments(user_id, office_id, created_by)
    values (requested_user_id, requested_office_id, requested_actor_id)
    on conflict (user_id, office_id) do nothing;
  else
    insert into public.staff_profiles(user_id, display_name, role, active, must_change_password, created_by)
    values (
      requested_user_id,
      btrim(requested_name),
      'office_staff'::public.staff_role,
      true,
      true,
      requested_actor_id
    );

    insert into public.office_staff_assignments(user_id, office_id, created_by)
    values (
      requested_user_id,
      requested_office_id,
      requested_actor_id
    )
    on conflict (user_id, office_id) do nothing;

    insert into public.audit_events(actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state)
    values (
      requested_actor_id,
      'staff',
      actor_role::text,
      'office.account_provisioned',
      'staff_profile',
      requested_user_id::text,
      requested_request_id,
      jsonb_build_object(
        'officeId', requested_office_id,
        'officeName', target_office.name,
        'role', 'office_staff',
        'active', true,
        'mustChangePassword', true
      )
    );
  end if;

  if requested_request_id is not null then
    update public.office_provisioning_operations
    set auth_user_id = coalesce(auth_user_id, requested_user_id),
        status = 'completed',
        last_error_code = null,
        last_error_message = null,
        completed_at = coalesce(completed_at, now())
    where operation_id = requested_request_id;
  end if;
end;
$$;

revoke all on function api.provision_office_staff_account(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.provision_office_staff_account(uuid, uuid, uuid, text, uuid) to service_role;

-- 5. RPC: api.replace_staff_office_assignments (atomic superadmin replacement)
create or replace function api.replace_staff_office_assignments(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_office_ids uuid[],
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_staff public.staff_profiles%rowtype;
  has_null_office boolean := false;
  clean_ids uuid[];
  found_count integer := 0;
  inactive_new_count integer := 0;
  before_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select exists (
    select 1
    from unnest(coalesce(requested_office_ids, array[]::uuid[])) as u(val)
    where u.val is null
  ) into has_null_office;

  if has_null_office then
    raise exception using errcode = '22023', message = 'office_id cannot be null';
  end if;

  select coalesce(array_agg(distinct u.val order by u.val), array[]::uuid[])
  into clean_ids
  from unnest(coalesce(requested_office_ids, array[]::uuid[])) as u(val);

  select * into target_staff
  from public.staff_profiles
  where user_id = requested_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'staff user not found';
  end if;

  if target_staff.decommissioned_at is not null then
    raise exception using errcode = 'P0004', message = 'target_decommissioned';
  end if;

  if coalesce(array_length(clean_ids, 1), 0) > 0 then
    if not target_staff.active then
      raise exception using errcode = '42501', message = 'staff account is inactive';
    end if;

    if target_staff.role <> 'office_staff'::public.staff_role then
      raise exception using errcode = '22023', message = 'office assignments require office_staff role';
    end if;

    select count(*) into found_count
    from public.offices
    where id = any(clean_ids);

    if found_count <> array_length(clean_ids, 1) then
      raise exception using errcode = 'P0002', message = 'one or more office ids do not exist';
    end if;

    select count(*) into inactive_new_count
    from public.offices o
    where o.id = any(clean_ids)
      and not o.active
      and not exists (
        select 1 from public.office_staff_assignments existing
        where existing.user_id = requested_user_id
          and existing.office_id = o.id
      );

    if inactive_new_count > 0 then
      raise exception using errcode = '42501', message = 'office is inactive';
    end if;
  end if;

  select coalesce(array_agg(a.office_id order by a.office_id), array[]::uuid[])
  into before_ids
  from public.office_staff_assignments a
  where a.user_id = requested_user_id;

  if coalesce(array_length(clean_ids, 1), 0) = 0 then
    delete from public.office_staff_assignments
    where user_id = requested_user_id;
  else
    delete from public.office_staff_assignments
    where user_id = requested_user_id
      and not (office_id = any(clean_ids));

    insert into public.office_staff_assignments(user_id, office_id, created_by)
    select requested_user_id, oid, requested_actor_id
    from unnest(clean_ids) as oid
    on conflict (user_id, office_id) do nothing;
  end if;

  insert into public.audit_events(
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    before_state,
    after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.assignments_replaced',
    'staff_profile',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object('officeIds', to_jsonb(before_ids)),
    jsonb_build_object('officeIds', to_jsonb(clean_ids))
  );

  return jsonb_build_object(
    'userId', requested_user_id,
    'officeIds', to_jsonb(clean_ids),
    'beforeOfficeIds', to_jsonb(before_ids)
  );
end;
$$;

revoke all on function api.replace_staff_office_assignments(uuid, uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function api.replace_staff_office_assignments(uuid, uuid, uuid[], uuid) to service_role;

-- 6. RPC: api.save_system_settings (single atomic transaction across operational, instructions, retention, and audit)
create or replace function api.save_system_settings(
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
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  current_settings public.app_settings%rowtype;
  changes_security_settings boolean;
  new_peak_mode public.peak_mode_scope;
  new_reasons jsonb;
  new_purposes jsonb;
  new_instructions jsonb;
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
  new_photo_enabled boolean;
  new_policy_photo_days integer;
  new_id_enabled boolean;
  new_policy_id_days integer;
  new_vehicle_enabled boolean;
  new_vehicle_days integer;
  new_visitor_enabled boolean;
  new_policy_visitor_days integer;
  new_returning_enabled boolean;
  new_returning_days integer;
  new_overrides jsonb;
  effective_reason text;
  retention_audit_entry jsonb := null;
  elem jsonb;
  updated_row public.app_settings%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into current_settings
  from public.app_settings
  where singleton = true
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'settings not found';
  end if;

  if requested_rejection_reasons is not null then
    if jsonb_typeof(requested_rejection_reasons) <> 'array' or jsonb_array_length(requested_rejection_reasons) > 50 then
      raise exception using errcode = '23514', message = 'rejection_reasons must be an array of up to 50 items';
    end if;
    for elem in select * from jsonb_array_elements(requested_rejection_reasons) loop
      if jsonb_typeof(elem) <> 'string' or char_length(btrim(elem #>> '{}')) < 1 or char_length(btrim(elem #>> '{}')) > 160 then
        raise exception using errcode = '23514', message = 'each rejection reason must be 1 to 160 characters';
      end if;
    end loop;
  end if;

  if requested_visit_purposes is not null then
    if jsonb_typeof(requested_visit_purposes) <> 'array'
       or jsonb_array_length(requested_visit_purposes) < 1
       or jsonb_array_length(requested_visit_purposes) > 50 then
      raise exception using errcode = '23514', message = 'visit_purposes must be an array of 1 to 50 items';
    end if;
  end if;

  if requested_visitor_instructions is not null then
    if jsonb_typeof(requested_visitor_instructions) <> 'array'
       or jsonb_array_length(requested_visitor_instructions) < 1
       or jsonb_array_length(requested_visitor_instructions) > 8 then
      raise exception using errcode = '23514', message = 'visitor_instructions must be an array of 1 to 8 items';
    end if;
    for elem in select * from jsonb_array_elements(requested_visitor_instructions) loop
      if jsonb_typeof(elem) <> 'string' or char_length(btrim(elem #>> '{}')) < 3 or char_length(btrim(elem #>> '{}')) > 180 then
        raise exception using errcode = '23514', message = 'each visitor instruction must be 3 to 180 characters';
      end if;
    end loop;
  end if;

  changes_security_settings := (
    coalesce(requested_update_retention_policies, false) or
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
  new_instructions := coalesce(requested_visitor_instructions, current_settings.visitor_instructions);
  new_start := coalesce(requested_working_hours_start, current_settings.working_hours_start);
  new_end := coalesce(requested_working_hours_end, current_settings.working_hours_end);
  new_sched := coalesce(requested_scheduling_days_ahead, current_settings.scheduling_days_ahead);
  new_cleanup := coalesce(requested_automatic_cleanup_enabled, current_settings.automatic_cleanup_enabled);
  new_audit_ret := coalesce(requested_audit_retention_days, current_settings.audit_retention_days);
  new_rec_ret := coalesce(requested_reconciliation_retention_days, current_settings.reconciliation_retention_days);

  if new_start >= new_end then
    raise exception using errcode = '22023', message = 'start time must be earlier than end time';
  end if;

  new_photo_enabled := current_settings.photo_retention_enabled;
  new_policy_photo_days := current_settings.photo_retention_days;
  new_id_enabled := current_settings.id_retention_enabled;
  new_policy_id_days := current_settings.id_retention_days;
  new_vehicle_enabled := current_settings.vehicle_photo_retention_enabled;
  new_vehicle_days := current_settings.vehicle_photo_retention_days;
  new_visitor_enabled := current_settings.visitor_retention_enabled;
  new_policy_visitor_days := current_settings.visitor_retention_days;
  new_returning_enabled := current_settings.returning_profile_retention_enabled;
  new_returning_days := current_settings.returning_profile_retention_days;
  new_overrides := current_settings.retention_overrides;

  if coalesce(requested_update_retention_policies, false) then
    new_photo_enabled := coalesce(requested_photo_enabled, current_settings.photo_retention_enabled);
    new_policy_photo_days := coalesce(requested_policy_photo_days, requested_photo_retention_days::integer, current_settings.photo_retention_days);
    new_id_enabled := coalesce(requested_id_enabled, current_settings.id_retention_enabled);
    new_policy_id_days := coalesce(requested_policy_id_days, requested_id_retention_days::integer, current_settings.id_retention_days);
    new_vehicle_enabled := coalesce(requested_vehicle_enabled, current_settings.vehicle_photo_retention_enabled);
    new_vehicle_days := coalesce(requested_vehicle_days, current_settings.vehicle_photo_retention_days);
    new_visitor_enabled := coalesce(requested_visitor_enabled, current_settings.visitor_retention_enabled);
    new_policy_visitor_days := coalesce(requested_policy_visitor_days, requested_visitor_retention_days::integer, current_settings.visitor_retention_days);
    new_returning_enabled := coalesce(requested_returning_enabled, current_settings.returning_profile_retention_enabled);
    new_returning_days := coalesce(requested_returning_days, current_settings.returning_profile_retention_days);

    if new_policy_photo_days < 1 or new_policy_photo_days > 365 then
      raise exception using errcode = '23514', message = 'photo_retention_days must be between 1 and 365';
    end if;
    if new_policy_id_days < 1 or new_policy_id_days > 365 then
      raise exception using errcode = '23514', message = 'id_retention_days must be between 1 and 365';
    end if;
    if new_vehicle_days < 1 or new_vehicle_days > 365 then
      raise exception using errcode = '23514', message = 'vehicle_photo_retention_days must be between 1 and 365';
    end if;
    if new_policy_visitor_days < 7 or new_policy_visitor_days > 730 then
      raise exception using errcode = '23514', message = 'visitor_retention_days must be between 7 and 730';
    end if;
    if new_returning_days < 1 or new_returning_days > 365 then
      raise exception using errcode = '23514', message = 'returning_profile_retention_days must be between 1 and 365';
    end if;

    effective_reason := nullif(btrim(coalesce(requested_override_reason, '')), '');
    if effective_reason is null then
      effective_reason := 'Superadmin policy update';
    end if;

    retention_audit_entry := jsonb_build_object(
      'timestamp', now(),
      'superadmin_id', requested_actor_id,
      'reason', effective_reason,
      'previous', jsonb_build_object(
        'photo_retention_enabled', current_settings.photo_retention_enabled,
        'photo_retention_days', current_settings.photo_retention_days,
        'id_retention_enabled', current_settings.id_retention_enabled,
        'id_retention_days', current_settings.id_retention_days,
        'vehicle_photo_retention_enabled', current_settings.vehicle_photo_retention_enabled,
        'vehicle_photo_retention_days', current_settings.vehicle_photo_retention_days,
        'visitor_retention_enabled', current_settings.visitor_retention_enabled,
        'visitor_retention_days', current_settings.visitor_retention_days,
        'returning_profile_retention_enabled', current_settings.returning_profile_retention_enabled,
        'returning_profile_retention_days', current_settings.returning_profile_retention_days
      ),
      'new', jsonb_build_object(
        'photo_retention_enabled', new_photo_enabled,
        'photo_retention_days', new_policy_photo_days,
        'id_retention_enabled', new_id_enabled,
        'id_retention_days', new_policy_id_days,
        'vehicle_photo_retention_enabled', new_vehicle_enabled,
        'vehicle_photo_retention_days', new_vehicle_days,
        'visitor_retention_enabled', new_visitor_enabled,
        'visitor_retention_days', new_policy_visitor_days,
        'returning_profile_retention_enabled', new_returning_enabled,
        'returning_profile_retention_days', new_returning_days
      )
    );

    new_overrides := case
      when jsonb_array_length(current_settings.retention_overrides) >= 50
      then (current_settings.retention_overrides - 0) || jsonb_build_array(retention_audit_entry)
      else current_settings.retention_overrides || jsonb_build_array(retention_audit_entry)
    end;

    new_photo_ret := new_policy_photo_days::smallint;
    new_id_ret := new_policy_id_days::smallint;
    new_image_ret := coalesce(requested_image_retention_days, new_photo_ret, current_settings.image_retention_days);
    new_vis_ret := new_policy_visitor_days::smallint;
  else
    new_photo_ret := coalesce(requested_photo_retention_days, requested_image_retention_days, current_settings.photo_retention_days);
    new_id_ret := coalesce(requested_id_retention_days, current_settings.id_retention_days);
    new_image_ret := coalesce(requested_image_retention_days, new_photo_ret, current_settings.image_retention_days);
    new_vis_ret := coalesce(requested_visitor_retention_days, current_settings.visitor_retention_days);
  end if;

  update public.app_settings
  set
    peak_mode = new_peak_mode,
    rejection_reasons = new_reasons,
    visit_purposes = new_purposes,
    visitor_instructions = new_instructions,
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
    photo_retention_enabled = new_photo_enabled,
    id_retention_enabled = new_id_enabled,
    vehicle_photo_retention_enabled = new_vehicle_enabled,
    vehicle_photo_retention_days = new_vehicle_days,
    visitor_retention_enabled = new_visitor_enabled,
    returning_profile_retention_enabled = new_returning_enabled,
    returning_profile_retention_days = new_returning_days,
    retention_overrides = new_overrides,
    updated_by = requested_actor_id,
    updated_at = clock_timestamp()
  where singleton = true
  returning * into updated_row;

  if coalesce(requested_update_retention_policies, false) then
    update public.visitor_evidence
       set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => new_policy_photo_days)
     where kind = 'photo' and purged_at is null;

    update public.visitor_evidence
       set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => new_policy_id_days)
     where kind = 'id' and purged_at is null;

    update public.visitor_evidence
       set expires_at = coalesce(created_at, verified_at, now()) + make_interval(days => new_vehicle_days)
     where kind = 'vehicle_photo' and purged_at is null;

    insert into public.audit_events (
      actor_id,
      actor_kind,
      actor_role,
      action,
      target_type,
      target_id,
      request_id,
      after_state
    ) values (
      requested_actor_id,
      'staff',
      'superadmin',
      'maintenance.retention_override',
      'app_settings',
      'retention_policies',
      requested_request_id,
      retention_audit_entry
    );
  end if;

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
      'visitor_instructions', new_instructions,
      'working_hours_start', new_start,
      'working_hours_end', new_end,
      'image_retention_days', new_image_ret,
      'photo_retention_days', new_photo_ret,
      'id_retention_days', new_id_ret,
      'visitor_retention_days', new_vis_ret,
      'audit_retention_days', new_audit_ret,
      'reconciliation_retention_days', new_rec_ret,
      'scheduling_days_ahead', new_sched,
      'automatic_cleanup_enabled', new_cleanup,
      'photo_retention_enabled', new_photo_enabled,
      'id_retention_enabled', new_id_enabled,
      'vehicle_photo_retention_enabled', new_vehicle_enabled,
      'vehicle_photo_retention_days', new_vehicle_days,
      'visitor_retention_enabled', new_visitor_enabled,
      'returning_profile_retention_enabled', new_returning_enabled,
      'returning_profile_retention_days', new_returning_days
    )
  );

  return jsonb_build_object(
    'peak_mode', updated_row.peak_mode,
    'rejection_reasons', updated_row.rejection_reasons,
    'visit_purposes', updated_row.visit_purposes,
    'visitor_instructions', updated_row.visitor_instructions,
    'working_hours_start', to_char(updated_row.working_hours_start, 'HH24:MI'),
    'working_hours_end', to_char(updated_row.working_hours_end, 'HH24:MI'),
    'scheduling_days_ahead', updated_row.scheduling_days_ahead,
    'automatic_cleanup_enabled', updated_row.automatic_cleanup_enabled,
    'image_retention_days', updated_row.image_retention_days,
    'photo_retention_days', updated_row.photo_retention_days,
    'id_retention_days', updated_row.id_retention_days,
    'visitor_retention_days', updated_row.visitor_retention_days,
    'audit_retention_days', updated_row.audit_retention_days,
    'reconciliation_retention_days', updated_row.reconciliation_retention_days,
    'photo_retention_enabled', updated_row.photo_retention_enabled,
    'id_retention_enabled', updated_row.id_retention_enabled,
    'vehicle_photo_retention_enabled', updated_row.vehicle_photo_retention_enabled,
    'vehicle_photo_retention_days', updated_row.vehicle_photo_retention_days,
    'visitor_retention_enabled', updated_row.visitor_retention_enabled,
    'returning_profile_retention_enabled', updated_row.returning_profile_retention_enabled,
    'returning_profile_retention_days', updated_row.returning_profile_retention_days,
    'retention_override_recorded', retention_audit_entry is not null,
    'updated_at', updated_row.updated_at
  );
end;
$$;

revoke all on function api.save_system_settings(
  uuid, public.peak_mode_scope, jsonb, jsonb, jsonb, time, time,
  smallint, smallint, smallint, smallint, smallint, smallint, smallint, boolean,
  boolean, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text, uuid
) from public, anon, authenticated;

grant execute on function api.save_system_settings(
  uuid, public.peak_mode_scope, jsonb, jsonb, jsonb, time, time,
  smallint, smallint, smallint, smallint, smallint, smallint, smallint, boolean,
  boolean, boolean, integer, boolean, integer, boolean, integer, boolean, integer, boolean, integer, text, uuid
) to service_role;
