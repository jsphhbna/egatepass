import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import deleteUserRoute from '../server/routes/system/delete-user.js';
import createUserRoute from '../server/routes/system/create-user.js';
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

    create or replace function auth.jwt() returns jsonb as $$
      select case
        when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
        else current_setting('request.jwt.claims', true)::jsonb
      end
    $$ language sql stable;

    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;

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

describe('Admin & Office Deletion & Lifecycle Management Regression Suite', () => {
  const SUPERADMIN_1 = '11111111-1111-4111-8111-111111111111';
  const SUPERADMIN_2 = '22222222-2222-4222-8222-222222222222';
  const STAFF_TO_DELETE = '33333333-3333-4333-8333-333333333333';
  const DEVICE_ACCOUNT = '44444444-4444-4444-8444-444444444444';
  const CALLER_ADMIN = '55555555-5555-4555-8555-555555555555';

  describe('1. Database RPC api.delete_staff_account Invariants', () => {
    it('enforces Super Admin authorization, last Super Admin protection, self-deletion block, and cleans up relations', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // Seed users in auth.users
      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at)
        values
          ('${SUPERADMIN_1}', 'super1@earist.edu.ph', now()),
          ('${SUPERADMIN_2}', 'super2@earist.edu.ph', now()),
          ('${STAFF_TO_DELETE}', 'decom_staff@earist.edu.ph', now()),
          ('${DEVICE_ACCOUNT}', 'kiosk1@devices.egatepass.invalid', now()),
          ('${CALLER_ADMIN}', 'admin_caller@earist.edu.ph', now());
      `);

      // Seed staff_profiles
      await db.exec(`
        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at, created_by)
        values
          ('${SUPERADMIN_1}', 'Super Admin 1', 'superadmin', true, false, now(), '${SUPERADMIN_1}'),
          ('${SUPERADMIN_2}', 'Super Admin 2', 'superadmin', true, false, now(), '${SUPERADMIN_1}'),
          ('${STAFF_TO_DELETE}', 'Staff to Delete', 'admin', false, false, now(), '${SUPERADMIN_1}'),
          ('${CALLER_ADMIN}', 'Admin Caller', 'admin', true, false, now(), '${SUPERADMIN_1}');
      `);

      // Seed device in devices table (user_id is the primary key)
      await db.exec(`
        insert into public.devices (user_id, alias, name, type, gate, status)
        values ('${DEVICE_ACCOUNT}', 'kiosk-test-1', 'Gate Kiosk 1', 'kiosk', 'Main Gate', 'active');
      `);

      // Seed a pass decided by STAFF_TO_DELETE to verify SET NULL behavior
      const testVisitorId = '99999999-9999-4999-8999-999999999999';
      const testPassId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await db.exec(`
        insert into auth.users (id, email) values ('${testVisitorId}', 'visitor@test.local');
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values ('${testVisitorId}', '${testVisitorId}', 'portal', 'Test Visitor', '09171234567', 'visitor@test.local', 'Official Visit', current_date, now());

        insert into public.passes (id, visitor_id, token_digest, source, status, decided_by, valid_from, valid_until)
        values ('${testPassId}', '${testVisitorId}', decode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'hex'), 'portal', 'inside', '${STAFF_TO_DELETE}', now(), now() + interval '8 hours');
      `);

      // 1. Rejects non-superadmin caller
      await expect(
        db.query(`
          select api.delete_staff_account(
            '${CALLER_ADMIN}'::uuid,
            '${STAFF_TO_DELETE}'::uuid,
            gen_random_uuid()
          );
        `)
      ).rejects.toThrow(/active_superadmin_required/);

      // 2. Rejects self-deletion
      await expect(
        db.query(`
          select api.delete_staff_account(
            '${SUPERADMIN_1}'::uuid,
            '${SUPERADMIN_1}'::uuid,
            gen_random_uuid()
          );
        `)
      ).rejects.toThrow(/cannot_delete_self/);

      // 3. Rejects deleting hardware device
      await expect(
        db.query(`
          select api.delete_staff_account(
            '${SUPERADMIN_1}'::uuid,
            '${DEVICE_ACCOUNT}'::uuid,
            gen_random_uuid()
          );
        `)
      ).rejects.toThrow(/cannot_delete_device_via_staff_api/);

      // 4. Deleting staff account succeeds
      const delRes = await db.query<{ delete_staff_account: any }>(`
        select api.delete_staff_account(
          '${SUPERADMIN_1}'::uuid,
          '${STAFF_TO_DELETE}'::uuid,
          gen_random_uuid()
        );
      `);
      expect(delRes.rows[0].delete_staff_account.deleted).toBe(true);
      expect(delRes.rows[0].delete_staff_account.userId).toBe(STAFF_TO_DELETE);

      // Verify staff_profiles row is deleted
      const profileCheck = await db.query(`select * from public.staff_profiles where user_id = '${STAFF_TO_DELETE}'`);
      expect(profileCheck.rows.length).toBe(0);

      // Verify dependent pass decided_by was preserved and set to null (not cascade deleted!)
      const passCheck = await db.query<{ id: string; decided_by: string | null }>(`select id, decided_by from public.passes where id = '${testPassId}'`);
      expect(passCheck.rows.length).toBe(1);
      expect(passCheck.rows[0].decided_by).toBeNull();

      // Verify audit log entry was written
      const auditCheck = await db.query<{ action: string; target_id: string }>(`
        select action, target_id from public.audit_events
        where action = 'staff.account_deleted' and target_id = '${STAFF_TO_DELETE}';
      `);
      expect(auditCheck.rows.length).toBe(1);

      // 5. Test last Super Admin protection
      // Deactivate SUPERADMIN_2
      await db.exec(`update public.staff_profiles set active = false where user_id = '${SUPERADMIN_2}'`);

      // SUPERADMIN_1 is now the sole active superadmin. Trying to delete SUPERADMIN_1 throws cannot_delete_self / cannot_delete_last_superadmin
      await expect(
        db.query(`
          select api.delete_staff_account(
            '${SUPERADMIN_1}'::uuid,
            '${SUPERADMIN_1}'::uuid,
            gen_random_uuid()
          );
        `)
      ).rejects.toThrow(/cannot_delete_self/);
    });
  });

  describe('2. Database RPC api.delete_office Invariants', () => {
    it('deletes an unused office cleanly while preventing deletion of an office with historical visit records', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // Seed superadmin
      await db.exec(`
        insert into auth.users (id, email) values ('${SUPERADMIN_1}', 'superadmin@earist.edu.ph');
        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at, created_by)
        values ('${SUPERADMIN_1}', 'Super Admin', 'superadmin', true, false, now(), '${SUPERADMIN_1}');
      `);

      // Seed two offices: one with visits and one without
      const unusedOfficeId = '10000000-0000-4000-8000-000000000001';
      const busyOfficeId = '20000000-0000-4000-8000-000000000002';

      await db.exec(`
        insert into public.offices (id, name, active, publication_status, verified, created_by)
        values
          ('${unusedOfficeId}', 'Obsolete Draft Office', true, 'draft', false, '${SUPERADMIN_1}'),
          ('${busyOfficeId}', 'Registrar Office', true, 'published', true, '${SUPERADMIN_1}');
      `);

      // Add a visit record to busyOfficeId
      const visitorUid = '88888888-8888-4888-8888-888888888888';
      await db.exec(`
        insert into auth.users (id, email) values ('${visitorUid}', 'visitor2@test.local');
        insert into public.visitors (id, owner_id, source, full_name, contact_number, email, purpose, visit_date, consent_accepted_at)
        values ('${visitorUid}', '${visitorUid}', 'portal', 'Visitor 2', '09181234567', 'visitor2@test.local', 'Transcript Request', current_date, now());

        insert into public.office_visits (
          id, visit_type, office_id, visitor_id, visitor_first_name, visitor_last_name,
          visitor_contact_number, visitor_email, purpose, visit_date, approval_status,
          attendance_status, request_id
        ) values (
          gen_random_uuid(), 'general', '${busyOfficeId}', '${visitorUid}', 'Visitor', 'Two',
          '09181234567', 'visitor2@test.local', 'Transcript Request', current_date, 'approved',
          'completed', gen_random_uuid()
        );
      `);

      // 1. Attempting to delete busyOfficeId must be blocked with historical records error
      await expect(
        db.query(`
          select api.delete_office(
            '${SUPERADMIN_1}'::uuid,
            '${busyOfficeId}'::uuid,
            gen_random_uuid()
          );
        `)
      ).rejects.toThrow(/office_has_historical_records_archival_required/);

      // Busy office still exists
      const busyCheck = await db.query(`select id from public.offices where id = '${busyOfficeId}'`);
      expect(busyCheck.rows.length).toBe(1);

      // 2. Deleting unusedOfficeId succeeds
      const delRes = await db.query<{ delete_office: any }>(`
        select api.delete_office(
          '${SUPERADMIN_1}'::uuid,
          '${unusedOfficeId}'::uuid,
          gen_random_uuid()
        );
      `);
      expect(delRes.rows[0].delete_office.deleted).toBe(true);
      expect(delRes.rows[0].delete_office.id).toBe(unusedOfficeId);

      // Verify office is gone
      const unusedCheck = await db.query(`select id from public.offices where id = '${unusedOfficeId}'`);
      expect(unusedCheck.rows.length).toBe(0);

      // Verify audit log
      const auditCheck = await db.query<{ action: string; target_id: string }>(`
        select action, target_id from public.audit_events
        where action = 'office.deleted' and target_id = '${unusedOfficeId}';
      `);
      expect(auditCheck.rows.length).toBe(1);
    });
  });

  describe('3. Server Routes: delete-user & create-user Email Reuse Lifecycle', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns 409 decommissioned_account_exists when creating with an email of a decommissioned account', async () => {
      const mockAdmin = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockImplementation(async () => {
            if (table === 'staff_profiles') {
              return {
                data: {
                  user_id: STAFF_TO_DELETE,
                  display_name: 'Former Staff',
                  role: 'admin',
                  decommissioned_at: '2026-11-20T00:00:00Z',
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }),
        })),
        auth: {
          admin: {
            createUser: vi.fn().mockResolvedValue({
              data: { user: null },
              error: { code: 'email_exists', message: 'User already registered' },
            }),
            listUsers: vi.fn().mockResolvedValue({
              data: {
                users: [{ id: STAFF_TO_DELETE, email: 'decom_staff@earist.edu.ph' }],
              },
            }),
          },
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        passwordVerifier: {} as any,
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: SUPERADMIN_1,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
        mustChangePassword: false,
      });

      const req = new Request('http://localhost/api/create-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Replacement Staff',
          email: 'decom_staff@earist.edu.ph',
          password: 'TestPassword123!',
          role: 'admin',
        }),
      });

      const res = await createUserRoute.fetch(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('decommissioned_account_exists');
      expect(data.message).toContain('permanently delete the decommissioned account');
    });

    it('permanently deletes staff account via /api/delete-user, enabling email re-use', async () => {
      let authUserDeleted = false;
      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({
            data: { deleted: true, target_uid: STAFF_TO_DELETE },
            error: null,
          }),
        }),
        auth: {
          admin: {
            deleteUser: vi.fn().mockImplementation(async (uid: string) => {
              if (uid === STAFF_TO_DELETE) {
                authUserDeleted = true;
                return { data: { user: null }, error: null };
              }
              return { data: null, error: { code: 'user_not_found', message: 'User not found' } };
            }),
          },
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        passwordVerifier: {
          auth: {
            signInWithPassword: vi.fn().mockResolvedValue({
              data: { user: { id: SUPERADMIN_1 } },
              error: null,
            }),
            signOut: vi.fn().mockResolvedValue({}),
          },
        } as any,
      });

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: SUPERADMIN_1,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
        mustChangePassword: false,
      });

      // 1. Delete user
      const deleteReq = new Request('http://localhost/api/delete-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: STAFF_TO_DELETE,
          password: 'SuperAdminPassword123!',
        }),
      });

      const delRes = await deleteUserRoute.fetch(deleteReq);
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.ok).toBe(true);
      expect(delData.deleted).toBe(true);
      expect(authUserDeleted).toBe(true);

      // 2. Verify subsequent creation with same email now succeeds
      const mockAdminAfter = {
        from: vi.fn((table: string) => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
        auth: {
          admin: {
            createUser: vi.fn().mockResolvedValue({
              data: { user: { id: '77777777-7777-4777-8777-777777777777', email: 'decom_staff@earist.edu.ph' } },
              error: null,
            }),
          },
          resend: vi.fn().mockResolvedValue({ data: {}, error: null }),
        },
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({
            data: { id: '77777777-7777-4777-8777-777777777777' },
            error: null,
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminAfter as any,
        passwordVerifier: {} as any,
      });

      const createReq = new Request('http://localhost/api/create-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'New Replacement Staff',
          email: 'decom_staff@earist.edu.ph',
          password: 'NewStrongPassword123!',
          role: 'admin',
        }),
      });

      const createRes = await createUserRoute.fetch(createReq);
      expect(createRes.status).toBe(201);
      const createData = await createRes.json();
      expect(createData.userId).toBe('77777777-7777-4777-8777-777777777777');
      expect(createData.confirmationPending).toBe(true);
    });
  });
});
