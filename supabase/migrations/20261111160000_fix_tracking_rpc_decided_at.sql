-- =============================================================================
-- Migration 85: Fix api.lookup_office_visit_tracking_status column reference
-- Replace non-existent v.decision_recorded_at (SQLSTATE 42703) with v.decided_at.
-- =============================================================================

create or replace function api.lookup_office_visit_tracking_status(
  requested_token_digest text
)
returns table (
  visitor_first_name text,
  visitor_last_name text,
  office_name text,
  personnel_name text,
  visit_date date,
  purpose text,
  approval_status text,
  submitted_at timestamptz,
  decided_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_token_digest is null or char_length(requested_token_digest) <> 64 then
    return;
  end if;

  return query
  select
    v.visitor_first_name,
    v.visitor_last_name,
    coalesce(o.name, 'EARIST Office') as office_name,
    coalesce(v.requested_person_name, p.name, 'Office Staff') as personnel_name,
    v.visit_date,
    v.purpose,
    v.approval_status::text,
    v.created_at as submitted_at,
    v.decided_at,
    v.updated_at
  from public.office_visits v
  left join public.offices o on o.id = v.office_id
  left join public.office_personnel p on p.id = v.personnel_id
  where v.tracking_token_digest = requested_token_digest
    and v.tracking_token_revoked_at is null
    and v.tracking_token_expires_at > now();
end;
$$;

revoke all on function api.lookup_office_visit_tracking_status(text) from public, anon, authenticated;
grant execute on function api.lookup_office_visit_tracking_status(text) to service_role;
