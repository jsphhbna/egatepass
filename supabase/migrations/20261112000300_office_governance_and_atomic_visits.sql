-- =============================================================================
-- Migration 88: Office Publication Lifecycle, Approval Policy, Atomic Visits,
-- Expected Gate Assignment, and Campus Calendar Suspension Support
-- =============================================================================

-- 1. Campus calendar: support 'emergency_suspension' and archiving
do $$
declare
  c_name text;
begin
  for c_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'campus_calendar_closures'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%closure_type%'
  loop
    execute format('alter table public.campus_calendar_closures drop constraint if exists %I', c_name);
  end loop;
end $$;

alter table public.campus_calendar_closures
  add constraint campus_calendar_closures_closure_type_check
    check (closure_type in ('holiday', 'campus_closure', 'emergency_suspension')),
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.staff_profiles(user_id) on delete set null;

-- 2. Authoritative Office Publication Lifecycle & Approval Policy
alter table public.offices
  add column if not exists publication_status text not null default 'draft'
    check (publication_status in ('draft', 'published', 'archived')),
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid references public.staff_profiles(user_id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.staff_profiles(user_id) on delete set null,
  add column if not exists requires_approval_before_pass boolean not null default true;

-- Backfill safely: previously verified offices become 'published'; unverified remain 'draft'
update public.offices
set
  publication_status = case when verified = true then 'published' else 'draft' end,
  published_at = case when verified = true then coalesce(verified_at, updated_at, created_at) else null end,
  published_by = case when verified = true then verified_by else null end
where publication_status = 'draft';

create index if not exists idx_offices_publication_active
  on public.offices (publication_status, active);

-- 3. Authoritative Expected Arrival Gate on passes & app_settings
alter table public.app_settings
  add column if not exists default_expected_gate text;

alter table public.passes
  add column if not exists expected_gate text;

create index if not exists idx_passes_expected_gate_status
  on public.passes (btrim(lower(expected_gate)), status, valid_until)
  where expected_gate is not null;

-- 4. Office Visits Immutable Policy Snapshot, Source, and Decision Attribution
alter table public.office_visits
  add column if not exists office_requires_approval_snapshot boolean not null default true,
  add column if not exists decision_source text
    check (decision_source is null or decision_source in ('manual_staff', 'auto_office_policy')),
  add column if not exists source public.pass_source not null default 'portal',
  add column if not exists expected_gate text;

update public.office_visits ov
set
  office_requires_approval_snapshot = case
    when ov.visit_type = 'general' and ov.decided_by is null and ov.approval_status = 'approved'::public.office_approval_status then false
    else true
  end,
  decision_source = case
    when ov.approval_status in ('approved'::public.office_approval_status, 'rejected'::public.office_approval_status)
      and ov.decided_by is not null then 'manual_staff'
    when ov.approval_status = 'approved'::public.office_approval_status
      and ov.decided_by is null then 'auto_office_policy'
    else null
  end
where decision_source is null;

create unique index if not exists idx_office_visits_unique_pass_id
  on public.office_visits (pass_id)
  where pass_id is not null;

-- 5. Transactional Office Governance RPCs
create or replace function api.update_office_publication(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_status text,
  requested_request_id uuid default gen_random_uuid()
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
  updated_office public.offices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_status not in ('draft', 'published', 'archived') then
    raise exception using errcode = '22023', message = 'invalid_publication_status';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required_for_office_publication';
  end if;

  select * into target_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  if requested_status = 'published' then
    update public.offices
    set
      publication_status = 'published',
      verified = true,
      verified_at = coalesce(verified_at, now()),
      verified_by = coalesce(verified_by, requested_actor_id),
      published_at = coalesce(published_at, now()),
      published_by = requested_actor_id,
      archived_at = null,
      archived_by = null,
      updated_by = requested_actor_id,
      updated_at = now()
    where id = target_office.id
    returning * into updated_office;
  elsif requested_status = 'draft' then
    if target_office.publication_status = 'archived' then
      raise exception using errcode = '40900', message = 'archived_office_cannot_revert_to_draft';
    end if;
    update public.offices
    set
      publication_status = 'draft',
      verified = false,
      updated_by = requested_actor_id,
      updated_at = now()
    where id = target_office.id
    returning * into updated_office;
  else
    update public.offices
    set
      publication_status = 'archived',
      active = false,
      verified = false,
      archived_at = coalesce(archived_at, now()),
      archived_by = requested_actor_id,
      updated_by = requested_actor_id,
      updated_at = now()
    where id = target_office.id
    returning * into updated_office;
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    case requested_status
      when 'published' then 'office.publish'
      when 'archived' then 'office.archive'
      else 'office.unpublish'
    end,
    'office',
    target_office.id::text,
    requested_request_id,
    jsonb_build_object(
      'publicationStatus', target_office.publication_status,
      'active', target_office.active,
      'verified', target_office.verified
    ),
    jsonb_build_object(
      'publicationStatus', updated_office.publication_status,
      'active', updated_office.active,
      'verified', updated_office.verified
    )
  );

  return jsonb_build_object(
    'id', updated_office.id,
    'name', updated_office.name,
    'publicationStatus', updated_office.publication_status,
    'active', updated_office.active,
    'requiresApprovalBeforePass', updated_office.requires_approval_before_pass,
    'publishedAt', updated_office.published_at,
    'archivedAt', updated_office.archived_at
  );
end;
$$;

revoke all on function api.update_office_publication(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.update_office_publication(uuid, uuid, text, uuid) to service_role;

create or replace function api.archive_office(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_staff_handling text default 'keep',
  requested_reason text default null,
  requested_request_id uuid default gen_random_uuid()
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
  updated_office public.offices%rowtype;
  removed_assignments integer := 0;
  deactivated_staff integer := 0;
  v_unshared_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_staff_handling not in ('keep', 'unassign', 'deactivate_unshared') then
    raise exception using errcode = '22023', message = 'invalid_staff_handling_option';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required_to_archive_office';
  end if;

  select * into target_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  update public.offices
  set
    publication_status = 'archived',
    active = false,
    verified = false,
    archived_at = coalesce(archived_at, now()),
    archived_by = requested_actor_id,
    updated_by = requested_actor_id,
    updated_at = now()
  where id = target_office.id
  returning * into updated_office;

  if requested_staff_handling in ('unassign', 'deactivate_unshared') then
    if requested_staff_handling = 'deactivate_unshared' then
      for v_unshared_id in
        select distinct a.user_id
        from public.office_staff_assignments a
        join public.staff_profiles sp on sp.user_id = a.user_id
        where a.office_id = target_office.id
          and sp.role = 'office_staff'::public.staff_role
          and sp.active = true
          and not exists (
            select 1
            from public.office_staff_assignments other
            join public.offices oo on oo.id = other.office_id
            where other.user_id = a.user_id
              and other.office_id <> target_office.id
              and oo.publication_status <> 'archived'
          )
      loop
        update public.staff_profiles
        set active = false, updated_at = now()
        where user_id = v_unshared_id and active = true;
        if found then
          deactivated_staff := deactivated_staff + 1;
        end if;
      end loop;
    end if;

    delete from public.office_staff_assignments
    where office_id = target_office.id;
    get diagnostics removed_assignments = row_count;
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.archive',
    'office',
    target_office.id::text,
    requested_request_id,
    jsonb_build_object(
      'name', target_office.name,
      'publicationStatus', target_office.publication_status,
      'active', target_office.active
    ),
    jsonb_build_object(
      'name', updated_office.name,
      'publicationStatus', 'archived',
      'active', false,
      'staffHandling', requested_staff_handling,
      'removedAssignments', removed_assignments,
      'deactivatedStaff', deactivated_staff,
      'reason', nullif(btrim(coalesce(requested_reason, '')), '')
    )
  );

  return jsonb_build_object(
    'id', updated_office.id,
    'publicationStatus', updated_office.publication_status,
    'active', updated_office.active,
    'archivedAt', updated_office.archived_at,
    'removedAssignments', removed_assignments,
    'deactivatedStaff', deactivated_staff
  );
end;
$$;

revoke all on function api.archive_office(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.archive_office(uuid, uuid, text, text, uuid) to service_role;

create or replace function api.update_office_approval_policy(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_requires_approval boolean,
  requested_request_id uuid default gen_random_uuid()
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
  updated_office public.offices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_requires_approval is null then
    raise exception using errcode = '22023', message = 'requires_approval_before_pass_required';
  end if;

  select role into actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active
    and not must_change_password
    and privacy_accepted_at is not null;

  if actor_role is null or actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required_for_approval_policy';
  end if;

  select * into target_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  update public.offices
  set
    requires_approval_before_pass = requested_requires_approval,
    updated_by = requested_actor_id,
    updated_at = now()
  where id = target_office.id
  returning * into updated_office;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.approval_policy_updated',
    'office',
    target_office.id::text,
    requested_request_id,
    jsonb_build_object('requiresApprovalBeforePass', target_office.requires_approval_before_pass),
    jsonb_build_object('requiresApprovalBeforePass', updated_office.requires_approval_before_pass)
  );

  return jsonb_build_object(
    'id', updated_office.id,
    'requiresApprovalBeforePass', updated_office.requires_approval_before_pass
  );
end;
$$;

revoke all on function api.update_office_approval_policy(uuid, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function api.update_office_approval_policy(uuid, uuid, boolean, uuid) to service_role;

create or replace function api.delete_draft_office(
  requested_actor_id uuid,
  requested_office_id uuid,
  requested_request_id uuid default gen_random_uuid()
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
  has_refs boolean := false;
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

  select * into target_office
  from public.offices
  where id = requested_office_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'office_not_found';
  end if;

  if target_office.publication_status <> 'draft' or target_office.published_at is not null or target_office.archived_at is not null then
    raise exception using errcode = '40900', message = 'only_unused_draft_office_may_be_deleted';
  end if;

  select (
    exists (select 1 from public.office_visits where office_id = target_office.id)
    or exists (select 1 from public.office_personnel where office_id = target_office.id)
    or exists (select 1 from public.office_staff_assignments where office_id = target_office.id)
    or exists (select 1 from public.office_provisioning_operations where office_id = target_office.id)
    or exists (select 1 from public.reconciliation_tasks where entity_type in ('office', 'office_visit') and entity_id = target_office.id::text)
    or exists (
      select 1 from public.audit_events
      where target_type in ('office', 'office_visit')
        and target_id = target_office.id::text
        and action <> 'office.create'
    )
  ) into has_refs;

  if not has_refs and to_regclass('public.emergency_gate_records') is not null then
    execute 'select exists (select 1 from public.emergency_gate_records where destination_office_id = $1)'
      into has_refs
      using target_office.id;
  end if;

  if has_refs then
    raise exception using errcode = '40900', message = 'office_has_dependencies_use_archive';
  end if;

  delete from public.offices where id = target_office.id;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'office.draft_deleted',
    'office',
    target_office.id::text,
    requested_request_id,
    jsonb_build_object(
      'name', target_office.name,
      'publicationStatus', target_office.publication_status,
      'active', target_office.active
    )
  );

  return jsonb_build_object('deleted', true, 'id', target_office.id, 'name', target_office.name);
end;
$$;

revoke all on function api.delete_draft_office(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_draft_office(uuid, uuid, uuid) to service_role;

-- 6. Explicit Expected Gate Assignment RPC (Admin/Superadmin controlled)
create or replace function api.assign_pass_expected_gate(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_expected_gate text,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target_pass public.passes%rowtype;
  normalized_gate text;
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

  normalized_gate := nullif(btrim(coalesce(requested_expected_gate, '')), '');
  if normalized_gate is not null and char_length(normalized_gate) > 50 then
    raise exception using errcode = '22023', message = 'expected_gate_too_long';
  end if;

  select * into target_pass from public.passes where id = requested_pass_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'pass_not_found';
  end if;

  update public.passes
  set expected_gate = normalized_gate
  where id = target_pass.id;

  insert into public.audit_events (
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'pass.expected_gate_updated',
    'pass',
    target_pass.id::text,
    requested_request_id,
    jsonb_build_object('expectedGate', target_pass.expected_gate),
    jsonb_build_object('expectedGate', normalized_gate)
  );

  return jsonb_build_object('passId', target_pass.id, 'expectedGate', normalized_gate);
end;
$$;

revoke all on function api.assign_pass_expected_gate(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function api.assign_pass_expected_gate(uuid, uuid, text, uuid) to service_role;

-- 7. Upgrade api.issue_pass with optional atomic requested_office_id and expected_gate
drop function if exists api.issue_pass(
  uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text
);

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
  requested_token_digest text,
  requested_office_id uuid default null,
  requested_expected_gate text default null
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
  verification_record public.portal_identity_verification_attempts%rowtype;
  target_office public.offices%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  new_visit_id uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  id_is_required boolean;
  target_closure_title text;
  effective_expected_gate text;
  v_first_name text;
  v_last_name text;
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

  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  -- Enforce office governance inside the same transaction if destination office provided
  if requested_office_id is not null then
    select * into target_office
    from public.offices
    where id = requested_office_id
      and active = true
      and publication_status = 'published';
    if not found then
      raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
    end if;
    if target_office.requires_approval_before_pass then
      raise exception using errcode = '40900', message = 'office_approval_required';
    end if;
  end if;

  if char_length(btrim(requested_full_name)) not between 2 and 160
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 160
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid pass parameters';
  end if;

  id_is_required := requested_source = 'portal'::public.pass_source
    or settings.peak_mode <> 'off'::public.peak_mode_scope;
  if id_is_required and requested_id_intent_id is null then
    raise exception using errcode = '22023', message = 'identification image required';
  end if;

  if requested_source = 'portal'::public.pass_source then
    select * into verification_record
    from public.portal_identity_verification_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and photo_intent_id = requested_photo_intent_id
      and id_intent_id = requested_id_intent_id
      and outcome = 'matched'
      and expires_at > now()
    order by verified_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid matched identity verification required';
    end if;
  end if;

  select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
  if not found or photo_intent.owner_id <> requested_actor_id or photo_intent.source <> requested_source
    or photo_intent.kind <> 'photo'::public.evidence_kind or photo_intent.status <> 'pending'::public.upload_intent_status
    or photo_intent.expires_at <= now()
    or requested_photo_bytes not between 1 and photo_intent.max_bytes
    or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid photo upload intent';
  end if;

  if requested_id_intent_id is not null then
    select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id or id_intent.source <> requested_source
      or id_intent.kind <> 'id'::public.evidence_kind or id_intent.status <> 'pending'::public.upload_intent_status
      or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;
  if ends_at <= now() then raise exception using errcode = '22023', message = 'visit window already closed'; end if;

  effective_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number),
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_source = 'portal'::public.pass_source then verification_record.id else null end,
    case when requested_source = 'portal'::public.pass_source then verification_record.verified_at else null end
  ) returning id into new_visitor_id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), greatest(
      now() + make_interval(days => coalesce(settings.photo_retention_days, settings.image_retention_days, 7)),
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
        now() + make_interval(days => coalesce(settings.id_retention_days, settings.image_retention_days, 30)),
        ends_at + interval '1 day'
      )
    );

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  insert into public.passes (
    visitor_id, source, issue_request_id, status, valid_from, valid_until,
    token_digest, expected_gate
  ) values (
    new_visitor_id, requested_source, requested_request_id, 'issued'::public.pass_status,
    starts_at, ends_at, decode(requested_token_digest, 'hex'), effective_expected_gate
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  -- Atomic general office visit linkage when officeId was supplied
  if requested_office_id is not null then
    v_first_name := split_part(btrim(requested_full_name), ' ', 1);
    v_last_name := coalesce(nullif(btrim(substring(btrim(requested_full_name) from length(v_first_name) + 2)), ''), '-');

    insert into public.office_visits (
      visit_type, office_id, approval_status, attendance_status,
      visitor_actor_id, visitor_id, pass_id,
      visitor_first_name, visitor_last_name, visitor_display_name,
      visitor_contact_number, visitor_email, visitor_email_verified,
      purpose, visit_date, arrival_mode, request_id, email_delivery_status,
      office_requires_approval_snapshot, decided_at, decided_by, decision_source,
      source, expected_gate
    ) values (
      'general', requested_office_id, 'approved'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
      requested_actor_id, new_visitor_id, new_pass_id,
      v_first_name, v_last_name, btrim(requested_full_name),
      btrim(requested_contact_number), null, false,
      btrim(requested_purpose), requested_visit_date, 'no_vehicle', requested_request_id, 'none',
      false, now(), null, 'auto_office_policy',
      requested_source, effective_expected_gate
    ) returning id into new_visit_id;

    insert into public.office_visit_events (
      office_visit_id, actor_id, actor_role, event_type, metadata
    ) values (
      new_visit_id, null, 'system', 'auto_approved_by_policy',
      jsonb_build_object(
        'pass_id', new_pass_id,
        'office_id', requested_office_id,
        'visit_date', requested_visit_date,
        'decision_source', 'auto_office_policy',
        'office_requires_approval_snapshot', false
      )
    );
  end if;

  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'system' end,
    'pass.issue', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object(
      'source', requested_source,
      'visitDate', requested_visit_date,
      'publicReference', new_public_reference,
      'officeId', requested_office_id,
      'expectedGate', effective_expected_gate
    )
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_pass(
  uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function api.issue_pass(
  uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text, uuid, text
) to service_role;

-- 8. Upgrade api.issue_online_pass_v6 with atomic office_id & approval enforcement + expected_gate
drop function if exists api.issue_online_pass_v6(
  uuid, text, uuid, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, text, text, text, text, text, text,
  numeric, numeric,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text, boolean, boolean
);

create or replace function api.issue_online_pass_v6(
  requested_actor_id uuid,
  requested_registration_mode text,
  requested_request_id uuid,
  requested_first_name text,
  requested_middle_name text,
  requested_last_name text,
  requested_contact_number text,
  requested_purpose text,
  requested_visit_date date,
  requested_photo_intent_id uuid default null,
  requested_photo_bytes integer default null,
  requested_photo_sha256 text default null,
  requested_id_intent_id uuid default null,
  requested_id_bytes integer default null,
  requested_id_sha256 text default null,
  requested_token_digest text default null,
  requested_arrival_mode text default 'no_vehicle',
  requested_psgc_version text default '2026-q3',
  requested_psgc_region_code text default null,
  requested_psgc_province_code text default null,
  requested_psgc_city_code text default null,
  requested_psgc_barangay_code text default null,
  requested_home_building text default null,
  requested_home_street text default null,
  requested_postal_code text default null,
  requested_postal_code_source text default null,
  requested_home_location_lat numeric(6,3) default null,
  requested_home_location_lon numeric(6,3) default null,
  requested_vehicle_type text default null,
  requested_plate_number text default null,
  requested_plate_key text default null,
  requested_color text default null,
  requested_make_model text default null,
  requested_vehicle_catalog_status text default 'catalog',
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  requested_saved_vehicle_id uuid default null,
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_save_vehicle boolean default false,
  requested_save_profile_updates boolean default false,
  requested_office_id uuid default null,
  requested_expected_gate text default null
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
  target_office public.offices%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  existing_pass public.passes%rowtype;
  existing_visitor public.visitors%rowtype;
  existing_decl public.visit_vehicle_declarations%rowtype;
  version_rec public.psgc_reference_versions%rowtype;
  region_rec public.psgc_locations%rowtype;
  province_rec public.psgc_locations%rowtype;
  city_rec public.psgc_locations%rowtype;
  barangay_rec public.psgc_locations%rowtype;
  region_has_provinces boolean;
  v_region_name text;
  v_province_name text := null;
  v_city_name text;
  v_barangay_name text;
  effective_home_address text;
  returning_profile_id_resolved uuid := null;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  new_vehicle_evidence_id uuid := null;
  new_visit_id uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  full_name_calc text;
  v_plate_conflict boolean := false;
  target_closure_title text;
  effective_expected_gate text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if not exists (
    select 1 from auth.users u
    where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
  ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
    or exists (select 1 from public.devices where user_id = requested_actor_id) then
    raise exception using errcode = '42501', message = 'anonymous visitor identity required';
  end if;

  if requested_registration_mode not in ('new', 'returning') then
    raise exception using errcode = '22023', message = 'invalid registration mode';
  end if;
  if requested_arrival_mode not in ('no_vehicle', 'vehicle') then
    raise exception using errcode = '22023', message = 'invalid arrival mode: explicit selection required';
  end if;

  full_name_calc := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  if requested_psgc_barangay_code = '1380600408' then requested_psgc_barangay_code := '1380606014';
  elsif requested_psgc_barangay_code = '1380600409' then requested_psgc_barangay_code := '1380606015';
  elsif requested_psgc_barangay_code = '1380600410' then requested_psgc_barangay_code := '1380606016';
  elsif requested_psgc_barangay_code = '1380600411' then requested_psgc_barangay_code := '1380606017';
  elsif requested_psgc_barangay_code = '1380600412' then requested_psgc_barangay_code := '1380606018';
  elsif requested_psgc_barangay_code = '1380600413' then requested_psgc_barangay_code := '1380606019';
  elsif requested_psgc_barangay_code = '1380600414' then requested_psgc_barangay_code := '1380606020';
  elsif requested_psgc_barangay_code = '1380600415' then requested_psgc_barangay_code := '1380606021';
  elsif requested_psgc_barangay_code = '1380600587' then requested_psgc_barangay_code := '1380606193';
  elsif requested_psgc_barangay_code = '1380600588' then requested_psgc_barangay_code := '1380606195';
  elsif requested_psgc_barangay_code = '1380600629' then requested_psgc_barangay_code := '1380606236';
  elsif requested_psgc_barangay_code = '1380600830' then requested_psgc_barangay_code := '1380611045';
  elsif requested_psgc_barangay_code = '1380600831' then requested_psgc_barangay_code := '1380611046';
  elsif requested_psgc_barangay_code = '1380600659' then requested_psgc_barangay_code := '1380608001';
  elsif requested_psgc_barangay_code = '1380600660' then requested_psgc_barangay_code := '1380608003';
  elsif requested_psgc_barangay_code = '1380600661' then requested_psgc_barangay_code := '1380608005';
  elsif requested_psgc_barangay_code = '1380600667' then requested_psgc_barangay_code := '1380608009';
  elsif requested_psgc_barangay_code = '1380600696' then requested_psgc_barangay_code := '1380610011';
  elsif requested_psgc_barangay_code = '1380600697' then requested_psgc_barangay_code := '1380610012';
  elsif requested_psgc_barangay_code = '1380600700' then requested_psgc_barangay_code := '1380610015';
  elsif requested_psgc_barangay_code = '1380600821' then requested_psgc_barangay_code := '1380611036';
  elsif requested_psgc_barangay_code = '1380600822' then requested_psgc_barangay_code := '1380611037';
  elsif requested_psgc_barangay_code = '1380600823' then requested_psgc_barangay_code := '1380611038';
  elsif requested_psgc_barangay_code = '1380600287' then requested_psgc_barangay_code := '1380602001';
  elsif requested_psgc_barangay_code = '1380600306' then requested_psgc_barangay_code := '1380603015';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  select * into existing_pass from public.passes
  where issue_request_id = requested_request_id;

  if found then
    select * into existing_visitor from public.visitors where id = existing_pass.visitor_id;
    if not found or existing_visitor.owner_id <> requested_actor_id or existing_visitor.source <> 'portal'::public.pass_source then
      raise exception using errcode = '42501', message = 'idempotency actor mismatch';
    end if;

    select * into existing_decl from public.visit_vehicle_declarations where visit_vehicle_declarations.pass_id = existing_pass.id;
    if existing_visitor.registration_mode <> requested_registration_mode
      or existing_visitor.full_name <> full_name_calc
      or existing_visitor.contact_number <> btrim(requested_contact_number)
      or existing_visitor.purpose <> btrim(requested_purpose)
      or existing_visitor.visit_date <> requested_visit_date
      or existing_visitor.arrival_mode <> requested_arrival_mode
      or (existing_visitor.psgc_region_code is distinct from requested_psgc_region_code)
      or (existing_visitor.psgc_province_code is distinct from requested_psgc_province_code)
      or (existing_visitor.psgc_city_code is distinct from requested_psgc_city_code)
      or (existing_visitor.psgc_barangay_code is distinct from requested_psgc_barangay_code)
      or (requested_arrival_mode = 'vehicle' and (
        existing_decl.vehicle_type is distinct from requested_vehicle_type
        or existing_decl.plate_key is distinct from requested_plate_key
        or existing_decl.color is distinct from requested_color
      )) then
      raise exception using errcode = '22023', message = 'idempotency parameter mismatch';
    end if;

    pass_id := existing_pass.id;
    public_reference := existing_pass.public_reference;
    valid_from := existing_pass.valid_from;
    valid_until := existing_pass.valid_until;
    return next;
    return;
  end if;

  select * into settings from public.app_settings where singleton for share;
  if requested_visit_date < (now() at time zone settings.timezone)::date
    or requested_visit_date > (now() at time zone settings.timezone)::date + settings.scheduling_days_ahead then
    raise exception using errcode = '22023', message = 'visit date outside scheduling window';
  end if;

  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  -- Enforce office governance atomically when destination office is selected
  if requested_office_id is not null then
    select * into target_office
    from public.offices
    where id = requested_office_id
      and active = true
      and publication_status = 'published';
    if not found then
      raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
    end if;
    if target_office.requires_approval_before_pass then
      raise exception using errcode = '40900', message = 'office_approval_required';
    end if;
  end if;

  if char_length(btrim(requested_first_name)) not between 1 and 50
    or char_length(btrim(requested_last_name)) not between 1 and 50
    or char_length(btrim(requested_contact_number)) not between 7 and 32
    or char_length(btrim(requested_purpose)) not between 3 and 300
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid pass parameters';
  end if;

  if requested_contact_number !~ '^\+639[0-9]{9}$' then
    raise exception using errcode = '22023', message = 'invalid philippine mobile number';
  end if;

  if requested_psgc_region_code is null or requested_psgc_city_code is null or requested_psgc_barangay_code is null then
    raise exception using errcode = '22023', message = 'structured psgc residential address required';
  end if;

  select * into version_rec from public.psgc_reference_versions
  where id = coalesce(requested_psgc_version, '2026-q3') and is_active = true;
  if not found then
    raise exception using errcode = '22023', message = 'invalid or inactive psgc dataset version';
  end if;

  select * into region_rec from public.psgc_locations
  where psgc_code = requested_psgc_region_code and level = 'region' and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'invalid psgc region'; end if;
  v_region_name := region_rec.name;

  select exists (
    select 1 from public.psgc_locations
    where parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true
  ) into region_has_provinces;

  if region_has_provinces then
    if requested_psgc_province_code is null then
      raise exception using errcode = '22023', message = 'psgc province code required for region';
    end if;
    select * into province_rec from public.psgc_locations
    where psgc_code = requested_psgc_province_code
      and parent_psgc_code = requested_psgc_region_code and level = 'province' and is_active = true;
    if not found then raise exception using errcode = '22023', message = 'psgc province does not belong to selected region'; end if;
    v_province_name := province_rec.name;
  else
    if requested_psgc_province_code is not null then
      raise exception using errcode = '22023', message = 'psgc province not permitted for region with no provinces';
    end if;
  end if;

  select * into city_rec from public.psgc_locations
  where psgc_code = requested_psgc_city_code
    and level in ('city', 'municipality') and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'invalid psgc city or municipality'; end if;

  if region_has_provinces then
    if city_rec.parent_psgc_code <> requested_psgc_province_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected province';
    end if;
  else
    if city_rec.parent_psgc_code <> requested_psgc_region_code then
      raise exception using errcode = '22023', message = 'psgc city/municipality does not belong to selected region';
    end if;
  end if;
  v_city_name := city_rec.name;

  select * into barangay_rec from public.psgc_locations
  where psgc_code = requested_psgc_barangay_code
    and parent_psgc_code = requested_psgc_city_code and level = 'barangay' and is_active = true;
  if not found then raise exception using errcode = '22023', message = 'psgc barangay does not belong to selected city/municipality'; end if;
  v_barangay_name := barangay_rec.name;

  if requested_postal_code is not null and btrim(requested_postal_code) !~ '^[0-9]{4}$' then
    raise exception using errcode = '22023', message = 'invalid philippine 4-digit postal code';
  end if;

  effective_home_address := concat_ws(', ',
    nullif(btrim(requested_home_building), ''),
    nullif(btrim(requested_home_street), ''),
    v_barangay_name,
    v_city_name,
    v_province_name,
    v_region_name,
    case when nullif(btrim(requested_postal_code), '') is not null then concat('Postal Code ', btrim(requested_postal_code)) else null end
  );

  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_type is null or requested_vehicle_type not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_plate_number is null or char_length(btrim(requested_plate_number)) not between 3 and 16
      or requested_plate_key is null or char_length(btrim(requested_plate_key)) not between 3 and 16
      or requested_color is null or char_length(btrim(requested_color)) not between 2 and 40
      or requested_vehicle_catalog_status not in ('catalog', 'manual') then
      raise exception using errcode = '22023', message = 'invalid vehicle declaration details';
    end if;

    if requested_vehicle_photo_intent_id is null or requested_vehicle_photo_bytes is null or requested_vehicle_photo_sha256 is null then
      raise exception using errcode = '22023', message = 'vehicle photo required for vehicle arrival mode';
    end if;

    select * into vehicle_photo_intent from public.upload_intents where id = requested_vehicle_photo_intent_id for update;
    if not found or vehicle_photo_intent.owner_id <> requested_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status <> 'pending'::public.upload_intent_status
      or vehicle_photo_intent.expires_at <= now()
      or requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes
      or requested_vehicle_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid vehicle photo upload intent';
    end if;

    select exists (
      select 1 from public.visit_vehicle_declarations vd
      join public.passes p on p.id = vd.pass_id
      where vd.plate_key = requested_plate_key
        and p.valid_until > now()
        and p.status in ('issued', 'pending', 'inside')
    ) into v_plate_conflict;
  end if;

  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'photo upload intent required for new visitor';
    end if;
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required for new visitor';
    end if;

    select * into verification_record
    from public.portal_identity_verification_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and photo_intent_id = requested_photo_intent_id
      and id_intent_id = requested_id_intent_id
      and outcome = 'matched'
      and expires_at > now()
    order by verified_at desc
    limit 1;

    if not found then
      raise exception using errcode = '42501', message = 'valid matched identity verification required';
    end if;

    select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> 'portal'::public.pass_source or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'pending'::public.upload_intent_status or photo_intent.expires_at <= now()
      or requested_photo_bytes not between 1 and photo_intent.max_bytes
      or requested_photo_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid photo upload intent';
    end if;

    select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
    if not found or id_intent.owner_id <> requested_actor_id
      or id_intent.source <> 'portal'::public.pass_source or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'pending'::public.upload_intent_status or id_intent.expires_at <= now()
      or requested_id_bytes not between 1 and id_intent.max_bytes
      or requested_id_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'invalid identification upload intent';
    end if;

    insert into public.returning_visitor_profiles (
      first_name, middle_name, last_name, contact_number_e164,
      home_address, home_location_lat, home_location_lon,
      psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
      psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
      home_building, home_street, postal_code, postal_code_source,
      consent_accepted_at, consent_version, expires_at
    ) values (
      btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), btrim(requested_contact_number),
      effective_home_address, requested_home_location_lat, requested_home_location_lon,
      version_rec.id, requested_psgc_region_code, requested_psgc_province_code, requested_psgc_city_code, requested_psgc_barangay_code,
      v_region_name, v_province_name, v_city_name, v_barangay_name,
      nullif(btrim(requested_home_building), ''), nullif(btrim(requested_home_street), ''),
      nullif(btrim(requested_postal_code), ''), nullif(btrim(requested_postal_code_source), ''),
      now(), 'v1', now() + interval '365 days'
    ) returning id into returning_profile_id_resolved;

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '22023', message = 'returning match credentials required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();
    if not found then
      raise exception using errcode = '42501', message = 'returning profile not found or expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts
    where owner_id = requested_actor_id
      and request_id = requested_request_id::text
      and matched_profile_id = requested_returning_profile_id
      and match_token_digest = requested_returning_match_token_digest
      and outcome in ('matched', 'provisional_matched')
      and expires_at > now()
    order by created_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid returning identity match required';
    end if;

    if coalesce(returning_attempt_record.threshold_mode, 'provisional') = 'calibrated'
       and returning_attempt_record.outcome = 'matched' then
      returning_profile_id_resolved := requested_returning_profile_id;

      if requested_save_profile_updates then
        update public.returning_visitor_profiles
        set last_used_at = now(),
            updated_at = now(),
            expires_at = greatest(expires_at, now() + interval '365 days'),
            contact_number_e164 = btrim(requested_contact_number),
            psgc_version = coalesce(version_rec.id, psgc_version),
            psgc_region_code = coalesce(requested_psgc_region_code, psgc_region_code),
            psgc_province_code = coalesce(requested_psgc_province_code, psgc_province_code),
            psgc_city_code = coalesce(requested_psgc_city_code, psgc_city_code),
            psgc_barangay_code = coalesce(requested_psgc_barangay_code, psgc_barangay_code),
            psgc_region_name = coalesce(v_region_name, psgc_region_name),
            psgc_province_name = coalesce(v_province_name, psgc_province_name),
            psgc_city_municipality_name = coalesce(v_city_name, psgc_city_municipality_name),
            psgc_barangay_name = coalesce(v_barangay_name, psgc_barangay_name),
            home_building = coalesce(nullif(btrim(requested_home_building), ''), home_building),
            home_street = coalesce(nullif(btrim(requested_home_street), ''), home_street),
            postal_code = coalesce(nullif(btrim(requested_postal_code), ''), postal_code),
            postal_code_source = coalesce(nullif(btrim(requested_postal_code_source), ''), postal_code_source),
            home_address = coalesce(effective_home_address, home_address)
        where id = returning_profile_id_resolved;
      else
        update public.returning_visitor_profiles
        set last_used_at = now(),
            expires_at = greatest(expires_at, now() + interval '365 days')
        where id = returning_profile_id_resolved;
      end if;
    else
      returning_profile_id_resolved := null;
    end if;
  end if;

  starts_at := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
  ends_at := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;

  effective_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street, postal_code, postal_code_source,
    registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id
  ) values (
    requested_actor_id, 'portal'::public.pass_source, null,
    full_name_calc, btrim(requested_contact_number),
    effective_home_address, requested_home_location_lat, requested_home_location_lon,
    version_rec.id, requested_psgc_region_code, requested_psgc_province_code, requested_psgc_city_code, requested_psgc_barangay_code,
    v_region_name, v_province_name, v_city_name, v_barangay_name,
    nullif(btrim(requested_home_building), ''), nullif(btrim(requested_home_street), ''),
    nullif(btrim(requested_postal_code), ''), nullif(btrim(requested_postal_code_source), ''),
    requested_registration_mode, requested_arrival_mode,
    returning_profile_id_resolved,
    btrim(requested_purpose), requested_visit_date, now(),
    case when requested_registration_mode = 'new' then verification_record.id else null end,
    case when requested_registration_mode = 'new' then verification_record.verified_at else null end,
    case when requested_registration_mode = 'returning' then returning_attempt_record.id else null end
  ) returning id into new_visitor_id;

  if requested_registration_mode = 'new' and requested_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
      photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
      requested_photo_sha256, now(), greatest(
        now() + make_interval(days => coalesce(settings.photo_retention_days, settings.image_retention_days, 7)),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = photo_intent.id;
  end if;

  if requested_registration_mode = 'new' and requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type, requested_id_bytes,
      requested_id_sha256, now(), greatest(
        now() + make_interval(days => coalesce(settings.id_retention_days, settings.image_retention_days, 30)),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  if requested_arrival_mode = 'vehicle' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type, requested_vehicle_photo_bytes,
      requested_vehicle_photo_sha256, now(), greatest(
        now() + make_interval(days => coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7)),
        ends_at + interval '1 day'
      )
    ) returning id into new_vehicle_evidence_id;

    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = vehicle_photo_intent.id;
  end if;

  if coalesce(requested_save_vehicle, false) = true and requested_arrival_mode = 'vehicle' and returning_profile_id_resolved is not null then
    if not exists (
      select 1 from public.returning_visitor_vehicles
      where profile_id = returning_profile_id_resolved
        and plate_key = requested_plate_key
        and archived_at is null
    ) then
      insert into public.returning_visitor_vehicles (
        profile_id, vehicle_type, plate_number, plate_key, color, make_model
      ) values (
        returning_profile_id_resolved,
        btrim(requested_vehicle_type),
        btrim(requested_plate_number),
        btrim(requested_plate_key),
        btrim(coalesce(requested_color, '')),
        nullif(btrim(coalesce(requested_make_model, '')), '')
      );
    else
      update public.returning_visitor_vehicles
      set vehicle_type = btrim(requested_vehicle_type),
          plate_number = btrim(requested_plate_number),
          color = btrim(coalesce(requested_color, '')),
          make_model = coalesce(nullif(btrim(coalesce(requested_make_model, '')), ''), make_model),
          last_used_at = now(),
          updated_at = now()
      where profile_id = returning_profile_id_resolved
        and plate_key = requested_plate_key
        and archived_at is null;
    end if;
  end if;

  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id, expected_gate
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), 'portal'::public.pass_source, 'issued'::public.pass_status,
    starts_at, ends_at, requested_request_id, effective_expected_gate
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  if requested_arrival_mode = 'vehicle' then
    insert into public.visit_vehicle_declarations (
      visitor_id, pass_id, saved_vehicle_id, vehicle_type,
      plate_number, plate_key, color, make_model,
      vehicle_photo_evidence_id, vehicle_catalog_status, plate_conflict_flag
    ) values (
      new_visitor_id, new_pass_id, requested_saved_vehicle_id, requested_vehicle_type,
      btrim(requested_plate_number), btrim(requested_plate_key), btrim(requested_color),
      nullif(btrim(requested_make_model), ''),
      new_vehicle_evidence_id, requested_vehicle_catalog_status, v_plate_conflict
    );
  end if;

  -- Atomic general office visit linkage when officeId was supplied
  if requested_office_id is not null then
    insert into public.office_visits (
      visit_type, office_id, approval_status, attendance_status,
      visitor_actor_id, visitor_id, pass_id,
      visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
      visitor_contact_number, visitor_email, visitor_email_verified,
      purpose, visit_date, arrival_mode, address_details, request_id, email_delivery_status,
      office_requires_approval_snapshot, decided_at, decided_by, decision_source,
      source, expected_gate
    ) values (
      'general', requested_office_id, 'approved'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
      requested_actor_id, new_visitor_id, new_pass_id,
      btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), full_name_calc,
      btrim(requested_contact_number), null, false,
      btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
      jsonb_build_object(
        'region', v_region_name,
        'province', v_province_name,
        'city', v_city_name,
        'barangay', v_barangay_name
      ),
      requested_request_id, 'none',
      false, now(), null, 'auto_office_policy',
      'portal'::public.pass_source, effective_expected_gate
    ) returning id into new_visit_id;

    insert into public.office_visit_events (
      office_visit_id, actor_id, actor_role, event_type, metadata
    ) values (
      new_visit_id, null, 'system', 'auto_approved_by_policy',
      jsonb_build_object(
        'pass_id', new_pass_id,
        'office_id', requested_office_id,
        'visit_date', requested_visit_date,
        'decision_source', 'auto_office_policy',
        'office_requires_approval_snapshot', false
      )
    );
  end if;

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_online_pass_v6(
  uuid, text, uuid, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, text, text, text, text, text, text,
  numeric, numeric,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text, boolean, boolean, uuid, text
) from public, anon, authenticated;

grant execute on function api.issue_online_pass_v6(
  uuid, text, uuid, text, text, text, text, text, date,
  uuid, integer, text, uuid, integer, text, text, text,
  text, text, text, text, text, text, text, text, text,
  numeric, numeric,
  text, text, text, text, text, text, uuid, integer, text,
  uuid, uuid, text, boolean, boolean, uuid, text
) to service_role;

-- 9. Unified Authoritative Office Visit Submission RPC
-- Supports BOTH general & specific_person, portal & kiosk, and honors
-- offices.requires_approval_before_pass atomically inside PostgreSQL!
drop function if exists api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb, uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid, text, text, timestamptz, text
);

create or replace function api.create_specific_person_visit_request(
  requested_actor_id uuid,
  requested_request_id uuid,
  requested_office_id uuid,
  requested_personnel_id uuid default null,
  requested_first_name text default null,
  requested_middle_name text default null,
  requested_last_name text default null,
  requested_contact_number text default null,
  requested_email text default null,
  requested_purpose text default null,
  requested_visit_date date default null,
  requested_arrival_mode text default 'no_vehicle',
  requested_vehicle_details jsonb default null,
  requested_address_details jsonb default null,
  requested_photo_intent_id uuid default null,
  requested_photo_bytes integer default null,
  requested_photo_sha256 text default null,
  requested_id_intent_id uuid default null,
  requested_id_bytes integer default null,
  requested_id_sha256 text default null,
  requested_vehicle_photo_intent_id uuid default null,
  requested_vehicle_photo_bytes integer default null,
  requested_vehicle_photo_sha256 text default null,
  requested_registration_mode text default 'new',
  requested_returning_profile_id uuid default null,
  requested_returning_match_token_digest text default null,
  requested_identity_verification_id uuid default null,
  requested_returning_attempt_id uuid default null,
  requested_person_name text default null,
  requested_tracking_token_digest text default null,
  requested_tracking_token_expires_at timestamptz default null,
  requested_encrypted_tracking_token text default null,
  requested_visit_type text default 'specific_person',
  requested_source public.pass_source default 'portal',
  requested_pass_token_digest text default null,
  requested_expected_gate text default null
)
returns table (
  visit_id uuid,
  request_id uuid,
  approval_status public.office_approval_status,
  attendance_status public.office_attendance_status,
  encrypted_tracking_token text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  decision_source text,
  office_requires_approval_snapshot boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_office public.offices%rowtype;
  target_personnel public.office_personnel%rowtype;
  settings public.app_settings%rowtype;
  new_visit_id uuid;
  new_visitor_id uuid := null;
  new_pass_id uuid := null;
  new_public_ref uuid := null;
  new_photo_ev_id uuid := null;
  new_id_ev_id uuid := null;
  new_veh_ev_id uuid := null;
  existing_visit public.office_visits%rowtype;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  verification_record public.portal_identity_verification_attempts%rowtype;
  returning_attempt_record public.returning_identity_attempts%rowtype;
  returning_profile_record public.returning_visitor_profiles%rowtype;
  v_bound_profile_id uuid := null;
  v_bound_verification_id uuid := null;
  v_bound_returning_id uuid := null;
  v_plate_key text;
  v_manila_today date;
  v_max_date date;
  v_from timestamptz := null;
  v_until timestamptz := null;
  target_closure_title text;
  v_effective_person_name text;
  v_existing_encrypted_token text := null;
  v_full_name text;
  v_home_addr text;
  v_expected_gate text;
  v_normalized_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_visit_type not in ('general', 'specific_person') then
    raise exception using errcode = '22023', message = 'invalid_visit_type';
  end if;

  if requested_source not in ('portal'::public.pass_source, 'kiosk'::public.pass_source) then
    raise exception using errcode = '22023', message = 'unsupported_source';
  end if;

  if requested_source = 'portal'::public.pass_source then
    if not exists (
      select 1 from auth.users u
      where u.id = requested_actor_id and coalesce(u.is_anonymous, false) = true
    ) or exists (select 1 from public.staff_profiles where user_id = requested_actor_id)
      or exists (select 1 from public.devices where user_id = requested_actor_id) then
      raise exception using errcode = '42501', message = 'anonymous visitor identity required';
    end if;
  else
    if not exists (
      select 1 from public.devices d
      where d.user_id = requested_actor_id
        and d.type = 'kiosk'::public.device_type
        and d.status = 'active'::public.device_status
    ) then
      raise exception using errcode = '42501', message = 'active_kiosk_identity_required';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requested_request_id::text, 0));

  v_normalized_email := nullif(lower(btrim(coalesce(requested_email, ''))), '');

  select * into settings from public.app_settings where singleton for share;

  -- 1. Idempotency Check
  select * into existing_visit from public.office_visits
  where office_visits.request_id = requested_request_id;

  if found then
    if existing_visit.visitor_actor_id <> requested_actor_id then
      raise exception using errcode = '42501', message = 'request_id_actor_mismatch';
    end if;

    if existing_visit.office_id <> requested_office_id
      or (requested_personnel_id is not null and existing_visit.personnel_id is distinct from requested_personnel_id)
      or (existing_visit.visitor_email is distinct from v_normalized_email)
      or existing_visit.visit_date <> requested_visit_date
      or existing_visit.visit_type <> requested_visit_type then
      raise exception using errcode = '40900', message = 'idempotency_conflict';
    end if;

    select ovo.encrypted_tracking_token into v_existing_encrypted_token
    from public.office_visit_acknowledgement_outbox ovo
    where ovo.office_visit_id = existing_visit.id;

    if existing_visit.pass_id is not null then
      select p.public_reference, p.valid_from, p.valid_until
      into new_public_ref, v_from, v_until
      from public.passes p where p.id = existing_visit.pass_id;
    end if;

    return query select
      existing_visit.id,
      existing_visit.request_id,
      existing_visit.approval_status,
      existing_visit.attendance_status,
      v_existing_encrypted_token,
      existing_visit.pass_id,
      new_public_ref,
      v_from,
      v_until,
      existing_visit.decision_source,
      existing_visit.office_requires_approval_snapshot;
    return;
  end if;

  -- 2. Validate Scheduling Window & Closed Date
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  v_max_date := v_manila_today + coalesce(settings.scheduling_days_ahead, 14);

  if requested_visit_date < v_manila_today then
    raise exception using errcode = '22023', message = 'visit_date_in_past';
  end if;
  if requested_visit_date > v_max_date then
    raise exception using errcode = '22023', message = 'visit_date_beyond_horizon';
  end if;

  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and requested_visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  -- 3. Validate Office: MUST be active AND published
  select * into target_office from public.offices
  where id = requested_office_id
    and active = true;
  if not found then
    raise exception using errcode = '22023', message = 'office_not_found_or_inactive';
  end if;
  if target_office.publication_status <> 'published' then
    raise exception using errcode = '22023', message = 'office_not_found_or_unpublished';
  end if;

  -- 4. Validate Personnel / Requested Person Name
  v_effective_person_name := nullif(btrim(coalesce(requested_person_name, '')), '');
  if requested_visit_type = 'specific_person' then
    if requested_personnel_id is not null then
      select * into target_personnel from public.office_personnel
      where id = requested_personnel_id and office_id = requested_office_id and active;
      if not found then
        raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
      end if;
      if v_effective_person_name is null then
        v_effective_person_name := target_personnel.name;
      end if;
    elsif v_effective_person_name is not null then
      if char_length(v_effective_person_name) not between 2 and 150 then
        raise exception using errcode = '22023', message = 'requested_person_name_invalid_length';
      end if;
    else
      raise exception using errcode = '22023', message = 'requested_person_name_required';
    end if;
  else
    if requested_personnel_id is not null then
      select * into target_personnel from public.office_personnel
      where id = requested_personnel_id and office_id = requested_office_id and active;
      if not found then
        raise exception using errcode = '22023', message = 'personnel_not_found_or_inactive';
      end if;
    end if;
  end if;

  -- 5. Basic Constraints
  if requested_first_name is null or char_length(btrim(requested_first_name)) = 0 then
    raise exception using errcode = '22023', message = 'first_name_required';
  end if;
  if requested_last_name is null or char_length(btrim(requested_last_name)) = 0 then
    raise exception using errcode = '22023', message = 'last_name_required';
  end if;
  if requested_contact_number is null or char_length(btrim(requested_contact_number)) < 7 then
    raise exception using errcode = '22023', message = 'contact_number_required';
  end if;
  if requested_visit_type = 'specific_person' and v_normalized_email is null then
    raise exception using errcode = '22023', message = 'email_required';
  end if;
  if requested_purpose is null or char_length(btrim(requested_purpose)) < 3 then
    raise exception using errcode = '22023', message = 'purpose_too_short';
  end if;

  if not target_office.requires_approval_before_pass then
    if requested_pass_token_digest is null or requested_pass_token_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'valid_token_digest_required_for_auto_pass';
    end if;
    v_from := (requested_visit_date + settings.working_hours_start) at time zone settings.timezone;
    v_until := (requested_visit_date + settings.working_hours_end) at time zone settings.timezone;
    if v_until <= now() then
      raise exception using errcode = '22023', message = 'visit_window_already_closed';
    end if;
  end if;

  -- 6. Validate Arrival Mode & Vehicle
  if requested_arrival_mode = 'vehicle' then
    if requested_vehicle_details is null
      or requested_vehicle_details->>'vehicleType' is null
      or requested_vehicle_details->>'vehicleType' not in ('car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'other')
      or requested_vehicle_details->>'plateNumber' is null
      or char_length(btrim(requested_vehicle_details->>'plateNumber')) not between 3 and 16
      or requested_vehicle_details->>'color' is null
      or char_length(btrim(requested_vehicle_details->>'color')) not between 2 and 40 then
      raise exception using errcode = '22023', message = 'invalid_vehicle_declaration';
    end if;

    if requested_vehicle_photo_intent_id is null then
      raise exception using errcode = '22023', message = 'vehicle_photo_required';
    end if;

    v_plate_key := upper(regexp_replace(requested_vehicle_details->>'plateNumber', '[^a-zA-Z0-9]', '', 'g'));
    if char_length(v_plate_key) not between 3 and 16 then
      raise exception using errcode = '22023', message = 'invalid_vehicle_plate';
    end if;

    if exists (
      select 1 from public.visit_vehicle_declarations vvd
      join public.passes p on p.id = vvd.pass_id
      where vvd.plate_key = v_plate_key
        and vvd.entry_recorded_at is not null
        and vvd.exit_recorded_at is null
        and p.status in ('issued', 'pending', 'inside')
    ) then
      raise exception using errcode = '40900', message = 'plate_already_active_on_campus';
    end if;
  elsif requested_arrival_mode = 'no_vehicle' then
    if requested_vehicle_details is not null or requested_vehicle_photo_intent_id is not null then
      raise exception using errcode = '22023', message = 'unexpected_vehicle_details';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_arrival_mode';
  end if;

  -- 7. Identity Verification & Registration Mode Validation
  if requested_registration_mode = 'new' then
    if requested_photo_intent_id is null then
      raise exception using errcode = '42501', message = 'identity_proof_required';
    end if;
    if requested_source = 'portal'::public.pass_source and requested_id_intent_id is null then
      raise exception using errcode = '42501', message = 'identity_proof_required';
    end if;
    if requested_source = 'kiosk'::public.pass_source and settings.peak_mode <> 'off'::public.peak_mode_scope and requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification_image_required';
    end if;

    if requested_returning_profile_id is not null or requested_returning_match_token_digest is not null then
      raise exception using errcode = '42501', message = 'returning_metadata_forbidden';
    end if;

    if requested_source = 'portal'::public.pass_source then
      select * into verification_record
      from public.portal_identity_verification_attempts piva
      where piva.owner_id = requested_actor_id
        and piva.request_id = requested_request_id::text
        and piva.photo_intent_id = requested_photo_intent_id
        and piva.id_intent_id = requested_id_intent_id
        and piva.outcome = 'matched'
        and piva.expires_at > now()
      order by piva.verified_at desc
      limit 1;

      if not found then
        raise exception using errcode = '42501', message = 'valid_matched_identity_verification_required';
      end if;

      v_bound_verification_id := verification_record.id;
      if exists (
        select 1 from public.office_visits ov_check
        where ov_check.identity_verification_id = v_bound_verification_id
          and ov_check.request_id <> requested_request_id
      ) then
        raise exception using errcode = '40900', message = 'identity_verification_already_consumed';
      end if;
    end if;

    select * into photo_intent from public.upload_intents where id = requested_photo_intent_id for update;
    if not found or photo_intent.owner_id <> requested_actor_id
      or photo_intent.source <> requested_source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or photo_intent.expires_at <= now()
      or (requested_photo_bytes is not null and requested_photo_bytes not between 1 and photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_photo_upload_intent';
    end if;

    if requested_id_intent_id is not null then
      select * into id_intent from public.upload_intents where id = requested_id_intent_id for update;
      if not found or id_intent.owner_id <> requested_actor_id
        or id_intent.source <> requested_source
        or id_intent.kind <> 'id'::public.evidence_kind
        or id_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
        or id_intent.expires_at <= now()
        or (requested_id_bytes is not null and requested_id_bytes not between 1 and id_intent.max_bytes) then
        raise exception using errcode = '22023', message = 'invalid_id_upload_intent';
      end if;
    end if;

    if target_office.requires_approval_before_pass then
      update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
      where id in (photo_intent.id, id_intent.id);
    end if;

  elsif requested_registration_mode = 'returning' then
    if requested_returning_profile_id is null or requested_returning_match_token_digest is null then
      raise exception using errcode = '42501', message = 'returning_match_credentials_required';
    end if;

    select * into returning_profile_record
    from public.returning_visitor_profiles
    where id = requested_returning_profile_id and revoked_at is null and expires_at > now();
    if not found then
      raise exception using errcode = '42501', message = 'returning_profile_not_found_or_expired';
    end if;

    select * into returning_attempt_record
    from public.returning_identity_attempts ria
    where ria.owner_id = requested_actor_id
      and ria.request_id = requested_request_id::text
      and ria.matched_profile_id = requested_returning_profile_id
      and ria.match_token_digest = requested_returning_match_token_digest
      and ria.outcome in ('matched', 'provisional_matched')
      and ria.expires_at > now()
    order by ria.created_at desc
    limit 1;
    if not found then
      raise exception using errcode = '42501', message = 'valid_returning_identity_match_required';
    end if;

    v_bound_profile_id := returning_profile_record.id;
    v_bound_returning_id := returning_attempt_record.id;
    if exists (
      select 1 from public.office_visits ov_ret_check
      where ov_ret_check.returning_attempt_id = v_bound_returning_id
        and ov_ret_check.request_id <> requested_request_id
    ) then
      raise exception using errcode = '40900', message = 'returning_attempt_already_consumed';
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents where id = requested_vehicle_photo_intent_id for update;
    if not found or vehicle_photo_intent.owner_id <> requested_actor_id
      or vehicle_photo_intent.source <> requested_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or vehicle_photo_intent.expires_at <= now()
      or (requested_vehicle_photo_bytes is not null and requested_vehicle_photo_bytes not between 1 and vehicle_photo_intent.max_bytes) then
      raise exception using errcode = '22023', message = 'invalid_vehicle_photo_upload_intent';
    end if;

    if target_office.requires_approval_before_pass then
      update public.upload_intents set held_until = greatest(expires_at, now() + interval '14 days')
      where id = vehicle_photo_intent.id;
    end if;
  end if;

  v_expected_gate := coalesce(
    nullif(btrim(coalesce(requested_expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  v_full_name := btrim(concat_ws(' ', nullif(btrim(requested_first_name), ''), nullif(btrim(requested_middle_name), ''), nullif(btrim(requested_last_name), '')));

  -- 8A. APPROVAL REQUIRED: create pending office visit with ZERO ordinary pass
  if target_office.requires_approval_before_pass then
    insert into public.office_visits (
      visit_type, office_id, personnel_id, requested_person_name,
      approval_status, attendance_status,
      visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
      visitor_contact_number, visitor_email, visitor_email_verified,
      visitor_actor_id, purpose, visit_date, arrival_mode,
      vehicle_details, address_details,
      photo_intent_id, photo_bytes, photo_sha256,
      id_intent_id, id_bytes, id_sha256,
      vehicle_photo_intent_id, vehicle_photo_bytes, vehicle_photo_sha256,
      registration_mode, returning_profile_id, identity_verification_id, returning_attempt_id,
      request_id, email_delivery_status,
      tracking_token_digest, tracking_token_expires_at,
      office_requires_approval_snapshot, decision_source, source, expected_gate
    ) values (
      requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
      'pending'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
      btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
      btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
      requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
      requested_vehicle_details, requested_address_details,
      requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
      requested_id_intent_id, requested_id_bytes, requested_id_sha256,
      requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
      requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
      requested_request_id, 'pending',
      requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
      true, null, requested_source, v_expected_gate
    ) returning id into new_visit_id;

    if requested_encrypted_tracking_token is not null and v_normalized_email is not null then
      insert into public.office_visit_acknowledgement_outbox (
        office_visit_id, recipient_email, encrypted_tracking_token, idempotency_key, delivery_status
      ) values (
        new_visit_id, v_normalized_email, requested_encrypted_tracking_token, 'office-ack-' || new_visit_id::text, 'pending'
      ) on conflict (office_visit_id) do nothing;
    end if;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      new_visit_id, 'request_submitted', requested_actor_id,
      case when requested_source = 'kiosk'::public.pass_source then 'device' else 'visitor' end,
      jsonb_build_object(
        'visit_type', requested_visit_type,
        'office_id', requested_office_id,
        'personnel_id', requested_personnel_id,
        'requested_person_name', v_effective_person_name,
        'visit_date', requested_visit_date,
        'office_requires_approval_snapshot', true,
        'source', requested_source
      )
    );

    return query select
      new_visit_id,
      requested_request_id,
      'pending'::public.office_approval_status,
      'awaiting_entry'::public.office_attendance_status,
      requested_encrypted_tracking_token,
      null::uuid,
      null::uuid,
      null::timestamptz,
      null::timestamptz,
      null::text,
      true;
    return;
  end if;

  -- 8B. AUTO-APPROVED BY OFFICE POLICY: atomically create visitor + pass + approved office_visit
  v_home_addr := coalesce(requested_address_details->>'homeAddress', '');
  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street,
    registration_mode, arrival_mode, returning_profile_id,
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at, returning_identity_attempt_id
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    v_full_name, btrim(requested_contact_number),
    nullif(btrim(v_home_addr), ''),
    (requested_address_details->>'lat')::numeric(6,3),
    (requested_address_details->>'lon')::numeric(6,3),
    requested_address_details->>'psgcVersion',
    requested_address_details->>'regionCode',
    requested_address_details->>'provinceCode',
    requested_address_details->>'cityCode',
    requested_address_details->>'barangayCode',
    requested_address_details->>'regionName',
    requested_address_details->>'provinceName',
    requested_address_details->>'cityName',
    requested_address_details->>'barangayName',
    requested_address_details->>'homeBuilding',
    requested_address_details->>'homeStreet',
    requested_registration_mode, requested_arrival_mode,
    case when requested_registration_mode = 'returning' and coalesce(returning_attempt_record.threshold_mode, 'provisional') = 'calibrated'
         then v_bound_profile_id else null end,
    btrim(requested_purpose), requested_visit_date, now(),
    v_bound_verification_id,
    case when v_bound_verification_id is not null then coalesce(verification_record.verified_at, now()) else null end,
    v_bound_returning_id
  ) returning id into new_visitor_id;

  if requested_registration_mode = 'new' and requested_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
      photo_intent.object_path, photo_intent.content_type,
      coalesce(requested_photo_bytes, 1), requested_photo_sha256, now(),
      greatest(now() + make_interval(days => coalesce(settings.photo_retention_days, settings.image_retention_days, 7)), v_until + interval '1 day')
    ) returning id into new_photo_ev_id;
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id where id = photo_intent.id;
  end if;

  if requested_registration_mode = 'new' and requested_id_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type,
      coalesce(requested_id_bytes, 1), requested_id_sha256, now(),
      greatest(now() + make_interval(days => coalesce(settings.id_retention_days, settings.image_retention_days, 30)), v_until + interval '1 day')
    ) returning id into new_id_ev_id;
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id where id = id_intent.id;
  end if;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
      coalesce(requested_vehicle_photo_bytes, 1), requested_vehicle_photo_sha256, now(),
      greatest(now() + make_interval(days => coalesce(settings.vehicle_photo_retention_days, settings.image_retention_days, 7)), v_until + interval '1 day')
    ) returning id into new_veh_ev_id;
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id where id = vehicle_photo_intent.id;
  end if;

  new_public_ref := gen_random_uuid();
  insert into public.passes (
    visitor_id, source, status, token_digest, public_reference, valid_from, valid_until, issue_request_id, expected_gate
  ) values (
    new_visitor_id, requested_source, 'issued'::public.pass_status, decode(requested_pass_token_digest, 'hex'),
    new_public_ref, v_from, v_until, requested_request_id, v_expected_gate
  ) returning id into new_pass_id;

  if requested_arrival_mode = 'vehicle' and requested_vehicle_details is not null then
    insert into public.visit_vehicle_declarations (
      pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model, vehicle_photo_evidence_id
    ) values (
      new_pass_id, new_visitor_id, requested_vehicle_details->>'vehicleType',
      btrim(requested_vehicle_details->>'plateNumber'), v_plate_key,
      btrim(requested_vehicle_details->>'color'), coalesce(requested_vehicle_details->>'makeModel', ''), new_veh_ev_id
    );
  end if;

  insert into public.office_visits (
    visit_type, office_id, personnel_id, requested_person_name,
    approval_status, attendance_status,
    decided_at, decided_by, decision_source, office_requires_approval_snapshot,
    visitor_id, pass_id,
    visitor_first_name, visitor_middle_name, visitor_last_name, visitor_display_name,
    visitor_contact_number, visitor_email, visitor_email_verified,
    visitor_actor_id, purpose, visit_date, arrival_mode,
    vehicle_details, address_details,
    photo_intent_id, photo_bytes, photo_sha256,
    id_intent_id, id_bytes, id_sha256,
    vehicle_photo_intent_id, vehicle_photo_bytes, vehicle_photo_sha256,
    registration_mode, returning_profile_id, identity_verification_id, returning_attempt_id,
    request_id, email_delivery_status,
    tracking_token_digest, tracking_token_expires_at,
    source, expected_gate
  ) values (
    requested_visit_type, requested_office_id, requested_personnel_id, v_effective_person_name,
    'approved'::public.office_approval_status, 'awaiting_entry'::public.office_attendance_status,
    now(), null, 'auto_office_policy', false,
    new_visitor_id, new_pass_id,
    btrim(requested_first_name), nullif(btrim(requested_middle_name), ''), btrim(requested_last_name), v_full_name,
    btrim(requested_contact_number), v_normalized_email, (v_normalized_email is not null),
    requested_actor_id, btrim(requested_purpose), requested_visit_date, requested_arrival_mode,
    requested_vehicle_details, requested_address_details,
    requested_photo_intent_id, requested_photo_bytes, requested_photo_sha256,
    requested_id_intent_id, requested_id_bytes, requested_id_sha256,
    requested_vehicle_photo_intent_id, requested_vehicle_photo_bytes, requested_vehicle_photo_sha256,
    requested_registration_mode, v_bound_profile_id, v_bound_verification_id, v_bound_returning_id,
    requested_request_id, 'none',
    requested_tracking_token_digest, coalesce(requested_tracking_token_expires_at, now() + interval '30 days'),
    requested_source, v_expected_gate
  ) returning id into new_visit_id;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    new_visit_id, 'auto_approved_by_policy', null, 'system',
    jsonb_build_object(
      'visit_type', requested_visit_type,
      'office_id', requested_office_id,
      'pass_id', new_pass_id,
      'public_reference', new_public_ref,
      'decision_source', 'auto_office_policy',
      'office_requires_approval_snapshot', false,
      'source', requested_source
    )
  );

  return query select
    new_visit_id,
    requested_request_id,
    'approved'::public.office_approval_status,
    'awaiting_entry'::public.office_attendance_status,
    requested_encrypted_tracking_token,
    new_pass_id,
    new_public_ref,
    v_from,
    v_until,
    'auto_office_policy'::text,
    false;
end;
$$;

revoke all on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) from public, anon, authenticated;

