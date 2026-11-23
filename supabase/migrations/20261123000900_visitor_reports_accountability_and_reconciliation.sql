-- ============================================================================
-- Migration: 20261123000900_visitor_reports_accountability_and_reconciliation.sql
-- Description: End-of-Day Visitor Accountability & Reconciliation
-- Adds:
--  1. Accountability tracking columns on public.passes and public.office_visits
--  2. Immutable resolution tracking table public.visitor_accountability_resolutions
--  3. Atomic RPC api.resolve_visitor_accountability (Super Admin only)
-- ============================================================================

-- 1. Extend public.passes with accountability & verification metadata
alter table public.passes
  add column if not exists accountability_status text not null default 'pending'
    check (accountability_status in ('pending', 'resolved', 'reviewed', 'exception')),
  add column if not exists accountability_notes text,
  add column if not exists accountability_resolved_at timestamptz,
  add column if not exists accountability_resolved_by uuid references public.staff_profiles(user_id) on delete set null,
  add column if not exists exit_verification_type text
    check (exit_verification_type is null or exit_verification_type in ('scanner', 'manual_verified', 'cctv_verified', 'exception'));

create index if not exists idx_passes_accountability_status
  on public.passes(accountability_status);

-- 2. Extend public.office_visits with verification metadata
alter table public.office_visits
  add column if not exists attendance_verification_type text
    check (attendance_verification_type is null or attendance_verification_type in ('office_confirmed', 'manual_verified', 'exception')),
  add column if not exists accountability_notes text;

-- 3. Create public.visitor_accountability_resolutions for tamper-evident review history
create table if not exists public.visitor_accountability_resolutions (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid not null references public.passes(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  office_visit_id uuid references public.office_visits(id) on delete set null,
  resolution_type text not null
    check (resolution_type in ('record_verified_exit', 'confirm_office_visit', 'mark_reviewed', 'record_exception')),
  exception_type text
    check (exception_type is null or exception_type in ('redirected', 'office_closed', 'cancelled_after_entry', 'cctv_verified', 'emergency_evacuation', 'other')),
  reason text not null check (char_length(btrim(reason)) >= 5),
  verified_event_time timestamptz,
  gate text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  actor_id uuid not null references public.staff_profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  request_id uuid not null unique
);

create index if not exists idx_var_pass_id on public.visitor_accountability_resolutions(pass_id);
create index if not exists idx_var_visitor_id on public.visitor_accountability_resolutions(visitor_id);
create index if not exists idx_var_created_at on public.visitor_accountability_resolutions(created_at desc);

alter table public.visitor_accountability_resolutions enable row level security;

drop policy if exists var_admin_read on public.visitor_accountability_resolutions;
create policy var_admin_read on public.visitor_accountability_resolutions
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_profiles s
      where s.user_id = auth.uid()
        and s.active
        and s.role in ('admin', 'superadmin')
    )
  );

grant select on public.visitor_accountability_resolutions to authenticated, service_role;
grant insert, update, delete on public.visitor_accountability_resolutions to service_role;

