-- =============================================================================
-- Migration 89: Emergency Device Offline Gate System, Leases, Sync & Exceptions
-- =============================================================================
-- Establishes:
--   1. public.emergency_reconciliation_status enum
--   2. public.emergency_device_manifests (device- and gate-bound offline leases)
--   3. public.emergency_gate_records (permanently OFFLINE MODE RECORDED records;
--      never ordinary QR passes; no selfies/ID photos/postal codes)
--   4. public.emergency_sync_receipts (immutable synchronization/conflict/reconciliation audit)
--   5. private.emergency_signing_keys (server-only ECDSA P-256 signing key storage)
--   6. app_settings emergency exception policy & emergency retention controls (default OFF)
--   7. Device management RPC upgrades supporting 'emergency_device' + audited gate changes
--   8. Offline manifest, sync idempotency/conflict/gap, reconciliation & retention RPCs
-- =============================================================================

-- 1. Emergency reconciliation status enum
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'emergency_reconciliation_status'
  ) then
    create type public.emergency_reconciliation_status as enum (
      'pending_sync',
      'received',
      'accepted',
      'needs_review',
      'duplicate',
      'rejected'
    );
  end if;
end $$;

-- 2. Emergency exception & retention category columns on app_settings
alter table public.app_settings
  add column if not exists allow_emergency_exception boolean not null default false,
  add column if not exists emergency_exception_policy_note text,
  add column if not exists emergency_record_retention_enabled boolean not null default true,
  add column if not exists emergency_record_retention_days smallint not null default 90;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'app_settings_emergency_record_retention_days_check'
  ) then
    alter table public.app_settings
      add constraint app_settings_emergency_record_retention_days_check
      check (emergency_record_retention_days between 7 and 3650);
  end if;
end $$;

-- 3. Server-only ECDSA P-256 signing key store in private schema (never exposed via PostgREST)
create table if not exists private.emergency_signing_keys (
  id text primary key,
  algorithm text not null default 'ECDSA_P256_SHA256',
  public_key_spki text not null check (char_length(public_key_spki) >= 32),
  private_key_pkcs8 text not null check (char_length(private_key_pkcs8) >= 32),
  created_at timestamptz not null default now()
);

revoke all on table private.emergency_signing_keys from public, anon, authenticated;
grant select, insert on table private.emergency_signing_keys to service_role;

-- 4. Issued signed offline manifests / leases for Emergency Devices
create table if not exists public.emergency_device_manifests (
  id uuid primary key,
  device_user_id uuid not null references public.devices(user_id) on delete cascade,
  assigned_gate text not null check (char_length(btrim(assigned_gate)) between 1 and 80),
  snapshot_version text not null check (char_length(btrim(snapshot_version)) between 8 and 128),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  scope text not null default 'emergency_offline_gate' check (scope = 'emergency_offline_gate'),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_emergency_device_manifests_device_issued
  on public.emergency_device_manifests (device_user_id, issued_at desc);

alter table public.emergency_device_manifests enable row level security;
revoke all on table public.emergency_device_manifests from public, anon, authenticated;
grant select on table public.emergency_device_manifests to authenticated, service_role;

drop policy if exists emergency_device_manifests_staff_select on public.emergency_device_manifests;
create policy emergency_device_manifests_staff_select on public.emergency_device_manifests
  for select to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- 5. Distinct table for permanently OFFLINE MODE RECORDED Emergency Device records
create table if not exists public.emergency_gate_records (
  id uuid primary key,
  device_user_id uuid not null references public.devices(user_id) on delete restrict,
  gate text not null check (char_length(btrim(gate)) between 1 and 80),
  normalized_gate text not null check (normalized_gate = pg_catalog.btrim(pg_catalog.lower(gate))),
  visitor_full_name text not null check (char_length(btrim(visitor_full_name)) between 2 and 160),
  declared_address text not null check (char_length(btrim(declared_address)) between 5 and 400),
  address_status text not null default 'visitor_declared_unverified'
    check (address_status = 'visitor_declared_unverified'),
  purpose text not null check (char_length(btrim(purpose)) between 2 and 500),
  destination_office_id uuid references public.offices(id) on delete restrict,
  destination_office_name_snapshot text not null check (char_length(btrim(destination_office_name_snapshot)) between 2 and 160),
  office_resolution_status text not null default 'resolved_snapshot'
    check (office_resolution_status in ('resolved_snapshot', 'unresolved_stale_snapshot')),
  office_requires_approval_snapshot boolean not null default true,
  id_physically_inspected boolean not null check (id_physically_inspected = true),
  id_inspection_attestation_text text not null check (
    id_inspection_attestation_text = 'I confirm that the visitor physically presented an identification document and that I visually inspected it.'
  ),
  record_classification text not null default 'OFFLINE MODE RECORDED'
    check (record_classification = 'OFFLINE MODE RECORDED'),
  local_recorded_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  local_sequence integer not null check (local_sequence >= 1),
  snapshot_version text not null check (char_length(btrim(snapshot_version)) between 1 and 128),
  manifest_id uuid references public.emergency_device_manifests(id) on delete set null,
  lease_status_at_record text not null check (
    lease_status_at_record in ('valid', 'stale_lease', 'expired_lease', 'unverified_lease', 'no_manifest')
  ),
  emergency_exception_applied boolean not null default false,
  emergency_exception_reason text,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  reconciliation_status public.emergency_reconciliation_status not null default 'received',
  reconciliation_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(reconciliation_flags) = 'array'),
  reconciliation_notes text,
  reconciled_by uuid references auth.users(id) on delete set null,
  reconciled_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint emergency_gate_records_device_seq_unique unique (device_user_id, local_sequence)
);

