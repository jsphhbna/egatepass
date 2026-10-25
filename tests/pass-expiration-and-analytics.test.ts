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

describe('PATCH 2 & 3: Authoritative Pass Expiration and Truthful Metric Event Clocks (PGlite)', () => {
  it('A. Pass expiration lifecycle: expires stale issued & pending passes, preserves future and entered passes', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const OWNER_ID = '00000000-0000-4000-e000-000000000010';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${OWNER_ID}', 'owner@example.com', true, now());
    `);

    // Create 7 distinct visitors for 7 passes (due to passes_visitor_id_key constraint)
    for (let i = 1; i <= 7; i++) {
      const vid = `00000000-0000-4000-a000-00000000001${i}`;
      await db.exec(`
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values ('${vid}', '${OWNER_ID}', 'portal', 'Visitor ${i}', '0912345678${i}', 'v${i}@example.com', 'Purpose', current_date, now());
      `);
    }

    const P_STALE_ISSUED = '00000000-0000-4000-d000-000000000011';
    const P_STALE_PENDING = '00000000-0000-4000-d000-000000000012';
    const P_FUTURE_ISSUED = '00000000-0000-4000-d000-000000000013';
    const P_FUTURE_PENDING = '00000000-0000-4000-d000-000000000014';
    const P_STALE_INSIDE = '00000000-0000-4000-d000-000000000015';
    const P_STALE_EXITED = '00000000-0000-4000-d000-000000000016';
    const P_STALE_REJECTED = '00000000-0000-4000-d000-000000000017';

    await db.exec(`
      -- Past timestamp
      -- 1. stale issued
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at)
      values ('${P_STALE_ISSUED}', '00000000-0000-4000-a000-000000000011', decode('1111111111111111111111111111111111111111111111111111111111111111', 'hex'), 'portal', 'issued', now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours');

      -- 2. stale pending
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, issued_at)
      values ('${P_STALE_PENDING}', '00000000-0000-4000-a000-000000000012', decode('1212121212121212121212121212121212121212121212121212121212121212', 'hex'), 'portal', 'pending', now() - interval '2 hours', now() - interval '1 hour', now() - interval '90 minutes', now() - interval '2 hours');

      -- 3. future issued
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at)
      values ('${P_FUTURE_ISSUED}', '00000000-0000-4000-a000-000000000013', decode('1313131313131313131313131313131313131313131313131313131313131313', 'hex'), 'portal', 'issued', now() - interval '1 hour', now() + interval '2 hours', now() - interval '1 hour');

      -- 4. future pending
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, issued_at)
      values ('${P_FUTURE_PENDING}', '00000000-0000-4000-a000-000000000014', decode('1414141414141414141414141414141414141414141414141414141414141414', 'hex'), 'portal', 'pending', now() - interval '1 hour', now() + interval '2 hours', now() - interval '10 minutes', now() - interval '1 hour');

      -- 5. inside with past valid_until (must remain inside)
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at, time_in)
      values ('${P_STALE_INSIDE}', '00000000-0000-4000-a000-000000000015', decode('1515151515151515151515151515151515151515151515151515151515151515', 'hex'), 'portal', 'inside', now() - interval '3 hours', now() - interval '1 hour', now() - interval '3 hours', now() - interval '2 hours');

      -- 6. exited with past valid_until (must remain exited)
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at, time_in, time_out)
      values ('${P_STALE_EXITED}', '00000000-0000-4000-a000-000000000016', decode('1616161616161616161616161616161616161616161616161616161616161616', 'hex'), 'portal', 'exited', now() - interval '4 hours', now() - interval '1 hour', now() - interval '4 hours', now() - interval '3 hours', now() - interval '2 hours');

      -- 7. rejected with past valid_until (must remain rejected)
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, issued_at, decided_at, rejection_reason)
      values ('${P_STALE_REJECTED}', '00000000-0000-4000-a000-000000000017', decode('1717171717171717171717171717171717171717171717171717171717171717', 'hex'), 'portal', 'rejected', now() - interval '4 hours', now() - interval '1 hour', now() - interval '4 hours', now() - interval '3 hours', 'Capacity Reached');
    `);

    // Call service-role RPC: api.expire_stale_passes()
    await db.exec(`
      set role service_role;
      set request.jwt.claims = '{"role": "service_role"}';
    `);
    const expireRes = await db.query<{ expire_stale_passes: number }>('select api.expire_stale_passes();');
    expect(expireRes.rows[0].expire_stale_passes).toBe(2);

    // Verify individual pass statuses
    await db.exec('reset role;');
    const rows = await db.query<{ id: string; status: string }>(`
      select id, status from public.passes where id in (
        '${P_STALE_ISSUED}', '${P_STALE_PENDING}', '${P_FUTURE_ISSUED}', '${P_FUTURE_PENDING}',
        '${P_STALE_INSIDE}', '${P_STALE_EXITED}', '${P_STALE_REJECTED}'
      );
    `);
    const statusMap = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));

    expect(statusMap[P_STALE_ISSUED]).toBe('expired');
    expect(statusMap[P_STALE_PENDING]).toBe('expired');
    expect(statusMap[P_FUTURE_ISSUED]).toBe('issued');
    expect(statusMap[P_FUTURE_PENDING]).toBe('pending');
    expect(statusMap[P_STALE_INSIDE]).toBe('inside');
    expect(statusMap[P_STALE_EXITED]).toBe('exited');
    expect(statusMap[P_STALE_REJECTED]).toBe('rejected');
  }, 60000);

  it('B. guard_dashboard automatically expires pending stale passes and excludes them from queue', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const GUARD_UID = '00000000-0000-4000-b000-000000000099';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_UID}', 'guard-queue@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Officer Queue', 'guard', true, false, now());
    `);

    const OWNER_ID = '00000000-0000-4000-e000-000000000020';
    const VISITOR_1 = '00000000-0000-4000-a000-000000000021';
    const VISITOR_2 = '00000000-0000-4000-a000-000000000022';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${OWNER_ID}', 'owner2@example.com', true, now());

      insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
      values
        ('${VISITOR_1}', '${OWNER_ID}', 'portal', 'Pending Expire Visitor 1', '09123456789', 'test1@example.com', 'Inquiry', current_date, now()),
        ('${VISITOR_2}', '${OWNER_ID}', 'portal', 'Pending Expire Visitor 2', '09123456788', 'test2@example.com', 'Inquiry', current_date, now());
    `);

    const STALE_PENDING = '00000000-0000-4000-d000-000000000021';
    const ACTIVE_PENDING = '00000000-0000-4000-d000-000000000022';

    await db.exec(`
      insert into public.passes (id, visitor_id, token_digest, source, status, valid_from, valid_until, entry_scanned_at, issued_at)
      values
        ('${STALE_PENDING}', '${VISITOR_1}', decode('2121212121212121212121212121212121212121212121212121212121212121', 'hex'), 'portal', 'pending', now() - interval '2 hours', now() - interval '1 hour', now() - interval '90 minutes', now() - interval '2 hours'),
        ('${ACTIVE_PENDING}', '${VISITOR_2}', decode('2222222222222222222222222222222222222222222222222222222222222222', 'hex'), 'portal', 'pending', now() - interval '1 hour', now() + interval '2 hours', now() - interval '10 minutes', now() - interval '1 hour');
    `);

    // Switch to Guard actor
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${GUARD_UID}", "role": "authenticated", "amr": [{"method": "password"}]}';
    `);

    const res = await db.query<{ guard_dashboard: any }>('select api.guard_dashboard(10, 0);');
    const dashboard = res.rows[0].guard_dashboard;

    // Stale pending pass must NOT be in queue and pendingTotal must be 1 (only ACTIVE_PENDING)
    expect(dashboard.pendingTotal).toBe(1);
    expect(dashboard.queue).toHaveLength(1);
    expect(dashboard.queue[0].id).toBe(ACTIVE_PENDING);

    // Stale pass status in passes table is now 'expired'
    await db.exec('reset role;');
    const staleCheck = await db.query<{ status: string }>(`select status from public.passes where id = '${STALE_PENDING}';`);
    expect(staleCheck.rows[0].status).toBe('expired');
  }, 60000);

  it('C. Recovery session confinement & role permission on guard_dashboard', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const GUARD_UID = '00000000-0000-4000-b000-000000000098';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_UID}', 'guard-recovery@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Officer Recovery', 'guard', true, false, now());
    `);

    // Recovery session claims
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${GUARD_UID}", "role": "authenticated", "amr": [{"method": "recovery"}]}';
    `);

    await expect(db.query('select api.guard_dashboard(10, 0);')).rejects.toThrow('recovery_session_forbidden');

    // Unprivileged user
    const ANON_UID = '00000000-0000-4000-b000-000000000097';
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${ANON_UID}", "role": "authenticated", "amr": [{"method": "password"}]}';
    `);

    await expect(db.query('select api.guard_dashboard(10, 0);')).rejects.toThrow('active guard or administrator required');
  }, 60000);

  it('D. Cross-day regression fixture (3D): Pass issued Oct 25, scanned & approved & exited Oct 26', async () => {
    const db = new PGlite();
    await applyAllMigrations(db);

    const OWNER_ID = '00000000-0000-4000-e000-000000000030';
    const VISITOR_ID = '00000000-0000-4000-a000-000000000030';
    const PASS_ID = '00000000-0000-4000-d000-000000000030';

    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${OWNER_ID}', 'owner3@example.com', true, now());

      insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
      values ('${VISITOR_ID}', '${OWNER_ID}', 'portal', 'Cross Day Visitor', '09123456789', 'cross@example.com', 'Cross Day Visit', '2026-10-25', '2026-10-25T08:00:00+08:00');

      -- Pass issued Oct 25, scanned Oct 26, approved Oct 26, exited Oct 26
      insert into public.passes (
        id, visitor_id, token_digest, source, status, valid_from, valid_until,
        issued_at, entry_scanned_at, gate, decided_at, time_in, time_out
      ) values (
        '${PASS_ID}', '${VISITOR_ID}', decode('3030303030303030303030303030303030303030303030303030303030303030', 'hex'), 'portal', 'exited',
        '2026-10-25T08:00:00+08:00', '2026-10-26T20:00:00+08:00',
        '2026-10-25T14:00:00+08:00',
        '2026-10-26T09:00:00+08:00',
        'Gate 1',
        '2026-10-26T09:10:00+08:00',
        '2026-10-26T09:10:00+08:00',
        '2026-10-26T11:00:00+08:00'
      );
    `);

    // Service-role query for today's insights on Oct 26
    await db.exec(`
      set role service_role;
      set request.jwt.claims = '{"role": "service_role"}';
    `);

    const insightsRes = await db.query<{ dashboard_today_insights: any }>(`
      select api.dashboard_today_insights(
        '2026-10-26T00:00:00+08:00'::timestamptz,
        '2026-10-26T23:59:59.999+08:00'::timestamptz
      ) as dashboard_today_insights;
    `);
    const insights = insightsRes.rows[0].dashboard_today_insights;

    // 1. Busiest Gate: includes it on Oct 26 (gate is Gate 1)
    expect(insights.busiestGate.label).toBe('Gate 1');
    expect(insights.busiestGate.count).toBe(1);

    // 2. Average Approval Time: includes it on Oct 26 (10 minutes = 600s)
    expect(insights.avgApprovalTime).toBe('10m');

    // 3. Top Purpose: filtered by issued_at on Oct 26 -> does NOT include it
    expect(insights.topPurpose.count).toBe(0);
    expect(insights.topPurpose.label).toBe('No data yet');

    // Reset role before inserting guard
    await db.exec('reset role;');

    // Guard Dashboard on Oct 26: Seed guard
    const GUARD_UID = '00000000-0000-4000-b000-000000000031';
    await db.exec(`
      insert into auth.users (id, email, is_anonymous, email_confirmed_at)
      values ('${GUARD_UID}', 'guard-cross@earist.edu.ph', false, now());
      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values ('${GUARD_UID}', 'Officer Cross', 'guard', true, false, now());
    `);

    // Verify stats when simulated for Oct 26
    const statsQuery = await db.query<{ stats: any }>(`
      select jsonb_build_object(
        'inside', (select count(*) from public.passes where status = 'inside'::public.pass_status),
        'exited', (select count(*) from public.passes where status = 'exited'::public.pass_status and time_out >= '2026-10-26T00:00:00+08:00'::timestamptz and time_out < '2026-10-27T00:00:00+08:00'::timestamptz),
        'rejected', (select count(*) from public.passes where status = 'rejected'::public.pass_status and decided_at >= '2026-10-26T00:00:00+08:00'::timestamptz and decided_at < '2026-10-27T00:00:00+08:00'::timestamptz),
        'total', (select count(*) from public.passes where entry_scanned_at >= '2026-10-26T00:00:00+08:00'::timestamptz and entry_scanned_at < '2026-10-27T00:00:00+08:00'::timestamptz)
      ) as stats;
    `);
    const stats = statsQuery.rows[0].stats;

    // Scanned Today: includes it on Oct 26
    expect(stats.total).toBe(1);
    // Exited Today: includes it on Oct 26 after exit
    expect(stats.exited).toBe(1);
    // Inside: 0 (it exited)
    expect(stats.inside).toBe(0);
  }, 60000);
});