-- 4. Atomic Super Admin Resolution RPC
create or replace function api.resolve_visitor_accountability(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_action text,
  requested_reason text,
  requested_event_time timestamptz default null,
  requested_exception_type text default null,
  requested_gate text default null,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_profile public.staff_profiles%rowtype;
  target_pass public.passes%rowtype;
  target_office_visit public.office_visits%rowtype;
  resolved_exit_time timestamptz;
  resolved_arrival_time timestamptz;
  existing_resolution public.visitor_accountability_resolutions%rowtype;
  result_json jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  -- 1. Validate caller is an active Super Admin
  select * into actor_profile
  from public.staff_profiles
  where user_id = requested_actor_id and active;

  if not found then
    raise exception using errcode = '42501', message = 'active_staff_profile_required';
  end if;

  if actor_profile.role <> 'superadmin' then
    raise exception using errcode = '42501', message = 'superadmin_authorization_required';
  end if;

  -- 2. Validate action and reason
  if requested_action not in ('record_verified_exit', 'confirm_office_visit', 'mark_reviewed', 'record_exception') then
    raise exception using errcode = '22023', message = 'invalid_resolution_action';
  end if;

  if requested_reason is null or char_length(btrim(requested_reason)) < 5 then
    raise exception using errcode = '22023', message = 'reason_must_be_at_least_5_characters';
  end if;

  -- 3. Idempotency check by request_id
  select * into existing_resolution
  from public.visitor_accountability_resolutions
  where request_id = requested_request_id;

  if found then
    return jsonb_build_object(
      'ok', true,
      'resolutionId', existing_resolution.id,
      'idempotent', true,
      'resolutionType', existing_resolution.resolution_type,
      'passId', existing_resolution.pass_id,
      'resolvedAt', existing_resolution.created_at
    );
  end if;

  -- 4. Lock and validate target pass
  select * into target_pass
  from public.passes
  where id = requested_pass_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'pass_not_found';
  end if;

  -- Fetch linked office visit if present
  select * into target_office_visit
  from public.office_visits
  where pass_id = target_pass.id
  for update;

  -- 5. Execute Action
  if requested_action = 'record_verified_exit' then
    if target_pass.time_in is null and target_pass.entry_scanned_at is null and target_pass.status <> 'inside' then
      raise exception using errcode = '22023', message = 'visitor_has_no_entry_record';
    end if;

    resolved_exit_time := coalesce(requested_event_time, now());

    update public.passes set
      status = 'exited'::public.pass_status,
      time_out = resolved_exit_time,
      exit_verification_type = 'manual_verified',
      accountability_status = case
        when accountability_status = 'pending' then 'resolved'
        else accountability_status
      end,
      accountability_notes = requested_reason,
      accountability_resolved_at = now(),
      accountability_resolved_by = requested_actor_id,
      updated_at = now()
    where id = target_pass.id;

    if target_office_visit.id is not null then
      if target_office_visit.attendance_status = 'confirmed'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'completed'::public.office_attendance_status,
          updated_at = now()
        where id = target_office_visit.id;
      elsif target_office_visit.attendance_status = 'awaiting_office_confirmation'::public.office_attendance_status then
        update public.office_visits set
          attendance_status = 'exited_unconfirmed'::public.office_attendance_status,
          updated_at = now()
        where id = target_office_visit.id;
      end if;
    end if;

    insert into public.visit_events(
      pass_id, visitor_id, event, reason, gate, guard_id, occurred_at, request_id, details
    ) values (
      target_pass.id,
      target_pass.visitor_id,
      'scan_exit'::public.visit_event_type,
      'Manually verified exit: ' || requested_reason,
      coalesce(requested_gate, target_pass.gate, 'Admin Gate'),
      requested_actor_id,
      resolved_exit_time,
      requested_request_id,
      jsonb_build_object(
        'manual_verification', true,
        'verified_by', requested_actor_id,
        'verified_time', resolved_exit_time,
        'reason', requested_reason
      )
    );

    insert into public.visitor_accountability_resolutions(
      pass_id, visitor_id, office_visit_id, resolution_type, reason,
      verified_event_time, gate, actor_id, request_id, metadata
    ) values (
      target_pass.id,
      target_pass.visitor_id,
      target_office_visit.id,
      'record_verified_exit',
      requested_reason,
      resolved_exit_time,
      coalesce(requested_gate, target_pass.gate, 'Admin Gate'),
      requested_actor_id,
      requested_request_id,
      jsonb_build_object('exit_time', resolved_exit_time, 'gate', coalesce(requested_gate, target_pass.gate))
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, details, outcome, request_id
    ) values (
      requested_actor_id,
      'staff',
      'superadmin',
      'visitor.verified_exit_recorded',
      'pass',
      target_pass.id::text,
      jsonb_build_object(
        'pass_id', target_pass.id,
        'visitor_id', target_pass.visitor_id,
        'exit_time', resolved_exit_time,
        'gate', coalesce(requested_gate, target_pass.gate),
        'reason', requested_reason
      ),
      'success',
      requested_request_id
    );

  elsif requested_action = 'confirm_office_visit' then
    if target_office_visit.id is null then
      raise exception using errcode = '22023', message = 'no_office_visit_for_pass';
    end if;

    if target_pass.time_in is null and target_pass.entry_scanned_at is null and target_pass.status <> 'inside' then
      raise exception using errcode = '22023', message = 'visitor_has_no_entry_record';
    end if;

    resolved_arrival_time := coalesce(requested_event_time, now());

    update public.office_visits set
      attendance_status = case
        when target_pass.status = 'exited' or target_pass.time_out is not null then 'completed'::public.office_attendance_status
        else 'confirmed'::public.office_attendance_status
      end,
      confirmed_at = resolved_arrival_time,
      confirmed_by = requested_actor_id,
      attendance_verification_type = 'manual_verified',
      accountability_notes = requested_reason,
      updated_at = now()
    where id = target_office_visit.id;

    if target_pass.time_out is not null then
      update public.passes set
        accountability_status = case
          when accountability_status = 'pending' then 'resolved'
          else accountability_status
        end,
        accountability_notes = requested_reason,
        accountability_resolved_at = now(),
        accountability_resolved_by = requested_actor_id,
        updated_at = now()
      where id = target_pass.id;
    end if;

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_office_visit.id,
      'arrival_confirmed',
      requested_actor_id,
      'superadmin',
      jsonb_build_object(
        'manual_verification', true,
        'arrival_time', resolved_arrival_time,
        'reason', requested_reason
      )
    );

    insert into public.visitor_accountability_resolutions(
      pass_id, visitor_id, office_visit_id, resolution_type, reason,
      verified_event_time, actor_id, request_id, metadata
    ) values (
      target_pass.id,
      target_pass.visitor_id,
      target_office_visit.id,
      'confirm_office_visit',
      requested_reason,
      resolved_arrival_time,
      requested_actor_id,
      requested_request_id,
      jsonb_build_object('arrival_time', resolved_arrival_time, 'office_id', target_office_visit.office_id)
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, details, outcome, request_id
    ) values (
      requested_actor_id,
      'staff',
      'superadmin',
      'visitor.office_visit_confirmed',
      'office_visit',
      target_office_visit.id::text,
      jsonb_build_object(
        'pass_id', target_pass.id,
        'office_visit_id', target_office_visit.id,
        'arrival_time', resolved_arrival_time,
        'reason', requested_reason
      ),
      'success',
      requested_request_id
    );

  elsif requested_action = 'mark_reviewed' then
    update public.passes set
      accountability_status = 'reviewed',
      accountability_notes = requested_reason,
      accountability_resolved_at = now(),
      accountability_resolved_by = requested_actor_id,
      updated_at = now()
    where id = target_pass.id;

    insert into public.visitor_accountability_resolutions(
      pass_id, visitor_id, office_visit_id, resolution_type, reason,
      actor_id, request_id, metadata
    ) values (
      target_pass.id,
      target_pass.visitor_id,
      target_office_visit.id,
      'mark_reviewed',
      requested_reason,
      requested_actor_id,
      requested_request_id,
      jsonb_build_object('reviewed_at', now(), 'reason', requested_reason)
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, details, outcome, request_id
    ) values (
      requested_actor_id,
      'staff',
      'superadmin',
      'visitor.accountability_reviewed',
      'pass',
      target_pass.id::text,
      jsonb_build_object(
        'pass_id', target_pass.id,
        'visitor_id', target_pass.visitor_id,
        'reason', requested_reason
      ),
      'success',
      requested_request_id
    );

  elsif requested_action = 'record_exception' then
    if requested_exception_type is null or requested_exception_type not in (
      'redirected', 'office_closed', 'cancelled_after_entry', 'cctv_verified', 'emergency_evacuation', 'other'
    ) then
      raise exception using errcode = '22023', message = 'invalid_exception_type';
    end if;

    update public.passes set
      accountability_status = 'exception',
      accountability_notes = requested_reason,
      accountability_resolved_at = now(),
      accountability_resolved_by = requested_actor_id,
      updated_at = now()
    where id = target_pass.id;

    if target_office_visit.id is not null then
      update public.office_visits set
        attendance_verification_type = 'exception',
        accountability_notes = requested_reason,
        updated_at = now()
      where id = target_office_visit.id;
    end if;

    insert into public.visitor_accountability_resolutions(
      pass_id, visitor_id, office_visit_id, resolution_type, exception_type, reason,
      actor_id, request_id, metadata
    ) values (
      target_pass.id,
      target_pass.visitor_id,
      target_office_visit.id,
      'record_exception',
      requested_exception_type,
      requested_reason,
      requested_actor_id,
      requested_request_id,
      jsonb_build_object('exception_type', requested_exception_type, 'reason', requested_reason)
    );

    insert into public.audit_events (
      actor_id, actor_kind, actor_role, action, target_type, target_id, details, outcome, request_id
    ) values (
      requested_actor_id,
      'staff',
      'superadmin',
      'visitor.exception_recorded',
      'pass',
      target_pass.id::text,
      jsonb_build_object(
        'pass_id', target_pass.id,
        'exception_type', requested_exception_type,
        'reason', requested_reason
      ),
      'success',
      requested_request_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', requested_action,
    'passId', target_pass.id,
    'accountabilityStatus', case
      when requested_action = 'mark_reviewed' then 'reviewed'
      when requested_action = 'record_exception' then 'exception'
      else 'resolved'
    end,
    'resolvedAt', now(),
    'message', 'Visitor accountability resolution recorded successfully.'
  );
end;
$$;

revoke all on function api.resolve_visitor_accountability(uuid, uuid, text, text, timestamptz, text, text, uuid) from public, anon, authenticated;
grant execute on function api.resolve_visitor_accountability(uuid, uuid, text, text, timestamptz, text, text, uuid) to service_role;
