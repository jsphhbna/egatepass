import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function setupSupabaseEmulation(db: PGlite) {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end
    $$;

    create table if not exists auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      encrypted_password text,
      is_anonymous boolean default false,
      raw_app_meta_data jsonb default '{}'::jsonb,
      raw_user_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create or replace function auth.uid() returns uuid as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
        nullif(current_setting('my.auth.uid', true), '')::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      );
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'service_role'::text
      );
    $$ language sql stable;

    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;

    create table if not exists storage.buckets (
      id text primary key,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );

    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      last_accessed_at timestamptz,
      metadata jsonb
    );

    do $$
    begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end
    $$;
  `);
}

async function applyAllMigrations(db: PGlite) {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    sql = sql.replace(/create extension if not exists "uuid-ossp"[^;]*;/gi, '-- uuid-ossp no-op');
    await db.exec(sql);
  }
  return files;
}

describe('Office Schema Reconciliation & Visitor Ownership Contracts (PGlite)', () => {
  it('verifies upload_intents held_until column and canonical schema isolation', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Check upload_intents columns
    const cols = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'upload_intents';
    `);
    const colNames = cols.rows.map((r) => r.column_name);

    expect(colNames).toContain('held_until');
    expect(colNames).toContain('storage_cleaned_at');
    expect(colNames).toContain('owner_id');
    expect(colNames).toContain('kind');
    expect(colNames).toContain('status');

    // Canonical upload_intents should NOT have purpose or storage_path
    expect(colNames).not.toContain('purpose');
    expect(colNames).not.toContain('storage_path');
    expect(colNames).not.toContain('consumed_at');

    // 2. Check visitors columns (should NOT have photo_storage_path or id_storage_path)
    const visitorCols = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'visitors';
    `);
    const visitorColNames = visitorCols.rows.map((r) => r.column_name);
    expect(visitorColNames).not.toContain('photo_storage_path');
    expect(visitorColNames).not.toContain('id_storage_path');

    // 3. Verify canonical visitor_evidence exists with expected kinds
    const evidenceCols = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'visitor_evidence';
    `);
    const evidenceColNames = evidenceCols.rows.map((r) => r.column_name);
    expect(evidenceColNames).toContain('kind');
    expect(evidenceColNames).toContain('bucket_id');
    expect(evidenceColNames).toContain('object_path');
    expect(evidenceColNames).toContain('sha256_hex');
  }, 60000);

  it('verifies office visit approval assigns visitor_actor_id as owner_id to canonical visitor and records staff in decided_by', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // Create visitor user and staff user in auth.users
    const visitorUserId = '11111111-1111-4111-8111-111111111111';
    const staffUserId = '22222222-2222-4222-8222-222222222222';

    await db.exec(`
      insert into auth.users (id, email, is_anonymous) values
      ('${visitorUserId}', 'visitor@test.local', true),
      ('${staffUserId}', 'staff@earist.edu.ph', false);

      insert into public.staff_profiles (user_id, display_name, role)
      values ('${staffUserId}', 'Admin Staff', 'superadmin');
    `);

    // Get an office id and create active personnel
    const officeRes = await db.query<{ id: string }>(`select id from public.offices limit 1;`);
    const officeId = officeRes.rows[0].id;

    const personnelRes = await db.query<{ id: string }>(`
      insert into public.office_personnel (office_id, name, title)
      values ('${officeId}', 'Dean Juan', 'College Dean')
      returning id;
    `);
    const personnelId = personnelRes.rows[0].id;

    // Create an upload intent for visitor photo
    const intentId = '33333333-3333-4333-8333-333333333333';
    await db.exec(`
      insert into public.upload_intents (
        id, owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at
      ) values (
        '${intentId}', '${visitorUserId}', 'portal', 'photo',
        'visitor-photos', 'photos/test.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour'
      );
    `);

    // Create specific person visit request via RPC using named parameters
    const createRes = await db.query<{ visit_id: string; request_id: string; approval_status: string }>(`
      select * from api.create_specific_person_visit_request(
        requested_actor_id => '${visitorUserId}'::uuid,
        requested_request_id => gen_random_uuid(),
        requested_office_id => '${officeId}'::uuid,
        requested_personnel_id => '${personnelId}'::uuid,
        requested_first_name => 'Juan',
        requested_middle_name => 'Dela',
        requested_last_name => 'Cruz',
        requested_contact_number => '09171234567',
        requested_email => 'visitor@test.local',
        requested_purpose => 'Consultation',
        requested_visit_date => current_date,
        requested_arrival_mode => 'no_vehicle',
        requested_vehicle_details => null::jsonb,
        requested_address_details => '{"cityName": "Manila"}'::jsonb,
        requested_photo_intent_id => '${intentId}'::uuid,
        requested_photo_bytes => 54321,
        requested_photo_sha256 => '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      );
    `);

    expect(createRes.rows.length).toBe(1);
    const visitId = createRes.rows[0].visit_id;
    expect(createRes.rows[0].approval_status).toBe('pending');

    // Verify upload intent received held_until hold
    const intentCheck = await db.query<{ held_until: string; status: string }>(`
      select held_until, status from public.upload_intents where id = '${intentId}';
    `);
    expect(intentCheck.rows[0].held_until).not.toBeNull();
    expect(intentCheck.rows[0].status).toBe('uploaded');

    // Now decide the visit as APPROVED by staffUserId
    const decideRes = await db.query<{ ok: boolean; status: string }>(`
      select * from api.decide_office_visit(
        requested_actor_id => '${staffUserId}'::uuid,
        requested_visit_id => '${visitId}'::uuid,
        requested_decision => 'approved',
        requested_rejection_reason => null::text,
        requested_token_digest => '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        requested_encrypted_payload => 'c2VjdXJlX2VuY3J5cHRlZF9xcl9wYXlsb2Fk'
      );
    `);

    expect(decideRes.rows.length).toBe(1);
    expect(decideRes.rows[0].ok).toBe(true);

    // Verify canonical visitor owner is visitorUserId, NOT staffUserId!
    const visitorRecord = await db.query<{ owner_id: string; full_name: string }>(`
      select v.owner_id, v.full_name
      from public.visitors v
      join public.office_visits ov on ov.visitor_id = v.id
      where ov.id = '${visitId}';
    `);
    expect(visitorRecord.rows.length).toBe(1);
    expect(visitorRecord.rows[0].owner_id).toBe(visitorUserId);
    expect(visitorRecord.rows[0].owner_id).not.toBe(staffUserId);

    // Verify decided_by records staffUserId
    const visitRecord = await db.query<{ decided_by: string; approval_status: string }>(`
      select decided_by, approval_status from public.office_visits where id = '${visitId}';
    `);
    expect(visitRecord.rows[0].decided_by).toBe(staffUserId);
    expect(visitRecord.rows[0].approval_status).toBe('approved');

    // Verify upload intent is now CLAIMED and held_until released
    const intentAfterApprove = await db.query<{ held_until: string | null; status: string }>(`
      select held_until, status from public.upload_intents where id = '${intentId}';
    `);
    expect(intentAfterApprove.rows[0].status).toBe('claimed');
    expect(intentAfterApprove.rows[0].held_until).toBeNull();

    // Verify email outbox record was inserted with encrypted payload
    const outboxRecord = await db.query<{ encrypted_token_payload: string; recipient_email: string; delivery_status: string }>(`
      select encrypted_token_payload, recipient_email, delivery_status
      from public.office_visit_email_outbox
      where office_visit_id = '${visitId}';
    `);
    expect(outboxRecord.rows.length).toBe(1);
    expect(outboxRecord.rows[0].encrypted_token_payload).toBe('c2VjdXJlX2VuY3J5cHRlZF9xcl9wYXlsb2Fk');
    expect(outboxRecord.rows[0].recipient_email).toBe('visitor@test.local');
    expect(outboxRecord.rows[0].delivery_status).toBe('pending');
  }, 60000);
});