create index if not exists idx_emergency_gate_records_received_id
  on public.emergency_gate_records (server_received_at desc, id desc);
create index if not exists idx_emergency_gate_records_status_received
  on public.emergency_gate_records (reconciliation_status, server_received_at desc);
create index if not exists idx_emergency_gate_records_gate_local
  on public.emergency_gate_records (normalized_gate, local_recorded_at desc);
create index if not exists idx_emergency_gate_records_office_id
  on public.emergency_gate_records (destination_office_id)
  where destination_office_id is not null;

alter table public.emergency_gate_records enable row level security;
revoke all on table public.emergency_gate_records from public, anon, authenticated;
grant select on table public.emergency_gate_records to authenticated, service_role;

drop policy if exists emergency_gate_records_staff_select on public.emergency_gate_records;
create policy emergency_gate_records_staff_select on public.emergency_gate_records
  for select to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- 6. Immutable sync & reconciliation receipt journal
create table if not exists public.emergency_sync_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  emergency_record_id uuid not null,
  device_user_id uuid not null references public.devices(user_id) on delete restrict,
  local_sequence integer not null check (local_sequence >= 1),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check (
    outcome in (
      'created',
      'idempotent_replay',
      'conflict_payload_mismatch',
      'conflict_sequence_collision',
      'rejected_device_revoked',
      'rejected_gate_mismatch',
      'flagged_needs_review',
      'reconciled'
    )
  ),
  resulting_status public.emergency_reconciliation_status,
  flags jsonb not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array'),
  reason_code text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_emergency_sync_receipts_record_created
  on public.emergency_sync_receipts (emergency_record_id, created_at desc);
create index if not exists idx_emergency_sync_receipts_device_created
  on public.emergency_sync_receipts (device_user_id, created_at desc);

alter table public.emergency_sync_receipts enable row level security;
revoke all on table public.emergency_sync_receipts from public, anon, authenticated;
grant select on table public.emergency_sync_receipts to authenticated, service_role;

drop policy if exists emergency_sync_receipts_staff_select on public.emergency_sync_receipts;
create policy emergency_sync_receipts_staff_select on public.emergency_sync_receipts
  for select to authenticated
  using ((select private.has_staff_role(array['admin', 'superadmin']::public.staff_role[])));

