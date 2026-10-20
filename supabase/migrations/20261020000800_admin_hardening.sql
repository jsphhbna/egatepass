-- Admin Hardening: atomic settings+audit RPC, automatic cleanup persistence, and governance invariants

alter table public.app_settings add column if not exists automatic_cleanup_enabled boolean not null default true;

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
  requested_request_id uuid
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
    (requested_working_hours_start is not null and requested_working_hours_start <> current_settings.working_hours_start) or
    (requested_working_hours_end is not null and requested_working_hours_end <> current_settings.working_hours_end) or
    (requested_image_retention_days is not null and requested_image_retention_days <> current_settings.image_retention_days) or
    (requested_visitor_retention_days is not null and requested_visitor_retention_days <> current_settings.visitor_retention_days) or
    (requested_audit_retention_days is not null and requested_audit_retention_days <> current_settings.audit_retention_days) or
    (requested_reconciliation_retention_days is not null and requested_reconciliation_retention_days <> current_settings.reconciliation_retention_days) or
    (requested_scheduling_days_ahead is not null and requested_scheduling_days_ahead <> current_settings.scheduling_days_ahead) or
    (requested_automatic_cleanup_enabled is not null and requested_automatic_cleanup_enabled <> current_settings.automatic_cleanup_enabled)
  );

  if changes_security_settings and actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'only super admins may change security-sensitive settings';
  end if;

  new_peak_mode := coalesce(requested_peak_mode, current_settings.peak_mode);
  new_reasons := coalesce(requested_rejection_reasons, current_settings.rejection_reasons);
  new_purposes := coalesce(requested_visit_purposes, current_settings.visit_purposes);

  if actor_role = 'superadmin'::public.staff_role then
    new_start := coalesce(requested_working_hours_start, current_settings.working_hours_start);
    new_end := coalesce(requested_working_hours_end, current_settings.working_hours_end);
    new_image_ret := coalesce(requested_image_retention_days, current_settings.image_retention_days);
    new_vis_ret := coalesce(requested_visitor_retention_days, current_settings.visitor_retention_days);
    new_audit_ret := coalesce(requested_audit_retention_days, current_settings.audit_retention_days);
    new_rec_ret := coalesce(requested_reconciliation_retention_days, current_settings.reconciliation_retention_days);
    new_sched := coalesce(requested_scheduling_days_ahead, current_settings.scheduling_days_ahead);
    new_cleanup := coalesce(requested_automatic_cleanup_enabled, current_settings.automatic_cleanup_enabled);
  else
    new_start := current_settings.working_hours_start;
    new_end := current_settings.working_hours_end;
    new_image_ret := current_settings.image_retention_days;
    new_vis_ret := current_settings.visitor_retention_days;
    new_audit_ret := current_settings.audit_retention_days;
    new_rec_ret := current_settings.reconciliation_retention_days;
    new_sched := current_settings.scheduling_days_ahead;
    new_cleanup := current_settings.automatic_cleanup_enabled;
  end if;

  if new_start >= new_end then
    raise exception using errcode = '23514', message = 'opening time must be earlier than closing time';
  end if;

  update public.app_settings
  set
    peak_mode = new_peak_mode,
    rejection_reasons = new_reasons,
    visit_purposes = new_purposes,
    working_hours_start = new_start,
    working_hours_end = new_end,
    image_retention_days = new_image_ret,
    visitor_retention_days = new_vis_ret,
    audit_retention_days = new_audit_ret,
    reconciliation_retention_days = new_rec_ret,
    scheduling_days_ahead = new_sched,
    automatic_cleanup_enabled = new_cleanup,
    updated_by = requested_actor_id,
    updated_at = now()
  where singleton;

  insert into public.audit_events (
    actor_id,
    actor_kind,
    actor_role,
    action,
    target_type,
    target_id,
    request_id,
    before_state,
    after_state,
    outcome
  )
  values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'settings_updated',
    'settings',
    'app',
    requested_request_id,
    jsonb_build_object(
      'peak_mode', current_settings.peak_mode,
      'working_hours_start', current_settings.working_hours_start,
      'working_hours_end', current_settings.working_hours_end,
      'image_retention_days', current_settings.image_retention_days,
      'visitor_retention_days', current_settings.visitor_retention_days,
      'audit_retention_days', current_settings.audit_retention_days,
      'reconciliation_retention_days', current_settings.reconciliation_retention_days,
      'scheduling_days_ahead', current_settings.scheduling_days_ahead,
      'automatic_cleanup_enabled', current_settings.automatic_cleanup_enabled
    ),
    jsonb_build_object(
      'peak_mode', new_peak_mode,
      'working_hours_start', new_start,
      'working_hours_end', new_end,
      'image_retention_days', new_image_ret,
      'visitor_retention_days', new_vis_ret,
      'audit_retention_days', new_audit_ret,
      'reconciliation_retention_days', new_rec_ret,
      'scheduling_days_ahead', new_sched,
      'automatic_cleanup_enabled', new_cleanup
    ),
    'success'
  );
end $$;

revoke all on function api.update_app_settings(uuid,public.peak_mode_scope,jsonb,jsonb,time,time,smallint,smallint,smallint,smallint,smallint,boolean,uuid) from public, anon, authenticated;
grant execute on function api.update_app_settings(uuid,public.peak_mode_scope,jsonb,jsonb,time,time,smallint,smallint,smallint,smallint,smallint,boolean,uuid) to service_role;

-- Pass Email Verifications for optional QR delivery (M5-F13)
create table if not exists public.pass_email_verifications (
  id uuid primary key default gen_random_uuid(),
  pass_id uuid not null references public.passes(id) on delete cascade,
  recipient_email text not null,
  code_hash text not null,
  attempts integer not null default 0,
  verified boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists pass_email_verifications_pass_idx
  on public.pass_email_verifications (pass_id, recipient_email, expires_at);

alter table public.pass_email_verifications enable row level security;
grant select, insert, update on public.pass_email_verifications to service_role;
revoke all on public.pass_email_verifications from public, anon, authenticated;

-- Optimization indexes for dashboard aggregate queries
create index if not exists passes_issued_at_idx on public.passes (issued_at desc);
create index if not exists passes_status_time_out_idx on public.passes (status, time_out desc);
create index if not exists passes_decided_at_idx on public.passes (status, decided_at desc);

