-- Trusted QR lifecycle transitions and the Guard's bounded operational read model.

create or replace function api.scan_pass(
  requested_actor_id uuid,
  requested_token_digest text,
  requested_mode public.device_type,
  requested_request_id uuid
)
returns table (ok boolean, result_status text, code text, message text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  scanner public.devices%rowtype;
  target public.passes%rowtype;
  event_name public.visit_event_type;
  failure_code text;
  failure_message text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  if requested_mode not in ('entry'::public.device_type, 'exit'::public.device_type)
    or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid scan request';
  end if;

  select * into scanner from public.devices d
  where d.user_id = requested_actor_id and d.status = 'active'::public.device_status
  for share;
  if not found or scanner.type <> requested_mode then
    raise exception using errcode = '42501', message = 'active matching scanner required';
  end if;

  select * into target from public.passes p
  where p.token_digest = decode(requested_token_digest, 'hex')
  for update;
  if not found then
    insert into public.visit_events(event, reason, device_id, gate, request_id)
    values ('invalid_scan', 'QR code not recognized', scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, null::text, 'not_found'::text, 'QR code not recognized'::text;
    return;
  end if;

  if requested_mode = 'entry'::public.device_type and target.status = 'issued'::public.pass_status then
    if target.valid_until < now() then
      update public.passes set status = 'expired', updated_at = now(), version = version + 1 where id = target.id;
      failure_code := 'expired'; failure_message := 'This pass has expired';
    elsif target.valid_from > now() then
      failure_code := 'early'; failure_message := 'Pass is not yet valid';
    else
      update public.passes set
        status = 'pending', entry_scanned_at = now(), entry_device_id = scanner.user_id,
        gate = scanner.gate, updated_at = now(), version = version + 1
      where id = target.id;
      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_entry', scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select true, 'pending'::text, null::text, 'Scanned! Waiting for guard approval…'::text;
      return;
    end if;
  elsif requested_mode = 'exit'::public.device_type and target.status = 'inside'::public.pass_status then
    if target.gate is distinct from scanner.gate then
      failure_code := 'wrong_gate'; failure_message := 'Use the exit scanner assigned to the entry gate';
    else
      update public.passes set
        status = 'exited', time_out = now(), exit_device_id = scanner.user_id,
        updated_at = now(), version = version + 1
      where id = target.id;
      insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
      values (target.id, target.visitor_id, 'scan_exit', scanner.user_id, scanner.gate, requested_request_id)
      on conflict (request_id, event) do nothing;
      return query select true, 'exited'::text, null::text, 'Exit recorded. Goodbye!'::text;
      return;
    end if;
  else
    failure_code := case target.status
      when 'pending' then case when requested_mode = 'entry' then 'already_scanned' else 'pending' end
      when 'inside' then case when requested_mode = 'entry' then 'already_scanned' else 'unknown' end
      when 'rejected' then 'rejected'
      when 'exited' then case when requested_mode = 'entry' then 'already_used' else 'already_exited' end
      when 'expired' then 'expired'
      when 'issued' then 'not_entered'
      else 'unknown' end;
    failure_message := case failure_code
      when 'already_scanned' then 'This pass has already been scanned'
      when 'pending' then 'Entry is still pending approval'
      when 'rejected' then 'This pass was rejected'
      when 'already_used' then 'This pass has already been used'
      when 'already_exited' then 'Visitor has already exited'
      when 'expired' then 'This pass has expired'
      when 'not_entered' then 'Visitor has not entered yet'
      else 'Pass cannot be used at this scanner' end;
  end if;

  insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
  values (target.id, target.visitor_id, 'invalid_scan', failure_message, scanner.user_id, scanner.gate, requested_request_id)
  on conflict (request_id, event) do nothing;
  return query select false, target.status::text, failure_code, failure_message;
end;
$$;

create or replace function api.decide_visit(
  requested_actor_id uuid,
  requested_pass_id uuid,
  requested_decision text,
  requested_reason text,
  requested_request_id uuid
)
returns public.pass_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  target public.passes%rowtype;
  next_status public.pass_status;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;
  select * into actor from public.staff_profiles
  where user_id = requested_actor_id and active and not must_change_password
    and privacy_accepted_at is not null for share;
  if not found or actor.role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;
  if requested_decision not in ('approved', 'rejected')
    or (requested_decision = 'approved' and requested_reason is not null)
    or (requested_decision = 'rejected' and char_length(btrim(coalesce(requested_reason, ''))) not between 1 and 500) then
    raise exception using errcode = '22023', message = 'invalid decision';
  end if;

  select * into target from public.passes where id = requested_pass_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'pass not found'; end if;
  if target.status <> 'pending'::public.pass_status then
    raise exception using errcode = '40001', message = 'pass is no longer pending';
  end if;
  next_status := case requested_decision when 'approved' then 'inside'::public.pass_status else 'rejected'::public.pass_status end;

  update public.passes set
    status = next_status, decided_at = now(),
    time_in = case when next_status = 'inside' then now() else time_in end,
    decided_by = actor.user_id,
    rejection_reason = case when next_status = 'rejected' then btrim(requested_reason) else null end,
    updated_at = now(), version = version + 1
  where id = target.id;
  insert into public.visit_events(pass_id, visitor_id, event, reason, gate, guard_id, request_id)
  values (
    target.id, target.visitor_id,
    case when next_status = 'inside' then 'approved'::public.visit_event_type else 'rejected'::public.visit_event_type end,
    case when next_status = 'rejected' then btrim(requested_reason) else null end,
    target.gate, actor.user_id, requested_request_id
  );
  return next_status;
end;
$$;

create or replace function api.guard_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.staff_profiles%rowtype;
  queue jsonb;
  stats jsonb;
  reasons jsonb;
begin
  select * into actor from public.staff_profiles
  where user_id = (select auth.uid()) and active and not must_change_password
    and privacy_accepted_at is not null;
  if not found or actor.role not in ('guard'::public.staff_role, 'admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'active guard or administrator required';
  end if;
  select coalesce(jsonb_agg(item order by item->>'scannedAt'), '[]'::jsonb) into queue
  from (
    select jsonb_build_object(
      'id', p.id, 'visitorName', v.full_name, 'purpose', v.purpose,
      'source', p.source, 'status', p.status, 'validFrom', p.valid_from,
      'validUntil', p.valid_until, 'scannedAt', p.entry_scanned_at, 'gate', p.gate,
      'photoEvidenceId', (select ve.id from public.visitor_evidence ve where ve.visitor_id = v.id and ve.kind = 'photo' and ve.purged_at is null),
      'idEvidenceId', (select ve.id from public.visitor_evidence ve where ve.visitor_id = v.id and ve.kind = 'id' and ve.purged_at is null)
    ) as item
    from public.passes p join public.visitors v on v.id = p.visitor_id
    where p.status = 'pending'::public.pass_status
    order by p.entry_scanned_at asc limit 50
  ) pending;
  select jsonb_build_object(
    'inside', count(*) filter (where status = 'inside'),
    'exited', count(*) filter (where status = 'exited'),
    'rejected', count(*) filter (where status = 'rejected'),
    'total', count(*)
  ) into stats from public.passes
  where issued_at >= date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
  select rejection_reasons into reasons from public.app_settings where singleton;
  return jsonb_build_object('queue', queue, 'stats', stats, 'rejectionReasons', coalesce(reasons, '[]'::jsonb));
end;
$$;

revoke all on function api.scan_pass(uuid, text, public.device_type, uuid) from public, anon, authenticated;
revoke all on function api.decide_visit(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function api.scan_pass(uuid, text, public.device_type, uuid) to service_role;
grant execute on function api.decide_visit(uuid, uuid, text, text, uuid) to service_role;
revoke all on function api.guard_dashboard() from public, anon;
grant execute on function api.guard_dashboard() to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'passes'
  ) then
    alter publication supabase_realtime add table public.passes;
  end if;
end
$$;
