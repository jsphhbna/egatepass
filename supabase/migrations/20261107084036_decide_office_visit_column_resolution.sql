-- Migration 68: Reconcile api.decide_office_visit vehicle photo column resolution
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
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_decision';
  end if;

  -- 1. Validate actor role and active status
  select * into actor_profile from public.staff_profiles
  where user_id = requested_actor_id and active;
  if not found then
    raise exception using errcode = '42501', message = 'active_staff_required';
  end if;

  -- 2. Lock visit record
  select * into target_visit from public.office_visits
  where id = requested_visit_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'visit_not_found';
  end if;

  -- 3. Validate office assignment (unless admin/superadmin)
  if actor_profile.role not in ('admin', 'superadmin') then
    if not exists (
      select 1 from public.office_staff_assignments a
      where a.office_id = target_visit.office_id and a.user_id = requested_actor_id
    ) then
      raise exception using errcode = '42501', message = 'unauthorized_for_this_office';
    end if;
  end if;

  -- 4. Concurrency check: already decided?
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

  -- 5. REJECTION FLOW
  if requested_decision = 'rejected' then
    if requested_rejection_reason is null or char_length(btrim(requested_rejection_reason)) = 0 then
      raise exception using errcode = '22023', message = 'rejection_reason_required';
    end if;

    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      rejection_reason = btrim(requested_rejection_reason),
      decided_at = now(),
      decided_by = requested_actor_id,
      attendance_status = 'cancelled'::public.office_attendance_status,
      updated_at = now()
    where id = target_visit.id;

    -- Release upload intent holds
    update public.upload_intents
    set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    -- Create rejection outbox record
    if target_visit.visitor_email is not null then
      v_idempotency_key := coalesce(requested_idempotency_key, 'office-rejection-' || target_visit.id::text);
      insert into public.office_visit_email_outbox (
        office_visit_id,
        email_type,
        recipient_email,
        rejection_reason,
        delivery_status,
        idempotency_key
      ) values (
        target_visit.id,
        'rejection',
        target_visit.visitor_email,
        btrim(requested_rejection_reason),
        'pending',
        v_idempotency_key
      ) on conflict (office_visit_id, email_type) do nothing;
    end if;

    insert into public.office_visit_events (
      office_visit_id,
      event_type,
      actor_id,
      actor_role,
      metadata
    ) values (
      target_visit.id,
      'rejected',
      requested_actor_id,
      actor_profile.role::text,
      jsonb_build_object('reason', btrim(requested_rejection_reason))
    );

    return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit rejected.'::text;
    return;
  end if;

  -- 6. APPROVAL FLOW
  if requested_token_digest is null or requested_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'valid_token_digest_required_for_approval';
  end if;

  if target_visit.visitor_actor_id is null then
    raise exception using errcode = '22023', message = 'missing_visitor_actor_identity';
  end if;

  select * into settings from public.app_settings where singleton for share;

  -- Enforce visit-date and validity window at approval time
  v_manila_today := (now() at time zone coalesce(settings.timezone, 'Asia/Manila'))::date;
  if target_visit.visit_date < v_manila_today then
    update public.office_visits set
      approval_status = 'rejected'::public.office_approval_status,
      attendance_status = 'expired'::public.office_attendance_status,
      rejection_reason = 'Visit date has passed prior to approval.',
      decided_at = now(),
      decided_by = requested_actor_id,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Visit date has passed prior to approval.', 'code', 'visit_date_expired')
    );

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
      decided_at = now(),
      decided_by = requested_actor_id,
      updated_at = now()
    where id = target_visit.id;

    update public.upload_intents set held_until = null
    where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

    insert into public.office_visit_events (
      office_visit_id, event_type, actor_id, actor_role, metadata
    ) values (
      target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
      jsonb_build_object('reason', 'Pass validity window has ended for this date.', 'code', 'pass_validity_window_ended')
    );

    return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'pass_validity_window_ended'::text;
    return;
  end if;

  -- Revalidate upload holds and evidence (Fail-Closed)
  if target_visit.registration_mode = 'new' then
    if target_visit.photo_intent_id is null or target_visit.id_intent_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Required photo or ID upload intent is missing.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Required photo or ID upload intent is missing.', 'code', 'missing_required_evidence_intents')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_required_evidence_intents'::text;
      return;
    end if;

    select * into photo_intent from public.upload_intents where id = target_visit.photo_intent_id for update;
    if not found
      or photo_intent.owner_id <> target_visit.visitor_actor_id
      or photo_intent.source <> 'portal'::public.pass_source
      or photo_intent.kind <> 'photo'::public.evidence_kind
      or photo_intent.status <> 'uploaded'::public.upload_intent_status
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
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor portrait evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_photo_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_photo_evidence'::text;
      return;
    end if;

    select * into id_intent from public.upload_intents where id = target_visit.id_intent_id for update;
    if not found
      or id_intent.owner_id <> target_visit.visitor_actor_id
      or id_intent.source <> 'portal'::public.pass_source
      or id_intent.kind <> 'id'::public.evidence_kind
      or id_intent.status <> 'uploaded'::public.upload_intent_status
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
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Visitor identification evidence is invalid, expired, or removed.', 'code', 'invalid_or_expired_id_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_or_expired_id_evidence'::text;
      return;
    end if;

  elsif target_visit.registration_mode = 'returning' then
    if target_visit.returning_profile_id is null then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile linkage is missing.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'missing_returning_profile_id'::text;
      return;
    end if;

    select * into returning_profile_rec
    from public.returning_visitor_profiles
    where id = target_visit.returning_profile_id and revoked_at is null and expires_at > now();

    if not found then
      update public.office_visits set
        approval_status = 'rejected'::public.office_approval_status,
        attendance_status = 'expired'::public.office_attendance_status,
        rejection_reason = 'Returning visitor profile is revoked or expired.',
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_returning_profile'::text;
      return;
    end if;
  end if;

  -- Optional vehicle photo evidence validation (if provided)
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    select * into vehicle_photo_intent from public.upload_intents
    where id = target_visit.vehicle_photo_intent_id for update;

    if not found
      or vehicle_photo_intent.owner_id <> target_visit.visitor_actor_id
      or vehicle_photo_intent.source <> 'portal'::public.pass_source
      or vehicle_photo_intent.kind <> 'vehicle_photo'::public.evidence_kind
      or vehicle_photo_intent.status <> 'uploaded'::public.upload_intent_status
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
        decided_at = now(),
        decided_by = requested_actor_id,
        updated_at = now()
      where id = target_visit.id;

      update public.upload_intents set held_until = null
      where id in (target_visit.photo_intent_id, target_visit.id_intent_id, target_visit.vehicle_photo_intent_id);

      insert into public.office_visit_events (
        office_visit_id, event_type, actor_id, actor_role, metadata
      ) values (
        target_visit.id, 'rejected', requested_actor_id, actor_profile.role::text,
        jsonb_build_object('reason', 'Vehicle photo evidence is invalid, expired, or missing.', 'code', 'invalid_vehicle_photo_evidence')
      );

      return query select false, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'invalid_vehicle_photo_evidence'::text;
      return;
    end if;
  end if;

  v_full_name := coalesce(target_visit.visitor_display_name, btrim(target_visit.visitor_first_name ||
    case when target_visit.visitor_middle_name is not null and char_length(btrim(target_visit.visitor_middle_name)) > 0
      then ' ' || btrim(target_visit.visitor_middle_name) else '' end ||
    ' ' || target_visit.visitor_last_name));

  v_addr := target_visit.address_details;
  v_veh := target_visit.vehicle_details;

  -- Insert canonical visitor owned strictly by the original anonymous visitor UUID
  insert into public.visitors (
    owner_id,
    source,
    full_name,
    contact_number,
    email,
    purpose,
    visit_date,
    consent_accepted_at,
    registration_mode,
    returning_profile_id,
    arrival_mode,
    psgc_version,
    psgc_region_code,
    psgc_province_code,
    psgc_city_code,
    psgc_barangay_code,
    home_building,
    home_street,
    home_address
  ) values (
    target_visit.visitor_actor_id,
    'portal'::public.pass_source,
    v_full_name,
    target_visit.visitor_contact_number,
    target_visit.visitor_email,
    target_visit.purpose,
    target_visit.visit_date,
    now(),
    target_visit.registration_mode,
    target_visit.returning_profile_id,
    target_visit.arrival_mode,
    coalesce(v_addr->>'version', '2026-q3'),
    v_addr->>'regionCode',
    v_addr->>'provinceCode',
    v_addr->>'cityCode',
    v_addr->>'barangayCode',
    v_addr->>'houseBuilding',
    v_addr->>'street',
    concat_ws(', ', v_addr->>'houseBuilding', v_addr->>'street', v_addr->>'barangayName', v_addr->>'cityName')
  )
  returning id into new_visitor_id;

  -- For new visitor: insert genuine visitor evidence and claim upload intents
  if target_visit.registration_mode = 'new' then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, photo_intent.id, photo_intent.kind, photo_intent.bucket_id,
      photo_intent.object_path, photo_intent.content_type,
      target_visit.photo_bytes,
      target_visit.photo_sha256,
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = photo_intent.id;

    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, id_intent.id, id_intent.kind, id_intent.bucket_id,
      id_intent.object_path, id_intent.content_type,
      target_visit.id_bytes,
      target_visit.id_sha256,
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    );

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = id_intent.id;
  end if;

  -- Create canonical visitor evidence and claim vehicle photo upload intent if applicable
  if target_visit.arrival_mode = 'vehicle' and target_visit.vehicle_photo_intent_id is not null then
    insert into public.visitor_evidence (
      visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type,
      byte_size, sha256_hex, verified_at, expires_at
    ) values (
      new_visitor_id, vehicle_photo_intent.id, vehicle_photo_intent.kind, vehicle_photo_intent.bucket_id,
      vehicle_photo_intent.object_path, vehicle_photo_intent.content_type,
      target_visit.vehicle_photo_bytes,
      target_visit.vehicle_photo_sha256,
      now(),
      greatest(now() + make_interval(days => settings.image_retention_days), v_until + interval '1 day')
    ) returning id into new_veh_ev_id;

    update public.upload_intents set
      status = 'claimed'::public.upload_intent_status,
      claimed_at = now(),
      visitor_id = new_visitor_id,
      held_until = null
    where id = vehicle_photo_intent.id;
  end if;

  new_public_ref := gen_random_uuid();

  -- Create Pass Record
  insert into public.passes (
    visitor_id,
    source,
    status,
    token_digest,
    public_reference,
    valid_from,
    valid_until,
    issue_request_id
  ) values (
    new_visitor_id,
    'portal'::public.pass_source,
    'issued'::public.pass_status,
    decode(requested_token_digest, 'hex'),
    new_public_ref,
    v_from,
    v_until,
    target_visit.request_id
  )
  returning id into new_pass_id;

  -- Link vehicle declaration if applicable
  if target_visit.arrival_mode = 'vehicle' and v_veh is not null then
    insert into public.visit_vehicle_declarations (
      pass_id,
      visitor_id,
      vehicle_type,
      plate_number,
      plate_key,
      color,
      make_model,
      vehicle_photo_evidence_id
    ) values (
      new_pass_id,
      new_visitor_id,
      v_veh->>'vehicleType',
      v_veh->>'plateNumber',
      upper(regexp_replace(v_veh->>'plateNumber', '[^a-zA-Z0-9]', '', 'g')),
      v_veh->>'color',
      coalesce(v_veh->>'makeModel', ''),
      new_veh_ev_id
    );
  end if;

  -- Update visit record to APPROVED
  update public.office_visits set
    approval_status = 'approved'::public.office_approval_status,
    attendance_status = 'awaiting_entry'::public.office_attendance_status,
    visitor_id = new_visitor_id,
    pass_id = new_pass_id,
    decided_at = now(),
    decided_by = requested_actor_id,
    updated_at = now()
  where id = target_visit.id;

  -- Enqueue approval email outbox record
  if target_visit.visitor_email is not null then
    v_idempotency_key := coalesce(requested_idempotency_key, 'office-approval-' || target_visit.id::text);
    insert into public.office_visit_email_outbox (
      office_visit_id,
      email_type,
      recipient_email,
      encrypted_token_payload,
      delivery_status,
      idempotency_key
    ) values (
      target_visit.id,
      'approval',
      target_visit.visitor_email,
      requested_encrypted_payload,
      'pending',
      v_idempotency_key
    ) on conflict (office_visit_id, email_type) do nothing;
  end if;

  -- Audit event
  insert into public.office_visit_events (
    office_visit_id,
    event_type,
    actor_id,
    actor_role,
    metadata
  ) values (
    target_visit.id,
    'approved',
    requested_actor_id,
    actor_profile.role::text,
    jsonb_build_object(
      'pass_id', new_pass_id,
      'public_reference', new_public_ref,
      'valid_from', v_from,
      'valid_until', v_until,
      'registration_mode', target_visit.registration_mode,
      'returning_profile_id', target_visit.returning_profile_id
    )
  );

  return query select true, 'approved'::text, new_pass_id, new_public_ref, v_from, v_until, 'Visit approved successfully.'::text;
end;
$$;

revoke all on function api.decide_office_visit from public, anon, authenticated;
grant execute on function api.decide_office_visit to service_role;
