-- Migration 39: Online Identity Verification, Portal Automatic Entry, and Guard Station Redesign
-- Sections 46, 49-51, 63-68

-- 1. Create authoritative portal_identity_verification_attempts table
create table if not exists public.portal_identity_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  photo_intent_id uuid not null references public.upload_intents(id) on delete cascade,
  id_intent_id uuid not null references public.upload_intents(id) on delete cascade,
  outcome text not null check (outcome in (
    'matched', 'mismatch', 'no_face_in_id', 'no_face_in_selfie',
    'multiple_selfie_faces', 'ambiguous_id_faces', 'low_quality_id',
    'low_quality_selfie', 'engine_error'
  )),
  model_name text not null,
  model_version text not null,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists portal_id_verif_lookup_idx
  on public.portal_identity_verification_attempts (owner_id, request_id, outcome, expires_at desc);

create index if not exists portal_id_verif_intents_idx
  on public.portal_identity_verification_attempts (photo_intent_id, id_intent_id);

-- Lock down direct client access: anon and authenticated denied, service_role only
alter table public.portal_identity_verification_attempts enable row level security;
revoke all on public.portal_identity_verification_attempts from public, anon, authenticated;
grant select, insert, update on public.portal_identity_verification_attempts to service_role;

-- 2. Add visitor provenance columns
alter table public.visitors
  add column if not exists identity_verification_id uuid references public.portal_identity_verification_attempts(id),
  add column if not exists identity_verified_at timestamptz;

-- 3. Update api.issue_pass to enforce valid server identity verification for portal registrations
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
  verification_record public.portal_identity_verification_attempts%rowtype;
  new_visitor_id uuid;
  new_pass_id uuid;
  new_public_reference uuid;
  starts_at timestamptz;
  ends_at timestamptz;
  id_is_required boolean;
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

  -- Identification image requirement
  if requested_source = 'portal'::public.pass_source then
    -- For online/portal registrations, ID image and successful verification are mandatory
    if requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required';
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
  else
    -- Kiosk source preserves existing peak mode logic
    id_is_required := not (
      settings.peak_mode = 'both'::public.peak_mode_scope
      or (settings.peak_mode = 'kiosk'::public.peak_mode_scope)
    );
    if id_is_required and requested_id_intent_id is null then
      raise exception using errcode = '22023', message = 'identification image required';
    end if;
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
    purpose, visit_date, consent_accepted_at,
    identity_verification_id, identity_verified_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number), btrim(requested_purpose),
    requested_visit_date, now(),
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
      now() + make_interval(days => settings.image_retention_days),
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
        now() + make_interval(days => settings.image_retention_days),
        ends_at + interval '1 day'
      )
    );
    update public.upload_intents set status = 'claimed', claimed_at = now(), visitor_id = new_visitor_id
    where id = id_intent.id;
  end if;

  insert into public.passes (
    visitor_id, token_digest, source, status, valid_from, valid_until, issue_request_id
  ) values (
    new_visitor_id, decode(requested_token_digest, 'hex'), requested_source, 'issued',
    starts_at, ends_at, requested_request_id
  ) returning id, passes.public_reference into new_pass_id, new_public_reference;

  insert into public.audit_events (
    actor_id, actor_kind, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id,
    case when requested_source = 'kiosk'::public.pass_source then 'device' else 'system' end,
    'pass.issue', 'pass', new_pass_id::text, requested_request_id,
    jsonb_build_object(
      'source', requested_source,
      'visitDate', requested_visit_date,
      'verified', case when requested_source = 'portal'::public.pass_source then true else false end
    )
  );

  pass_id := new_pass_id;
  public_reference := new_public_reference;
  valid_from := starts_at;
  valid_until := ends_at;
  return next;
end;
$$;

revoke all on function api.issue_pass(uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function api.issue_pass(uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text)
  to service_role;

-- 4. Update api.scan_pass for Automatic Online Entry (Workstream G)
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
      -- Check pass source: Portal visitors transition directly to 'inside'
      if target.source = 'portal'::public.pass_source then
        update public.passes set
          status = 'inside'::public.pass_status,
          entry_scanned_at = now(),
          time_in = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        return query select true, 'inside'::text, null::text, 'Entry recorded. Please proceed through the normal security inspection.'::text;
        return;
      else
        -- Kiosk passes retain pending guard review until walk-in redesign
        update public.passes set
          status = 'pending'::public.pass_status,
          entry_scanned_at = now(),
          entry_device_id = scanner.user_id,
          gate = scanner.gate,
          updated_at = now(),
          version = version + 1
        where id = target.id;

        insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
        values (target.id, target.visitor_id, 'scan_entry'::public.visit_event_type, scanner.user_id, scanner.gate, requested_request_id)
        on conflict (request_id, event) do nothing;

        return query select true, 'pending'::text, null::text, 'Scanned! Waiting for guard approval.'::text;
        return;
      end if;
    end if;

    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'scan_failed', failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  elsif requested_mode = 'exit'::public.device_type and target.status = 'inside'::public.pass_status then
    update public.passes set
      status = 'exited', time_out = now(), exit_device_id = scanner.user_id,
      updated_at = now(), version = version + 1
    where id = target.id;
    insert into public.visit_events(pass_id, visitor_id, event, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'exit', scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select true, 'exited'::text, null::text, 'Pass successfully exited.'::text;
    return;
  else
    if target.status in ('expired', 'rejected') then
      failure_code := target.status::text; failure_message := 'Pass is no longer valid (' || target.status::text || ')';
    elsif target.status = 'exited' then
      failure_code := 'already_exited'; failure_message := 'Pass has already exited';
    elsif target.status = 'pending' then
      failure_code := 'pending'; failure_message := 'Pass is already awaiting guard decision';
    elsif target.status = 'inside' and requested_mode = 'entry'::public.device_type then
      failure_code := 'already_inside'; failure_message := 'Pass has already been admitted';
    elsif target.status = 'issued' and requested_mode = 'exit'::public.device_type then
      failure_code := 'not_entered'; failure_message := 'Pass has not recorded an entry yet';
    else
      failure_code := 'invalid_state'; failure_message := 'Pass state cannot transition under current scan';
    end if;
    insert into public.visit_events(pass_id, visitor_id, event, reason, device_id, gate, request_id)
    values (target.id, target.visitor_id, 'scan_failed', failure_message, scanner.user_id, scanner.gate, requested_request_id)
    on conflict (request_id, event) do nothing;
    return query select false, target.status::text, failure_code, failure_message;
    return;
  end if;
end;
$$;

revoke all on function api.scan_pass(uuid, text, public.device_type, uuid) from public, anon, authenticated;
grant execute on function api.scan_pass(uuid, text, public.device_type, uuid) to service_role;
