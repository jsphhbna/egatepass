-- Migration 93: Emergency Sync Manifest Field Remediation
-- Fixes v_manifest field access to use issued_at and ensures recovery_sync executes without plpgsql lint errors

create or replace function api.record_emergency_sync_item(
  requested_request_id uuid,
  requested_device_user_id uuid,
  requested_record_id uuid,
  requested_claimed_gate text,
  requested_visitor_full_name text,
  requested_declared_address text,
  requested_purpose text,
  requested_destination_office_id uuid,
  requested_destination_office_name_snapshot text,
  requested_office_resolution_status text,
  requested_office_requires_approval_snapshot boolean,
  requested_id_physically_inspected boolean,
  requested_id_inspection_attestation_text text,
  requested_local_recorded_at timestamptz,
  requested_local_sequence integer,
  requested_snapshot_version text,
  requested_manifest_id uuid,
  requested_lease_status_at_record text,
  requested_emergency_exception_applied boolean default false,
  requested_emergency_exception_reason text default null,
  requested_is_recovery boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_settings public.app_settings%rowtype;
  v_existing public.emergency_gate_records%rowtype;
  v_seq_owner public.emergency_gate_records%rowtype;
  v_manifest public.emergency_device_manifests%rowtype;
  v_office public.offices%rowtype;
  v_fingerprint text;
  v_clean_name text := btrim(coalesce(requested_visitor_full_name, ''));
  v_clean_addr text := btrim(coalesce(requested_declared_address, ''));
  v_clean_purpose text := btrim(coalesce(requested_purpose, ''));
  v_clean_office_name text := btrim(coalesce(requested_destination_office_name_snapshot, ''));
  v_clean_claimed_gate text := regexp_replace(btrim(coalesce(requested_claimed_gate, '')), '\s+', ' ', 'g');
  v_norm_claimed_gate text := pg_catalog.btrim(pg_catalog.lower(coalesce(requested_claimed_gate, '')));
  v_norm_device_gate text;
  v_flags text[] := array[]::text[];
  v_status public.emergency_reconciliation_status := 'received'::public.emergency_reconciliation_status;
  v_max_seq integer := 0;
  v_outcome text := 'created';
  v_receipt_id uuid := gen_random_uuid();
  v_has_duplicate_walkin boolean := false;
  v_valid_manifest_id uuid := null;
  v_office_approval boolean := coalesce(requested_office_requires_approval_snapshot, true);
  v_is_recovery_quarantine boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  if requested_id_physically_inspected is distinct from true
     or requested_id_inspection_attestation_text is distinct from 'I confirm that the visitor physically presented an identification document and that I visually inspected it.' then
    raise exception using errcode = '22023', message = 'physical_id_inspection_attestation_required';
  end if;

  if char_length(v_clean_name) < 2 or char_length(v_clean_addr) < 5 or char_length(v_clean_purpose) < 2 or char_length(v_clean_office_name) < 2 then
    raise exception using errcode = '22023', message = 'invalid_offline_record_fields';
  end if;

  if requested_local_sequence is null or requested_local_sequence < 1 then
    raise exception using errcode = '22023', message = 'invalid_local_sequence';
  end if;

  perform pg_advisory_xact_lock(hashtext('emergency_sync:' || requested_device_user_id::text));

  select * into v_device
  from public.devices d
  where d.user_id = requested_device_user_id
    and d.type = 'emergency_device'::public.device_type
  for update;

  if not found then
    raise exception using errcode = '42501', message = 'emergency_device_not_found';
  end if;

  v_norm_device_gate := pg_catalog.btrim(pg_catalog.lower(v_device.gate));

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          '|',
          requested_device_user_id::text,
          requested_local_sequence::text,
          v_norm_claimed_gate,
          lower(v_clean_name),
          lower(v_clean_addr),
          lower(v_clean_purpose),
          coalesce(requested_destination_office_id::text, 'unresolved'),
          lower(v_clean_office_name),
          requested_office_resolution_status,
          coalesce(to_char(requested_local_recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
          coalesce(requested_emergency_exception_applied::text, 'false')
        ),
        'UTF8'
      )
    ),
    'hex'
  );

  -- 1. Check device active status or evaluate safe recovery-sync for retired device
  if v_device.status <> 'active'::public.device_status or v_device.deleted_at is not null then
    if requested_is_recovery is true
       and requested_local_recorded_at < coalesce(v_device.deleted_at, v_device.updated_at) then
      -- Verify manifest exists and was issued before device retirement
      select * into v_manifest
      from public.emergency_device_manifests m
      where m.id = requested_manifest_id
        and m.device_user_id = requested_device_user_id;

      if not found or v_manifest.issued_at >= coalesce(v_device.deleted_at, v_device.updated_at) then
        insert into public.emergency_sync_receipts(
          id, request_id, emergency_record_id, device_user_id, local_sequence,
          payload_fingerprint, outcome, flags, reason_code, actor_id
        ) values (
          v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
          requested_local_sequence, v_fingerprint, 'rejected_invalid_recovery_manifest',
          jsonb_build_array('invalid_recovery_manifest'), 'invalid_recovery_manifest', requested_device_user_id
        );

        return jsonb_build_object(
          'accepted', false,
          'httpStatus', 403,
          'outcome', 'rejected_invalid_recovery_manifest',
          'error', 'invalid_recovery_manifest',
          'receiptId', v_receipt_id
        );
      end if;

      v_is_recovery_quarantine := true;
      v_flags := array_append(v_flags, 'recovery_sync_retired_device');
      v_status := 'needs_review'::public.emergency_reconciliation_status;
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_device_revoked',
        jsonb_build_array('device_revoked'), 'device_revoked', requested_device_user_id
      );

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
      ) values (
        requested_device_user_id, 'device', 'emergency_device', 'emergency_record.sync_rejected_revoked',
        'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
        jsonb_build_object('receiptId', v_receipt_id, 'deviceStatus', v_device.status, 'localSequence', requested_local_sequence)
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 403,
        'outcome', 'rejected_device_revoked',
        'error', 'device_revoked',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 2. Idempotency / UUID conflict check
  select * into v_existing
  from public.emergency_gate_records r
  where r.id = requested_record_id
  for update;

  if found then
    if v_existing.device_user_id = requested_device_user_id
       and v_existing.payload_fingerprint = v_fingerprint then
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, resulting_status, flags, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'idempotent_replay',
        v_existing.reconciliation_status, v_existing.reconciliation_flags, requested_device_user_id
      );

      return jsonb_build_object(
        'accepted', true,
        'outcome', 'idempotent_replay',
        'recordId', v_existing.id,
        'localSequence', v_existing.local_sequence,
        'reconciliationStatus', v_existing.reconciliation_status,
        'classification', v_existing.record_classification,
        'flags', v_existing.reconciliation_flags,
        'receiptId', v_receipt_id
      );
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_record_id_conflict',
        jsonb_build_array('record_id_conflict'), 'uuid_conflict', requested_device_user_id
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 409,
        'outcome', 'rejected_record_id_conflict',
        'error', 'record_id_conflict',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 3. Verify manifest if provided
  if requested_manifest_id is not null then
    select * into v_manifest
    from public.emergency_device_manifests m
    where m.id = requested_manifest_id
      and m.device_user_id = requested_device_user_id;

    if found then
      v_valid_manifest_id := v_manifest.id;
    else
      v_flags := array_append(v_flags, 'unknown_manifest_reference');
    end if;
  else
    v_flags := array_append(v_flags, 'no_manifest');
  end if;

  -- 4. Verify gate binding (cross-gate replay vs post-manifest gate reassignment)
  if v_norm_claimed_gate is distinct from v_norm_device_gate then
    if v_manifest.id is not null and pg_catalog.btrim(pg_catalog.lower(v_manifest.assigned_gate)) = v_norm_claimed_gate then
      v_flags := array_append(v_flags, 'gate_reassigned_since_manifest');
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'rejected_gate_mismatch',
        jsonb_build_array('gate_mismatch'), 'gate_mismatch', requested_device_user_id
      );

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
      ) values (
        requested_device_user_id, 'device', 'emergency_device', 'emergency_record.gate_mismatch_rejected',
        'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
        jsonb_build_object('receiptId', v_receipt_id, 'claimedGate', v_clean_claimed_gate, 'deviceGate', v_device.gate)
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 403,
        'outcome', 'rejected_gate_mismatch',
        'error', 'gate_mismatch',
        'receiptId', v_receipt_id
      );
    end if;
  end if;

  -- 5. Sequence collision check
  select * into v_seq_owner
  from public.emergency_gate_records r
  where r.device_user_id = requested_device_user_id
    and r.local_sequence = requested_local_sequence;

  if found then
    insert into public.emergency_sync_receipts(
      id, request_id, emergency_record_id, device_user_id, local_sequence,
      payload_fingerprint, outcome, flags, reason_code, actor_id
    ) values (
      v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
      requested_local_sequence, v_fingerprint, 'conflict_sequence_collision',
      jsonb_build_array('sequence_collision'), 'sequence_collision', requested_device_user_id
    );

    insert into public.audit_events(
      actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
    ) values (
      requested_device_user_id, 'device', 'emergency_device', 'emergency_record.sequence_collision',
      'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
      jsonb_build_object('receiptId', v_receipt_id, 'collidingRecordId', v_seq_owner.id, 'localSequence', requested_local_sequence)
    );

    return jsonb_build_object(
      'accepted', false,
      'httpStatus', 409,
      'outcome', 'conflict_sequence_collision',
      'error', 'sequence_collision',
      'receiptId', v_receipt_id
    );
  end if;

  select coalesce(max(r.local_sequence), 0) into v_max_seq
  from public.emergency_gate_records r
  where r.device_user_id = requested_device_user_id;

  if requested_local_sequence > v_max_seq + 1 then
    v_flags := array_append(v_flags, 'sequence_gap_detected');
  elsif requested_local_sequence < v_max_seq then
    v_flags := array_append(v_flags, 'out_of_order_sequence');
  end if;

  -- 6. Lease & manifest revocation flags
  if v_manifest.id is not null and v_manifest.revoked_at is not null then
    v_flags := array_append(v_flags, 'revoked_manifest_lease');
  end if;

  if requested_lease_status_at_record <> 'valid' then
    v_flags := array_append(v_flags, requested_lease_status_at_record);
  end if;

  -- 7. Office resolution and live approval policy check
  if requested_office_resolution_status = 'unresolved_stale_snapshot' or requested_destination_office_id is null then
    v_flags := array_append(v_flags, 'unresolved_office');
    v_office_approval := true;
  else
    select * into v_office from public.offices o where o.id = requested_destination_office_id;
    if not found then
      v_flags := array_append(v_flags, 'office_not_found');
      v_office_approval := true;
    else
      if not v_office.active or v_office.publication_status <> 'published' then
        v_flags := array_append(v_flags, 'office_unpublished_or_inactive');
      end if;
      v_office_approval := v_office.requires_approval_before_pass or coalesce(requested_office_requires_approval_snapshot, true);
    end if;
  end if;

  if v_office_approval then
    v_flags := array_append(v_flags, 'office_approval_required');
  end if;

  -- 8. Emergency exception policy validation
  select * into v_settings from public.app_settings where singleton = true;
  if requested_emergency_exception_applied then
    if coalesce(v_settings.allow_emergency_exception, false) = false then
      v_flags := array_append(v_flags, 'emergency_exception_policy_disabled');
    else
      v_flags := array_append(v_flags, 'emergency_exception_applied');
    end if;
  end if;

  -- 9. Potential walk-in duplicate detection (same normalized name + purpose + gate within 15 minutes)
  select exists (
    select 1 from public.emergency_gate_records existing_r
    where existing_r.normalized_gate = v_norm_claimed_gate
      and lower(existing_r.visitor_full_name) = lower(v_clean_name)
      and lower(existing_r.purpose) = lower(v_clean_purpose)
      and abs(extract(epoch from (existing_r.local_recorded_at - requested_local_recorded_at))) <= 900
  ) into v_has_duplicate_walkin;

  if v_has_duplicate_walkin then
    v_flags := array_append(v_flags, 'potential_duplicate_walkin');
  end if;

  if v_is_recovery_quarantine or coalesce(array_length(v_flags, 1), 0) > 0 then
    v_status := 'needs_review'::public.emergency_reconciliation_status;
    v_outcome := 'flagged_needs_review';
  else
    v_status := 'received'::public.emergency_reconciliation_status;
    v_outcome := 'created';
  end if;

  insert into public.emergency_gate_records(
    id,
    device_user_id,
    gate,
    normalized_gate,
    visitor_full_name,
    declared_address,
    address_status,
    purpose,
    destination_office_id,
    destination_office_name_snapshot,
    office_resolution_status,
    office_requires_approval_snapshot,
    id_physically_inspected,
    id_inspection_attestation_text,
    record_classification,
    local_recorded_at,
    local_sequence,
    snapshot_version,
    manifest_id,
    lease_status_at_record,
    emergency_exception_applied,
    emergency_exception_reason,
    payload_fingerprint,
    reconciliation_status,
    reconciliation_flags
  ) values (
    requested_record_id,
    requested_device_user_id,
    v_clean_claimed_gate,
    v_norm_claimed_gate,
    v_clean_name,
    v_clean_addr,
    'visitor_declared_unverified',
    v_clean_purpose,
    requested_destination_office_id,
    v_clean_office_name,
    requested_office_resolution_status,
    v_office_approval,
    true,
    requested_id_inspection_attestation_text,
    'OFFLINE MODE RECORDED',
    requested_local_recorded_at,
    requested_local_sequence,
    requested_snapshot_version,
    v_valid_manifest_id,
    requested_lease_status_at_record,
    coalesce(requested_emergency_exception_applied, false),
    nullif(btrim(requested_emergency_exception_reason), ''),
    v_fingerprint,
    v_status,
    to_jsonb(v_flags)
  );

  insert into public.emergency_sync_receipts(
    id, request_id, emergency_record_id, device_user_id, local_sequence,
    payload_fingerprint, outcome, resulting_status, flags, actor_id
  ) values (
    v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
    requested_local_sequence, v_fingerprint, v_outcome, v_status, to_jsonb(v_flags),
    requested_device_user_id
  );

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
  ) values (
    requested_device_user_id,
    'device',
    'emergency_device',
    'emergency_record.synced',
    'emergency_gate_record',
    requested_record_id::text,
    requested_request_id,
    jsonb_build_object(
      'receiptId', v_receipt_id,
      'localSequence', requested_local_sequence,
      'status', v_status,
      'flags', v_flags,
      'isRecovery', requested_is_recovery
    )
  );

  return jsonb_build_object(
    'accepted', true,
    'outcome', v_outcome,
    'recordId', requested_record_id,
    'localSequence', requested_local_sequence,
    'reconciliationStatus', v_status,
    'classification', 'OFFLINE MODE RECORDED',
    'flags', to_jsonb(v_flags),
    'receiptId', v_receipt_id
  );
end $$;

revoke all on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text, boolean
) from public, anon, authenticated;

grant execute on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text, boolean
) to service_role;