grant execute on function api.create_specific_person_visit_request(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, date, text, jsonb, jsonb,
  uuid, integer, text, uuid, integer, text, uuid, integer, text, text, uuid, text, uuid, uuid,
  text, text, timestamptz, text, text, public.pass_source, text, text
) to service_role;

-- 10. Harden api.decide_office_visit: enforce active+published office & Manila closure on approval + decision_source
create or replace function api.decide_office_visit(
  requested_actor_id uuid,
  requested_visit_id uuid,
  requested_decision text,
  requested_rejection_reason text default null,
  requested_token_digest text default null,
  requested_encrypted_payload text default null,
  requested_idempotency_key text default null,
  requested_request_id uuid default gen_random_uuid()
)
returns table (
  ok boolean,
  decision text,
  pass_id uuid,
  public_reference uuid,
  valid_from timestamptz,
  valid_until timestamptz,
  message text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target_visit public.office_visits%rowtype;
  target_office public.offices%rowtype;
  actor_profile public.staff_profiles%rowtype;
  settings public.app_settings%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_ref uuid;
  new_veh_ev_id uuid := null;
  v_from timestamptz;
  v_until timestamptz;
  v_full_name text;
  v_addr jsonb;
  v_veh jsonb;
  photo_intent public.upload_intents%rowtype;
  id_intent public.upload_intents%rowtype;
  vehicle_photo_intent public.upload_intents%rowtype;
  returning_profile_rec public.returning_visitor_profiles%rowtype;
  v_idempotency_key text;
  v_manila_today date;
  target_closure_title text;
  v_expected_gate text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  if target_visit.approval_status <> 'pending'::public.office_approval_status then
    if target_visit.approval_status::text = requested_decision then
      if target_visit.approval_status = 'approved'::public.office_approval_status and target_visit.pass_id is not null then
        select p.public_reference, p.valid_from, p.valid_until
        into new_public_ref, v_from, v_until
        from public.passes p where p.id = target_visit.pass_id;

        return query select true, 'approved'::text, target_visit.pass_id, new_public_ref, v_from, v_until, 'Visit already approved.'::text;
        return;
      else
        return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit already rejected.'::text;
        return;
      end if;
    else
      raise exception using errcode = '40900', message = 'visit_already_decided';
    end if;
  end if;

  -- REJECTION FLOW
  if requested_decision = 'rejected' then
    if requested_rejection_reason is null or char_length(btrim(requested_rejection_reason)) = 0 then
      raise exception using errcode = '22023', message = 'rejection_reason_required';
    end if;

    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      rejection_reason = btrim(requested_rejection_reason),
      decided_at = now(),
      decided_by = requested_actor_id,
      decision_source = 'manual_staff',
      attendance_status = 'cancelled'::public.office_attendance_status,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    if target_visit.visitor_email is not null then
      v_idempotency_key := coalesce(requested_idempotency_key, 'office-rejection-' || target_visit.id::text);
      insert into public.office_visit_email_outbox (
        office_visit_id, email_type, recipient_email, rejection_reason, delivery_status, idempotency_key
      ) values (
        target_visit.id, 'rejection', target_visit.visitor_email, btrim(requested_rejection_reason), 'pending', v_idempotency_key
      ) on conflict (office_visit_id, email_type) do nothing;
    end if;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', btrim(requested_rejection_reason), 'decision_source', 'manual_staff')
    );

    return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit rejected.'::text;
    return;
  end if;

  -- APPROVAL FLOW
  -- Enforce current office operational/publication state
  select * into target_office from public.offices
  where id = target_visit.office_id and active = true and publication_status = 'published';
  if not found then
    raise exception using errcode = '40900', message = 'office_no_longer_active_or_published';
  end if;

  -- Enforce campus closure check AT APPROVAL TIME (handles closures added after submission)
  if exists (
    select 1 from public.campus_calendar_closures
    where active and published and target_visit.visit_date between start_date and end_date
  ) then
    select title into target_closure_title
    from public.campus_calendar_closures
    where active and published and target_visit.visit_date between start_date and end_date
    limit 1;
    raise exception 'visit_date_closed: %', target_closure_title using errcode = 'P0001';
  end if;

  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;
  if target_visit.visitor_actor_id is null then
    raise exception using errcode = '22023', message = 'missing_visitor_actor_identity';
  end if;

  select * into settings from public.app_settings where singleton for share;
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  if target_visit.visit_date < v_manila_today then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Visit date has passed prior to approval.',
      decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
    where id = target_visit.id;
    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
    insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
    values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Visit date has passed prior to approval.', 'code', 'visit_date_expired'));
    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'visit_date_expired'::text;
    return;
  end if;

  v_from := (target_visit.visit_date + settings.working_hours_start) at time zone settings.timezone;
  v_until := (target_visit.visit_date + settings.working_hours_end) at time zone settings.timezone;

  if v_until <= now() then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Pass validity window has ended for this date.',
      decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
    where id = target_visit.id;
    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
    insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
    values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Pass validity window has ended for this date.', 'code', 'pass_validity_window_ended'));
    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'pass_validity_window_ended'::text;
    return;
  end if;

  if target_visit.registration_mode = 'new' then
    if target_visit.photo_intent_id is null or (target_visit.source = 'portal'::public.pass_source and target_visit.id_intent_id is null) then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Required photo or ID upload intent is missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Required photo or ID upload intent is missing.', 'code', 'missing_required_evidence_intents'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_required_evidence_intents'::text;
      return;
    end if;

    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if not found
      or photo_intent.owner_id <> target_visit.visitor_actor_id
      or photo_intent.source <> target_visit.source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or (target_visit.source = 'portal'::public.pass_source and photo_intent.status <> 'uploaded'::public.upload_intent_status)
      or photo_intent.expires_at <= now()
      or photo_intent.storage_cleaned_at is not null
      or photo_intent.held_until is null
      or photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = photo_intent.bucket_id
          and so.name = photo_intent.object_path
      )
      or target_visit.photo_bytes is null
      or target_visit.photo_bytes <= 0
      or target_visit.photo_sha256 is null
      or target_visit.photo_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.photo_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Visitor portrait evidence is invalid, expired, or removed.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor portrait evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_photo_evidence'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_photo_evidence'::text;
      return;
    end if;

    if target_visit.id_intent_id is not null then
      select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
      if not found
        or id_intent.owner_id <> target_visit.visitor_actor_id
        or id_intent.source <> target_visit.source
        or id_intent.kind <> 'id'::public.evidence_kind
        or id_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
        or (target_visit.source = 'portal'::public.pass_source and id_intent.status <> 'uploaded'::public.upload_intent_status)
        or id_intent.expires_at <= now()
        or id_intent.storage_cleaned_at is not null
        or id_intent.held_until is null
        or id_intent.held_until < now()
        or not exists (
          select 1 from storage.objects so
          where so.bucket_id = id_intent.bucket_id
            and so.name = id_intent.object_path
        )
        or target_visit.id_bytes is null
        or target_visit.id_bytes <= 0
        or target_visit.id_sha256 is null
        or target_visit.id_sha256 !~ '^[0-9a-f]{64}$'
        or target_visit.id_sha256 = repeat('0', 64)
      then
        update public.office_visits set
          approval_status = 'rejected'::public.office_approval_status,
          attendance_status = 'expired'::public.office_attendance_status,
          rejection_reason = 'Visitor identification evidence is invalid, expired, or removed.',
          decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
        where id = target_visit.id;
        update public.upload_intents set held_until = null
        where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
        insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
        values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
          jsonb_build_object('reason', 'Visitor identification evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_id_evidence'));
        return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_id_evidence'::text;
        return;
      end if;
    end if;
  elsif target_visit.registration_mode = 'returning' then
    if target_visit.returning_profile_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile linkage is missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_returning_profile_id'::text;
      return;
    end if;
    select * into returning_profile_rec from public.returning_visitor_profiles
    where id = target_visit.returning_profile_id and revoked_at is null and expires_at > now();
    if not found then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile is revoked or expired.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_returning_profile'::text;
      return;
    end if;
  else
    raise exception using errcode = '22023', message = 'invalid_registration_mode';
  end if;

  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents where id = target_visit.vehicle_photo_intent_id for update;
    if not found
      or vehicle_photo_intent.owner_id <> target_visit.visitor_actor_id
      or vehicle_photo_intent.source <> target_visit.source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status not in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)
      or (target_visit.source = 'portal'::public.pass_source and vehicle_photo_intent.status <> 'uploaded'::public.upload_intent_status)
      or vehicle_photo_intent.expires_at <= now()
      or vehicle_photo_intent.storage_cleaned_at is not null
      or vehicle_photo_intent.held_until is null
      or vehicle_photo_intent.held_until < now()
      or not exists (
        select 1 from storage.objects so
        where so.bucket_id = vehicle_photo_intent.bucket_id
          and so.name = vehicle_photo_intent.object_path
      )
      or target_visit.vehicle_photo_bytes is null
      or target_visit.vehicle_photo_bytes <= 0
      or target_visit.vehicle_photo_sha256 is null
      or target_visit.vehicle_photo_sha256 !~ '^[0-9a-f]{64}$'
      or target_visit.vehicle_photo_sha256 = repeat('0', 64)
    then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Vehicle photo evidence is invalid, expired, or missing.',
        decided_at = now(), decided_by = requested_actor_id, decision_source = 'manual_staff', updated_at = now()
      where id = target_visit.id;
      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);
      insert into public.office_visit_events (office_visit_id, event_type, actor_id, actor_role, metadata)
      values (target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Vehicle photo evidence is invalid, expired, or missing.', 'code', 'invalid_vehicle_photo_evidence'));
      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_vehicle_photo_evidence'::text;
      return;
    end if;
  end if;

  v_full_name := btrim(concat_ws(' ', target_visit.visitor_first_name, target_visit.visitor_middle_name, target_visit.visitor_last_name));
  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;
  v_expected_gate := coalesce(
    nullif(btrim(coalesce(target_visit.expected_gate, '')), ''),
    nullif(btrim(coalesce(settings.default_expected_gate, '')), '')
  );

  insert into public.visitors (
    owner_id, source, created_by_device_id, full_name, contact_number,
    home_address, home_location_lat, home_location_lon,
    psgc_version, psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
    psgc_region_name, psgc_province_name, psgc_city_municipality_name, psgc_barangay_name,
    home_building, home_street,
    purpose, visit_date, consent_accepted_at,
    registration_mode, arrival_mode, returning_profile_id,
    identity_verification_id, returning_identity_attempt_id
  ) values (
    target_visit.visitor_actor_id, target_visit.source,
    case when target_visit.source = 'kiosk'::public.pass_source then target_visit.visitor_actor_id else null end,
    v_full_name, target_visit.visitor_contact_number,
    coalesce(v_addr->>'homeAddress', ''),
    (v_addr->>'lat')::numeric, (v_addr->>'lon')::numeric,
    v_addr->>'psgcVersion', v_addr->>'regionCode', v_addr->>'provinceCode', v_addr->>'cityCode', v_addr->>'barangayCode',
    v_addr->>'regionName', v_addr->>'provinceName', v_addr->>'cityName', v_addr->>'barangayName',
    v_addr->>'homeBuilding', v_addr->>'homeStreet',
    target_visit.purpose, target_visit.visit_date, target_visit.created_at,
    target_visit.registration_mode, target_visit.arrival_mode, target_visit.returning_profile_id,
    target_visit.identity_verification_id, target_visit.returning_attempt_id
  ) returning id into new_visitor_id;

  if target_visit.registration_mode = 'new' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id, photo_intent.object_path, photo_intent.content_type,
      target_visit.photo_bytes, target_visit.photo_sha256, now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );
    update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
    where id = photo_intent.id;

    if target_visit.id_intent_id is not null then
      insert into public.visitor_evidence (
        visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
        byte_size, sha256_hex, verified_at, expires_at
      ) values (
        new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id, id_intent.object_path, id_intent.content_type,
        target_visit.id_bytes, target_visit.id_sha256, now(),
        greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
      );
      update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
      where id = id_intent.id;
    end if;
  end if;

  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
      target_visit.vehicle_photo_bytes, target_visit.vehicle_photo_sha256, now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    ) returning id into new_veh_ev_id;
    update public.upload_intents set status = 'claimed'::public.upload_intent_status, claimed_at = now(), visitor_id = new_visitor_id, held_until = null
    where id = vehicle_photo_intent.id;
  end if;

  new_public_ref := gen_random_uuid();
  insert into public.passes (
    visitor_id, source, status, token_digest, public_reference, valid_from, valid_until, issue_request_id, expected_gate
  ) values (
    new_visitor_id, target_visit.source, 'issued'::public.pass_status, decode(requested_token_digest, 'hex'),
    new_public_ref, v_from, v_until, target_visit.request_id, v_expected_gate
  ) returning id into new_pass_id;

  if target_visit.arrival_mode = 'vehicle' and v_veh is not null then
    insert into public.visit_vehicle_declarations (
      pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model, vehicle_photo_evidence_id
    ) values (
      new_pass_id, new_visitor_id, v_veh->>'vehicleType', v_veh->>'plateNumber',
      upper(regexp_replace(v_veh->>'plateNumber', '[^a-zA-Z0-9]', '', 'g')),
      v_veh->>'color', coalesce(v_veh->>'makeModel', ''), new_veh_ev_id
    );
  end if;

  update public.office_visits set
    approval_status = 'approved'::public.office_approval_status,
    attendance_status = 'awaiting_entry'::public.office_attendance_status,
    visitor_id = new_visitor_id,
    pass_id = new_pass_id,
    decided_at = now(),
    decided_by = requested_actor_id,
    decision_source = 'manual_staff',
    expected_gate = v_expected_gate,
    updated_at = now()
  where id = target_visit.id;

  if target_visit.visitor_email is not null then
    v_idempotency_key := coalesce(requested_idempotency_key, 'office-approval-' || target_visit.id::text);
    insert into public.office_visit_email_outbox (
      office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, idempotency_key
    ) values (
      target_visit.id, 'approval', target_visit.visitor_email, requested_encrypted_payload, 'pending', v_idempotency_key
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  insert into public.office_visit_events (
    office_visit_id, event_type, actor_id, actor_role, metadata
  ) values (
    target_visit.id, 'approved', requested_actor_id, actor_profile.role::text,
    jsonb_build_object(
      'pass_id', new_pass_id,
      'public_reference', new_public_ref,
      'valid_from', v_from,
      'valid_until', v_until,
      'decision_source', 'manual_staff',
      'office_requires_approval_snapshot', target_visit.office_requires_approval_snapshot,
      'registration_mode', target_visit.registration_mode,
      'returning_profile_id', target_visit.returning_profile_id
    )
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved successfully.'::text;
end;
$$;

revoke all on function api.decide_office_visit(uuid, uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function api.decide_office_visit(uuid, uuid, text, text, text, text, text, uuid) to service_role;
