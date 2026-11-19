import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  enumerateBucketRecursive,
  deleteStorageObjectsInBatches,
  purgeAndVerifyStorageBuckets,
  isFolderEntry,
  assertAllowedBucket,
  STORAGE_REMOVAL_BATCH_SIZE,
  MAX_SAFE_STORAGE_INVENTORY,
} from '../server/lib/storagePurgeService.js';
import adminSettingsHandler from '../server/routes/admin/settings.js';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function setupSupabaseEmulation(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end $$;

    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema api to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema storage to anon, authenticated, service_role;

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

    create table if not exists auth.mfa_factors (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references auth.users(id) on delete cascade,
      friendly_name text,
      factor_type text not null,
      status text not null,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      secret text
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
        nullif(current_setting('my.auth.role', true), ''),
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

    do $$ begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end $$;
  `);
}

async function applyAllMigrations(db: PGlite): Promise<string[]> {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const rawSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const sql = rawSql.replace(
      /create extension if not exists pgcrypto[^;]*;/gi,
      '-- pgcrypto no-op'
    );
    try {
      await db.exec(sql);
    } catch (err: unknown) {
      console.error(`Migration failed in ${file}:`, err);
      throw err;
    }
  }
  return files;
}

describe('Return-to-Zero Storage Service & State Machine Hardening (Section 10 Matrix)', () => {
  // --------------------------------------------------------------------------
  // WORKSTREAM A - Part 1: Storage Enumeration, Deletion & Verification Tests
  // --------------------------------------------------------------------------

  describe('Storage Enumeration & Batch Deletion (Requirements 1 - 10, 23)', () => {
    it('Requirement 1: recursively discovers nested objects across multiple folder levels (1, 2, 3 levels)', async () => {
      // Mock Storage filesystem:
      // Root: folder "2026", file "root-file.jpg"
      // "2026": folder "11", file "year-file.jpg"
      // "2026/11": folder "19", file "month-file.jpg"
      // "2026/11/19": file "deep-portrait.jpg"
      const mockStorageMap: Record<string, any[]> = {
        '': [
          { name: '2026', id: null, metadata: null },
          { name: 'root-file.jpg', id: 'f-root', metadata: { size: 100 } },
        ],
        '2026': [
          { name: '11', id: null, metadata: null },
          { name: 'year-file.jpg', id: 'f-year', metadata: { size: 200 } },
        ],
        '2026/11': [
          { name: '19', id: null, metadata: null },
          { name: 'month-file.jpg', id: 'f-month', metadata: { size: 300 } },
        ],
        '2026/11/19': [
          { name: 'deep-portrait.jpg', id: 'f-deep', metadata: { size: 400 } },
        ],
      };

      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async (prefix: string = '') => ({
              data: mockStorageMap[prefix] || [],
              error: null,
            })),
          }),
        },
      } as unknown as SupabaseClient;

      const manifest = await enumerateBucketRecursive(mockClient, 'visitor-photos');
      expect(manifest.bucket).toBe('visitor-photos');
      expect(manifest.folderCount).toBe(3);
      expect(manifest.files.sort()).toEqual([
        '2026/11/19/deep-portrait.jpg',
        '2026/11/month-file.jpg',
        '2026/year-file.jpg',
        'root-file.jpg',
      ].sort());
    });

    it('Requirement 2: handles more than one listing page correctly via pagination offset', async () => {
      // Bucket root has 2500 files, returning 1000 per page
      const totalItems = 2500;
      const allFiles = Array.from({ length: totalItems }, (_, i) => ({
        name: `photo_${String(i).padStart(5, '0')}.jpg`,
        id: `uuid-${i}`,
        metadata: { size: 1024 },
      }));

      const listCalls: any[] = [];
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async (prefix: string = '', options?: any) => {
              listCalls.push({ prefix, options });
              const offset = options?.offset || 0;
              const limit = options?.limit || 1000;
              const slice = allFiles.slice(offset, offset + limit);
              return { data: slice, error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      const manifest = await enumerateBucketRecursive(mockClient, 'visitor-photos');
      expect(manifest.files.length).toBe(totalItems);
      expect(listCalls.length).toBe(3); // 0-1000, 1000-2000, 2000-2500
      expect(listCalls[0].options.offset).toBe(0);
      expect(listCalls[1].options.offset).toBe(1000);
      expect(listCalls[2].options.offset).toBe(2000);
    });

    it('Requirement 3: distinguishes folder entries (id: null) from actual file objects', () => {
      expect(isFolderEntry({ name: 'nested-folder', id: null, metadata: null })).toBe(true);
      expect(isFolderEntry({ name: 'folder/', isFolder: true })).toBe(true);
      expect(isFolderEntry({ name: 'trailing-slash/', id: undefined, metadata: null })).toBe(true);

      // Files have non-null id or non-empty metadata
      expect(isFolderEntry({ name: 'image.jpg', id: '123e4567-e89b-12d3-a456-426614174000', metadata: { size: 500 } })).toBe(false);
      expect(isFolderEntry({ name: 'doc.pdf', id: '', metadata: { mimetype: 'application/pdf' } })).toBe(false);
      expect(isFolderEntry(null)).toBe(false);
    });

    it('Requirement 4 & 5: removes all discovered objects in batches strictly <= 1,000 objects', async () => {
      const pathsToDelete = Array.from({ length: 2450 }, (_, i) => `folder/file_${i}.jpg`);
      const removeBatches: string[][] = [];

      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            remove: vi.fn(async (batch: string[]) => {
              removeBatches.push(batch);
              return { data: batch.map(b => ({ name: b })), error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      const res = await deleteStorageObjectsInBatches(mockClient, 'visitor-ids', pathsToDelete);
      expect(res.deletedCount).toBe(2450);
      expect(removeBatches.length).toBe(3);
      expect(removeBatches[0].length).toBe(1000);
      expect(removeBatches[1].length).toBe(1000);
      expect(removeBatches[2].length).toBe(450);
      for (const batch of removeBatches) {
        expect(batch.length).toBeLessThanOrEqual(STORAGE_REMOVAL_BATCH_SIZE);
      }
    });

    it('Requirement 6: Storage list errors prevent completion and throw immediately', async () => {
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async () => ({
              data: null,
              error: { message: 'Storage connection timeout' },
            })),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        enumerateBucketRecursive(mockClient, 'visitor-photos')
      ).rejects.toThrow(/Storage list operation failed.*Storage connection timeout/);
    });

    it('Requirement 7: Storage remove errors retry and prevent completion if unresolved', async () => {
      let callCount = 0;
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            remove: vi.fn(async () => {
              callCount++;
              return { data: null, error: { message: '503 Service Unavailable' } };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        deleteStorageObjectsInBatches(mockClient, 'visitor-photos', ['sample1.jpg', 'sample2.jpg'])
      ).rejects.toThrow(/Failed to remove batch of 2 files.*after 3 attempts/);

      expect(callCount).toBe(3); // Retried max 3 times
    });

    it('Requirement 8: Partial removal is tracked and retries can succeed', async () => {
      let attempt = 0;
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            remove: vi.fn(async (batch: string[]) => {
              attempt++;
              if (attempt === 1) {
                return { data: null, error: { message: 'Rate limit exceeded' } };
              }
              // Second attempt succeeds
              return { data: batch.map(b => ({ name: b })), error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      const res = await deleteStorageObjectsInBatches(mockClient, 'visitor-ids', ['retry-me.png']);
      expect(res.deletedCount).toBe(1);
      expect(attempt).toBe(2);
    });

    it('Requirement 9: Verification detects remaining objects and fails closed', async () => {
      // Mock client that lists 1 file initially, simulates deletion, but re-enumeration still returns 1 file
      let postCheck = false;
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async () => {
              if (postCheck) {
                // Post-deletion verification still finds undeleted ghost file
                return {
                  data: [{ name: 'persistent-ghost.jpg', id: 'ghost-1', metadata: { size: 100 } }],
                  error: null,
                };
              }
              return {
                data: [{ name: 'persistent-ghost.jpg', id: 'ghost-1', metadata: { size: 100 } }],
                error: null,
              };
            }),
            remove: vi.fn(async () => {
              postCheck = true;
              return { data: [{ name: 'persistent-ghost.jpg' }], error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        purgeAndVerifyStorageBuckets(mockClient)
      ).rejects.toThrow(/Storage verification failed: 1 file\(s\) still remain in bucket "visitor-photos" after deletion/);
    });

    it('Requirement 10: Retry safely resumes incomplete operations and achieves verified empty state', async () => {
      let filesInPhotos = ['photo1.jpg', 'photo2.jpg'];
      let filesInIds = ['id1.jpg'];

      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async () => {
              const items = bucket === 'visitor-photos' ? filesInPhotos : filesInIds;
              return {
                data: items.map(name => ({ name, id: `id-${name}`, metadata: { size: 100 } })),
                error: null,
              };
            }),
            remove: vi.fn(async (batch: string[]) => {
              if (bucket === 'visitor-photos') {
                filesInPhotos = filesInPhotos.filter(f => !batch.includes(f));
              } else {
                filesInIds = filesInIds.filter(f => !batch.includes(f));
              }
              return { data: batch.map(b => ({ name: b })), error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      const purgeResult = await purgeAndVerifyStorageBuckets(mockClient);
      expect(purgeResult.success).toBe(true);
      expect(purgeResult.verifiedEmpty).toBe(true);
      expect(purgeResult.totalFilesDiscovered).toBe(3);
      expect(purgeResult.totalFilesDeleted).toBe(3);
      expect(filesInPhotos.length).toBe(0);
      expect(filesInIds.length).toBe(0);
    });

    it('Requirement 23: Bucket containing nested files is never reported as empty merely because root contains folder entries', async () => {
      const mockStorageMap: Record<string, any[]> = {
        '': [
          { name: 'kiosk-uploads', id: null, metadata: null },
          { name: 'portal-uploads', id: null, metadata: null },
        ],
        'kiosk-uploads': [
          { name: 'kiosk-portrait-1.jpg', id: 'k-1', metadata: { size: 500 } },
        ],
        'portal-uploads': [
          { name: 'portal-portrait-2.jpg', id: 'p-2', metadata: { size: 800 } },
        ],
      };

      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async (prefix: string = '') => ({
              data: mockStorageMap[prefix] || [],
              error: null,
            })),
          }),
        },
      } as unknown as SupabaseClient;

      const manifest = await enumerateBucketRecursive(mockClient, 'visitor-photos');
      expect(manifest.files.length).toBe(2);
      expect(manifest.files).toContain('kiosk-uploads/kiosk-portrait-1.jpg');
      expect(manifest.files).toContain('portal-uploads/portal-portrait-2.jpg');
    });

    it('Strict allowlist: rejects unapproved buckets from purge enumeration', () => {
      expect(() => assertAllowedBucket('system-backups' as any)).toThrow(
        /Bucket "system-backups" is not authorized for Return-to-Zero purge/
      );
      expect(() => assertAllowedBucket('avatars' as any)).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // WORKSTREAM A - Part 2: Database Migration, Lock Concurrency & Integrity
  // --------------------------------------------------------------------------

  describe('Database State Machine, Concurrency Lock & Role Boundaries (Requirements 11 - 22)', { timeout: 60000 }, () => {
    let db: PGlite;
    const superadminId = '00000000-0000-0000-0000-000000000001';
    const nonSuperadminStaffId = '00000000-0000-0000-0000-000000000002';
    const visitorOwnerId = '00000000-0000-0000-0000-000000000003';

    beforeEach(async () => {
      db = new PGlite();
      await applyAllMigrations(db);

      // Seed Superadmin and Regular Staff
      await db.exec(`
        insert into auth.users (id, email) values
          ('${superadminId}'::uuid, 'superadmin@institution.edu'),
          ('${nonSuperadminStaffId}'::uuid, 'guard@institution.edu'),
          ('${visitorOwnerId}'::uuid, 'visitor@test.local')
        on conflict (id) do nothing;

        insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret) values
          ('${superadminId}'::uuid, 'Primary Authenticator', 'totp', 'verified', 'BASE32ENCODEDSECRETKEY123')
        on conflict (id) do nothing;

        insert into public.staff_profiles (user_id, display_name, role, active) values
          ('${superadminId}'::uuid, 'System Superadmin', 'superadmin', true),
          ('${nonSuperadminStaffId}'::uuid, 'Duty Guard', 'guard', true)
        on conflict (user_id) do nothing;
      `);
    }, 60000);

    it('Requirement 11: Concurrent reset attempts cannot corrupt operation state (lock rejection)', async () => {
      // 1. Acquire lock for first operation
      const lock1 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; operation_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(lock1.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      const opId = lock1.rows[0].acquire_system_reset_lock.operation_id;
      expect(opId).toBeDefined();

      // 2. Second concurrent acquire attempt must fail or report already locked
      const lock2 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; reason: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(lock2.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(lock2.rows[0].acquire_system_reset_lock.reason).toBe('reset_already_in_progress');

      // 3. Release lock
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`);
    });

    it('Requirement 12: New uploads and operational writes rejected by lock triggers during reset', async () => {
      // 1. Acquire lock
      const lockRes = await db.query<{ acquire_system_reset_lock: { operation_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;

      // 2. Attempt insert into visitors -> must throw system_reset_in_progress
      await expect(
        db.exec(`
          insert into public.visitors (owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
          values ('${visitorOwnerId}'::uuid, 'portal', 'Blocked Visitor', '+639170000000', 'Visit', current_date, now());
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 3. Attempt insert into upload_intents -> must throw system_reset_in_progress
      await expect(
        db.exec(`
          insert into public.upload_intents (owner_id, bucket_id, object_path, kind, status, max_bytes, expires_at, source, content_type)
          values ('${visitorOwnerId}'::uuid, 'visitor-photos', 'test.jpg', 'photo', 'pending', 1024, now() + interval '1 hour', 'portal', 'image/jpeg');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 4. Release lock
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`);

      // 5. Subsequent insert succeeds now that lock is released
      await expect(
        db.exec(`
          insert into public.visitors (owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
          values ('${visitorOwnerId}'::uuid, 'portal', 'Allowed Visitor', '+639170000000', 'Visit', current_date, now());
        `)
      ).resolves.not.toThrow();
    });

    it('Requirement 13: SQL reset code never directly deletes from storage.objects (static invariant check)', () => {
      const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));
      for (const file of migrationFiles) {
        const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        // Assert no direct SQL deletion on storage.objects exists anywhere in migrations
        expect(content).not.toMatch(/delete\s+from\s+storage\.objects/i);
      }
    });

    it('Requirement 14 & 15: RPC executable by service_role only; anon and authenticated rejected', async () => {
      // 1. Authenticated role call rejected
      await db.exec(`set request.jwt.claim.role = 'authenticated';`);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`)
      ).rejects.toThrow(/service role required/);

      // 2. Anon role call rejected
      await db.exec(`set request.jwt.claim.role = 'anon';`);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`)
      ).rejects.toThrow(/service role required/);

      // 3. Service role call permitted
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const res = await db.query<{ return_to_zero_reset: { success: boolean } }>(`
        select api.return_to_zero_reset('${superadminId}'::uuid);
      `);
      expect(res.rows[0].return_to_zero_reset.success).toBe(true);
    });

    it('Requirement 16 & 17: Non-Superadmin or inactive superadmin callers rejected', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Guard role cannot execute
      await expect(
        db.query(`select api.return_to_zero_reset('${nonSuperadminStaffId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);

      // Inactive superadmin cannot execute
      const inactiveAdminId = '00000000-0000-0000-0000-000000000099';
      await db.exec(`
        insert into auth.users (id, email) values ('${inactiveAdminId}'::uuid, 'inactive@institution.edu') on conflict do nothing;
        insert into public.staff_profiles (user_id, display_name, role, active) values ('${inactiveAdminId}'::uuid, 'Ex Admin', 'superadmin', false) on conflict do nothing;
      `);
      await expect(
        db.query(`select api.return_to_zero_reset('${inactiveAdminId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);
    });

    it('Requirement 18: Intended active Superadmins and verified MFA factors remain intact', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`);

      // Verify active superadmin user still exists in auth.users
      const superUser = await db.query(`select id, email from auth.users where id = '${superadminId}';`);
      expect(superUser.rows.length).toBe(1);

      // Verify staff profile still exists
      const superProfile = await db.query(`select user_id, role, active from public.staff_profiles where user_id = '${superadminId}';`);
      expect(superProfile.rows.length).toBe(1);
      expect(superProfile.rows[0].active).toBe(true);

      // Verify MFA factor preserved intact
      const mfaCheck = await db.query(`select user_id, factor_type, status from auth.mfa_factors where user_id = '${superadminId}';`);
      expect(mfaCheck.rows.length).toBe(1);
      expect(mfaCheck.rows[0].status).toBe('verified');
      expect(mfaCheck.rows[0].factor_type).toBe('totp');
    });

    it('Requirement 19: Institutional configuration tables preserved intact', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`);

      const settings = await db.query(`select count(*) as c from public.app_settings;`);
      expect(Number(settings.rows[0].c)).toBeGreaterThanOrEqual(1);

      const offices = await db.query(`select count(*) as c from public.offices;`);
      expect(Number(offices.rows[0].c)).toBeGreaterThanOrEqual(1);

      const psgc = await db.query(`select count(*) as c from public.psgc_locations;`);
      expect(Number(psgc.rows[0].c)).toBeGreaterThanOrEqual(1);
    });

    it('Requirement 20 & 21: Historical audit records remain durable and mandatory reset audit event written', async () => {
      // Seed pre-existing historical audit event
      await db.exec(`
        insert into public.audit_events (action, actor_id, actor_kind, target_type, outcome, after_state)
        values ('staff.login', '${superadminId}'::uuid, 'staff', 'session', 'success', '{"ip": "127.0.0.1"}'::jsonb);
      `);

      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`);

      // Verify pre-existing audit record was NOT deleted
      const loginAudit = await db.query(`select action, outcome from public.audit_events where action = 'staff.login';`);
      expect(loginAudit.rows.length).toBe(1);

      // Verify mandatory reset audit event was appended
      const resetAudit = await db.query<{ action: string; outcome: string; actor_id: string }>(`
        select action, outcome, actor_id from public.audit_events where action = 'superadmin.return_to_zero';
      `);
      expect(resetAudit.rows.length).toBe(1);
      expect(resetAudit.rows[0].actor_id).toBe(superadminId);
      expect(resetAudit.rows[0].outcome).toBe('success');
    });

    it('Requirement 22: Failed Storage or Auth cleanup never produces success and leaves system in recovery state', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-valid-token',
        },
        body: JSON.stringify({
          action: 'return_to_zero',
          confirmationPhrase: 'DELETE ALL OPERATIONAL DATA',
        }),
      });

      // Mock requireStaffActor returning active superadmin
      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      // Mock storage purge service throwing an error during Storage step
      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockRejectedValueOnce(
        new Error('Network timeout during S3 batch delete')
      );

      // Mock supabase client to track RPC calls
      const mockRpc = vi.fn().mockImplementation((name: string) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({ data: { acquired: true, operation_id: 'op-fail-test-123' }, error: null });
        }
        if (name === 'record_system_reset_step' || name === 'release_system_reset_lock') {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        if (name === 'return_to_zero_reset') {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: () => ({ rpc: mockRpc }),
          rpc: mockRpc,
          from: vi.fn(),
        } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const jsonBody = await res.json();
      expect(jsonBody.error).toBe('storage_purge_failed');
      expect(jsonBody.recoveryRequired).toBe(true);
      // Verify return_to_zero_reset DB RPC was NEVER called because storage purge failed
      expect(mockRpc).not.toHaveBeenCalledWith('return_to_zero_reset', expect.anything());
    });
  });
});
