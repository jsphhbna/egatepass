-- Atomic pass issuance after the Vercel function validates uploaded object bytes.

alter table public.passes
  add column if not exists issue_request_id uuid;

create unique index if not exists passes_issue_request_unique
  on public.passes (issue_request_id)
  where issue_request_id is not null;

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

  id_is_required := not (
    settings.peak_mode = 'both'::public.peak_mode_scope
    or (settings.peak_mode = 'portal'::public.peak_mode_scope and requested_source = 'portal'::public.pass_source)
    or (settings.peak_mode = 'kiosk'::public.peak_mode_scope and requested_source = 'kiosk'::public.pass_source)
  );
  if id_is_required and requested_id_intent_id is null then
    raise exception using errcode = '22023', message = 'identification image required';
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
    purpose, visit_date, consent_accepted_at
  ) values (
    requested_actor_id, requested_source,
    case when requested_source = 'kiosk'::public.pass_source then requested_actor_id else null end,
    btrim(requested_full_name), btrim(requested_contact_number), btrim(requested_purpose),
    requested_visit_date, now()
  ) returning id into new_visitor_id;

  insert into public.visitor_evidence (
    visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
    byte_size, sha256_hex, verified_at, expires_at
  ) values (
    new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
    photo_intent.object_path, photo_intent.content_type, requested_photo_bytes,
    requested_photo_sha256, now(), now() + make_interval(days => settings.image_retention_days)
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
      requested_id_sha256, now(), now() + make_interval(days => settings.image_retention_days)
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
    jsonb_build_object('source', requested_source, 'visitDate', requested_visit_date)
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

comment on function api.issue_pass(uuid, public.pass_source, uuid, text, text, text, date, uuid, integer, text, uuid, integer, text, text) is
  'Service-only transaction that validates actor and intent ownership, claims evidence, and issues an idempotent digest-backed pass.';
