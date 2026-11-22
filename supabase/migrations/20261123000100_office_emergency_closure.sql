-- ============================================================================
-- Migration: 20261123000100_office_emergency_closure.sql
-- Description: Adds emergency office closure status, closure explanation reason,
--              audit attribution, and secure visitor alert query RPCs.
-- ============================================================================

-- 1. Add closure columns to public.offices
alter table public.offices
  add column if not exists closure_status text not null default 'open' check (closure_status in ('open', 'closed')),
  add column if not exists closure_reason text default null,
  add column if not exists closed_at timestamptz default null,
  add column if not exists closed_by uuid references auth.users(id) default null;

create index if not exists idx_offices_closure_status on public.offices(closure_status);

-- 2. RPC: api.set_office_emergency_closure
-- Allows Superadmin, Admin, or assigned Office Staff to set office emergency closure with explanation
create or replace function api.set_office_emergency_closure(
  requested_office_id uuid,
  requested_status text,
  requested_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_user_id uuid;
  v_caller_role text;
  v_is_assigned boolean := false;
  v_target_office record;
  v_trimmed_reason text;
begin
  v_caller_user_id := auth.uid();
  if v_caller_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if requested_status not in ('open', 'closed') then
    raise exception 'invalid_closure_status' using errcode = '22023';
  end if;

  v_trimmed_reason := btrim(coalesce(requested_reason, ''));
  if requested_status = 'closed' and v_trimmed_reason = '' then
    raise exception 'closure_reason_required' using errcode = '22023';
  end if;

  -- Verify office existence
  select * into v_target_office
  from public.offices
  where id = requested_office_id
    and archived_at is null;

  if v_target_office.id is null then
    raise exception 'office_not_found' using errcode = 'P0002';
  end if;

  -- Check caller permissions: superadmin, admin, or assigned active staff
  select p.role::text into v_caller_role
  from public.staff_profiles p
  where p.user_id = v_caller_user_id
    and p.active = true;

  if v_caller_role not in ('admin', 'superadmin') then
    select exists (
      select 1
      from public.office_staff_assignments a
      where a.office_id = requested_office_id
        and a.user_id = v_caller_user_id
    ) into v_is_assigned;

    if not v_is_assigned then
      raise exception 'unauthorized_office_closure' using errcode = '42501';
    end if;
  end if;

  -- Apply status change
  update public.offices
  set
    closure_status = requested_status,
    closure_reason = case when requested_status = 'closed' then v_trimmed_reason else null end,
    closed_at = case when requested_status = 'closed' then now() else null end,
    closed_by = case when requested_status = 'closed' then v_caller_user_id else null end,
    updated_at = now()
  where id = requested_office_id;

  return jsonb_build_object(
    'success', true,
    'officeId', requested_office_id,
    'closureStatus', requested_status,
    'closureReason', case when requested_status = 'closed' then v_trimmed_reason else null end,
    'updatedAt', now()
  );
end;
$$;

revoke all on function api.set_office_emergency_closure(uuid, text, text) from public, anon, authenticated;
grant execute on function api.set_office_emergency_closure(uuid, text, text) to service_role;

-- 3. RPC: api.get_office_closure_affected_visitors
-- Retrieves all active or upcoming registered visitors for a specific office to alert via SMS/email
create or replace function api.get_office_closure_affected_visitors(
  requested_office_id uuid
)
returns table (
  visitor_id uuid,
  visitor_name text,
  contact_number text,
  email text,
  office_visit_id uuid,
  office_name text,
  visit_date date,
  attendance_status text,
  pass_status text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller_user_id uuid;
  v_caller_role text;
  v_is_assigned boolean := false;
begin
  v_caller_user_id := auth.uid();
  if v_caller_user_id is not null then
    select p.role::text into v_caller_role
    from public.staff_profiles p
    where p.user_id = v_caller_user_id
      and p.active = true;

    if v_caller_role not in ('admin', 'superadmin') then
      select exists (
        select 1
        from public.office_staff_assignments a
        where a.office_id = requested_office_id
          and a.user_id = v_caller_user_id
      ) into v_is_assigned;

      if not v_is_assigned then
        raise exception 'unauthorized_office_access' using errcode = '42501';
      end if;
    end if;
  end if;

  return query
  select distinct
    v.id as visitor_id,
    v.full_name as visitor_name,
    v.contact_number as contact_number,
    v.email as email,
    ov.id as office_visit_id,
    o.name as office_name,
    coalesce(p.visit_date, (p.valid_from at time zone 'Asia/Manila')::date, current_date) as visit_date,
    ov.attendance_status::text as attendance_status,
    p.status::text as pass_status
  from public.office_visits ov
  inner join public.offices o on o.id = ov.office_id
  inner join public.visitors v on v.id = ov.visitor_id
  left join public.passes p on p.id = ov.pass_id
  where ov.office_id = requested_office_id
    and (
      (p.id is not null and p.status in ('issued', 'inside') and p.valid_until >= now())
      or
      (ov.approval_status in ('pending', 'approved') and ov.attendance_status in ('awaiting_entry', 'awaiting_office_confirmation'))
    )
  order by visitor_name asc;
end;
$$;

revoke all on function api.get_office_closure_affected_visitors(uuid) from public, anon, authenticated;
grant execute on function api.get_office_closure_affected_visitors(uuid) to service_role;