-- 7. Upgrade device governance RPCs (create_device_profile, update_device_profile, retire_device)
create or replace function api.create_device_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_alias text,
  requested_name text,
  requested_type public.device_type,
  requested_gate text,
  requested_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  clean_alias text;
  clean_name text;
  clean_gate text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  clean_alias := lower(btrim(coalesce(requested_alias, '')));
  clean_name := btrim(coalesce(requested_name, ''));
  clean_gate := regexp_replace(btrim(coalesce(requested_gate, '')), '\s+', ' ', 'g');

  if char_length(clean_alias) < 3 or char_length(clean_name) < 2 or char_length(clean_gate) < 1 then
    raise exception using errcode = '22023', message = 'invalid_device_profile_fields';
  end if;

  insert into public.devices(user_id, alias, name, type, gate, status, created_by)
  values (requested_user_id, clean_alias, clean_name, requested_type, clean_gate, 'active', requested_actor_id);

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'device.create',
    'device',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object(
      'alias', clean_alias,
      'name', clean_name,
      'type', requested_type,
      'gate', clean_gate,
      'status', 'active'
    )
  );
end $$;

drop function if exists api.update_device_profile(uuid, uuid, public.device_status, text, uuid);

create or replace function api.update_device_profile(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_status public.device_status default null,
  requested_alias text default null,
  requested_request_id uuid default null,
  requested_name text default null,
  requested_gate text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.devices%rowtype;
  next_status public.device_status;
  next_alias text;
  next_name text;
  next_gate text;
  gate_changed boolean;
  status_changed boolean;
  audit_action text;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  select * into target
  from public.devices d
  where d.user_id = requested_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'device not found';
  end if;

  if target.status = 'retired'::public.device_status or target.deleted_at is not null then
    raise exception using errcode = '42501', message = 'cannot modify retired device';
  end if;

  next_status := coalesce(requested_status, target.status);
  next_alias := coalesce(nullif(lower(btrim(requested_alias)), ''), target.alias);
  next_name := coalesce(nullif(btrim(requested_name), ''), target.name);
  next_gate := coalesce(nullif(regexp_replace(btrim(requested_gate), '\s+', ' ', 'g'), ''), target.gate);

  gate_changed := btrim(lower(next_gate)) is distinct from btrim(lower(target.gate));
  status_changed := next_status is distinct from target.status;

  -- Restrict emergency device gate reassignment strictly to Superadmin so offline lease/gate binding cannot be bypassed casually
  if gate_changed and target.type = 'emergency_device'::public.device_type and actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin_required_for_emergency_gate_reassignment';
  end if;

  update public.devices
  set
    status = next_status,
    alias = next_alias,
    name = next_name,
    gate = next_gate,
    updated_at = now()
  where user_id = target.user_id;

  -- Revoke outstanding offline manifests whenever an emergency device is revoked or changes gate
  if target.type = 'emergency_device'::public.device_type and (gate_changed or next_status <> 'active'::public.device_status) then
    update public.emergency_device_manifests
    set revoked_at = coalesce(revoked_at, now())
    where device_user_id = target.user_id
      and revoked_at is null;
  end if;

  if gate_changed then
    audit_action := 'device.gate_changed';
  elsif status_changed and next_status = 'revoked'::public.device_status then
    audit_action := 'device.revoke';
  elsif status_changed and next_status = 'active'::public.device_status then
    audit_action := 'device.activate';
  else
    audit_action := 'device.update';
  end if;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    audit_action,
    'device',
    target.user_id::text,
    coalesce(requested_request_id, gen_random_uuid()),
    jsonb_build_object('status', target.status, 'alias', target.alias, 'name', target.name, 'gate', target.gate),
    jsonb_build_object('status', next_status, 'alias', next_alias, 'name', next_name, 'gate', next_gate)
  );
end $$;

create or replace function api.retire_device(
  requested_actor_id uuid,
  requested_user_id uuid,
  requested_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.devices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role <> 'superadmin'::public.staff_role then
    raise exception using errcode = '42501', message = 'superadmin required';
  end if;

  select * into target from public.devices where user_id = requested_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'device not found';
  end if;

  update public.devices
  set status = 'retired'::public.device_status,
      deleted_at = now(),
      updated_at = now()
  where user_id = requested_user_id;

  update public.emergency_device_manifests
  set revoked_at = coalesce(revoked_at, now())
  where device_user_id = requested_user_id
    and revoked_at is null;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'device.retire',
    'device',
    requested_user_id::text,
    requested_request_id,
    jsonb_build_object('status', target.status, 'gate', target.gate),
    jsonb_build_object('status', 'retired', 'deleted', true)
  );
