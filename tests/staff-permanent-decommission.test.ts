import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import decommissionRoute from '../server/routes/system/decommission-user.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

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
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
}

describe('Group J: Production-Backed Staff Permanent Decommission Contract', () => {
  describe('1. Real PostgreSQL / PGlite RPC Contract', () => {
    const SUPERADMIN_A = '11111111-1111-4111-8111-111111111111';
    const INACTIVE_GUARD_B = '22222222-2222-4222-8222-222222222222';
    const ACTIVE_GUARD_C = '33333333-3333-4333-8333-333333333333';
    const INACTIVE_ADMIN_D = '44444444-4444-4444-8444-444444444444';

    it('executes real api.decommission_staff_profile RPC against migrated schema and enforces invariants', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // Verify function definition does not contain invalid device staff_role enum cast
      const funcDefRes = await db.query<{ prosrc: string }>(`
        select p.prosrc
        from pg_proc p
        join pg_namespace n on p.pronamespace = n.oid
        where n.nspname = 'api' and p.proname = 'decommission_staff_profile';
      `);
      expect(funcDefRes.rows.length).toBe(1);
      expect(funcDefRes.rows[0].prosrc).not.toContain("'device'::public.staff_role");

      // Seed staff users in auth.users
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at)
        values
          ('${SUPERADMIN_A}', 'superadmin@earist.edu.ph', now()),
          ('${INACTIVE_GUARD_B}', 'guard_b@earist.edu.ph', now()),
          ('${ACTIVE_GUARD_C}', 'guard_c@earist.edu.ph', now()),
          ('${INACTIVE_ADMIN_D}', 'admin_d@earist.edu.ph', now());
      `);

      // Seed staff_profiles
      await db.exec(`
        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at, created_by)
        values
          ('${SUPERADMIN_A}', 'Super Admin A', 'superadmin', true, false, now(), '${SUPERADMIN_A}'),
          ('${INACTIVE_GUARD_B}', 'Inactive Guard B', 'guard', false, false, now(), '${SUPERADMIN_A}'),
          ('${ACTIVE_GUARD_C}', 'Active Guard C', 'guard', true, false, now(), '${SUPERADMIN_A}'),
          ('${INACTIVE_ADMIN_D}', 'Inactive Admin D', 'admin', false, false, now(), '${SUPERADMIN_A}');
      `);

      const initialStaffCount = await db.query('select count(*) as cnt from public.staff_profiles;');
      expect(Number(initialStaffCount.rows[0].cnt)).toBe(4);

      // Set JWT session for Super Admin A
      await db.exec(`set request.jwt.claims = '{"sub": "${SUPERADMIN_A}", "role": "service_role"}';`);

      // Rule: cannot decommission self
      await expect(
        db.query(`
          select api.decommission_staff_profile(
            '${SUPERADMIN_A}'::uuid,
            'Attempt to decommission self'::text,
            '${SUPERADMIN_A}'::uuid
          );
        `)
      ).rejects.toThrow('cannot_decommission_self');

      // Rule: cannot decommission active staff (Guard C is active)
      await expect(
        db.query(`
          select api.decommission_staff_profile(
            '${ACTIVE_GUARD_C}'::uuid,
            'Attempt to decommission active guard'::text,
            '${SUPERADMIN_A}'::uuid
          );
        `)
      ).rejects.toThrow('target_user_must_be_inactive');

      // Rule: decommissions inactive Guard B successfully
      const decommRes = await db.query<{ decommission_staff_profile: any }>(`
        select api.decommission_staff_profile(
          '${INACTIVE_GUARD_B}'::uuid,
          'Guard resigned and cleared all property.'::text,
          '${SUPERADMIN_A}'::uuid
        );
      `);
      expect(decommRes.rows.length).toBe(1);

      // Verify historical row is preserved (NOT deleted)
      const guardBProfile = await db.query<{
        user_id: string;
        active: boolean;
        decommissioned_at: string;
        decommissioned_by: string;
        decommission_reason: string;
      }>(`
        select user_id, active, decommissioned_at, decommissioned_by, decommission_reason
        from public.staff_profiles
        where user_id = '${INACTIVE_GUARD_B}';
      `);
      expect(guardBProfile.rows.length).toBe(1);
      expect(guardBProfile.rows[0].active).toBe(false);
      expect(guardBProfile.rows[0].decommissioned_at).not.toBeNull();
      expect(guardBProfile.rows[0].decommissioned_by).toBe(SUPERADMIN_A);
      expect(guardBProfile.rows[0].decommission_reason).toBe('Guard resigned and cleared all property.');

      // Verify audit event is recorded
      const auditRes = await db.query<{ action: string; target_id: string; outcome: string }>(`
        select action, target_id, outcome
        from public.audit_events
        where action = 'staff.decommissioned' and target_id = '${INACTIVE_GUARD_B}';
      `);
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].outcome).toBe('success');

      // Rule: cannot decommission already-decommissioned user
      await expect(
        db.query(`
          select api.decommission_staff_profile(
            '${INACTIVE_GUARD_B}'::uuid,
            'Second decommission attempt'::text,
            '${SUPERADMIN_A}'::uuid
          );
        `)
      ).rejects.toThrow('target_already_decommissioned');

      // Rule: total staff row count never decreases (historical data preserved)
      const afterStaffCount = await db.query('select count(*) as cnt from public.staff_profiles;');
      expect(Number(afterStaffCount.rows[0].cnt)).toBe(4);
    }, 35000);

    it('enforces privilege boundaries: service_role only can execute decommission RPC', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // anon cannot execute
      await db.exec('set role anon;');
      await expect(
        db.query(`select api.decommission_staff_profile('${INACTIVE_GUARD_B}'::uuid, 'Reason'::text);`)
      ).rejects.toThrow(/permission denied/);

      // authenticated cannot execute (closing reauth bypass)
      await db.exec('set role authenticated;');
      await expect(
        db.query(`select api.decommission_staff_profile('${INACTIVE_GUARD_B}'::uuid, 'Reason'::text);`)
      ).rejects.toThrow(/permission denied/);

      // service_role can execute (tested above)
      await db.exec('set role service_role;');
      const hasPriv = await db.query<{ has_priv: boolean }>(`
        select has_function_privilege('service_role', 'api.decommission_staff_profile(uuid,text,uuid)', 'EXECUTE') as has_priv;
      `);
      expect(hasPriv.rows[0].has_priv).toBe(true);

      const authHasPriv = await db.query<{ has_priv: boolean }>(`
        select has_function_privilege('authenticated', 'api.decommission_staff_profile(uuid,text,uuid)', 'EXECUTE') as has_priv;
      `);
      expect(authHasPriv.rows[0].has_priv).toBe(false);
    }, 30000);
  });

  describe('2. Server Route Reauthentication & Execution Contract', () => {
    const superAdminActor = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'superadmin@earist.edu.ph',
      role: 'superadmin',
    };
    const targetStaffUid = '22222222-2222-4222-8222-222222222222';

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('wrong password -> zero decommission RPC calls and local verifier cleanup', async () => {
      const mockRpc = vi.fn();
      const mockSignOut = vi.fn().mockResolvedValue({});
      const mockSignInWithPassword = vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid login credentials' },
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue(superAdminActor as any);
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: () => ({ rpc: mockRpc }),
          auth: { admin: { updateUserById: vi.fn() } },
        } as any,
        passwordVerifier: {
          auth: {
            signInWithPassword: mockSignInWithPassword,
            signOut: mockSignOut,
          },
        } as any,
      });

      const req = new Request('https://egatepass.tech/api/decommission-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-superadmin-token',
        },
        body: JSON.stringify({
          targetUid: targetStaffUid,
          reason: 'Valid resignation reason.',
          password: 'wrongPassword!',
        }),
      });

      const res = await decommissionRoute.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('invalid_superadmin_password');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('verified wrong UID -> zero decommission RPC calls and local verifier cleanup', async () => {
      const mockRpc = vi.fn();
      const mockSignOut = vi.fn().mockResolvedValue({});
      const mockSignInWithPassword = vi.fn().mockResolvedValue({
        data: { user: { id: '99999999-9999-4999-8999-999999999999' } },
        error: null,
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue(superAdminActor as any);
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: () => ({ rpc: mockRpc }),
        } as any,
        passwordVerifier: {
          auth: {
            signInWithPassword: mockSignInWithPassword,
            signOut: mockSignOut,
          },
        } as any,
      });

      const req = new Request('https://egatepass.tech/api/decommission-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-superadmin-token',
        },
        body: JSON.stringify({
          targetUid: targetStaffUid,
          reason: 'Valid resignation reason.',
          password: 'somePassword',
        }),
      });

      const res = await decommissionRoute.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.error).toBe('invalid_superadmin_password');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('correct password -> calls RPC and suspends Auth user with local verifier cleanup', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
      const mockUpdateUserById = vi.fn().mockResolvedValue({ data: {}, error: null });
      const mockSignOut = vi.fn().mockResolvedValue({});
      const mockSignInWithPassword = vi.fn().mockResolvedValue({
        data: { user: { id: superAdminActor.id } },
        error: null,
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue(superAdminActor as any);
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: () => ({ rpc: mockRpc }),
          auth: { admin: { updateUserById: mockUpdateUserById } },
        } as any,
        passwordVerifier: {
          auth: {
            signInWithPassword: mockSignInWithPassword,
            signOut: mockSignOut,
          },
        } as any,
      });

      const req = new Request('https://egatepass.tech/api/decommission-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-superadmin-token',
        },
        body: JSON.stringify({
          targetUid: targetStaffUid,
          reason: 'Employee resigned and cleared obligations.',
          password: 'SuperAdminCorrectPassword123!',
        }),
      });

      const res = await decommissionRoute.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('decommission_staff_profile', {
        requested_target_uid: targetStaffUid,
        requested_reason: 'Employee resigned and cleared obligations.',
        requested_actor_id: superAdminActor.id,
      });
      expect(mockUpdateUserById).toHaveBeenCalledWith(targetStaffUid, { ban_duration: '876000h' });
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('partial failure: DB decommission succeeds but Auth suspension fails -> HTTP 503 partial result with reconciliationRequired', async () => {
      const mockRpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
      const mockUpdateUserById = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'auth_service_down', message: 'Unable to reach Auth service' },
      });
      const mockSignOut = vi.fn().mockResolvedValue({});
      const mockSignInWithPassword = vi.fn().mockResolvedValue({
        data: { user: { id: superAdminActor.id } },
        error: null,
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue(superAdminActor as any);
      vi.spyOn(actorsModule, 'recordReconciliation').mockResolvedValue();
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: () => ({ rpc: mockRpc }),
          auth: { admin: { updateUserById: mockUpdateUserById } },
        } as any,
        passwordVerifier: {
          auth: {
            signInWithPassword: mockSignInWithPassword,
            signOut: mockSignOut,
          },
        } as any,
      });

      const req = new Request('https://egatepass.tech/api/decommission-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-superadmin-token',
        },
        body: JSON.stringify({
          targetUid: targetStaffUid,
          reason: 'Employee resigned and cleared obligations.',
          password: 'SuperAdminCorrectPassword123!',
        }),
      });

      const res = await decommissionRoute.fetch(req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.result).toBe('partial');
      expect(json.profileDecommissioned).toBe(true);
      expect(json.authSynchronized).toBe(false);
      expect(json.reconciliationRequired).toBe(true);
      expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' });
    });
  });
});
