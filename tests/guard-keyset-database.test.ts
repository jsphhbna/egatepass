import { describe, it, expect } from 'vitest';
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

describe('Guard Keyset Pagination Database Contracts & Mutation Invariants (PGlite)', () => {
  const GUARD_UID = '00000000-0000-4000-b000-000000000088';
  const VISITOR_OWNER = '00000000-0000-4000-e000-000000000088';

  async function asGuard(db: PGlite) {
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${GUARD_UID}", "role": "authenticated", "amr": [{"method": "password"}]}';
    `);
  }

  async function setupGuardAndOwner(db: PGlite, guardEmail = 'keyset-guard@example.com') {
    await db.exec(`
      reset role;
      insert into auth.users (id, email, encrypted_password, email_confirmed_at)
      values ('${GUARD_UID}', '${guardEmail}', 'hash', now())
      on conflict (id) do update set email_confirmed_at = now();

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Keyset Guard', 'guard', true, false, now())
      on conflict (user_id) do update set active = true, must_change_password = false, privacy_accepted_at = now();

      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${VISITOR_OWNER}', 'visitor-owner@example.com', true, now())
      on conflict (id) do update set email_confirmed_at = now();
    `);
  }

  it('PATCH 30. Keyset Mutation Test: Deleting row #10 between page 1 and page 2 preserves row #201 on page 2 (proves keyset immunity to offset shift)', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db);

    // Seed 260 pending passes with deterministic entry_scanned_at and id
    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
        v_vis_id uuid;
        v_pass_id uuid;
        i integer;
        hex text;
      begin
        for i in 1..260 loop
          hex := lpad(to_hex(i), 12, '0');
          v_vis_id := ('00000000-0000-4000-a000-' || hex)::uuid;
          v_pass_id := ('00000000-0000-4000-d000-' || hex)::uuid;

          insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
          values (v_vis_id, '${VISITOR_OWNER}', 'portal', 'Visitor ' || i, '09123456789', 'vis' || i || '@test.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

          insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
          values (
            v_pass_id,
            v_vis_id,
            decode(lpad(to_hex(i), 64, '0'), 'hex'),
            'portal',
            'pending',
            v_day_start + interval '1 hour',
            v_day_end - interval '1 minute',
            v_day_start + (i * interval '10 seconds'),
            'Gate 1',
            v_day_start + interval '1 hour'
          );
        end loop;
      end $$;
    `);

    await asGuard(db);

    // 1. Fetch Page 1: requested_limit 200, cursor null
    const resPage1 = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(200, null, null) as guard_dashboard_page;'
    );
    const page1 = resPage1.rows[0].guard_dashboard_page;

    expect(page1.queue).toHaveLength(200);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.pendingTotal).toBe(260);

    const cursor = page1.nextCursor;
    const lastItemPage1 = page1.queue[199];
    expect(cursor.id).toBe(lastItemPage1.id);
    expect(cursor.scannedAt).toBe(lastItemPage1.scannedAt);

    // Record what pass #201 is before any mutation:
    const pass201Id = '00000000-0000-4000-d000-0000000000c9'; // 201 in hex is 0xc9

    // 2. Simulate concurrent Guard approval/deletion of row #10 from Page 1:
    const row10Id = '00000000-0000-4000-d000-00000000000a'; // 10 in hex is 0x0a
    await db.exec(`
      reset role;
      update public.passes
      set status = 'inside', time_in = now(), updated_at = now()
      where id = '${row10Id}';
    `);

    await asGuard(db);

    // In an OFFSET-based query, querying offset 200 now skips pass #201 because the list shifted by -1.
    // Verify what offset 200 on api.guard_dashboard would return:
    const resOffset = await db.query<{ guard_dashboard: any }>(
      'select api.guard_dashboard(200, 200) as guard_dashboard;'
    );
    const offsetQueue = resOffset.rows[0].guard_dashboard.queue;
    // With offset 200 on a 259-row queue, pass #201 was at index 200 (offset 200), but now pass #202 is at index 200!
    // Offset pagination skips pass #201:
    expect(offsetQueue[0].id).not.toBe(pass201Id); // Demonstrates the OFFSET flaw!

    // 3. Now verify KEYSET pagination using cursor:
    const resPage2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(200, '${cursor.scannedAt}'::timestamptz, '${cursor.id}'::uuid) as guard_dashboard_page;`
    );
    const page2 = resPage2.rows[0].guard_dashboard_page;

    // Keyset pagination guarantees pass #201 is NOT skipped!
    expect(page2.queue[0].id).toBe(pass201Id);
    expect(page2.queue).toHaveLength(60); // 201..260 = 60 items
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    expect(page2.pendingTotal).toBe(259); // 260 - 1
  }, 60000);

  it('PATCH 31. Keyset Insertion Test: Newly inserted pass after cursor appears in page 2; pass before cursor does not shift boundary', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db, 'keyset-guard2@example.com');

    // Seed 10 passes: 1..5 for page 1, 6..10 for page 2
    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
        i integer;
        hex text;
      begin
        for i in 1..10 loop
          hex := lpad(to_hex(i), 12, '0');
          insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
          values (('00000000-0000-4000-a000-' || hex)::uuid, '${VISITOR_OWNER}', 'portal', 'V ' || i, '09123456789', 'v' || i || '@test.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

          insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
          values (
            ('00000000-0000-4000-d000-' || hex)::uuid,
            ('00000000-0000-4000-a000-' || hex)::uuid,
            decode(lpad(to_hex(i), 64, '0'), 'hex'),
            'portal',
            'pending',
            v_day_start + interval '1 hour',
            v_day_end - interval '1 minute',
            v_day_start + (i * interval '1 minute'),
            'Gate 1',
            v_day_start + interval '1 hour'
          );
        end loop;
      end $$;
    `);

    await asGuard(db);

    // Fetch page 1 with limit 5
    const res1 = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(5, null, null) as guard_dashboard_page;'
    );
    const p1 = res1.rows[0].guard_dashboard_page;
    expect(p1.queue).toHaveLength(5);
    const cursor = p1.nextCursor;

    // Insert pass BEFORE cursor (scanned at minute 2.5):
    await db.exec(`
      reset role;
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
      begin
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values ('00000000-0000-4000-a000-0000000000aa', '${VISITOR_OWNER}', 'portal', 'V Early', '09123456789', 'early@test.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
        values ('00000000-0000-4000-d000-0000000000aa', '00000000-0000-4000-a000-0000000000aa', decode(repeat('aa', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_day_start + interval '2 minutes 30 seconds', 'Gate 1', v_day_start + interval '1 hour');
      end $$;
    `);

    await asGuard(db);

    // Fetch page 2 using cursor
    const res2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(5, '${cursor.scannedAt}'::timestamptz, '${cursor.id}'::uuid) as guard_dashboard_page;`
    );
    const p2 = res2.rows[0].guard_dashboard_page;

    // Page 2 still starts at pass #6! It is NOT shifted or duplicated by the earlier insertion!
    expect(p2.queue[0].id).toBe('00000000-0000-4000-d000-000000000006');
    expect(p2.queue).toHaveLength(5); // passes 6..10
  }, 60000);

  it('PATCH 32. Same-Timestamp UUID Tie Break: Deterministic ordering across page boundaries when entry_scanned_at is identical', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db, 'keyset-guard3@example.com');

    // Seed 4 passes with IDENTICAL entry_scanned_at but distinct UUIDs:
    // ID_A < ID_B < ID_C < ID_D
    const ID_A = '00000000-0000-4000-d000-000000000001';
    const ID_B = '00000000-0000-4000-d000-000000000002';
    const ID_C = '00000000-0000-4000-d000-000000000003';
    const ID_D = '00000000-0000-4000-d000-000000000004';

    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
        v_ts timestamptz := v_day_start + interval '2 hours';
      begin
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values
          ('00000000-0000-4000-a000-000000000001', '${VISITOR_OWNER}', 'portal', 'V1', '09123456781', 'v1@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now()),
          ('00000000-0000-4000-a000-000000000002', '${VISITOR_OWNER}', 'portal', 'V2', '09123456782', 'v2@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now()),
          ('00000000-0000-4000-a000-000000000003', '${VISITOR_OWNER}', 'portal', 'V3', '09123456783', 'v3@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now()),
          ('00000000-0000-4000-a000-000000000004', '${VISITOR_OWNER}', 'portal', 'V4', '09123456784', 'v4@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
        values
          ('${ID_D}', '00000000-0000-4000-a000-000000000004', decode(repeat('44', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_ts, 'Gate 1', v_day_start + interval '1 hour'),
          ('${ID_B}', '00000000-0000-4000-a000-000000000002', decode(repeat('22', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_ts, 'Gate 1', v_day_start + interval '1 hour'),
          ('${ID_A}', '00000000-0000-4000-a000-000000000001', decode(repeat('11', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_ts, 'Gate 1', v_day_start + interval '1 hour'),
          ('${ID_C}', '00000000-0000-4000-a000-000000000003', decode(repeat('33', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_ts, 'Gate 1', v_day_start + interval '1 hour');
      end $$;
    `);

    await asGuard(db);

    // Fetch Page 1: limit 2
    const res1 = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(2, null, null) as guard_dashboard_page;'
    );
    const p1 = res1.rows[0].guard_dashboard_page;
    expect(p1.queue).toHaveLength(2);
    expect(p1.queue[0].id).toBe(ID_A);
    expect(p1.queue[1].id).toBe(ID_B);
    expect(p1.hasMore).toBe(true);

    const cursor = p1.nextCursor;
    expect(cursor.id).toBe(ID_B);

    // Fetch Page 2: limit 2 with cursor
    const res2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(2, '${cursor.scannedAt}'::timestamptz, '${cursor.id}'::uuid) as guard_dashboard_page;`
    );
    const p2 = res2.rows[0].guard_dashboard_page;
    expect(p2.queue).toHaveLength(2);
    expect(p2.queue[0].id).toBe(ID_C);
    expect(p2.queue[1].id).toBe(ID_D);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextCursor).toBeNull();
  }, 60000);

  it('PATCH 33. Null Timestamp Compatibility: Non-null passes sort before null-timestamp passes; nulls sort last by ID', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db, 'keyset-guard4@example.com');

    const ID_SCANNED = '00000000-0000-4000-d000-000000000001';
    const ID_NULL_1 = '00000000-0000-4000-d000-000000000002';
    const ID_NULL_2 = '00000000-0000-4000-d000-000000000003';

    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
      begin
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values
          ('00000000-0000-4000-a000-000000000001', '${VISITOR_OWNER}', 'portal', 'Scanned', '09123456781', 's@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now()),
          ('00000000-0000-4000-a000-000000000002', '${VISITOR_OWNER}', 'portal', 'Null1', '09123456782', 'n1@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now()),
          ('00000000-0000-4000-a000-000000000003', '${VISITOR_OWNER}', 'portal', 'Null2', '09123456783', 'n2@t.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
        values
          ('${ID_NULL_2}', '00000000-0000-4000-a000-000000000003', decode(repeat('33', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', null, null, v_day_start + interval '1 hour'),
          ('${ID_SCANNED}', '00000000-0000-4000-a000-000000000001', decode(repeat('11', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', v_day_start + interval '1 hour', 'Gate 1', v_day_start + interval '1 hour'),
          ('${ID_NULL_1}', '00000000-0000-4000-a000-000000000002', decode(repeat('22', 32), 'hex'), 'portal', 'pending', v_day_start + interval '1 hour', v_day_end - interval '1 minute', null, null, v_day_start + interval '1 hour');
      end $$;
    `);

    await asGuard(db);

    // Page 1: limit 2
    const res1 = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(2, null, null) as guard_dashboard_page;'
    );
    const p1 = res1.rows[0].guard_dashboard_page;
    expect(p1.queue).toHaveLength(2);
    expect(p1.queue[0].id).toBe(ID_SCANNED);
    expect(p1.queue[1].id).toBe(ID_NULL_1);
    expect(p1.hasMore).toBe(true);

    const cursor = p1.nextCursor;
    expect(cursor.scannedAt).toBeNull();
    expect(cursor.id).toBe(ID_NULL_1);

    // Page 2: with null-scanned cursor
    const res2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(2, null, '${cursor.id}'::uuid) as guard_dashboard_page;`
    );
    const p2 = res2.rows[0].guard_dashboard_page;
    expect(p2.queue).toHaveLength(1);
    expect(p2.queue[0].id).toBe(ID_NULL_2);
    expect(p2.hasMore).toBe(false);
  }, 60000);

  it('DATABASE RPC INVARIANTS: Recovery session confinement and role authorization on api.guard_dashboard_page', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    // 1. Anon / unauthenticated caller fails
    await db.exec('set role anon;');
    await expect(
      db.query('select api.guard_dashboard_page(50, null, null);')
    ).rejects.toThrow();

    // 2. Recovery session is forbidden
    const RECOVERY_UID = '00000000-0000-4000-b000-000000000099';
    await db.exec(`
      reset role;
      insert into auth.users (id, email, encrypted_password)
      values ('${RECOVERY_UID}', 'rec@example.com', 'hash')
      on conflict (id) do nothing;

      insert into public.staff_profiles (user_id, display_name, role)
      values ('${RECOVERY_UID}', 'Recovery Staff', 'guard')
      on conflict (user_id) do nothing;

      set role authenticated;
      set request.jwt.claims = '{"sub": "${RECOVERY_UID}", "role": "authenticated", "amr": [{"method": "recovery"}]}';
    `);

    await expect(
      db.query('select api.guard_dashboard_page(50, null, null);')
    ).rejects.toThrow(/recovery_session_forbidden/);
  }, 60000);

  it('PATCH 39. Equal-Count Mutation Test: approve one visitor from page 1 + scan new visitor after snapshot preserves live pendingTotal but snapshotPendingTotal drops (detects mutation)', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db, 'keyset-guard5@example.com');

    // Seed 450 passes
    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
        i integer;
        hex text;
        v_vis_id uuid;
        v_pass_id uuid;
      begin
        for i in 1..450 loop
          hex := lpad(to_hex(i), 12, '0');
          v_vis_id := ('00000000-0000-4000-a000-' || hex)::uuid;
          v_pass_id := ('00000000-0000-4000-d000-' || hex)::uuid;

          insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
          values (v_vis_id, '${VISITOR_OWNER}', 'portal', 'Visitor ' || i, '09123456789', 'v' || i || '@test.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

          insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
          values (
            v_pass_id,
            v_vis_id,
            decode(lpad(to_hex(i), 64, '0'), 'hex'),
            'portal',
            'pending',
            v_day_start + interval '1 hour',
            v_day_end - interval '1 minute',
            v_day_start + (i * interval '10 seconds'),
            'Gate 1',
            v_day_start + interval '1 hour'
          );
        end loop;
      end $$;
    `);

    await asGuard(db);

    // Fetch page 1 (200 rows) with queue_snapshot_at = null
    const res1 = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(200, null, null, null) as guard_dashboard_page;'
    );
    const p1 = res1.rows[0].guard_dashboard_page;
    expect(p1.queue).toHaveLength(200);
    expect(p1.pendingTotal).toBe(450);
    expect(p1.snapshotPendingTotal).toBe(450);
    const snapshotAt = p1.snapshotAt;
    const cursor = p1.nextCursor;

    // Mutate queue concurrently:
    // 1. Approve pass #1 from page 1 (status becomes 'inside')
    const pass1Id = '00000000-0000-4000-d000-000000000001';
    await db.exec(`
      reset role;
      update public.passes
      set status = 'inside', time_in = now(), updated_at = now()
      where id = '${pass1Id}';

      -- 2. Scan a NEW pass (visitor 451) AFTER the snapshot timestamp
      insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
      values ('00000000-0000-4000-a000-000000000451', '${VISITOR_OWNER}', 'portal', 'Visitor 451', '09123456789', 'v451@test.com', 'Meeting', now()::date, now());

      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
      values (
        '00000000-0000-4000-d000-000000000451',
        '00000000-0000-4000-a000-000000000451',
        decode(lpad(to_hex(451), 64, '0'), 'hex'),
        'portal',
        'pending',
        now(),
        now() + interval '1 day',
        '${snapshotAt}'::timestamptz + interval '1 second',
        'Gate 1',
        now()
      );
    `);

    await asGuard(db);

    // Fetch page 2 using cursor and pinning snapshotAt
    const res2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(200, '${cursor.scannedAt}'::timestamptz, '${cursor.id}'::uuid, '${snapshotAt}'::timestamptz) as guard_dashboard_page;`
    );
    const p2 = res2.rows[0].guard_dashboard_page;

    // Live pendingTotal remains 450 (450 - 1 + 1 = 450)!
    expect(p2.pendingTotal).toBe(450);

    // BUT snapshotPendingTotal drops to 449 because the newly scanned pass was after snapshot!
    expect(p2.snapshotPendingTotal).toBe(449);
    // Equal-count mutation is authoritatively detected by snapshotPendingTotal!
    expect(p2.snapshotPendingTotal).not.toBe(p1.snapshotPendingTotal);
  }, 60000);

  it('PATCH 40. Snapshot Insert Test: Pass inserted after snapshotAt is excluded from current traversal, but appears on next fresh traversal', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    await setupGuardAndOwner(db, 'keyset-guard6@example.com');

    // Seed 5 passes
    await db.exec(`
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
        i integer;
        hex text;
      begin
        for i in 1..5 loop
          hex := lpad(to_hex(i), 12, '0');
          insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
          values (('00000000-0000-4000-a000-' || hex)::uuid, '${VISITOR_OWNER}', 'portal', 'V ' || i, '09123456789', 'v' || i || '@test.com', 'Meeting', (v_day_start at time zone 'Asia/Manila')::date, now());

          insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
          values (
            ('00000000-0000-4000-d000-' || hex)::uuid,
            ('00000000-0000-4000-a000-' || hex)::uuid,
            decode(lpad(to_hex(i), 64, '0'), 'hex'),
            'portal',
            'pending',
            v_day_start + interval '1 hour',
            v_day_end - interval '1 minute',
            v_day_start + (i * interval '1 minute'),
            'Gate 1',
            v_day_start + interval '1 hour'
          );
        end loop;
      end $$;
    `);

    await asGuard(db);

    // Fetch page 1 (limit 2) with queue_snapshot_at pinned to minute 5.5
    const res1 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(2, null, null, (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila' + interval '5 minutes 30 seconds')::timestamptz) as guard_dashboard_page;`
    );
    const p1 = res1.rows[0].guard_dashboard_page;
    expect(p1.queue).toHaveLength(2);
    const snapshotAt = p1.snapshotAt;
    const cursor = p1.nextCursor;

    // Insert pass #6 scanned at minute 6 (which is AFTER snapshotAt at 5.5 minutes, but before statement_timestamp)
    const PASS6_ID = '00000000-0000-4000-d000-000000000006';
    await db.exec(`
      reset role;
      do $$
      declare
        v_day_start timestamptz := date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
        v_day_end timestamptz := (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila';
      begin
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values ('00000000-0000-4000-a000-000000000006', '${VISITOR_OWNER}', 'portal', 'V 6 Post-Snapshot', '09123456789', 'v6@test.com', 'Meeting', now()::date, now());

        insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, gate, issued_at)
        values (
          '${PASS6_ID}',
          '00000000-0000-4000-a000-000000000006',
          decode(lpad(to_hex(6), 64, '0'), 'hex'),
          'portal',
          'pending',
          v_day_start + interval '1 hour',
          v_day_end - interval '1 minute',
          v_day_start + interval '6 minutes',
          'Gate 1',
          v_day_start + interval '1 hour'
        );
      end $$;
    `);

    await asGuard(db);

    // Fetch page 2 (limit 10) pinning snapshotAt
    const res2 = await db.query<{ guard_dashboard_page: any }>(
      `select api.guard_dashboard_page(10, '${cursor.scannedAt}'::timestamptz, '${cursor.id}'::uuid, '${snapshotAt}'::timestamptz) as guard_dashboard_page;`
    );
    const p2 = res2.rows[0].guard_dashboard_page;

    // Page 2 contains passes 3, 4, 5 (3 passes). Pass #6 must NOT appear!
    expect(p2.queue).toHaveLength(3);
    expect(p2.queue.some((p: any) => p.id === PASS6_ID)).toBe(false);

    // Now start a fresh traversal with queue_snapshot_at = null
    const resFresh = await db.query<{ guard_dashboard_page: any }>(
      'select api.guard_dashboard_page(10, null, null, null) as guard_dashboard_page;'
    );
    const pFresh = resFresh.rows[0].guard_dashboard_page;
    // On fresh traversal, Pass #6 DOES appear!
    expect(pFresh.queue.some((p: any) => p.id === PASS6_ID)).toBe(true);
    expect(pFresh.pendingTotal).toBe(6);
  }, 60000);
});