end $$;

revoke all on function api.create_device_profile(uuid, uuid, text, text, public.device_type, text, uuid) from public, anon, authenticated;
grant execute on function api.create_device_profile(uuid, uuid, text, text, public.device_type, text, uuid) to service_role;

revoke all on function api.update_device_profile(uuid, uuid, public.device_status, text, uuid, text, text) from public, anon, authenticated;
grant execute on function api.update_device_profile(uuid, uuid, public.device_status, text, uuid, text, text) to service_role;

revoke all on function api.retire_device(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function api.retire_device(uuid, uuid, uuid) to service_role;

-- 8. RPC: api.record_emergency_manifest (records device- & gate-bound offline lease)
create or replace function api.record_emergency_manifest(
  requested_device_user_id uuid,
  requested_manifest_id uuid,
  requested_assigned_gate text,
  requested_snapshot_version text,
  requested_issued_at timestamptz,
  requested_expires_at timestamptz,
  requested_manifest_hash text,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into v_device
  from public.devices d
  where d.user_id = requested_device_user_id
    and d.type = 'emergency_device'::public.device_type
    and d.status = 'active'::public.device_status
    and d.deleted_at is null
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'active_emergency_device_required';
  end if;

  if btrim(lower(v_device.gate)) is distinct from btrim(lower(requested_assigned_gate)) then
    raise exception using errcode = '42501', message = 'device_gate_mismatch';
  end if;

  insert into public.emergency_device_manifests(
    id, device_user_id, assigned_gate, snapshot_version, issued_at, expires_at, manifest_hash
  ) values (
    requested_manifest_id,
    requested_device_user_id,
    v_device.gate,
    requested_snapshot_version,
    requested_issued_at,
    requested_expires_at,
    requested_manifest_hash
  )
  on conflict (id) do nothing;

  update public.devices
  set last_seen_at = now(), updated_at = now()
  where user_id = requested_device_user_id;

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, after_state
  ) values (
    requested_device_user_id,
    'device',
    'emergency_device',
    'emergency_device.manifest_issued',
    'emergency_manifest',
    requested_manifest_id::text,
    coalesce(requested_request_id, gen_random_uuid()),
    jsonb_build_object(
      'deviceUserId', requested_device_user_id,
      'gate', v_device.gate,
      'snapshotVersion', requested_snapshot_version,
      'expiresAt', requested_expires_at
    )
  );

  return jsonb_build_object(
    'manifestId', requested_manifest_id,
    'gate', v_device.gate,
    'issuedAt', requested_issued_at,
    'expiresAt', requested_expires_at
  );
end $$;

revoke all on function api.record_emergency_manifest(uuid, uuid, text, text, timestamptz, timestamptz, text, uuid) from public, anon, authenticated;
grant execute on function api.record_emergency_manifest(uuid, uuid, text, text, timestamptz, timestamptz, text, uuid) to service_role;

-- 9. RPC: api.record_emergency_sync_item
-- Transactional idempotent synchronization with payload fingerprint verification,
-- sequence collision/gap detection, gate binding verification, and audit/receipt creation.
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
  requested_emergency_exception_reason text default null
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

  -- 1. Check device active status FIRST if not already idempotently persisted
  -- (Wait: if an identical offline record was ALREADY received previously before revocation, allow reading its replay?
  --  No, a revoked device must not perform online sync/reads; record rejected_device_revoked receipt & audit!)
  if v_device.status <> 'active'::public.device_status or v_device.deleted_at is not null then
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
        v_receipt_id, requested_request_id, v_existing.id, requested_device_user_id,
        v_existing.local_sequence, v_fingerprint, 'idempotent_replay',
        v_existing.reconciliation_status, v_existing.reconciliation_flags, requested_device_user_id
      );

      return jsonb_build_object(
        'accepted', true,
        'httpStatus', 200,
        'outcome', 'idempotent_replay',
        'recordId', v_existing.id,
        'classification', v_existing.record_classification,
        'reconciliationStatus', v_existing.reconciliation_status,
        'flags', v_existing.reconciliation_flags,
        'serverReceivedAt', v_existing.server_received_at,
        'receiptId', v_receipt_id
      );
    else
      insert into public.emergency_sync_receipts(
        id, request_id, emergency_record_id, device_user_id, local_sequence,
        payload_fingerprint, outcome, resulting_status, flags, reason_code, actor_id
      ) values (
        v_receipt_id, requested_request_id, requested_record_id, requested_device_user_id,
        requested_local_sequence, v_fingerprint, 'conflict_payload_mismatch',
        'needs_review'::public.emergency_reconciliation_status,
        jsonb_build_array('payload_mismatch_for_record_uuid'), 'payload_mismatch_for_record_uuid',
        requested_device_user_id
      );

      insert into public.audit_events(
        actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, outcome, after_state
      ) values (
        requested_device_user_id, 'device', 'emergency_device', 'emergency_record.sync_conflict',
        'emergency_gate_record', requested_record_id::text, requested_request_id, 'denied',
        jsonb_build_object('receiptId', v_receipt_id, 'reason', 'payload_mismatch_for_record_uuid', 'localSequence', requested_local_sequence)
      );

      return jsonb_build_object(
        'accepted', false,
        'httpStatus', 409,
        'outcome', 'conflict_payload_mismatch',
        'error', 'payload_mismatch_for_record_uuid',
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

  if coalesce(array_length(v_flags, 1), 0) > 0 then
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
      'classification', 'OFFLINE MODE RECORDED',
      'gate', v_clean_claimed_gate,
      'localSequence', requested_local_sequence,
      'localRecordedAt', requested_local_recorded_at,
      'reconciliationStatus', v_status,
      'flags', to_jsonb(v_flags),
      'receiptId', v_receipt_id
    )
  );

  update public.devices
  set last_seen_at = now(), updated_at = now()
  where user_id = requested_device_user_id;

  return jsonb_build_object(
    'accepted', true,
    'httpStatus', 201,
    'outcome', v_outcome,
    'recordId', requested_record_id,
    'classification', 'OFFLINE MODE RECORDED',
    'reconciliationStatus', v_status,
    'flags', to_jsonb(v_flags),
    'serverReceivedAt', now(),
    'receiptId', v_receipt_id
  );
