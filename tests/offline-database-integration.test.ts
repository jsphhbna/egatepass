import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
        '00000000-0000-4000-a000-000000000001'::uuid
      );
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'authenticated'::text
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

async function applyAllMigrations(db: PGlite): Promise<void> {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
}

describe('Offline Database Integration & Lifecycle Invariants (DB-T01 - DB-T10)', () => {
  let db: PGlite;
  const GUARD_ID = '00000000-0000-4000-a000-000000000001';

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    // Seed Guard user in superuser context
    await db.exec(`
      reset role;
      insert into auth.users (id, email, raw_user_meta_data)
      values ('${GUARD_ID}', 'guard@earist.edu.ph', '{"role": "guard"}')
      on conflict (id) do nothing;

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_ID}', 'Officer Gate 1', 'guard', true, false, now())
      on conflict (user_id) do update set active = true, must_change_password = false, privacy_accepted_at = now();
    `);
  }, 60000);

  async function asGuard() {
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${GUARD_ID}", "role": "authenticated"}';
    `);
  }

  // DB-T01: Valid offline approved registration
  it('DB-T01: executes valid approved offline registration with correct schema and evidence', async () => {
    const regId = '11111111-1111-4000-8000-111111111111';
    const photoIntent = '22222222-2222-4000-8000-222222222222';
    const idIntent = '33333333-3333-4000-8000-333333333333';
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values
        ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p1.webp', 'image/webp', now() + interval '1 hour'),
        ('${idIntent}', '${GUARD_ID}', 'guard_offline', 'id', 'visitor-ids', 'guards/i1.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    const res = await db.query<{ guard_sync_offline_registration: any }>(`
      select api.guard_sync_offline_registration(
        '${regId}'::uuid,
        '{"firstName": "Juan", "middleName": "Protacio", "lastName": "Dela Cruz", "contactNumber": "09171234567", "email": "juan@example.com", "purpose": "Registrar Records Request", "visitDate": "2026-10-27"}'::jsonb,
        'approved'::text,
        '${occurredAt}'::timestamptz,
        '${photoIntent}'::uuid,
        54321::integer,
        'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'::text,
        '${idIntent}'::uuid,
        98765::integer,
        'efef5678efef5678efef5678efef5678efef5678efef5678efef5678efef5678'::text,
        null::text
      );
    `);

    const result = res.rows[0]?.guard_sync_offline_registration;
    expect(result.status).toBe('applied');
    expect(result.passStatus).toBe('approved' === 'approved' ? 'inside' : 'rejected');
    expect(result.visitorId).toBeDefined();
    expect(result.passId).toBeDefined();

    await db.exec('reset role;');
    const vRows = await db.query<any>(`select * from public.visitors where id = '${result.visitorId}'`);
    expect(vRows.rows.length).toBe(1);
    expect(vRows.rows[0].source).toBe('guard_offline');
    expect(vRows.rows[0].full_name).toBe('Juan Protacio Dela Cruz');
    expect(new Date(vRows.rows[0].visit_date).toISOString().slice(0, 10)).toBe('2026-10-27');
    expect(vRows.rows[0].consent_accepted_at).not.toBeNull();
    expect(vRows.rows[0].owner_id).toBe(GUARD_ID);

    const pRows = await db.query<any>(`select * from public.passes where id = '${result.passId}'`);
    expect(pRows.rows.length).toBe(1);
    expect(pRows.rows[0].status).toBe('inside');
    expect(new Date(pRows.rows[0].time_in).toISOString()).toBe(new Date(occurredAt).toISOString());
    expect(pRows.rows[0].offline_registration_id).toBe(regId);

    const eRows = await db.query<any>(`select * from public.visitor_evidence where visitor_id = '${result.visitorId}'`);
    expect(eRows.rows.length).toBe(2);
    const photoRow = eRows.rows.find((r) => r.kind === 'photo');
    const idRow = eRows.rows.find((r) => r.kind === 'id');
    expect(photoRow.byte_size).toBe(54321);
    expect(photoRow.sha256_hex).toBe('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
    expect(idRow.byte_size).toBe(98765);

    const rRows = await db.query<any>(`select * from public.offline_sync_receipts where offline_registration_id = '${regId}'`);
    expect(rRows.rows.length).toBe(1);
    expect(rRows.rows[0].fingerprint).toBeDefined();
  });

  // DB-T02: Rejected offline registration
  it('DB-T02: records rejected offline registration with null time_in and preserved reason', async () => {
    const regId = '44444444-4444-4000-8000-444444444444';
    const photoIntent = '55555555-5555-4000-8000-555555555555';
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p2.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    const res = await db.query<{ guard_sync_offline_registration: any }>(`
      select api.guard_sync_offline_registration(
        '${regId}'::uuid,
        '{"firstName": "Bad", "lastName": "Actor", "contactNumber": "09170000000", "purpose": "Unauthorized Solicitation", "visitDate": "2026-10-27"}'::jsonb,
        'rejected'::text,
        '${occurredAt}'::timestamptz,
        '${photoIntent}'::uuid,
        12345::integer,
        '1111222233334444111122223333444411112222333344441111222233334444'::text,
        null::uuid,
        null::integer,
        null::text,
        'Visitor possessed no valid ID and refused identification'::text
      );
    `);

    const result = res.rows[0]?.guard_sync_offline_registration;
    expect(result.status).toBe('applied');
    expect(result.passStatus).toBe('rejected');

    await db.exec('reset role;');
    const pRows = await db.query<any>(`select * from public.passes where id = '${result.passId}'`);
    expect(pRows.rows[0].status).toBe('rejected');
    expect(pRows.rows[0].time_in).toBeNull();
    expect(pRows.rows[0].rejection_reason).toBe('Visitor possessed no valid ID and refused identification');
  });

  // DB-T03: Same ID same payload retry (Idempotent)
  it('DB-T03: returns identical canonical pass without duplicating rows on same payload retry', async () => {
    const regId = '66666666-6666-4000-8000-666666666666';
    const photoIntent = '77777777-7777-4000-8000-777777777777';
    const idIntent = '88888888-8888-4000-8000-888888888888';
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values
        ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p3.webp', 'image/webp', now() + interval '1 hour'),
        ('${idIntent}', '${GUARD_ID}', 'guard_offline', 'id', 'visitor-ids', 'guards/i3.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    const payload = `
      '${regId}'::uuid,
      '{"firstName": "Maria", "lastName": "Clara", "contactNumber": "09191234567", "purpose": "Faculty Meeting", "visitDate": "2026-10-27"}'::jsonb,
      'approved'::text,
      '${occurredAt}'::timestamptz,
      '${photoIntent}'::uuid,
      20000::integer,
      'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'::text,
      '${idIntent}'::uuid,
      40000::integer,
      'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'::text,
      null::text
    `;

    const first = await db.query<{ guard_sync_offline_registration: any }>(
      `select api.guard_sync_offline_registration(${payload});`
    );
    const second = await db.query<{ guard_sync_offline_registration: any }>(
      `select api.guard_sync_offline_registration(${payload});`
    );

    expect(first.rows[0].guard_sync_offline_registration.passId).toBe(
      second.rows[0].guard_sync_offline_registration.passId
    );
    expect(first.rows[0].guard_sync_offline_registration.visitorId).toBe(
      second.rows[0].guard_sync_offline_registration.visitorId
    );

    await db.exec('reset role;');
    const vCount = await db.query<any>(`select count(*)::int as count from public.visitors where contact_number = '09191234567'`);
    expect(vCount.rows[0].count).toBe(1);
  });

  // DB-T04: Same ID modified payload
  it('DB-T04: detects fingerprint mismatch on modified payload and records reconciliation task', async () => {
    const regId = '99999999-9999-4000-8000-999999999999';
    const photoIntent = 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa';
    const idIntent = 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb';
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values
        ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p4.webp', 'image/webp', now() + interval '1 hour'),
        ('${idIntent}', '${GUARD_ID}', 'guard_offline', 'id', 'visitor-ids', 'guards/i4.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    // First submission: Juan Dela Cruz
    await db.query(`
      select api.guard_sync_offline_registration(
        '${regId}'::uuid,
        '{"firstName": "Juan", "lastName": "Dela Cruz", "contactNumber": "09171112222", "purpose": "Inquiry", "visitDate": "2026-10-27"}'::jsonb,
        'approved'::text,
        '${occurredAt}'::timestamptz,
        '${photoIntent}'::uuid,
        10000::integer,
        'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333'::text,
        '${idIntent}'::uuid,
        20000::integer,
        'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444'::text,
        null::text
      );
    `);

    // Modified submission with same registration ID: Different Person
    const modifiedRes = await db.query<{ guard_sync_offline_registration: any }>(`
      select api.guard_sync_offline_registration(
        '${regId}'::uuid,
        '{"firstName": "Different", "lastName": "Person", "contactNumber": "09998887766", "purpose": "Tampered", "visitDate": "2026-10-27"}'::jsonb,
        'approved'::text,
        '${occurredAt}'::timestamptz,
        '${photoIntent}'::uuid,
        10000::integer,
        'cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333'::text,
        '${idIntent}'::uuid,
        20000::integer,
        'dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444'::text,
        null::text
      );
    `);

    const result = modifiedRes.rows[0].guard_sync_offline_registration;
    expect(result.status).toBe('conflict');
    expect(result.reason).toBe('modified_payload_conflict');

    await db.exec('reset role;');
    const reconRows = await db.query<any>(`
      select * from public.reconciliation_tasks
      where reference_id = '${regId}' and operation = 'offline_registration_payload_conflict'
    `);
    expect(reconRows.rows.length).toBe(1);
    expect(reconRows.rows[0].reference_type).toBe('offline_registration');
    expect(reconRows.rows[0].last_error_code).toBe('modified_payload_conflict');
  });

  // DB-T05: Illegal lifecycle resurrection (exited -> approve_entry)
  it('DB-T05: rejects illegal lifecycle resurrection from exited state', async () => {
    await db.exec(`
      reset role;
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('00000000-0000-4000-c000-000000000005', '${GUARD_ID}', 'guard_offline', 'Exited Visitor', '09175555555', 'Test', '2026-10-27', now());

      insert into public.passes (id, visitor_id, source, token_digest, status, version, valid_from, valid_until, time_in, time_out)
      values ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-c000-000000000005', 'guard_offline', sha256('token5'::bytea), 'exited', 3, now() - interval '2 hours', now() + interval '8 hours', now() - interval '2 hours', now() - interval '1 hour');
    `);

    await asGuard();
    const eventId = 'eeeeeeee-eeee-4000-8000-eeeeeeeeeeee';
    const res = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}'::uuid,
        '00000000-0000-4000-d000-000000000005'::uuid,
        'approve_entry'::text,
        'exited'::text,
        3::integer,
        now()::timestamptz,
        null::text
      );
    `);

    const result = res.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('conflict');
    expect(result.reason).toBe('illegal_status_transition');

    await db.exec('reset role;');
    const passCheck = await db.query<any>(`select status from public.passes where id = '00000000-0000-4000-d000-000000000005'`);
    expect(passCheck.rows[0].status).toBe('exited');
  });

  // DB-T06: Invalid exit (issued -> record_exit)
  it('DB-T06: rejects invalid exit transition from issued state', async () => {
    await db.exec(`
      reset role;
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('00000000-0000-4000-c000-000000000006', '${GUARD_ID}', 'guard_offline', 'Issued Visitor', '09176666666', 'Test', '2026-10-27', now());

      insert into public.passes (id, visitor_id, source, token_digest, status, version, valid_from, valid_until)
      values ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-c000-000000000006', 'guard_offline', sha256('token6'::bytea), 'issued', 1, now() - interval '1 hour', now() + interval '8 hours');
    `);

    await asGuard();
    const eventId = 'ffffffff-ffff-4000-8000-ffffffffffff';
    const res = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}'::uuid,
        '00000000-0000-4000-d000-000000000006'::uuid,
        'record_exit'::text,
        'issued'::text,
        1::integer,
        now()::timestamptz,
        null::text
      );
    `);

    const result = res.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('conflict');
    expect(result.reason).toBe('illegal_status_transition');

    await db.exec('reset role;');
    const passCheck = await db.query<any>(`select status from public.passes where id = '00000000-0000-4000-d000-000000000006'`);
    expect(passCheck.rows[0].status).toBe('issued');
  });

  // DB-T07: Version conflict
  it('DB-T07: detects stale version conflict even if status matches', async () => {
    await db.exec(`
      reset role;
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('00000000-0000-4000-c000-000000000007', '${GUARD_ID}', 'guard_offline', 'Stale Visitor', '09177777777', 'Test', '2026-10-27', now());

      insert into public.passes (id, visitor_id, source, token_digest, status, version, valid_from, valid_until)
      values ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-c000-000000000007', 'guard_offline', sha256('token7'::bytea), 'issued', 5, now() - interval '1 hour', now() + interval '8 hours');
    `);

    await asGuard();
    const eventId = '12121212-1212-4000-8000-121212121212';
    const res = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}'::uuid,
        '00000000-0000-4000-d000-000000000007'::uuid,
        'approve_entry'::text,
        'issued'::text,
        4::integer, -- Stale client version 4 when server is at version 5
        now()::timestamptz,
        null::text
      );
    `);

    const result = res.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('version_conflict');
  });

  // DB-T08: Reconciliation schema check
  it('DB-T08: asserts reconciliation task uses exact production schema columns', async () => {
    await asGuard();
    const eventId = '88888888-9999-4000-8000-888888889999';
    await db.query(`
      select api.guard_sync_offline_event(
        '${eventId}'::uuid,
        '00000000-0000-4000-d000-000000000007'::uuid,
        'approve_entry'::text,
        'issued'::text,
        1::integer,
        now()::timestamptz,
        null::text
      );
    `);

    await db.exec('reset role;');
    const recon = await db.query<any>(`
      select operation, reference_type, reference_id, safe_context, last_error_code
      from public.reconciliation_tasks
      order by created_at desc
      limit 1;
    `);

    expect(recon.rows.length).toBeGreaterThan(0);
    const row = recon.rows[0];
    expect(row.operation).toBeDefined();
    expect(row.reference_type).toBeDefined();
    expect(row.reference_id).toBeDefined();
    expect(row.safe_context).toBeDefined();
    expect(typeof row.safe_context).toBe('object');
  });

  // DB-T09: Offline registration -> offline exit -> sync
  it('DB-T09: correctly syncs offline registration followed by offline exit with truthful timestamps', async () => {
    const regId = '34343434-3434-4000-8000-343434343434';
    const photoIntent = '56565656-5656-4000-8000-565656565656';
    const idIntent = '78787878-7878-4000-8000-787878787878';
    const timeIn = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const timeOut = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values
        ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p9.webp', 'image/webp', now() + interval '1 hour'),
        ('${idIntent}', '${GUARD_ID}', 'guard_offline', 'id', 'visitor-ids', 'guards/i9.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    // 1. Sync offline registration
    const regRes = await db.query<{ guard_sync_offline_registration: any }>(`
      select api.guard_sync_offline_registration(
        '${regId}'::uuid,
        '{"firstName": "Offline", "lastName": "Visitor", "contactNumber": "09179998888", "purpose": "Campus Tour", "visitDate": "2026-10-27"}'::jsonb,
        'approved'::text,
        '${timeIn}'::timestamptz,
        '${photoIntent}'::uuid,
        15000::integer,
        '9999000099990000999900009999000099990000999900009999000099990000'::text,
        '${idIntent}'::uuid,
        25000::integer,
        '0000999900009999000099990000999900009999000099990000999900009999'::text,
        null::text
      );
    `);

    const passId = regRes.rows[0].guard_sync_offline_registration.passId;

    // 2. Sync offline exit event
    const exitEventId = '90909090-9090-4000-8000-909090909090';
    const exitRes = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${exitEventId}'::uuid,
        '${passId}'::uuid,
        'record_exit'::text,
        'inside'::text,
        1::integer,
        '${timeOut}'::timestamptz,
        'normal_exit'::text
      );
    `);

    expect(exitRes.rows[0].guard_sync_offline_event.status).toBe('applied');

    await db.exec('reset role;');
    const passRow = (await db.query<any>(`select * from public.passes where id = '${passId}'`)).rows[0];
    expect(passRow.status).toBe('exited');
    expect(new Date(passRow.time_in).toISOString()).toBe(new Date(timeIn).toISOString());
    expect(new Date(passRow.time_out).toISOString()).toBe(new Date(timeOut).toISOString());

    const events = (await db.query<any>(`select * from public.visit_events where pass_id = '${passId}' order by occurred_at asc`)).rows;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(new Date(events[0].occurred_at).toISOString()).toBe(new Date(timeIn).toISOString());
    expect(new Date(events[events.length - 1].occurred_at).toISOString()).toBe(new Date(timeOut).toISOString());
  });

  // DB-T10: Evidence tampering / validation checks
  it('DB-T10: rejects offline registration if mandatory ID evidence is missing on approved entry', async () => {
    const regId = 'abababab-abab-4000-8000-abababababab';
    const photoIntent = 'cdcdcdcd-cdcd-4000-8000-cdcdcdcdcdcd';

    await db.exec(`
      reset role;
      insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, expires_at)
      values ('${photoIntent}', '${GUARD_ID}', 'guard_offline', 'photo', 'visitor-photos', 'guards/p10.webp', 'image/webp', now() + interval '1 hour');
    `);

    await asGuard();
    let thrownError: any = null;
    try {
      await db.query(`
        select api.guard_sync_offline_registration(
          '${regId}'::uuid,
          '{"firstName": "NoId", "lastName": "Visitor", "contactNumber": "09171239999", "purpose": "Testing", "visitDate": "2026-10-27"}'::jsonb,
          'approved'::text,
          now()::timestamptz,
          '${photoIntent}'::uuid,
          10000::integer,
          '1234123412341234123412341234123412341234123412341234123412341234'::text,
          null::uuid, -- Missing ID intent on approval
          null::integer,
          null::text,
          null::text
        );
      `);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).not.toBeNull();
    expect(String(thrownError)).toContain('valid_id_evidence_required_for_approval');
  });
});
