-- ============================================================================
-- Migration: 20261123001100_search_records_and_accountability_repair.sql
-- Description: Search & Records and Visitor Accountability Repair
-- 1. Fixes foreign key constraint on public.visitor_accountability_resolutions.actor_id
--    to ON DELETE RESTRICT (resolves NOT NULL vs ON DELETE SET NULL contradiction).
-- 2. Protects staff deletion in api.delete_staff_account against deleting staff who
--    authored accountability resolutions (audit log preservation).
-- 3. Adds api.get_accountability_summary RPC to calculate authoritative deduplicated
--    summary statistics across full date ranges directly in SQL.
-- ============================================================================

-- 1. Correct foreign key contradiction on public.visitor_accountability_resolutions
alter table public.visitor_accountability_resolutions
  drop constraint if exists visitor_accountability_resolutions_actor_id_fkey;

alter table public.visitor_accountability_resolutions
  add constraint visitor_accountability_resolutions_actor_id_fkey
  foreign key (actor_id) references public.staff_profiles(user_id)
  on delete restrict;

-- 2. Update api.delete_staff_account to protect staff who resolved accountability issues
create or replace function api.delete_staff_account(
  requested_actor_id uuid,
  requested_target_uid uuid,
  requested_request_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role public.staff_role;
  v_target public.staff_profiles%rowtype;
  v_remaining_superadmins int;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  -- 1. Validate caller is an active Super Admin
  select role into v_actor_role
  from public.staff_profiles
  where user_id = requested_actor_id
    and active = true
    and not must_change_password
    and privacy_accepted_at is not null;

  if v_actor_role is null or v_actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'active_superadmin_required';
  end if;

  -- 2. Caller cannot delete their own account
  if requested_target_uid = requested_actor_id then
    raise exception using errcode = '42501', message = 'cannot_delete_self';
  end if;

  -- 3. Target cannot be a registered hardware device identity
  if exists (select 1 from public.devices where user_id = requested_target_uid) then
    raise exception using errcode = '42501', message = 'cannot_delete_device_via_staff_api';
  end if;

  -- 4. Target profile must exist
  select * into v_target
  from public.staff_profiles
  where user_id = requested_target_uid
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'target_user_not_found';
  end if;

  -- 5. If target is active superadmin, protect last active superadmin
  if v_target.role = 'superadmin'::public.staff_role and v_target.active then
    select count(*) into v_remaining_superadmins
    from public.staff_profiles
    where role = 'superadmin'::public.staff_role
      and active = true
      and user_id <> requested_target_uid;

    if v_remaining_superadmins < 1 then
      raise exception using errcode = '23514', message = 'cannot_delete_last_superadmin';
    end if;
  end if;

  -- 6. Check active incident holds: accounts with active locks on visitor evidence cannot be removed
  if exists (
    select 1 from public.incident_holds
    where created_by = requested_target_uid
      and active = true
  ) then
    raise exception using errcode = '40900', message = 'target_has_active_incident_holds';
  end if;

  -- 7. Audit preservation: accounts that authored visitor accountability resolutions cannot be deleted
  if exists (
    select 1 from public.visitor_accountability_resolutions
    where actor_id = requested_target_uid
  ) then
    raise exception using errcode = '40900', message = 'target_has_accountability_resolutions';
  end if;

  -- 8. Clean up assignments and operational associations
  delete from public.office_staff_assignments where user_id = requested_target_uid;

  if to_regclass('public.staff_mfa_factors') is not null then
    execute 'delete from public.staff_mfa_factors where user_id = $1' using requested_target_uid;
  end if;

  delete from public.staff_backup_codes where user_id = requested_target_uid;
  delete from public.staff_passwords where user_id = requested_target_uid;

  -- 9. Anonymize/tombstone or delete the staff profile record
  delete from public.staff_profiles where user_id = requested_target_uid;

  -- 10. Record immutable audit event
  perform api.record_audit_event(
    requested_actor_id,
    'staff',
    v_actor_role::text,
    'staff_account_deleted',
    'staff_profiles',
    requested_target_uid::text,
    requested_request_id,
    jsonb_build_object(
      'deleted_role', v_target.role,
      'deleted_full_name', v_target.full_name,
      'target_uid', requested_target_uid
    )
  );

  return jsonb_build_object(
    'ok', true,
    'action', 'staff_deleted',
    'target_uid', requested_target_uid,
    'deleted_role', v_target.role
  );
end;
$$;

revoke all on function api.delete_staff_account(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.delete_staff_account(uuid, uuid, uuid) to service_role;

-- 3. Authoritative Date-Range Accountability Summary RPC
create or replace function api.get_accountability_summary(
  requested_actor_id uuid,
  requested_date_from date,
  requested_date_to date,
  requested_closing_hours text default '17:00'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_profile public.staff_profiles%rowtype;
  v_app_settings record;
  v_closing_time text;
  v_opening_time text;
  v_timezone text;
  summary_record record;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  -- 1. Validate caller is an active admin or superadmin
  select * into actor_profile
  from public.staff_profiles
  where user_id = requested_actor_id
    and active = true;

  if not found or actor_profile.role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'admin_authorization_required';
  end if;

  -- 2. Fetch app settings for working hours
  select
    to_char(working_hours_end, 'HH24:MI') as working_hours_end,
    to_char(working_hours_start, 'HH24:MI') as working_hours_start,
    timezone
  into v_app_settings
  from public.app_settings
  where singleton = true;

  v_closing_time := coalesce(v_app_settings.working_hours_end, requested_closing_hours, '17:00');
  v_opening_time := coalesce(v_app_settings.working_hours_start, '08:00');
  v_timezone := coalesce(v_app_settings.timezone, 'Asia/Manila');

  -- 3. Compute deduplicated summary across all matching passes in date range
  with pass_eval as (
    select
      p.id as pass_id,
      p.visitor_id,
      p.status,
      p.accountability_status,
      (p.time_in is not null or p.entry_scanned_at is not null or p.status in ('inside', 'exited')) as has_entered,
      (p.time_out is not null or p.status = 'exited') as has_exited,
      (now() >= coalesce(p.valid_until, (v.visit_date || ' ' || v_closing_time || ':00+08')::timestamptz)) as is_past_closing,
      (ov.id is not null and ov.office_id is not null and o.name is not null and lower(btrim(o.name)) not in ('', 'general campus')) as has_office,
      (ov.attendance_status in ('confirmed', 'completed') or ov.confirmed_at is not null) as is_office_confirmed
    from public.passes p
    inner join public.visitors v on v.id = p.visitor_id
    left join lateral (
      select id, office_id, attendance_status, confirmed_at
      from public.office_visits
      where pass_id = p.id
      order by created_at asc
      limit 1
    ) ov on true
    left join public.offices o on o.id = ov.office_id
    where (requested_date_from is null or v.visit_date >= requested_date_from)
      and (requested_date_to is null or v.visit_date <= requested_date_to)
  ),
  classified as (
    select
      visitor_id,
      has_entered,
      has_exited,
      (has_entered and not has_exited and is_past_closing) as is_missing_exit,
      (has_entered and has_office and not is_office_confirmed and (is_past_closing or has_exited)) as is_missing_office,
      (has_entered and has_exited and (not has_office or is_office_confirmed)) as is_completed,
      accountability_status
    from pass_eval
  )
  select
    count(distinct visitor_id) as total_visitors,
    count(distinct visitor_id) filter (where is_completed) as completed_visits,
    count(distinct visitor_id) filter (where is_missing_exit and accountability_status = 'pending') as missing_exit_count,
    count(distinct visitor_id) filter (where is_missing_office and accountability_status = 'pending') as missing_office_count,
    count(distinct visitor_id) filter (where (is_missing_exit or is_missing_office) and accountability_status = 'pending') as requiring_review_count,
    count(distinct visitor_id) filter (where accountability_status in ('resolved', 'reviewed', 'exception')) as reviewed_count
  into summary_record
  from classified;

  return jsonb_build_object(
    'totalVisitors', coalesce(summary_record.total_visitors, 0),
    'completedVisits', coalesce(summary_record.completed_visits, 0),
    'missingExitCount', coalesce(summary_record.missing_exit_count, 0),
    'missingOfficeCount', coalesce(summary_record.missing_office_count, 0),
    'requiringReviewCount', coalesce(summary_record.requiring_review_count, 0),
    'reviewedCount', coalesce(summary_record.reviewed_count, 0),
    'schoolClosingTime', v_closing_time,
    'schoolOpeningTime', v_opening_time,
    'timezone', v_timezone
  );
end;
$$;

revoke all on function api.get_accountability_summary(uuid, date, date, text) from public, anon, authenticated;
grant execute on function api.get_accountability_summary(uuid, date, date, text) to service_role;