end $$;

revoke all on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text
) from public, anon, authenticated;
grant execute on function api.record_emergency_sync_item(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, boolean, boolean, text, timestamptz, integer, text, uuid, text, boolean, text
) to service_role;

-- 10. RPC: api.reconcile_emergency_gate_record (Admin/Superadmin resolution with immutable audit)
create or replace function api.reconcile_emergency_gate_record(
  requested_actor_id uuid,
  requested_record_id uuid,
  requested_decision public.emergency_reconciliation_status,
  requested_notes text,
  requested_request_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_role public.staff_role;
  target public.emergency_gate_records%rowtype;
  clean_notes text := btrim(coalesce(requested_notes, ''));
  v_req_id uuid := coalesce(requested_request_id, gen_random_uuid());
  v_receipt_id uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select sp.role into actor_role
  from public.staff_profiles sp
  where sp.user_id = requested_actor_id
    and sp.active
    and not sp.must_change_password
    and sp.privacy_accepted_at is not null;

  if actor_role not in ('admin'::public.staff_role, 'superadmin'::public.staff_role) then
    raise exception using errcode = '42501', message = 'administrator required';
  end if;

  if requested_decision not in (
    'accepted'::public.emergency_reconciliation_status,
    'needs_review'::public.emergency_reconciliation_status,
    'duplicate'::public.emergency_reconciliation_status,
    'rejected'::public.emergency_reconciliation_status
  ) then
    raise exception using errcode = '22023', message = 'invalid_reconciliation_decision';
  end if;

  if char_length(clean_notes) < 5 then
    raise exception using errcode = '22023', message = 'reconciliation_notes_required';
  end if;

  select * into target
  from public.emergency_gate_records r
  where r.id = requested_record_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'emergency_record_not_found';
  end if;

  update public.emergency_gate_records
  set
    reconciliation_status = requested_decision,
    reconciliation_notes = clean_notes,
    reconciled_by = requested_actor_id,
    reconciled_at = now(),
    updated_at = now()
  where id = requested_record_id;

  insert into public.emergency_sync_receipts(
    id, request_id, emergency_record_id, device_user_id, local_sequence,
    payload_fingerprint, outcome, resulting_status, flags, reason_code, actor_id
  ) values (
    v_receipt_id, v_req_id, target.id, target.device_user_id, target.local_sequence,
    target.payload_fingerprint, 'reconciled', requested_decision, target.reconciliation_flags,
    clean_notes, requested_actor_id
  );

  insert into public.audit_events(
    actor_id, actor_kind, actor_role, action, target_type, target_id, request_id, before_state, after_state
  ) values (
    requested_actor_id,
    'staff',
    actor_role::text,
    'emergency_record.reconciled',
    'emergency_gate_record',
    target.id::text,
    v_req_id,
    jsonb_build_object(
      'reconciliationStatus', target.reconciliation_status,
      'reconciledAt', target.reconciled_at
    ),
    jsonb_build_object(
      'reconciliationStatus', requested_decision,
      'classification', target.record_classification,
      'notes', clean_notes,
      'receiptId', v_receipt_id
    )
  );

  return jsonb_build_object(
    'recordId', target.id,
    'classification', target.record_classification,
    'reconciliationStatus', requested_decision,
    'reconciledAt', now(),
    'reconciledBy', requested_actor_id,
    'receiptId', v_receipt_id
  );
end $$;

revoke all on function api.reconcile_emergency_gate_record(uuid, uuid, public.emergency_reconciliation_status, text, uuid) from public, anon, authenticated;
grant execute on function api.reconcile_emergency_gate_record(uuid, uuid, public.emergency_reconciliation_status, text, uuid) to service_role;

-- 11. RPC: api.anonymize_expired_emergency_gate_record
-- Distinct retention category for emergency gate records; skips frozen, unsettled, or needs_review records!
create or replace function api.anonymize_expired_emergency_gate_record(
  requested_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings public.app_settings%rowtype;
  v_rec public.emergency_gate_records%rowtype;
  v_cutoff timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'service role required';
  end if;

  select * into v_settings from public.app_settings where singleton = true;
  if not found then
    return jsonb_build_object('anonymized', false, 'reason', 'settings_unavailable');
  end if;

  if coalesce(v_settings.emergency_record_retention_enabled, true) = false then
    return jsonb_build_object('anonymized', false, 'reason', 'category_retention_disabled');
  end if;

  select * into v_rec from public.emergency_gate_records where id = requested_record_id for update;
  if not found then
    return jsonb_build_object('anonymized', false, 'reason', 'not_found');
  end if;

  if v_rec.anonymized_at is not null then
    return jsonb_build_object('anonymized', false, 'reason', 'already_anonymized');
  end if;

  -- Never purge unresolved or pending records merely because they aged out
  if v_rec.reconciliation_status in ('pending_sync', 'received', 'needs_review') then
    return jsonb_build_object('anonymized', false, 'reason', 'unresolved_reconciliation');
  end if;

  v_cutoff := statement_timestamp() - make_interval(days => coalesce(v_settings.emergency_record_retention_days, 90));
  if v_rec.local_recorded_at > v_cutoff then
    return jsonb_build_object('anonymized', false, 'reason', 'not_expired');
  end if;

  update public.emergency_gate_records
  set
    visitor_full_name = 'Anonymized Offline Record',
    declared_address = 'Anonymized per retention policy',
    anonymized_at = statement_timestamp(),
    updated_at = statement_timestamp()
  where id = v_rec.id;

  return jsonb_build_object('anonymized', true, 'recordId', v_rec.id);
end $$;

revoke all on function api.anonymize_expired_emergency_gate_record(uuid) from public, anon, authenticated;
grant execute on function api.anonymize_expired_emergency_gate_record(uuid) to service_role;
