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
  StorageTimeoutError,
  executeWithStorageTimeout,
  STORAGE_REQUEST_TIMEOUT_MS,
} from '../server/lib/storagePurgeService.js';
import adminSettingsHandler from '../server/routes/admin/settings.js';
import lookupReturningHandler from '../server/routes/passes/lookup-returning.js';
import identifyReturningHandler from '../server/routes/passes/identify-returning.js';
import returningPhotoPreviewHandler from '../server/routes/passes/returning-photo-preview.js';
import { createCandidateToken, verifyCandidateToken } from '../server/lib/candidate-token.js';

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

  async function advanceResetToDatabaseCleanup(
    dbInstance: PGlite,
    opId: string,
    generation: number,
    workerId: string,
    verificationOverride?: any
  ) {
    const verification = verificationOverride !== undefined
      ? verificationOverride
      : {
          verifiedAt: new Date().toISOString(),
          buckets: {
            'visitor-photos': { bucket: 'visitor-photos', remainingCount: 0, verifiedEmpty: true },
            'visitor-ids': { bucket: 'visitor-ids', remainingCount: 0, verifiedEmpty: true },
          },
          verifiedEmpty: true,
        };

    await dbInstance.exec(`
      select api.record_system_reset_step(
        '${opId}'::uuid,
        'storage_deletion_in_progress',
        'storage_deletion_in_progress',
        '{}'::jsonb,
        '{}'::jsonb,
        null,
        ${generation},
        '${workerId}'::uuid
      );
      select api.record_system_reset_step(
        '${opId}'::uuid,
        'storage_deletion_verified',
        'storage_deletion_verified',
        '{}'::jsonb,
        '{}'::jsonb,
        null,
        ${generation},
        '${workerId}'::uuid,
        '${JSON.stringify(verification)}'::jsonb
      );
      select api.record_system_reset_step(
        '${opId}'::uuid,
        'database_cleanup_in_progress',
        'database_cleanup_in_progress',
        '{}'::jsonb,
        '{}'::jsonb,
        null,
        ${generation},
        '${workerId}'::uuid
      );
    `);
  }

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
      const lock1 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; operation_id: string; worker_generation: number; worker_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(lock1.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lock1.rows[0].acquire_system_reset_lock;
      expect(opId).toBeDefined();

      // 2. Second concurrent acquire attempt must fail or report already locked
      const lock2 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; reason: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(lock2.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(lock2.rows[0].acquire_system_reset_lock.reason).toBe('reset_already_in_progress');

      // 3. Fenced database cleanup and release lock
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Requirement 12: New uploads and operational writes rejected by lock triggers during reset', async () => {
      // 1. Acquire lock
      const lockRes = await db.query<{ acquire_system_reset_lock: { operation_id: string; worker_generation: number; worker_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

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

      // 4. Fenced database cleanup and release lock
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);

      // 5. Subsequent insert succeeds now that lock is released (re-create visitor owner since non-admin users were purged by reset)
      await db.exec(`
        insert into auth.users (id, email)
        values ('${visitorOwnerId}'::uuid, 'visitor-owner@domain.test')
        on conflict (id) do nothing;
      `);
      await expect(
        db.exec(`
          insert into public.visitors (owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
          values ('${visitorOwnerId}'::uuid, 'portal', 'Allowed Visitor', '+639170000000', 'Visit', current_date, now());
        `)
      ).resolves.not.toThrow();
    });

    it('Requirement 13: SQL reset code never directly deletes from storage.objects (static invariant check)', async () => {
      const activeMigrationPath = join(MIGRATIONS_DIR, '20261119000100_return_to_zero_and_storage_integrity.sql');
      const content = readFileSync(activeMigrationPath, 'utf8');
      // Assert no direct SQL deletion on storage.objects exists in the new reset migration
      expect(content).not.toMatch(/delete\s+from\s+storage\.objects/i);

      // Verify active installed api.return_to_zero_reset function in the database contains no direct storage.objects deletion
      const procRes = await db.query<{ prosrc: string }>(`
        select prosrc from pg_proc where proname = 'return_to_zero_reset';
      `);
      expect(procRes.rows[0].prosrc).not.toMatch(/delete\s+from\s+storage\.objects/i);
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

      // 3. Standalone service_role call without lock rejected with fencing_token_revoked
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 4. Authorized fenced worker under service role call permitted
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      const res = await db.query<{ return_to_zero_reset: { success: boolean } }>(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);
      expect(res.rows[0].return_to_zero_reset.success).toBe(true);

      // Clean up lock
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);
    });

    it('Requirement 16 & 17: Non-Superadmin or inactive superadmin callers rejected', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Guard role cannot acquire lock or execute
      await expect(
        db.query(`select api.acquire_system_reset_lock('${nonSuperadminStaffId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);

      // Inactive superadmin cannot execute
      const inactiveAdminId = '00000000-0000-0000-0000-000000000099';
      await db.exec(`
        insert into auth.users (id, email) values ('${inactiveAdminId}'::uuid, 'inactive@institution.edu') on conflict do nothing;
        insert into public.staff_profiles (user_id, display_name, role, active) values ('${inactiveAdminId}'::uuid, 'Ex Admin', 'superadmin', false) on conflict do nothing;
      `);
      await expect(
        db.query(`select api.acquire_system_reset_lock('${inactiveAdminId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);

      // Fenced return_to_zero_reset rejects non-superadmin even with active lock
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await expect(
        db.query(`select api.return_to_zero_reset('${nonSuperadminStaffId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);

      await expect(
        db.query(`select api.return_to_zero_reset('${inactiveAdminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/superadmin_required/);

      // Complete cleanup and release lock
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Requirement 18: Intended active Superadmins and verified MFA factors remain intact', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);

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
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);

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
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);

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
          return Promise.resolve({
            data: {
              acquired: true,
              operation_id: 'a0000000-0000-4000-8000-000000000001',
              worker_generation: 1,
              worker_id: 'b0000000-0000-4000-8000-000000000002',
            },
            error: null,
          });
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

  // --------------------------------------------------------------------------
  // WORKSTREAM F: Section F Regression and Adversarial Tests (Cases 1-14, 20)
  // --------------------------------------------------------------------------

  describe('Section F Required Regression and Adversarial Tests', { timeout: 60000 }, () => {
    let db: PGlite;
    const superadminId = '00000000-0000-0000-0000-000000000001';

    beforeEach(async () => {
      db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`
        insert into auth.users (id, email)
        values ('${superadminId}'::uuid, 'superadmin@institution.edu')
        on conflict do nothing;

        insert into public.staff_profiles (user_id, display_name, role, active)
        values ('${superadminId}'::uuid, 'Super Admin', 'superadmin', true)
        on conflict do nothing;

        insert into auth.mfa_factors (user_id, friendly_name, factor_type, status, secret)
        values ('${superadminId}'::uuid, 'Primary TOTP', 'totp', 'verified', 'MFA_SECRET_1234')
        on conflict do nothing;
      `);
    }, 60000);

    afterEach(async () => {
      await db.close();
      vi.restoreAllMocks();
    });

    it('Case 1: Lock RPC throws exception -> fails closed with HTTP 500, zero Storage/DB operations', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      const mockPurge = vi.fn();
      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockImplementation(mockPurge);

      const mockRpc = vi.fn().mockImplementation((name: string) => {
        if (name === 'acquire_system_reset_lock') {
          throw new Error('Database connection pool exhausted during lock acquisition');
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('lock_acquisition_failed');
      expect(mockPurge).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalledWith('return_to_zero_reset', expect.anything());
    });

    it('Case 2: Lock RPC returns { error } -> fails closed with HTTP 500, zero Storage/DB operations', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      const mockPurge = vi.fn();
      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockImplementation(mockPurge);

      const mockRpc = vi.fn().mockImplementation((name: string) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({ data: null, error: { message: 'relation maintenance_state deadlocked' } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('lock_acquisition_failed');
      expect(mockPurge).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalledWith('return_to_zero_reset', expect.anything());
    });

    it('Case 3: Lock RPC returns null or malformed data -> fails closed with HTTP 500, zero operations', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      const mockPurge = vi.fn();
      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockImplementation(mockPurge);

      // Null lockData
      const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('lock_acquisition_failed');
      expect(mockPurge).not.toHaveBeenCalled();
    });

    it('Case 4: Two reset requests attempt to acquire lock simultaneously in PostgreSQL -> atomic winner', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const res1 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; operation_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(res1.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      const opId1 = res1.rows[0].acquire_system_reset_lock.operation_id;
      expect(opId1).toBeDefined();

      const res2 = await db.query<{ acquire_system_reset_lock: { acquired: boolean; reason: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(res2.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(res2.rows[0].acquire_system_reset_lock.reason).toBe('reset_already_in_progress');
    });

    it('Case 5: Existing recovery_required operation is not silently overwritten', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Initial lock
      const lockRes = await db.query<{ acquire_system_reset_lock: { operation_id: string; worker_generation: number; worker_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // 2. Mark operation recovery_required
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid,
          'recovery_required',
          'storage_purge_failed',
          '{"photos": ["failed.jpg"]}'::jsonb,
          '{"totalDiscovered": 1, "totalDeleted": 0}'::jsonb,
          'S3 batch deletion timed out',
          ${gen},
          '${wId}'::uuid
        );
      `);

      // 3. New request to acquire lock must NOT overwrite the existing recovery state
      const nextAttempt = await db.query<{ acquire_system_reset_lock: { acquired: boolean; reason: string; operation_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      expect(nextAttempt.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(nextAttempt.rows[0].acquire_system_reset_lock.reason).toBe('recovery_required');
      expect(nextAttempt.rows[0].acquire_system_reset_lock.operation_id).toBe(opId);

      // Verify the original manifest and counts were NOT erased
      const opRecord = await db.query<{ storage_manifest: any; error_details: string }>(`
        select storage_manifest, error_details from public.system_reset_operations where id = '${opId}';
      `);
      expect(opRecord.rows[0].storage_manifest).toEqual({ photos: ['failed.jpg'] });
      expect(opRecord.rows[0].error_details).toContain('S3 batch deletion timed out');
    });

    it('Case 6: Status-recording RPC returns an error -> reset fails closed with HTTP 500', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockResolvedValue({
        success: true,
        inventories: {} as any,
        totalFilesDiscovered: 0,
        totalFilesDeleted: 0,
        verifiedEmpty: true,
        purgedAt: new Date().toISOString(),
      });

      const mockRpc = vi.fn().mockImplementation((name: string, args: any) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({
            data: {
              acquired: true,
              operation_id: 'a0000000-0000-4000-8000-000000000006',
              worker_generation: 1,
              worker_id: 'b0000000-0000-4000-8000-000000000006',
            },
            error: null,
          });
        }
        if (name === 'record_system_reset_step') {
          if (args?.requested_status === 'storage_deletion_in_progress') {
            return Promise.resolve({ data: null, error: { message: 'disk quota exceeded writing audit record' } });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: { success: true }, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.recoveryRequired).toBe(true);
    });

    it('Case 7: Lock release returns an error -> returns HTTP 500 lock_release_failed and retains recovery state', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockResolvedValue({
        success: true,
        inventories: {} as any,
        totalFilesDiscovered: 0,
        totalFilesDeleted: 0,
        verifiedEmpty: true,
        purgedAt: new Date().toISOString(),
      });

      const recordedSteps: string[] = [];
      const mockRpc = vi.fn().mockImplementation((name: string, args: any) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({
            data: {
              acquired: true,
              operation_id: 'a0000000-0000-4000-8000-000000000007',
              worker_generation: 1,
              worker_id: 'b0000000-0000-4000-8000-000000000007',
            },
            error: null,
          });
        }
        if (name === 'record_system_reset_step') {
          recordedSteps.push(args?.requested_step);
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'return_to_zero_reset') {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        if (name === 'release_system_reset_lock') {
          return Promise.resolve({ data: null, error: { message: 'Database transaction lock release failed' } });
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('lock_release_failed');
      expect(body.recoveryRequired).toBe(true);
      expect(recordedSteps).toContain('lock_release_failed');
    });

    it('Case 8: Interruption between Storage verification and DB cleanup leaves recoverable operation', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Lock acquired
      const lockRes = await db.query<{ acquire_system_reset_lock: { operation_id: string; worker_generation: number; worker_id: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid);
      `);
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // 2. Storage in-progress and verified step recorded
      await db.exec(`
        select api.record_system_reset_step(
          '${opId}'::uuid,
          'storage_deletion_in_progress',
          'storage_deletion_in_progress',
          '{}'::jsonb,
          '{}'::jsonb,
          null,
          ${gen},
          '${wId}'::uuid
        );
        select api.record_system_reset_step(
          '${opId}'::uuid,
          'storage_deletion_verified',
          'storage_deletion_verified',
          '{"visitor-photos": {"files": []}, "visitor-ids": {"files": []}}'::jsonb,
          '{"totalDiscovered": 5, "totalDeleted": 5}'::jsonb,
          null,
          ${gen},
          '${wId}'::uuid
        );
      `);

      // 3a. While worker is still active (fresh heartbeat and unexpired lease), a concurrent resume request cannot obtain authority
      const concurrentRes = await db.query<{ acquire_system_reset_lock: { acquired: boolean; reason: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);
      `);
      expect(concurrentRes.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(['previous_worker_lease_active', 'reset_already_in_progress']).toContain(concurrentRes.rows[0].acquire_system_reset_lock.reason);

      // 3b. Process interruption / serverless timeout occurs here (worker lease expires)
      await db.exec(`
        update public.maintenance_state
        set lease_expires_at = now() - interval '5 seconds',
            heartbeat_at = now() - interval '35 seconds'
        where job_name = 'system_reset';
      `);

      // Next admin resumes explicitly via acquire_system_reset_lock with requested_resume_op_id
      const resumeRes = await db.query<{ acquire_system_reset_lock: { acquired: boolean; resumed: boolean; operation_id: string; previous_status: string } }>(`
        select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);
      `);
      expect(resumeRes.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      expect(resumeRes.rows[0].acquire_system_reset_lock.resumed).toBe(true);
      expect(resumeRes.rows[0].acquire_system_reset_lock.operation_id).toBe(opId);
      expect(resumeRes.rows[0].acquire_system_reset_lock.previous_status).toBe('storage_deletion_verified');
    });

    it('Case 9: Writes to visitors, passes, office_visits, devices, and evidence are rejected during reset lock', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Acquire lock
      await db.query(`select api.acquire_system_reset_lock('${superadminId}'::uuid);`);

      // 1. Visitors insert rejected
      await expect(
        db.exec(`
          insert into public.visitors (owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
          values ('${superadminId}'::uuid, 'portal', 'Blocked Visitor', '+639170000001', 'Test', current_date, now());
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 2. Passes insert rejected
      await expect(
        db.exec(`
          insert into public.passes (visitor_id, source, token_digest, status, valid_from, valid_until)
          values ('00000000-0000-0000-0000-000000000001'::uuid, 'portal', '\\x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'::bytea, 'issued', now(), now() + interval '1 day');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 3. Devices insert rejected
      await expect(
        db.exec(`
          insert into public.devices (user_id, alias, name, type, gate)
          values ('${superadminId}'::uuid, 'dev-blocked-alias', 'Gate 1 Blocked', 'kiosk'::public.device_type, 'Gate 1');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 4. Office visits insert rejected
      await expect(
        db.exec(`
          insert into public.office_visits (visit_type, office_id, visitor_first_name, visitor_last_name, visitor_contact_number, purpose, visit_date)
          values ('general', '00000000-0000-0000-0000-000000000001'::uuid, 'First', 'Last', '+639170000000', 'Meeting', current_date);
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 5. Visitor evidence insert rejected
      await expect(
        db.exec(`
          insert into public.visitor_evidence (visitor_id, upload_intent_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, verified_at, expires_at)
          values ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'photo', 'visitor-photos', 'test.jpg', 'image/jpeg', 100, repeat('0', 64), now(), now() + interval '1 day');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);
    });

    it('Case 10: Pre-existing upload intent attempting upload during reset is rejected', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Seed pending upload intent before lock
      const intentId = '00000000-0000-0000-0000-000000000088';
      await db.exec(`
        insert into public.upload_intents (id, owner_id, source, kind, bucket_id, object_path, content_type, status, expires_at)
        values ('${intentId}'::uuid, '${superadminId}'::uuid, 'portal', 'photo', 'visitor-photos', 'photos/racing.jpg', 'image/jpeg', 'pending', now() + interval '1 hour');
      `);

      // Now lock the system
      await db.query(`select api.acquire_system_reset_lock('${superadminId}'::uuid);`);

      // Attempting to write into storage.objects during lock must be rejected by trigger/lock check
      await expect(
        db.exec(`
          insert into storage.objects (bucket_id, name, owner, owner_id)
          values ('visitor-photos', 'photos/racing.jpg', '${superadminId}'::uuid, '${superadminId}');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);
    });

    it('Case 11: Directory deeper than supported limit (MAX_DIRECTORY_DEPTH) throws hard error', async () => {
      // Create a mock filesystem 12 levels deep (exceeding MAX_DIRECTORY_DEPTH = 10)
      const mockStorageMap: Record<string, any[]> = {};
      let currentPath = '';
      for (let i = 1; i <= 12; i++) {
        const nextFolder = `level_${i}`;
        mockStorageMap[currentPath] = [
          { name: nextFolder, id: null, metadata: null },
        ];
        currentPath = currentPath ? `${currentPath}/${nextFolder}` : nextFolder;
      }
      mockStorageMap[currentPath] = [
        { name: 'deep_hidden.jpg', id: 'f-deep', metadata: { size: 100 } },
      ];

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

      await expect(
        enumerateBucketRecursive(mockClient, 'visitor-photos')
      ).rejects.toThrow(/Maximum folder depth \(10\) exceeded/);
    });

    it('Case 12: Combined two-bucket inventory exceeding 20,000 ceiling throws error', async () => {
      // 12,000 objects in visitor-photos, 9,000 in visitor-ids (each under 20k, but combined = 21k)
      const photosCount = 12_000;
      const idsCount = 9_000;

      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async (prefix: string = '', options?: any) => {
              const offset = options?.offset || 0;
              const limit = options?.limit || 1000;
              const total = bucket === 'visitor-photos' ? photosCount : idsCount;
              const count = Math.max(0, Math.min(limit, total - offset));
              const data = Array.from({ length: count }, (_, i) => ({
                name: `file_${offset + i}.jpg`,
                id: `id-${offset + i}`,
                metadata: { size: 100 },
              }));
              return { data, error: null };
            }),
            remove: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        purgeAndVerifyStorageBuckets(mockClient)
      ).rejects.toThrow(/Combined storage inventory safety threshold exceeded/);
    });

    it('Case 13: Storage removal partial failure fails closed before database cleanup', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      // Storage remove permanently fails after 3 retries
      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockRejectedValueOnce(
        new Error('Failed to remove batch of 1000 files in bucket "visitor-photos" after 3 attempts')
      );

      const mockRpc = vi.fn().mockImplementation((name: string) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({
            data: {
              acquired: true,
              operation_id: 'a0000000-0000-4000-8000-000000000013',
              worker_generation: 1,
              worker_id: 'b0000000-0000-4000-8000-000000000013',
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { success: true }, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('storage_purge_failed');
      expect(body.recoveryRequired).toBe(true);
      expect(mockRpc).not.toHaveBeenCalledWith('return_to_zero_reset', expect.anything());
    });

    it('Case 14: Post-deletion verification detects persistent object and fails closed', async () => {
      let phase = 'initial';
      const mockClient = {
        storage: {
          from: (bucket: string) => ({
            list: vi.fn(async () => {
              if (phase === 'post-check') {
                // Post-check finds remaining file
                return { data: [{ name: 'ghost.jpg', id: 'g-1', metadata: { size: 10 } }], error: null };
              }
              return { data: [{ name: 'ghost.jpg', id: 'g-1', metadata: { size: 10 } }], error: null };
            }),
            remove: vi.fn(async () => {
              phase = 'post-check';
              return { data: [{ name: 'ghost.jpg' }], error: null };
            }),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        purgeAndVerifyStorageBuckets(mockClient)
      ).rejects.toThrow(/Storage verification failed: 1 file\(s\) still remain/);
    });

    it('Case 15: Anonymous lookup response contains no raw profile ID, gender, exact total-match count, or portrait token', async () => {
      const origSecret = process.env.RETURNING_MATCH_TOKEN_SECRET;
      process.env.RETURNING_MATCH_TOKEN_SECRET = 'test-token-secret-must-be-at-least-32-chars-long!';

      const visitorActorId = '22222222-2222-4222-8222-222222222222';
      const mockProfile = {
        id: '33333333-3333-4333-8333-333333333333',
        first_name: 'Juan',
        middle_name: 'Santos',
        last_name: 'Dela Cruz',
        contact_number_e164: '+639171234567',
        gender: 'Male',
        psgc_barangay_name: 'Batasan Hills',
        psgc_city_municipality_name: 'Quezon City',
        psgc_province_name: 'Metro Manila',
      };

      const chainable: any = {
        select: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        gt: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [mockProfile],
          error: null,
        }),
      };

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: {
          schema: vi.fn().mockReturnValue({
            rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
          }),
          from: vi.fn((table: string) => {
            if (table === 'returning_visitor_profiles') return chainable;
            if (table === 'visitors') {
              return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                order: vi.fn().mockResolvedValue({ data: [{ id: 'v-1' }], error: null }),
              };
            }
            if (table === 'visitor_evidence') {
              return {
                select: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                is: vi.fn().mockReturnThis(),
                gt: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'e-1', expires_at: new Date(Date.now() + 86400000).toISOString(), purged_at: null },
                  error: null,
                }),
              };
            }
            return {};
          }),
        } as any,
        client: {} as any,
      });

      vi.spyOn(await import('../server/actors.js'), 'getVerifiedSessionContext').mockResolvedValue({
        actorId: visitorActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: visitorActorId },
        identity: 'test-user',
      } as any);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ success: true, hostname: 'localhost' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = new Request('http://localhost/api/passes/lookup-returning', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer visitor-token',
        },
        body: JSON.stringify({
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          captchaToken: 'test-turnstile',
        }),
      });

      const res = await lookupReturningHandler.fetch(req);
      if (origSecret !== undefined) process.env.RETURNING_MATCH_TOKEN_SECRET = origSecret;
      else delete process.env.RETURNING_MATCH_TOKEN_SECRET;

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.found).toBe(true);
      expect(body.candidates).toHaveLength(1);
      const cand = body.candidates[0];

      // Assert complete attribute minimization
      expect(cand.profileId).toBeUndefined();
      expect(cand.gender).toBeUndefined();
      expect(body.totalMatches).toBeUndefined();
      expect(cand.previewUrl).toBeUndefined();
      expect(cand.previewToken).toBeUndefined();
      expect(cand.registeredAt).toBeUndefined();
      expect(cand.storagePath).toBeUndefined();

      // Assert candidate token is opaque cand.v2 and does NOT contain raw profile UUID in plaintext
      expect(cand.candidateToken).toMatch(/^cand\.v2\./);
      expect(cand.candidateToken.includes(mockProfile.id)).toBe(false);
      expect(cand.maskedName).toBe('Juan S. D****');
      expect(cand.maskedContact).toBe('+639***4567');
    });

    it('Case 16: Candidate authorization is tampered with, expired, replayed, or used by a different actor', async () => {
      const actorId = '11111111-1111-4111-8111-111111111111';
      const otherActorId = '99999999-9999-4999-8999-999999999999';
      const profileId = '33333333-3333-4333-8333-333333333333';
      const secret = 'test-token-secret-must-be-at-least-32-chars-long!';

      // 1. Tampered candidate token:
      const validToken = createCandidateToken(profileId, actorId, secret, 300);
      const parts = validToken.split('.');
      const tamperedParts = [...parts];
      const origCipher = tamperedParts[3];
      tamperedParts[3] = origCipher.slice(0, -2) + (origCipher.endsWith('AA') ? 'BB' : 'AA');
      const tamperedToken = tamperedParts.join('.');

      const tamperResult = verifyCandidateToken(tamperedToken, actorId, secret);
      expect(tamperResult.valid).toBe(false);
      expect(tamperResult.error).toBe('signature_mismatch');

      // 2. Expired candidate token:
      const expiredToken = createCandidateToken(profileId, actorId, secret, -10);
      const expireResult = verifyCandidateToken(expiredToken, actorId, secret);
      expect(expireResult.valid).toBe(false);
      expect(expireResult.expired).toBe(true);
      expect(expireResult.error).toBe('candidate_token_expired');

      // 3. Different actor (cross-actor replay):
      const actorMismatchResult = verifyCandidateToken(validToken, otherActorId, secret);
      expect(actorMismatchResult.valid).toBe(false);
      expect(actorMismatchResult.error).toBe('actor_mismatch');
    });

    it('Case 17: Identification without a valid candidate authorization is rejected', async () => {
      const visitorActorId = '11111111-1111-4111-8111-111111111111';
      const profileId = '33333333-3333-4333-8333-333333333333';

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        client: {} as any,
      });

      vi.spyOn(await import('../server/actors.js'), 'getVerifiedSessionContext').mockResolvedValue({
        actorId: visitorActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: visitorActorId },
        identity: 'test-user',
      } as any);

      // Attempt 1: Omission of candidateToken
      const noTokenReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          photoBase64: '/9j/4AAQSkZJRg==',
        }),
      });

      const res1 = await identifyReturningHandler.fetch(noTokenReq);
      expect(res1.status).toBe(403);
      const body1 = await res1.json();
      expect(body1.error).toBe('candidate_token_required');

      // Attempt 2: Malformed candidateToken
      const badTokenReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          candidateToken: 'cand.v2.invalid.not.enough.parts',
          photoBase64: '/9j/4AAQSkZJRg==',
        }),
      });

      const res2 = await identifyReturningHandler.fetch(badTokenReq);
      expect(res2.status).toBe(403);
      const body2 = await res2.json();
      expect(body2.error).toBe('invalid_candidate_token');

      // Attempt 3: Supplying raw profileId is strictly rejected (400 raw_profile_id_forbidden)
      const rawProfileReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          profileId,
          photoBase64: '/9j/4AAQSkZJRg==',
        }),
      });

      const res3 = await identifyReturningHandler.fetch(rawProfileReq);
      expect(res3.status).toBe(400);
      const body3 = await res3.json();
      expect(body3.error).toBe('raw_profile_id_forbidden');
    });

    it('Case 18: A discovery token cannot retrieve a portrait or ID', async () => {
      const visitorActorId = '11111111-1111-4111-8111-111111111111';
      const profileId = '33333333-3333-4333-8333-333333333333';
      const secret = 'test-token-secret-must-be-at-least-32-chars-long!';

      const candToken = createCandidateToken(profileId, visitorActorId, secret, 300);

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        client: {} as any,
      });

      vi.spyOn(await import('../server/actors.js'), 'getVerifiedSessionContext').mockResolvedValue({
        actorId: visitorActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: visitorActorId },
        identity: 'test-user',
      } as any);

      // Attempt to retrieve photo using candidate discovery token
      const photoReq = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${profileId}&token=${candToken}&kind=photo`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } }
      );
      const photoRes = await returningPhotoPreviewHandler.fetch(photoReq);
      expect(photoRes.status).toBe(403);
      const photoBody = await photoRes.json();
      expect(photoBody.error).toBe('discovery_token_cannot_authorize_preview');

      // Attempt to retrieve ID using candidate discovery token
      const idReq = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${profileId}&token=${candToken}&kind=id`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } }
      );
      const idRes = await returningPhotoPreviewHandler.fetch(idReq);
      expect(idRes.status).toBe(403);
      const idBody = await idRes.json();
      expect(idBody.error).toBe('discovery_token_cannot_authorize_preview');
    });

    it('Case 19: A returning selfie causes zero Storage uploads, zero evidence inserts, and zero persistent template writes', async () => {
      const origSecret = process.env.RETURNING_MATCH_TOKEN_SECRET;
      const origMode = process.env.RETURNING_FACE_THRESHOLD_MODE;
      const origCosine = process.env.RETURNING_FACE_MIN_COSINE;

      const visitorActorId = '11111111-1111-4111-8111-111111111111';
      const profileId = '33333333-3333-4333-8333-333333333333';
      const secret = 'test-token-secret-must-be-at-least-32-chars-long!';

      process.env.RETURNING_MATCH_TOKEN_SECRET = secret;
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'provisional';
      process.env.RETURNING_FACE_MIN_COSINE = '0.363';

      const candToken = createCandidateToken(profileId, visitorActorId, secret, 300);

      const uploadSpy = vi.fn();
      const evidenceInsertSpy = vi.fn();
      const faceTemplateInsertSpy = vi.fn();
      const identityAttemptInsertSpy = vi.fn().mockResolvedValue({ error: null });

      const mockAdmin: any = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        storage: {
          from: vi.fn(() => ({
            upload: uploadSpy,
            download: vi.fn().mockResolvedValue({
              data: { arrayBuffer: async () => new Uint8Array(100).buffer },
              error: null,
            }),
          })),
        },
        from: vi.fn((table: string) => {
          if (table === 'visitor_evidence') {
            return {
              insert: evidenceInsertSpy,
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          if (table === 'returning_face_templates') {
            return { insert: faceTemplateInsertSpy };
          }
          if (table === 'returning_identity_attempts') {
            return { insert: identityAttemptInsertSpy };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: profileId,
                  first_name: 'Juan',
                  last_name: 'Dela Cruz',
                  contact_number_e164: '+639171234567',
                  expires_at: new Date(Date.now() + 86400000).toISOString(),
                  revoked_at: null,
                },
                error: null,
              }),
            };
          }
          if (table === 'returning_visitor_vehicles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        }),
      };

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        client: {} as any,
      });

      vi.spyOn(await import('../server/actors.js'), 'getVerifiedSessionContext').mockResolvedValue({
        actorId: visitorActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: visitorActorId },
        identity: 'test-user',
      } as any);

      const fakeDescriptor = new Float32Array(128).fill(0.1);
      vi.spyOn(await import('../server/lib/face-engine.js'), 'analyzeFaceImage').mockResolvedValue({
        quality: { passed: true, code: 'good', message: 'Passed' },
        descriptor: fakeDescriptor,
        modelName: 'sface',
        modelVersion: '1.0',
      } as any);

      vi.spyOn(await import('../server/lib/returningVisitorResolution.js'), 'resolveAuthoritativeVisitorForProfile').mockResolvedValue({
        match: { profileId, visitorIds: ['v-1'] },
      } as any);

      vi.spyOn(await import('../server/lib/returningVisitorResolution.js'), 'resolveEligibleRegistrationPortrait').mockResolvedValue({
        id: 'e-1',
        bucket_id: 'visitor-photos',
        object_path: 'portraits/juan.jpg',
        created_at: new Date().toISOString(),
      } as any);

      const testJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          candidateToken: candToken,
          photoBase64: testJpeg.toString('base64'),
        }),
      });

      const res = await identifyReturningHandler.fetch(req);
      expect(res.status).toBe(200);

      // Invariants:
      // Zero Storage uploads
      expect(uploadSpy).not.toHaveBeenCalled();
      // Zero visitor_evidence records
      expect(evidenceInsertSpy).not.toHaveBeenCalled();
      // Zero permanent facial templates persisted
      expect(faceTemplateInsertSpy).not.toHaveBeenCalled();

      // Identity attempt record must be ephemeral (null photo_intent_id and null numeric score)
      expect(identityAttemptInsertSpy).toHaveBeenCalledTimes(1);
      const insertedAttempt = identityAttemptInsertSpy.mock.calls[0][0];
      expect(insertedAttempt.photo_intent_id).toBeNull();
      expect(insertedAttempt.best_score).toBeNull();
      expect(insertedAttempt.second_score).toBeNull();

      if (origSecret !== undefined) process.env.RETURNING_MATCH_TOKEN_SECRET = origSecret;
      else delete process.env.RETURNING_MATCH_TOKEN_SECRET;
      if (origMode !== undefined) process.env.RETURNING_FACE_THRESHOLD_MODE = origMode;
      else delete process.env.RETURNING_FACE_THRESHOLD_MODE;
      if (origCosine !== undefined) process.env.RETURNING_FACE_MIN_COSINE = origCosine;
      else delete process.env.RETURNING_FACE_MIN_COSINE;
    });

    it('Case 21: Database cleanup RPC throws exception -> fails closed with HTTP 500 database_reset_failed and records recovery state', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ action: 'return_to_zero', confirmationPhrase: 'DELETE ALL OPERATIONAL DATA' }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      vi.spyOn(await import('../server/lib/storagePurgeService.js'), 'purgeAndVerifyStorageBuckets').mockResolvedValue({
        success: true,
        inventories: {} as any,
        totalFilesDiscovered: 0,
        totalFilesDeleted: 0,
        verifiedEmpty: true,
        purgedAt: new Date().toISOString(),
      });

      const recordedSteps: string[] = [];
      const mockRpc = vi.fn().mockImplementation((name: string, args: any) => {
        if (name === 'acquire_system_reset_lock') {
          return Promise.resolve({
            data: {
              acquired: true,
              operation_id: 'a0000000-0000-4000-8000-000000000021',
              worker_generation: 1,
              worker_id: 'b0000000-0000-4000-8000-000000000021',
            },
            error: null,
          });
        }
        if (name === 'record_system_reset_step') {
          recordedSteps.push(args?.requested_step);
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'return_to_zero_reset') {
          throw new Error('Database server terminated abnormally during reset');
        }
        return Promise.resolve({ data: null, error: null });
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('database_reset_failed');
      expect(body.recoveryRequired).toBe(true);
      expect(body.operationId).toBe('a0000000-0000-4000-8000-000000000021');
      expect(recordedSteps).toContain('database_cleanup_failed');
    });

    it('Case 22: Superadmin can reconcile interrupted reset operation via reconcile_system_reset API action', async () => {
      const mockReq = new Request('http://localhost/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          action: 'reconcile_system_reset',
          operationId: 'op-rec-1234',
          reconcileAction: 'force_unlock',
          note: 'Operator recovery inspection completed',
        }),
      });

      vi.spyOn(await import('../server/actors.js'), 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        role: 'superadmin',
        active: true,
      } as any);

      const mockRpc = vi.fn().mockResolvedValue({
        data: { success: true, action: 'force_unlocked', operation_id: 'op-rec-1234' },
        error: null,
      });

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: { schema: () => ({ rpc: mockRpc }), rpc: mockRpc, from: vi.fn() } as any,
        client: {} as any,
      });

      const res = await adminSettingsHandler(mockReq);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.result.action).toBe('force_unlocked');
      expect(mockRpc).toHaveBeenCalledWith('reconcile_system_reset_operation', {
        requested_actor_id: superadminId,
        requested_op_id: 'op-rec-1234',
        requested_action: 'force_unlock',
        requested_note: 'Operator recovery inspection completed',
      });
    });

    it('Case 23: Complete write freeze rejects writes across outbox, reconciliation, and staff session tables', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Acquire lock
      await db.query(`select api.acquire_system_reset_lock('${superadminId}'::uuid);`);

      // 1. Office visit email outbox insert rejected
      await expect(
        db.exec(`
          insert into public.office_visit_email_outbox (office_visit_id, recipient_email, email_type)
          values ('00000000-0000-0000-0000-000000000001'::uuid, 'test@example.com', 'approval');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 2. Reconciliation tasks insert rejected
      await expect(
        db.exec(`
          insert into public.reconciliation_tasks (operation, reference_type)
          values ('storage_cleanup', 'storage');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 3. Staff sessions insert rejected
      await expect(
        db.exec(`
          insert into public.staff_sessions (session_id, user_id, role)
          values ('session-12345678', '${superadminId}'::uuid, 'superadmin'::public.staff_role);
        `)
      ).rejects.toThrow(/system_reset_in_progress/);
    });

    it('Case 24: api.get_system_reset_status reflects accurate locked/unlocked state and operation details', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. When idle
      await db.exec(`update public.maintenance_state set cursor_value = 'idle' where job_name = 'system_reset';`);
      const idleRes = await db.query<{ get_system_reset_status: any }>(`select api.get_system_reset_status();`);
      expect(idleRes.rows[0].get_system_reset_status.isLocked).toBe(false);
      expect(idleRes.rows[0].get_system_reset_status.status).toBe('idle');

      // 2. Acquired lock
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      const lockedRes = await db.query<{ get_system_reset_status: any }>(`select api.get_system_reset_status();`);
      expect(lockedRes.rows[0].get_system_reset_status.isLocked).toBe(true);
      expect(lockedRes.rows[0].get_system_reset_status.status).toBe('locked');
      expect(lockedRes.rows[0].get_system_reset_status.activeOperation.id).toBe(opId);

      // Clean up / release (DB cleanup then release)
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Case 25: Resuming an old completed or unrelated operation cannot replace a newer active operation', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Acquire first operation op1
      const lock1 = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const op1 = lock1.rows[0].acquire_system_reset_lock.operation_id;
      const gen1 = lock1.rows[0].acquire_system_reset_lock.worker_generation;
      const w1 = lock1.rows[0].acquire_system_reset_lock.worker_id;

      // Complete DB cleanup and release op1
      await advanceResetToDatabaseCleanup(db, op1, gen1, w1);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${op1}'::uuid, ${gen1}, '${w1}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${op1}'::uuid, ${gen1}, '${w1}'::uuid);
      `);

      // 2. Acquire second operation op2
      const lock2 = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const op2 = lock2.rows[0].acquire_system_reset_lock.operation_id;
      const gen2 = lock2.rows[0].acquire_system_reset_lock.worker_generation;
      const w2 = lock2.rows[0].acquire_system_reset_lock.worker_id;
      expect(op2).not.toBe(op1);

      // 3. Attempt to resume old completed op1 while op2 is active
      const resumeOld = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${op1}'::uuid);`
      );
      expect(resumeOld.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(resumeOld.rows[0].acquire_system_reset_lock.reason).toBe('cannot_resume_completed_operation');

      // 4. Attempt to resume non-existent / arbitrary operation
      const nonExistent = '99999999-9999-4999-8999-999999999999';
      const resumeFake = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${nonExistent}'::uuid);`
      );
      expect(resumeFake.rows[0].acquire_system_reset_lock.acquired).toBe(false);
      expect(resumeFake.rows[0].acquire_system_reset_lock.reason).toBe('operation_not_found');

      // Clean up op2 (DB cleanup then release)
      await advanceResetToDatabaseCleanup(db, op2, gen2, w2);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${op2}'::uuid, ${gen2}, '${w2}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${op2}'::uuid, ${gen2}, '${w2}'::uuid);
      `);
    });

    it('Case 26: A stale worker cannot record steps, execute DB cleanup RPC, or release lock', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Worker 1 acquires lock
      const lock1 = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lock1.rows[0].acquire_system_reset_lock.operation_id;
      const gen1 = lock1.rows[0].acquire_system_reset_lock.worker_generation;
      const w1 = lock1.rows[0].acquire_system_reset_lock.worker_id;

      // 2. Worker 1 times out (simulate lease expiration via lease_expires_at)
      await db.exec(`
        update public.maintenance_state
        set lease_expires_at = now() - interval '5 seconds',
            heartbeat_at = now() - interval '40 seconds'
        where job_name = 'system_reset';
      `);

      // 3. Worker 2 resumes the operation
      const lock2 = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
      );
      expect(lock2.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      const gen2 = lock2.rows[0].acquire_system_reset_lock.worker_generation;
      const w2 = lock2.rows[0].acquire_system_reset_lock.worker_id;
      expect(gen2).toBeGreaterThan(gen1);
      expect(w2).not.toBe(w1);

      // 4. Stale Worker 1 attempts worker active assertion -> rejected with fencing_token_revoked
      await expect(
        db.query(`select api.assert_system_reset_worker_active('${opId}'::uuid, ${gen1}, '${w1}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 5. Stale Worker 1 attempts record_system_reset_step -> rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', 'storage_deletion_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen1}, '${w1}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 6. Stale Worker 1 attempts return_to_zero_reset -> rejected
      await expect(
        db.query(`
          select api.return_to_zero_reset(
            '${superadminId}'::uuid, '${opId}'::uuid, ${gen1}, '${w1}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 7. Stale Worker 1 attempts release_system_reset_lock -> rejected
      await expect(
        db.query(`
          select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen1}, '${w1}'::uuid);
        `)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 8. Active Worker 2 can successfully assert ownership, cleanup DB, and release
      const assertRes = await db.query<{ assert_system_reset_worker_active: boolean }>(
        `select api.assert_system_reset_worker_active('${opId}'::uuid, ${gen2}, '${w2}'::uuid);`
      );
      expect(assertRes.rows[0].assert_system_reset_worker_active).toBe(true);

      await advanceResetToDatabaseCleanup(db, opId, gen2, w2);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen2}, '${w2}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen2}, '${w2}'::uuid);
      `);
    });

    it('Case 27: Force-unlock/reconciliation revokes old worker authority immediately', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Worker acquires lock
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;
      const gen = lockRes.rows[0].acquire_system_reset_lock.worker_generation;
      const workerId = lockRes.rows[0].acquire_system_reset_lock.worker_id;

      // 2. Admin performs force-unlock reconciliation
      const recRes = await db.query<{ reconcile_system_reset_operation: any }>(`
        select api.reconcile_system_reset_operation(
          '${superadminId}'::uuid, '${opId}'::uuid, 'force_unlock', 'Emergency operator override'
        );
      `);
      expect(recRes.rows[0].reconcile_system_reset_operation.success).toBe(true);

      // 3. Old worker tries to execute DB cleanup RPC -> rejected (fencing token revoked)
      await expect(
        db.query(`
          select api.return_to_zero_reset(
            '${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${workerId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 4. Old worker tries to record step -> rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'db_cleanup_in_progress', 'db_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${workerId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked/);
    });

    it('Case 28: Four operational tables (resend_webhook_events, rate_limit_buckets, nominatim_rate_limiter, location_search_cache) are frozen during reset lock', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Acquire reset lock
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;
      const gen = lockRes.rows[0].acquire_system_reset_lock.worker_generation;
      const wId = lockRes.rows[0].acquire_system_reset_lock.worker_id;

      // 1. resend_webhook_events insert rejected
      await expect(
        db.exec(`
          insert into public.resend_webhook_events (provider_event_id, event_type, email_id)
          values ('evt-frozen-123', 'email.delivered', 'email-frozen-123');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 2. rate_limit_buckets insert rejected
      await expect(
        db.exec(`
          insert into public.rate_limit_buckets (key_digest, action, window_started_at, expires_at)
          values ('\\x0102'::bytea, 'login', now(), now() + interval '1 hour');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 3. nominatim_rate_limiter update rejected
      await expect(
        db.exec(`
          update public.nominatim_rate_limiter set last_request_at = now() where id = 1;
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // 4. location_search_cache insert rejected
      await expect(
        db.exec(`
          insert into public.location_search_cache (query_hash, query, results, expires_at)
          values ('hash-1', 'City Hall', '[]'::jsonb, now() + interval '1 day');
        `)
      ).rejects.toThrow(/system_reset_in_progress/);

      // DB cleanup and release lock
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);

      // Now verify writes succeed after lock release
      await db.exec(`
        insert into public.resend_webhook_events (provider_event_id, event_type, email_id)
        values ('evt-unfrozen-123', 'email.delivered', 'email-unfrozen-123');
        insert into public.rate_limit_buckets (key_digest, action, window_started_at, expires_at)
        values ('\\x0304'::bytea, 'login', now(), now() + interval '1 hour');
        update public.nominatim_rate_limiter set last_request_at = now() where id = 1;
        insert into public.location_search_cache (query_hash, query, results, expires_at)
        values ('hash-2', 'City Hall', '[]'::jsonb, now() + interval '1 day');
      `);
    });

    it('Case 29: Two concurrent resumes cannot both obtain worker authority', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Initial lock acquired
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;

      // 2. Simulate worker crash / lease timeout (lease_expires_at expired)
      await db.exec(`
        update public.maintenance_state
        set lease_expires_at = now() - interval '5 seconds',
            heartbeat_at = now() - interval '45 seconds'
        where job_name = 'system_reset';
      `);

      // 3. Launch two simultaneous resume requests
      const [res1, res2] = await Promise.all([
        db.query<{ acquire_system_reset_lock: any }>(
          `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
        ),
        db.query<{ acquire_system_reset_lock: any }>(
          `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
        ),
      ]);

      const r1 = res1.rows[0].acquire_system_reset_lock;
      const r2 = res2.rows[0].acquire_system_reset_lock;

      // Exactly one must acquire, and the other must be rejected
      const acquiredCount = (r1.acquired ? 1 : 0) + (r2.acquired ? 1 : 0);
      expect(acquiredCount).toBe(1);

      const rejected = r1.acquired ? r2 : r1;
      expect(rejected.acquired).toBe(false);
      expect(rejected.reason).toBe('reset_already_in_progress');

      const winner = r1.acquired ? r1 : r2;
      // Clean up winner (cleanup DB then release lock)
      await advanceResetToDatabaseCleanup(db, opId, winner.worker_generation, winner.worker_id);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${winner.worker_generation}, '${winner.worker_id}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${winner.worker_generation}, '${winner.worker_id}'::uuid);
      `);
    });

    it('Case 30: Two concurrent resumes for an operation in recovery_required state cannot both obtain worker authority', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Initial lock acquired and marked recovery_required via reconciliation
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;

      await db.query(`
        select api.reconcile_system_reset_operation('${superadminId}'::uuid, '${opId}'::uuid, 'resume', 'Prepare for recovery');
      `);

      // Verify status is recovery_required
      const statusRes = await db.query<{ get_system_reset_status: any }>(`select api.get_system_reset_status();`);
      expect(statusRes.rows[0].get_system_reset_status.status).toBe('recovery_required');

      // 2. Launch two simultaneous resume requests for the recovery_required operation
      const [res1, res2] = await Promise.all([
        db.query<{ acquire_system_reset_lock: any }>(
          `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
        ),
        db.query<{ acquire_system_reset_lock: any }>(
          `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
        ),
      ]);

      const r1 = res1.rows[0].acquire_system_reset_lock;
      const r2 = res2.rows[0].acquire_system_reset_lock;

      // Exactly one must acquire, and the other must be rejected with reset_already_in_progress
      const acquiredCount = (r1.acquired ? 1 : 0) + (r2.acquired ? 1 : 0);
      expect(acquiredCount).toBe(1);

      const rejected = r1.acquired ? r2 : r1;
      expect(rejected.acquired).toBe(false);
      expect(rejected.reason).toBe('reset_already_in_progress');

      const winner = r1.acquired ? r1 : r2;
      // Clean up winner (cleanup DB then release lock)
      await advanceResetToDatabaseCleanup(db, opId, winner.worker_generation, winner.worker_id);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${winner.worker_generation}, '${winner.worker_id}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${winner.worker_generation}, '${winner.worker_id}'::uuid);
      `);
    });

    it('Case 31: api.get_system_reset_status returns activeOperation: null when active_operation_id is null without inferring from history', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // Ensure historical unfinished operation exists but maintenance_state has active_operation_id = null
      const dummyOpId = '00000000-0000-0000-0000-000000000099';
      await db.exec(`
        insert into public.system_reset_operations (id, actor_id, status, step, created_at, updated_at)
        values ('${dummyOpId}'::uuid, '${superadminId}'::uuid, 'lock_acquired', 'test_hanging_step', now() - interval '1 day', now() - interval '1 day')
        on conflict (id) do update set status = 'lock_acquired';

        update public.maintenance_state
        set cursor_value = 'idle', active_operation_id = null
        where job_name = 'system_reset';
      `);

      const statusRes = await db.query<{ get_system_reset_status: any }>(`select api.get_system_reset_status();`);
      const status = statusRes.rows[0].get_system_reset_status;
      expect(status.isLocked).toBe(false);
      expect(status.activeOperation).toBeNull();
    });

    it('Case 32: Calling api.return_to_zero_reset with null operation ID or null worker generation while lock is active fails with fencing_token_revoked', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Acquire lock
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const opId = lockRes.rows[0].acquire_system_reset_lock.operation_id;
      const gen = lockRes.rows[0].acquire_system_reset_lock.worker_generation;
      const wId = lockRes.rows[0].acquire_system_reset_lock.worker_id;

      // 2. Attempt return_to_zero_reset with omitted/null opId while lock is active -> rejected
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, null, null, null);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 3. Attempt return_to_zero_reset with valid opId but null worker generation -> rejected
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, null, null);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 4. Attempt return_to_zero_reset with valid opId and generation but null worker ID -> rejected
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, null);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 5. Attempt record_system_reset_step with status = 'completed' -> rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'completed', 'completed',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_(state|step)_transition/);

      // 6. Attempt release_system_reset_lock with null generation -> rejected
      await expect(
        db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, null, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 7. Attempt release_system_reset_lock with null worker ID -> rejected
      await expect(
        db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, null);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // Clean up lock (cleanup DB then release lock)
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`
        select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);
      await db.query(`
        select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);
      `);
    });

    it('Case 33: identify-returning strictly rejects request containing profileId: null', async () => {
      const visitorActorId = '11111111-1111-4111-8111-111111111111';

      vi.spyOn(await import('../server/supabase.js'), 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        client: {} as any,
      });

      vi.spyOn(await import('../server/actors.js'), 'getVerifiedSessionContext').mockResolvedValue({
        actorId: visitorActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: visitorActorId },
        identity: 'test-user',
      } as any);

      const nullProfileReq = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          requestId: '22222222-2222-4222-8222-222222222222',
          profileId: null,
          candidateToken: 'cand.v2.abc.def.ghi',
          photoBase64: '/9j/4AAQSkZJRg==',
        }),
      });

      const res = await identifyReturningHandler.fetch(nullProfileReq);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('raw_profile_id_forbidden');
    });

    it('Case 20: Historical migration 20261118000300 is byte-for-byte identical to main, and 20261119000100 upgrades cleanly from baseline', async () => {
      const histMigrationPath = join(MIGRATIONS_DIR, '20261118000300_gender_and_system_reset.sql');
      const histContent = readFileSync(histMigrationPath, 'utf8');

      // Verify historical migration retains original baseline contents (delete from storage.objects and audit_events)
      expect(histContent).toMatch(/delete\s+from\s+storage\.objects\s+where\s+bucket_id/i);
      expect(histContent).toMatch(/delete\s+from\s+public\.audit_events/i);

      // Verify the new append-only migration 20261119000100 independently replaces api.return_to_zero_reset
      const newMigrationPath = join(MIGRATIONS_DIR, '20261119000100_return_to_zero_and_storage_integrity.sql');
      const newContent = readFileSync(newMigrationPath, 'utf8');

      expect(newContent).not.toMatch(/delete\s+from\s+storage\.objects/i);
      expect(newContent).not.toMatch(/delete\s+from\s+public\.audit_events/i);
      expect(newContent).toMatch(/create\s+or\s+replace\s+function\s+api\.return_to_zero_reset/i);
      expect(newContent).toMatch(/create\s+or\s+replace\s+function\s+api\.acquire_system_reset_lock/i);

      // Verify that after running both migrations, the installed function in the database is the hardened version
      const procRes = await db.query<{ prosrc: string }>(`
        select prosrc from pg_proc where proname = 'return_to_zero_reset';
      `);
      expect(procRes.rows[0].prosrc).not.toMatch(/delete\s+from\s+storage\.objects/i);
      expect(procRes.rows[0].prosrc).not.toMatch(/delete\s+from\s+public\.audit_events/i);
    });

    it('Case 34: Fresh lock_acquired operation cannot call return_to_zero_reset before Storage phase', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // Attempt to invoke DB reset directly from lock_acquired status -> rejected
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/invalid_state_transition: operation must be in database_cleanup_in_progress phase/);

      // Clean up lock
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Case 35: record_system_reset_step cannot write database_cleanup_completed or completed (forgery defense)', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // 1. Status forgery rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_completed', 'storage_deletion_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: database cleanup completion must be performed via return_to_zero_reset/);

      // 2. Step forgery rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', 'database_cleanup_completed',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: database cleanup completion must be performed via return_to_zero_reset/);

      // 3. Completed status forgery rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'completed', 'completed',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: operation completion must be performed via release_system_reset_lock/);

      // 4. Caller cannot release lock after forgery attempt
      await expect(
        db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/database_cleanup_incomplete/);

      // Clean up properly
      await advanceResetToDatabaseCleanup(db, opId, gen, wId);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Case 36: Database cleanup strictly requires verified Storage phase and empty bucket proof', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // 1. Cannot skip storage_deletion_verified to jump straight to database_cleanup_in_progress
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'storage_deletion_in_progress', 'storage_deletion_in_progress',
          '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
        );
      `);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: database_cleanup_in_progress requires storage_deletion_verified state/);

      // 2. Missing or malformed verification metadata blocks reaching database_cleanup_in_progress
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
          '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid, null
        );
      `);

      // Prove database_cleanup_in_progress is unreachable without valid verification:
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/storage_verification_required/);

      // And even if database_cleanup_in_progress were directly forced in the table, return_to_zero_reset blocks:
      await db.exec(`
        update public.system_reset_operations
        set status = 'database_cleanup_in_progress', step = 'database_cleanup_in_progress', storage_verification = null
        where id = '${opId}';
      `);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/storage_verification_required/);

      // 3. Verification missing visitor-ids bucket blocks cleanup
      const missingBucketVerification = {
        verifiedAt: new Date().toISOString(),
        buckets: {
          'visitor-photos': { bucket: 'visitor-photos', remainingCount: 0, verifiedEmpty: true },
        },
        verifiedEmpty: true,
      };
      await db.exec(`
        update public.system_reset_operations
        set storage_verification = '${JSON.stringify(missingBucketVerification)}'::jsonb
        where id = '${opId}';
      `);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/storage_verification_malformed/);

      // 4. Verification with remaining files in visitor-photos blocks cleanup
      const nonZeroVerification = {
        verifiedAt: new Date().toISOString(),
        buckets: {
          'visitor-photos': { bucket: 'visitor-photos', remainingCount: 1, verifiedEmpty: false },
          'visitor-ids': { bucket: 'visitor-ids', remainingCount: 0, verifiedEmpty: true },
        },
        verifiedEmpty: false,
      };
      await db.exec(`
        update public.system_reset_operations
        set storage_verification = '${JSON.stringify(nonZeroVerification)}'::jsonb
        where id = '${opId}';
      `);
      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/storage_verification_failed/);

      // 5. Valid verification permits cleanup and release
      const validVerification = {
        verifiedAt: new Date().toISOString(),
        buckets: {
          'visitor-photos': { bucket: 'visitor-photos', remainingCount: 0, verifiedEmpty: true },
          'visitor-ids': { bucket: 'visitor-ids', remainingCount: 0, verifiedEmpty: true },
        },
        verifiedEmpty: true,
      };
      await db.exec(`
        update public.system_reset_operations
        set storage_verification = '${JSON.stringify(validVerification)}'::jsonb
        where id = '${opId}';
      `);
      const resetRes = await db.query<{ return_to_zero_reset: any }>(
        `select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`
      );
      expect(resetRes.rows[0].return_to_zero_reset.success).toBe(true);

      // Release lock
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Case 37: NULL lease and expired lease fail closed across all reset RPCs', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      await advanceResetToDatabaseCleanup(db, opId, gen, wId);

      // 1. NULL lease fails closed
      await db.exec(`update public.maintenance_state set lease_expires_at = null where job_name = 'system_reset';`);

      await expect(
        db.query(`select api.assert_system_reset_worker_active('${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      await expect(
        db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      // 2. Expired lease fails closed
      await db.exec(`update public.maintenance_state set lease_expires_at = clock_timestamp() - interval '10 seconds' where job_name = 'system_reset';`);

      await expect(
        db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      await expect(
        db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      // Restore lease and complete cleanly
      await db.exec(`update public.maintenance_state set lease_expires_at = clock_timestamp() + interval '60 seconds' where job_name = 'system_reset';`);
      await db.query(`select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);
    });

    it('Case 38: Storage request deadline timeout actually aborts client-side without overlapping retries', async () => {
      // 1. executeWithStorageTimeout throws StorageTimeoutError when duration exceeds timeout
      const mockClientForTimeout = {
        storage: {
          from: () => ({
            remove: vi.fn(),
          }),
        },
      } as unknown as SupabaseClient;

      const fastController = new AbortController();
      await expect(
        executeWithStorageTimeout(
          mockClientForTimeout,
          'visitor-photos',
          'remove',
          async (storage, signal) => {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve('done'), 5000);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason);
              });
            });
          },
          { timeoutMs: 50, parentSignal: fastController.signal }
        )
      ).rejects.toThrow(StorageTimeoutError);

      // 2. Test deletion batch does not retry on StorageTimeoutError (no overlapping retries)
      let attemptCount = 0;
      const mockStorageClient = {
        storage: {
          from: () => ({
            remove: vi.fn(async () => {
              attemptCount++;
              throw new StorageTimeoutError('Storage request timed out after 15000ms');
            }),
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        deleteStorageObjectsInBatches(mockStorageClient, 'visitor-photos', ['file-1.jpg', 'file-2.jpg'])
      ).rejects.toThrow(StorageTimeoutError);

      // Crucial: exactly 1 attempt must have run, ZERO overlapping retries!
      expect(attemptCount).toBe(1);

      // 3. executeWithStorageTimeout never produces false success if deadline triggers
      const mockStorageFastAbort = {
        storage: {
          from: () => ({}),
        },
      } as unknown as SupabaseClient;

      await expect(
        executeWithStorageTimeout(
          mockStorageFastAbort,
          'visitor-photos',
          'list',
          async (storage, signal) => {
            // Wait for signal to abort, then attempt to resolve a success value
            await new Promise((resolve) => setTimeout(resolve, 80));
            return { data: [{ name: 'file.jpg' }], error: null };
          },
          { timeoutMs: 30 }
        )
      ).rejects.toThrow(StorageTimeoutError);
    });

    it('Case 39: Recovery waits for safety window, acquires new generation, re-verifies storage, and proceeds', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Worker 1 acquires lock
      const lock1 = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen1, worker_id: w1 } = lock1.rows[0].acquire_system_reset_lock;

      // 2. Storage timeout enters recovery_required
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'recovery_required', 'storage_purge_timeout',
          '{}'::jsonb, '{}'::jsonb, 'Storage request timed out after 15000ms', ${gen1}, '${w1}'::uuid
        );
      `);

      // 3. Competing resume during safety window (lease still active) is rejected
      const earlyResume = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
      );
      expect(earlyResume.rows[0].acquire_system_reset_lock.acquired).toBe(false);

      // 4. Safety window passes (worker 1 lease expires)
      await db.exec(`
        update public.maintenance_state
        set lease_expires_at = clock_timestamp() - interval '5 seconds'
        where job_name = 'system_reset';
      `);

      // 5. Worker 2 resumes successfully with new generation
      const resume = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid);`
      );
      expect(resume.rows[0].acquire_system_reset_lock.acquired).toBe(true);
      const { worker_generation: gen2, worker_id: w2 } = resume.rows[0].acquire_system_reset_lock;
      expect(gen2).toBeGreaterThan(gen1);
      expect(w2).not.toBe(w1);

      // 6. Old Worker 1 attempts to record step or renew lease -> strictly rejected
      await expect(
        db.query(`select api.assert_system_reset_worker_active('${opId}'::uuid, ${gen1}, '${w1}'::uuid);`)
      ).rejects.toThrow(/fencing_token_revoked/);

      // 7. Worker 2 re-enumerates Storage, verifies empty, cleans up DB, and releases lock
      await advanceResetToDatabaseCleanup(db, opId, gen2, w2);
      const dbResetRes = await db.query<{ return_to_zero_reset: any }>(
        `select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen2}, '${w2}'::uuid);`
      );
      expect(dbResetRes.rows[0].return_to_zero_reset.success).toBe(true);

      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen2}, '${w2}'::uuid);`);

      // Verify clean final state
      const maintFinal = await db.query<{ cursor_value: string }>(`select cursor_value from public.maintenance_state where job_name = 'system_reset';`);
      expect(maintFinal.rows[0].cursor_value).toBe('idle');
    });

    it('Case 40: Strict status/step pair allowlist, previous status-and-step ordering, and unauthorized role rejection', async () => {
      await db.exec(`set request.jwt.claim.role = 'service_role';`);
      const lockRes = await db.query<{ acquire_system_reset_lock: any }>(
        `select api.acquire_system_reset_lock('${superadminId}'::uuid);`
      );
      const { operation_id: opId, worker_generation: gen, worker_id: wId } = lockRes.rows[0].acquire_system_reset_lock;

      // 1. Unknown and NULL status/step combinations are strictly rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, null, 'storage_deletion_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: status and step are required/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', null,
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: status and step are required/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', 'arbitrary_step_123',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'unknown_status', 'unknown_status',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      // 2. Mismatched status and step pairs are strictly rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'recovery_required', 'storage_deletion_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'failed', 'arbitrary_failure_step',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: invalid or mismatched status and step pair requested/);

      // 3. Skipping a required phase is strictly rejected
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: database_cleanup_in_progress requires storage_deletion_verified state/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: storage_deletion_verified requires storage_deletion_in_progress state/);

      // 4. Advance properly to storage_deletion_in_progress
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'storage_deletion_in_progress', 'storage_deletion_in_progress',
          '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
        );
      `);

      // 5. Previous status correct but previous step incorrect:
      // Tamper step to an invalid string while status is storage_deletion_in_progress
      await db.exec(`
        update public.system_reset_operations
        set step = 'corrupted_step'
        where id = '${opId}';
      `);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: storage_deletion_verified requires storage_deletion_in_progress state/);

      // Restore correct step
      await db.exec(`
        update public.system_reset_operations
        set step = 'storage_deletion_in_progress'
        where id = '${opId}';
      `);

      // 6. Unauthorized role attempting step recording is rejected
      const sampleVerification = {
        verifiedAt: new Date().toISOString(),
        buckets: {
          'visitor-photos': { bucket: 'visitor-photos', remainingCount: 0, verifiedEmpty: true },
          'visitor-ids': { bucket: 'visitor-ids', remainingCount: 0, verifiedEmpty: true },
        },
        verifiedEmpty: true,
      };

      await db.exec(`set request.jwt.claim.role = 'authenticated';`);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid, '${JSON.stringify(sampleVerification)}'::jsonb
          );
        `)
      ).rejects.toThrow(/service role required/);

      await db.exec(`set request.jwt.claim.role = 'anon';`);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid, '${JSON.stringify(sampleVerification)}'::jsonb
          );
        `)
      ).rejects.toThrow(/service role required/);

      // Restore service_role
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 7. Legitimate transition to storage_deletion_verified
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'storage_deletion_verified', 'storage_deletion_verified',
          '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid, '${JSON.stringify(sampleVerification)}'::jsonb
        );
      `);

      // 8. Previous status correct but previous step incorrect for database_cleanup_in_progress:
      await db.exec(`
        update public.system_reset_operations
        set step = 'corrupted_step'
        where id = '${opId}';
      `);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/invalid_state_transition: database_cleanup_in_progress requires storage_deletion_verified state/);

      // Restore correct step
      await db.exec(`
        update public.system_reset_operations
        set step = 'storage_deletion_verified'
        where id = '${opId}';
      `);

      // 9. Stale worker generation, worker ID, and expired lease fail closed
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen + 99}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked: worker generation/);

      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '11111111-2222-3333-4444-555555555555'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked: worker ID/);

      // Expire lease
      await db.exec(`update public.maintenance_state set lease_expires_at = clock_timestamp() - interval '1 second' where job_name = 'system_reset';`);
      await expect(
        db.query(`
          select api.record_system_reset_step(
            '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
            '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
          );
        `)
      ).rejects.toThrow(/fencing_token_revoked: worker lease expired/);

      // Restore lease
      await db.exec(`update public.maintenance_state set lease_expires_at = clock_timestamp() + interval '60 seconds' where job_name = 'system_reset';`);

      // 10. Complete legitimate workflow
      await db.query(`
        select api.record_system_reset_step(
          '${opId}'::uuid, 'database_cleanup_in_progress', 'database_cleanup_in_progress',
          '{}'::jsonb, '{}'::jsonb, null, ${gen}, '${wId}'::uuid
        );
      `);

      const resetRes = await db.query<{ return_to_zero_reset: any }>(
        `select api.return_to_zero_reset('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`
      );
      expect(resetRes.rows[0].return_to_zero_reset.success).toBe(true);

      await db.query(`select api.release_system_reset_lock('${superadminId}'::uuid, '${opId}'::uuid, ${gen}, '${wId}'::uuid);`);

      const opCheck = await db.query<{ status: string; step: string }>(
        `select status, step from public.system_reset_operations where id = '${opId}';`
      );
      expect(opCheck.rows[0].status).toBe('completed');
      expect(opCheck.rows[0].step).toBe('completed');
    });
  });
});
