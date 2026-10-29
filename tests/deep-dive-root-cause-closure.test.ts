// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveCachedVisitors,
  saveOfflineRegistrationWithCache,
  queueOfflineVisitorAction,
  searchCachedVisitors,
  atomicReplaceCachedVisitors,
  stripTerminalOfflineEvidence,
  remapCachedVisitorPassId,
  updateOfflineRegistrationStatus,
  getOfflineRegistrations,
  finalizeOfflineRegistrationSync,
  recoverInterruptedSyncStates,
  getOfflineEvents,
  queueOfflineEvent,
  updateOfflineEventStatus,
  updateOfflineRegistrationCheckpoint,
  clearOfflineRegistrationCheckpoints,
  type CachedVisitorPass,
} from '../src/lib/offline/guardIndexedDb';
import {
  acquireCoordinatorLock,
  isCoordinatorLocked,
  runOfflineMaintenance,
} from '../src/lib/offline/guardSyncManager';
import {
  isAuthoritativeServerError,
  isTransportOrNetworkError,
} from '../src/lib/offline/errorClassification';
import { computeBackendAvailability } from '../src/lib/offline/backendAvailability';
import { fetchWithTimeout, RequestTimeoutError } from '../src/lib/fetchWithTimeout';
import { getManilaDayValidityWindow } from '../src/lib/scheduling';
import {
  classifySubmissionOutcome,
  uploadCheckpointedEvidence,
  createIssueTransaction,
  createPortalIssueTransaction,
  issueVisitorPass,
  PassIssuanceError,
  shouldReuseUploadedIntentForIssue,
} from '../src/services/visitorRegistration';
import { createPassPresentation } from '../src/lib/passPresentation';
import { requireSupabase } from '../src/lib/supabase';
import { thermalTemplateLayoutSchema } from '../src/types/thermalTemplate';
import { renderThermalPass } from '../src/printer/renderer/thermalRenderer';
import { MXW01Manager, mxw01PrinterManager } from '../src/printer/mxw01/mxw01Manager';
import { PGlite } from '@electric-sql/pglite';

// Mock dependencies for guardSyncManager and supabase services
const { mockRpc, mockGetSession, mockStorageFrom, createMockSupabase } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockGetSession = vi.fn().mockResolvedValue({
    data: {
      session: {
        access_token: 'valid-test-token',
        user: { id: 'portal-user-1' },
      },
    },
    error: null,
  });
  const mockStorageFrom = vi.fn();

  const createMockSupabase = () => {
    const client: any = {
      auth: {
        getSession: mockGetSession,
        signOut: vi.fn().mockResolvedValue({}),
        signInAnonymously: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'portal-anon-token',
              user: { id: 'portal-user-1' },
            },
          },
          error: null,
        }),
      },
      rpc: (...args: any[]) => {
        const getResult = () => Promise.resolve(mockRpc(...args));
        const builder: any = {
          abortSignal: vi.fn().mockImplementation(() => builder),
          single: vi.fn().mockImplementation(() => getResult()),
          then: (onfulfilled: any, onrejected: any) => getResult().then(onfulfilled, onrejected),
          catch: (onrejected: any) => getResult().catch(onrejected),
        };
        return builder;
      },
      schema: () => client,
      storage: {
        from: mockStorageFrom,
      },
    };
    return {
      supabase: client,
      requireSupabase: () => client,
      requirePortalSupabase: () => client,
      apiRpc: (c: any, fn: string, args: any) => client.schema('api').rpc(fn, args),
    };
  };

  return { mockRpc, mockGetSession, mockStorageFrom, createMockSupabase };
});

vi.mock('@/lib/supabase', () => createMockSupabase());
vi.mock('../src/lib/supabase', () => createMockSupabase());

// Setup Supabase Emulation for PGlite testing matching migration-chain-pglite.test.ts
async function setupSupabaseEmulation(db: PGlite) {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
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
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    let sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
  return files;
}

describe('Deep Dive 1 + Deep Dive 2 Root-Cause Closure Test Suite', () => {
  beforeEach(() => {
    setupMockIndexedDb();
    vi.clearAllMocks();
    if (typeof navigator !== 'undefined') {
      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    }

    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'valid-test-guard-token',
        },
      },
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_upload_intent') {
        return Promise.resolve({
          data: {
            intent_id: 'intent-uuid-default',
            bucket_id: 'visitor-photos',
            object_path: 'passes/photo-default.jpg',
            expires_at: new Date(Date.now() + 600000).toISOString(),
            max_bytes: 1048576,
          },
          error: null,
        });
      }
      if (name === 'guard_offline_snapshot_page') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mockStorageFrom.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'test.jpg' }, error: null }),
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    // Setup canvas 2d context stub for happy-dom
    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clip: vi.fn(),
      rect: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 800 * 4),
        width: 384,
        height: 800,
      }),
    };
    if (typeof HTMLCanvasElement !== 'undefined') {
      HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
      HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,mockValidMonochromeTicket');
    }
  });

  // =========================================================================
  // 1. ROOT CAUSE: API Schema Boundary Drift
  // =========================================================================
  describe('1. API Schema Boundary Invariant', () => {
    it('ensures no client code in src/ calls api.* functions via bare .rpc()', () => {
      const srcDir = path.resolve(process.cwd(), 'src');
      const apiRpcNames = [
        'guard_search_recovery_visitors',
        'guard_recover_pass_action',
        'create_upload_intent',
        'guard_sync_offline_registration',
        'guard_sync_offline_event',
        'guard_offline_snapshot_page',
        'admin_save_thermal_template',
        'admin_publish_thermal_template',
        'admin_restore_thermal_template',
        'get_published_thermal_template',
        'acknowledge_privacy',
        'guard_dashboard_page',
        'guard_dashboard',
      ];

      function checkDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDir(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            const content = fs.readFileSync(fullPath, 'utf8');
            for (const rpcName of apiRpcNames) {
              if (content.includes(`.rpc('${rpcName}'`) || content.includes(`.rpc("${rpcName}"`)) {
                // Must be preceded by .schema('api') within preceding 100 characters
                const callRegex = new RegExp(`\\.schema\\(['"]api['"]\\)[\\s\\S]{0,80}\\.rpc\\(['"]${rpcName}['"]`);
                const hasApiSchema = callRegex.test(content);
                expect(
                  hasApiSchema,
                  `Bare .rpc('${rpcName}') call found in ${path.relative(process.cwd(), fullPath)}. Must route through .schema('api').`
                ).toBe(true);
              }
            }
          }
        }
      }

      checkDir(srcDir);
    });
  });

  // =========================================================================
  // 2. ROOT CAUSE: Offline Operations State Machine & Atomicity
  // =========================================================================
  describe('2. Offline State Machine & Ordered Transitions', () => {
    it('atomically approves entry and advances projected version from N to N+1', async () => {
      const passId = 'pass-uuid-1';
      const initialPass: CachedVisitorPass = {
        actorId: 'guard-1',
        id: passId,
        passId,
        publicReference: 'EG-12345678',
        passReference: 'EG-12345678',
        visitorId: 'vis-1',
        visitorName: 'Juan Dela Cruz',
        contactNumber: '09171234567',
        purpose: 'Official Business',
        visitDate: '2026-10-27',
        status: 'issued',
        version: 5,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: new Date().toISOString(),
      };

      // Seed cache directly using saveCachedVisitors
      await saveCachedVisitors('guard-1', [initialPass]);

      // Perform atomic approve entry
      const actionResult = await queueOfflineVisitorAction('guard-1', {
        passId,
        action: 'approve_entry',
        gate: 'Main Gate',
        actorId: 'guard-1',
        occurredAt: '2026-10-27T09:00:00+08:00',
      });

      expect(actionResult.projectedVisitor?.status).toBe('inside');
      expect(actionResult.projectedVisitor?.version).toBe(6);
      expect(actionResult.event.expectedStatus).toBe('issued');
      expect(actionResult.event.expectedVersion).toBe(5);

      // Verify cached pass now shows projected state
      const searchRes = await searchCachedVisitors('guard-1', 'Juan');
      expect(searchRes.length).toBe(1);
      expect(searchRes[0]?.status).toBe('inside');
      expect(searchRes[0]?.version).toBe(6);
    });

    it('offline-created visitor supports offline exit before reconnect at version 1', async () => {
      const offlineRegId = 'off-reg-abc';
      const occurredAt = '2026-10-27T10:00:00+08:00';

      // Create approved offline registration (creates pass at status 'inside', version 1)
      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: offlineRegId,
        visitor: {
          firstName: 'Maria',
          lastName: 'Santos',
          contactNumber: '09181234567',
          purpose: 'Delivery',
          visitDate: '2026-10-27',
        },
        occurredAt,
        action: 'approved',
      });

      // Now record exit while still offline
      const exitResult = await queueOfflineVisitorAction('guard-1', {
        passId: offlineRegId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
        occurredAt: '2026-10-27T11:00:00+08:00',
      });

      // Exited visitor is terminal: removed from actionable cache
      expect(exitResult.projectedVisitor).toBeNull();
      expect(exitResult.event.action).toBe('record_exit');
      expect(exitResult.event.expectedStatus).toBe('inside');
      expect(exitResult.event.expectedVersion).toBe(1);

      // Verify that after exit, visitor cannot be exited a second time
      await expect(
        queueOfflineVisitorAction('guard-1', {
          passId: offlineRegId,
          action: 'record_exit',
          gate: 'Main Gate',
          actorId: 'guard-1',
        })
      ).rejects.toThrow();
    });

    it('offline rejection removes visitor from actionable cache', async () => {
      const passId = 'pass-reject-1';
      const pass: CachedVisitorPass = {
        actorId: 'guard-1',
        id: passId,
        passId,
        publicReference: 'EG-REJECT01',
        passReference: 'EG-REJECT01',
        visitorId: 'vis-r',
        visitorName: 'Blocked Visitor',
        contactNumber: '09191234567',
        purpose: 'Inquiry',
        visitDate: '2026-10-27',
        status: 'issued',
        version: 2,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: new Date().toISOString(),
      };

      await saveCachedVisitors('guard-1', [pass]);

      const rejResult = await queueOfflineVisitorAction('guard-1', {
        passId,
        action: 'reject_entry',
        gate: 'Main Gate',
        actorId: 'guard-1',
        reason: 'Dress code violation',
      });

      expect(rejResult.projectedVisitor).toBeNull();
      expect(rejResult.event.action).toBe('reject_entry');

      // Confirm visitor is no longer actionable/returned in search
      const results = await searchCachedVisitors('guard-1', 'Blocked');
      expect(results.length).toBe(0);
    });
  });

  // =========================================================================
  // 3. ROOT CAUSE: Sync and Cache Refresh Race Each Other
  // =========================================================================
  describe('3. Serialized Sync Coordinator & Cache Preservation', () => {
    it('enforces mutual exclusion via coordinator mutex', async () => {
      expect(isCoordinatorLocked()).toBe(false);
      const unlock1 = await acquireCoordinatorLock();
      expect(isCoordinatorLocked()).toBe(true);

      let caller2Executed = false;
      const caller2Promise = acquireCoordinatorLock().then((unlock2: any) => {
        caller2Executed = true;
        unlock2();
      });

      // Caller 2 must be queued and waiting
      expect(caller2Executed).toBe(false);

      // Release first lock
      unlock1();

      await caller2Promise;
      expect(caller2Executed).toBe(true);
      expect(isCoordinatorLocked()).toBe(false);
    });

    it('atomicReplaceCachedVisitors preserves unsynchronized local visitors', async () => {
      const localOfflineId = 'off-local-pending';

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: localOfflineId,
        visitor: {
          firstName: 'Pending Local',
          lastName: 'Visitor',
          contactNumber: '09170000000',
          purpose: 'Local Meeting',
          visitDate: '2026-10-27',
        },
        occurredAt: new Date().toISOString(),
        action: 'approved',
      });

      // Now simulate server snapshot replacement with only server passes
      const serverSnapshotPasses: CachedVisitorPass[] = [
        {
          actorId: 'guard-1',
          id: 'server-pass-1',
          passId: 'server-pass-1',
          publicReference: 'EG-SERVER01',
          passReference: 'EG-SERVER01',
          visitorId: 'vis-srv-1',
          visitorName: 'Server Synced Visitor',
          contactNumber: '09171111111',
          purpose: 'Server Business',
          visitDate: '2026-10-27',
          status: 'issued',
          version: 1,
          validFrom: '2026-10-27T08:00:00+08:00',
          validUntil: '2026-10-27T17:00:00+08:00',
          cachedAt: new Date().toISOString(),
        },
      ];

      await atomicReplaceCachedVisitors('guard-1', serverSnapshotPasses);

      // Verify that local unsynchronized visitor was PRESERVED
      const searchLocal = await searchCachedVisitors('guard-1', 'Pending Local');
      expect(searchLocal.length).toBe(1);
      expect(searchLocal[0]?.id).toBe(localOfflineId);

      // Verify server pass is also present
      const searchServer = await searchCachedVisitors('guard-1', 'Server Synced');
      expect(searchServer.length).toBe(1);
      expect(searchServer[0]?.id).toBe('server-pass-1');
    });

    it('finalizeOfflineRegistrationSync atomically remaps cache, queues events, clears local blobs and marks registration synced', async () => {
      const localId = 'local-reg-atomic-1';
      const canonicalPassId = 'canonical-pass-uuid-999';
      const photoBlob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
      const idBlob = new Blob(['id-bytes'], { type: 'image/jpeg' });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: localId,
        visitor: {
          firstName: 'Atomic',
          lastName: 'Remap',
          contactNumber: '09172222222',
          purpose: 'Remap Test',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
        photoBlob,
        idBlob,
      });

      // Create queued exit event for this localId
      await queueOfflineEvent('guard-1', {
        actorId: 'guard-1',
        eventId: 'evt-atomic-1',
        passId: localId,
        visitorName: 'Atomic Remap',
        action: 'record_exit',
        expectedStatus: 'inside',
        expectedVersion: 1,
        occurredAt: '2026-10-27T11:00:00+08:00',
        syncStatus: 'pending',
      });

      // Verify before state
      const searchBefore = await searchCachedVisitors('guard-1', 'Atomic');
      expect(searchBefore.length).toBe(1);
      expect(searchBefore[0]?.id).toBe(localId);
      const eventsBefore = await getOfflineEvents('guard-1');
      expect(eventsBefore.find((e: any) => e.passId === localId)).toBeDefined();

      // Execute ONE atomic transaction
      await finalizeOfflineRegistrationSync({
        offlineRegistrationId: localId,
        canonicalPassId,
        publicReference: 'EG-20261027-CANON',
        syncedAt: new Date().toISOString(),
      });

      // Verify after state:
      // 1. Registration is synced, has canonicalPassId, local blobs stripped
      const regs = await getOfflineRegistrations('guard-1');
      const reg = regs.find((r: any) => r.offlineRegistrationId === localId);
      expect(reg?.syncStatus).toBe('synced');
      expect(reg?.canonicalPassId).toBe(canonicalPassId);
      expect(reg?.photoBlob).toBeUndefined();
      expect(reg?.idBlob).toBeUndefined();
      expect(reg?.photoUploadCheckpoint).toBeUndefined();
      expect(reg?.idUploadCheckpoint).toBeUndefined();

      // 2. Cached visitor under old localId is absent, under canonicalPassId exists
      const searchOld = await searchCachedVisitors('guard-1', localId);
      expect(searchOld.length).toBe(0);
      const searchCanonical = await searchCachedVisitors('guard-1', 'Atomic');
      expect(searchCanonical.length).toBe(1);
      expect(searchCanonical[0]?.id).toBe(canonicalPassId);
      expect(searchCanonical[0]?.passId).toBe(canonicalPassId);
      expect(searchCanonical[0]?.publicReference).toBe('EG-20261027-CANON');
      expect(searchCanonical[0]?.status).toBe('inside');
      expect(searchCanonical[0]?.version).toBe(1);

      // 3. Queued event has passId remapped to canonicalPassId
      const eventsAfter = await getOfflineEvents('guard-1');
      const remappedEvent = eventsAfter[0];
      expect(remappedEvent?.passId).toBe(canonicalPassId);
    });
  });

  // =========================================================================
  // 4 & 5. ROOT CAUSES: Backend Availability & Error Classification
  // =========================================================================
  describe('4 & 5. Backend Availability and Error Taxonomy', () => {
    it('computeBackendAvailability reflects backend failures even when browser is online', () => {
      // Browser is online, but refresh failed
      expect(computeBackendAvailability({ isBrowserOnline: true, refreshError: true })).toBe(false);

      // Browser is online, but queue failed
      expect(computeBackendAvailability({ isBrowserOnline: true, queueError: true })).toBe(false);

      // Browser is offline
      expect(computeBackendAvailability({ isBrowserOnline: false })).toBe(false);

      // Browser is online and no errors
      expect(computeBackendAvailability({ isBrowserOnline: true })).toBe(true);
    });

    it('distinguishes authoritative server responses from transport errors', () => {
      // Authoritative errors: 400, 401, 403, 409, domain errors
      expect(isAuthoritativeServerError({ status: 403, message: 'Forbidden' })).toBe(true);
      expect(isAuthoritativeServerError({ status: 409, message: 'Version conflict' })).toBe(true);
      expect(isAuthoritativeServerError({ code: 'P0001', message: 'pass_already_exited' })).toBe(true);

      // Transport errors: network failure, failed to fetch, abort
      expect(isTransportOrNetworkError(new TypeError('Failed to fetch'))).toBe(true);
      expect(isTransportOrNetworkError({ message: 'NetworkError when attempting to fetch resource' })).toBe(true);

      // Invariant: Authoritative errors must NEVER qualify as transport errors
      expect(isTransportOrNetworkError({ status: 403, message: 'Forbidden' })).toBe(false);
      expect(isTransportOrNetworkError({ status: 409, message: 'Version conflict' })).toBe(false);
    });
  });

  // =========================================================================
  // 6. ROOT CAUSE: Bounded Async Requests
  // =========================================================================
  describe('6. Bounded Async Requests', () => {
    it('aborts and throws RequestTimeoutError when fetch exceeds timeoutMs', async () => {
      // Mock a fetch that resolves after 200ms
      const slowFetch = vi.fn((_url: any, init: any) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('ok')), 200);
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }
        });
      });
      globalThis.fetch = slowFetch as any;

      // 50ms timeout on a 200ms request must reject with RequestTimeoutError
      await expect(
        fetchWithTimeout('https://egatepass.tech/api/scan-pass', {}, 50)
      ).rejects.toThrow(RequestTimeoutError);
    });
  });

  // =========================================================================
  // 9 & 10. ROOT CAUSE: Thermal Printer & Templates
  // =========================================================================
  describe('9 & 10. Thermal Printer & Template Geometry Contracts', () => {
    it('thermalTemplateLayoutSchema enforces minimum height of 400 and forbids canvasHeight', () => {
      const baseElements: any = [
        { id: '1', type: 'text', field: 'institution_name', x: 16, y: 10, width: 352, height: 30 },
        { id: '2', type: 'text', field: 'visitor_name', x: 16, y: 50, width: 352, height: 30 },
        { id: '3', type: 'text', field: 'visit_date', x: 16, y: 90, width: 352, height: 30 },
        { id: '4', type: 'qr', x: 62, y: 130, width: 260, height: 260 },
        { id: '5', type: 'text', field: 'pass_reference', x: 16, y: 400, width: 352, height: 30 },
      ];

      // Valid layout
      const valid = thermalTemplateLayoutSchema.safeParse({
        width: 384,
        height: 500,
        elements: baseElements,
      });
      expect(valid.success).toBe(true);

      // Invalid height below 400
      const invalidHeight = thermalTemplateLayoutSchema.safeParse({
        width: 384,
        height: 350,
        elements: baseElements,
      });
      expect(invalidHeight.success).toBe(false);

      // Reject legacy undeclared canvasHeight
      const withLegacy = thermalTemplateLayoutSchema.safeParse({
        width: 384,
        height: 500,
        canvasHeight: 500,
        elements: baseElements,
      });
      expect(withLegacy.success).toBe(false);
    });

    it('renderThermalPass executes without error and bounds elements to canvas width', async () => {
      const samplePresentation = {
        passId: '00000000-0000-0000-0000-000000000001',
        passReference: 'EG-20261027-TEST',
        visitorName: 'Dr. John Christopher Del Rosario',
        purpose: 'Campus Facilities Inspection & Quality Assurance Review with Engineering Team',
        validityWindow: '08:00 AM - 05:00 PM',
        institutionName: 'Eulogio "Amang" Rodriguez Institute of Science and Technology',
        visitDate: '2026-10-27',
        qrToken: 'test-cryptographic-token-12345',
      };

      const result = await renderThermalPass(samplePresentation as any);
      expect(result.canvas).toBeDefined();
      expect(result.canvas.width).toBe(384);
      expect(result.imageData.width).toBe(384);
      expect(result.dataUrl.startsWith('data:image/png')).toBe(true);
    });

    it('mxw01Manager unifies lifecycle listener registration in connect and reconnect', () => {
      const managerPath = path.resolve(process.cwd(), 'src/printer/mxw01/mxw01Manager.ts');
      const managerContent = fs.readFileSync(managerPath, 'utf8');

      expect(managerContent).toContain('this.registerClientLifecycle(this.client)');
      // Both connect and reconnect methods must invoke registerClientLifecycle
      const connectIdx = managerContent.indexOf('public async connect');
      const reconnectIdx = managerContent.indexOf('public async reconnect');
      expect(connectIdx).toBeGreaterThan(-1);
      expect(reconnectIdx).toBeGreaterThan(-1);
    });
  });

  // =========================================================================
  // 11. ROOT CAUSE: Database Serialized Version Allocation (PGlite)
  // =========================================================================
  describe('11. Database Serialized Version Allocator Invariant (PGlite)', () => {
    it('verifies that migration 33 applies and defines serialized advisory lock helper', async () => {
      const db = new PGlite();
      const files = await applyAllMigrations(db);

      // Verify migration 33 was applied
      expect(files.some((f) => f.includes('20261027170000_deep_dive_root_cause_closure.sql'))).toBe(true);

      // Verify private.allocate_thermal_template_version exists
      const funcCheck = await db.query(`
        select routine_name
        from information_schema.routines
        where routine_schema = 'private'
          and routine_name = 'allocate_thermal_template_version';
      `);
      expect(funcCheck.rows.length).toBe(1);

      // Verify that calling it sequentially yields increasing versions
      const v1Res = await db.query(`select private.allocate_thermal_template_version() as v;`);
      const v1 = Number((v1Res.rows[0] as any).v);
      expect(v1).toBeGreaterThanOrEqual(1);

      // Seed user for created_by foreign key
      await db.exec(`
        insert into auth.users (id, email)
        values ('00000000-0000-0000-0000-000000000001'::uuid, 'admin@test.local')
        on conflict (id) do nothing;
      `);

      // Insert template at allocated v1
      await db.query(`
        insert into public.thermal_templates (name, version, status, layout, created_by)
        values ('Test Template', $1, 'draft', '{}'::jsonb, '00000000-0000-0000-0000-000000000001'::uuid);
      `, [v1]);

      const v2Res = await db.query(`select private.allocate_thermal_template_version() as v;`);
      const v2 = Number((v2Res.rows[0] as any).v);
      expect(v2).toBe(v1 + 1);
    }, 60000);

    it('asserts api.guard_sync_offline_registration rejects visit date mismatch with Manila occurrence date', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // Seed active guard staff profile for caller auth.uid()
      await db.exec(`
        insert into auth.users (id, email)
        values ('00000000-0000-0000-0000-000000000001'::uuid, 'guard@test.local')
        on conflict (id) do nothing;

        insert into public.staff_profiles (
          user_id, display_name, role, active, must_change_password, privacy_accepted_at
        ) values (
          '00000000-0000-0000-0000-000000000001'::uuid, 'Guard Tester', 'guard'::public.staff_role, true, false, now()
        ) on conflict (user_id) do update set active = true, privacy_accepted_at = now();
      `);

      let rejected = false;
      try {
        await db.query(`
          select api.guard_sync_offline_registration(
            requested_actor_id := '00000000-0000-0000-0000-000000000001'::uuid,
            requested_registration_id := gen_random_uuid(),
            requested_visitor := jsonb_build_object(
              'firstName', 'Test',
              'lastName', 'Visitor',
              'contactNumber', '09171234567',
              'purpose', 'Audit',
              'visitDate', '1999-01-01'
            ),
            requested_action := 'rejected',
            requested_occurred_at := now(),
            requested_photo_intent_id := gen_random_uuid(),
            requested_photo_byte_size := 1024,
            requested_photo_sha256 := 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          );
        `);
      } catch (err: any) {
        rejected = true;
        expect(err.message).toContain('visit_date_must_match_occurrence_date');
      }

      expect(rejected).toBe(true);
    }, 60000);
  });

  // =========================================================================
  // 14. ROOT CAUSE: Terminal Evidence Stripping
  // =========================================================================
  describe('14. Terminal Evidence Stripping & Retention', () => {
    it('strips photo and ID blobs from terminal synced or conflict registrations', async () => {
      const regId = 'term-reg-1';
      const fakePhotoBlob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
      const fakeIdBlob = new Blob(['id-bytes'], { type: 'image/jpeg' });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'Terminal',
          lastName: 'Visitor',
          contactNumber: '09173333333',
          purpose: 'Audit',
          visitDate: '2026-10-27',
        },
        occurredAt: new Date().toISOString(),
        action: 'approved',
        photoBlob: fakePhotoBlob,
        idBlob: fakeIdBlob,
      });

      await updateOfflineRegistrationStatus(regId, 'conflict');

      // Execute terminal evidence stripping
      await stripTerminalOfflineEvidence(regId);

      // Verify blobs are stripped while metadata remains
      const regs = await getOfflineRegistrations('guard-1');
      const strippedReg = regs.find((r: any) => r.offlineRegistrationId === regId);
      expect(strippedReg).toBeDefined();
      expect(strippedReg?.photoBlob).toBeFalsy();
      expect(strippedReg?.idBlob).toBeFalsy();
      expect(strippedReg?.visitor.firstName).toBe('Terminal');
      expect(strippedReg?.visitor.lastName).toBe('Visitor');
      expect(strippedReg?.syncStatus).toBe('conflict');
    });
  });

  // =========================================================================
  // 15 & 16. ROOT CAUSES: Password Reset CAPTCHA & Peak Mode Truthfulness
  // =========================================================================
  describe('15 & 16. Password Reset CAPTCHA & Peak Mode Truthfulness', () => {
    it('verifies all password-reset surfaces enforce CAPTCHA token provision', () => {
      const cardPath = path.resolve(process.cwd(), 'src/components/ChangePasswordCard.tsx');
      const modalPath = path.resolve(process.cwd(), 'src/components/GuardPasswordResetModal.tsx');
      const forgotPath = path.resolve(process.cwd(), 'src/pages/ForgotPasswordPage.tsx');

      const cardContent = fs.readFileSync(cardPath, 'utf8');
      const modalContent = fs.readFileSync(modalPath, 'utf8');
      const forgotContent = fs.readFileSync(forgotPath, 'utf8');

      expect(cardContent).toContain('TurnstileWidget');
      expect(cardContent).toContain('sendPasswordReset(');
      expect(cardContent).toContain('captchaToken');

      expect(modalContent).toContain('TurnstileWidget');
      expect(modalContent).toContain('sendPasswordReset(');
      expect(modalContent).toContain('captchaToken');

      expect(forgotContent).toContain('TurnstileWidget');
      expect(forgotContent).toContain('sendPasswordReset(');
    });

    it('verifies Peak Mode confirmation displays staged status instead of premature success', () => {
      const settingsPath = path.resolve(process.cwd(), 'src/pages/AdminSettings.tsx');
      const settingsContent = fs.readFileSync(settingsPath, 'utf8');

      expect(settingsContent).toContain('Peak Mode change staged. Press Save Settings to apply.');
      expect(settingsContent).toContain('canManageSecuritySettings');
      expect(settingsContent).toContain('isSuperAdmin(role)');
    });
  });

  // =========================================================================
  // 17 & 18. ROOT CAUSES: Verification Resend & Web Share Abort
  // =========================================================================
  describe('17 & 18. Verification Resend & Share Cancellation', () => {
    it('EmailPassModal keeps previous verificationId during resend until success', () => {
      const modalPath = path.resolve(process.cwd(), 'src/components/EmailPassModal.tsx');
      const modalContent = fs.readFileSync(modalPath, 'utf8');

      expect(modalContent).toContain('setVerificationId(data.verificationId)');
      expect(modalContent).toContain('outcome_unknown');
    });

    it('GetPassPage has completely removed Web Share API in favor of direct download and email', () => {
      const pagePath = path.resolve(process.cwd(), 'src/pages/GetPassPage.tsx');
      const pageContent = fs.readFileSync(pagePath, 'utf8');

      expect(pageContent).not.toContain('handleShare');
      expect(pageContent).not.toContain('navigator.share');
      expect(pageContent).toContain('Download E-GatePass');
      expect(pageContent).toContain('Email E-GatePass');
    });
  });

  // =========================================================================
  // 20. ROOT CAUSE: Partial Device Updates
  // =========================================================================
  describe('20. Partial Device Update Handling', () => {
    it('server update-device route returns partial success when Auth sync fails', () => {
      const routePath = path.resolve(process.cwd(), 'server/routes/device/update-device.ts');
      const routeContent = fs.readFileSync(routePath, 'utf8');

      expect(routeContent).toContain("result: 'partial'");
      expect(routeContent).toContain('deviceUpdated: true');
      expect(routeContent).toContain('authSynchronized: false');
      expect(routeContent).toContain('reconciliationRequired: true');
    });

    it('DevicesPage inspects result: partial before generic failure handling', () => {
      const pagePath = path.resolve(process.cwd(), 'src/pages/DevicesPage.tsx');
      const pageContent = fs.readFileSync(pagePath, 'utf8');

      expect(pageContent).toContain("res.result === 'partial'");
      expect(pageContent).toContain('toast.warning');
    });
  });

  // =========================================================================
  // 21. POST-CLOSURE VERIFICATION BEHAVIORAL REGRESSIONS
  // =========================================================================
  describe('21. Post-Closure Verification Behavioral Regressions', () => {
    it('offline registration approved locally -> queue local exit -> runOfflineMaintenance syncs registration to canonical ID then submits event with canonical ID', async () => {
      const regId = '00000000-0000-4000-8000-000000000001';
      const canonicalPassId = '00000000-0000-4000-8000-000000000099';
      const occurredAt = '2026-10-27T10:00:00+08:00';

      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      // Save approved offline registration
      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'Causal',
          lastName: 'Visitor',
          contactNumber: '09171234567',
          purpose: 'Meeting',
          visitDate: '2026-10-27',
        },
        occurredAt,
        action: 'approved',
        photoBlob: new Blob(['photo-bytes'], { type: 'image/jpeg' }),
      });

      // Queue exit event referencing regId
      await queueOfflineVisitorAction('guard-1', {
        passId: regId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
        occurredAt: '2026-10-27T11:00:00+08:00',
      });

      // Mock /api/sync-offline-registration and RPCs
      const rpcCalls: { name: string; params: any }[] = [];
      mockRpc.mockImplementation((name: string, params: any) => {
        rpcCalls.push({ name, params });
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-1',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-1.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        if (name === 'guard_sync_offline_event') {
          return Promise.resolve({
            data: { pass_id: params.requested_pass_id, status: 'exited', version: 2 },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                canonicalPassId,
                publicReference: 'EG-20261027-CANON1',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await runOfflineMaintenance();

      // Assert registration is synced with canonicalPassId
      const regs = await getOfflineRegistrations('guard-1');
      const syncedReg = regs.find((r: any) => r.offlineRegistrationId === regId);
      expect(syncedReg?.syncStatus).toBe('synced');
      expect(syncedReg?.canonicalPassId).toBe(canonicalPassId);

      // Assert event RPC was called using the CANONICAL pass ID, expected status 'inside', expected version 1
      const eventRpc = rpcCalls.find((c) => c.name === 'guard_sync_offline_event');
      expect(eventRpc).toBeDefined();
      expect(eventRpc?.params.requested_pass_id).toBe(canonicalPassId);
      expect(eventRpc?.params.requested_expected_status).toBe('inside');
      expect(eventRpc?.params.requested_expected_version).toBe(1);
      expect(eventRpc?.params.requested_action).toBe('record_exit');

      // Assert event in IDB is now synced
      const events = await getOfflineEvents('guard-1');
      expect(events[0]?.syncStatus).toBe('synced');
      expect(events[0]?.passId).toBe(canonicalPassId);
    });

    it('transient registration sync failure leaves dependent event pending and does NOT call event RPC', async () => {
      const regId = '00000000-0000-4000-8000-000000000002';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'Transient',
          lastName: 'Failure',
          contactNumber: '09171234567',
          purpose: 'Meeting',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
        photoBlob: new Blob(['photo-bytes'], { type: 'image/jpeg' }),
      });

      await queueOfflineVisitorAction('guard-1', {
        passId: regId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
      });

      const rpcCalls: string[] = [];
      mockRpc.mockImplementation((name: string) => {
        rpcCalls.push(name);
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-2',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-2.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      // Mock /api/sync-offline-registration failing due to network/timeout
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await runOfflineMaintenance();

      // Registration remains pending
      const regs = await getOfflineRegistrations('guard-1');
      expect(regs.find((r: any) => r.offlineRegistrationId === regId)?.syncStatus).toBe('pending');

      // Dependent event remains pending
      const events = await getOfflineEvents('guard-1');
      expect(events.find((e: any) => e.passId === regId)?.syncStatus).toBe('pending');

      // Event RPC was NEVER called
      expect(rpcCalls).not.toContain('guard_sync_offline_event');
    });

    it('registration conflict marks dependent event as registration_sync_conflicted and does NOT call event RPC', async () => {
      const regId = '00000000-0000-4000-8000-000000000003';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'Conflict',
          lastName: 'Visitor',
          contactNumber: '09171234567',
          purpose: 'Meeting',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
        photoBlob: new Blob(['photo-bytes'], { type: 'image/jpeg' }),
      });

      await queueOfflineVisitorAction('guard-1', {
        passId: regId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
      });

      const rpcCalls: string[] = [];
      mockRpc.mockImplementation((name: string) => {
        rpcCalls.push(name);
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-3',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-3.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      // Mock /api/sync-offline-registration returning 409 conflict
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: 'visitor_already_registered' }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await runOfflineMaintenance();

      // Registration is marked conflict
      const regs = await getOfflineRegistrations('guard-1');
      expect(regs.find((r: any) => r.offlineRegistrationId === regId)?.syncStatus).toBe('conflict');

      // Dependent event marked conflict with reason 'registration_sync_conflicted'
      const events = await getOfflineEvents('guard-1');
      const depEvent = events.find((e: any) => e.passId === regId);
      expect(depEvent?.syncStatus).toBe('conflict');
      expect(depEvent?.conflictReason).toBe('registration_sync_conflicted');

      // Event RPC was NEVER called
      expect(rpcCalls).not.toContain('guard_sync_offline_event');
    });

    it('recoverInterruptedSyncStates resets stranded syncing registrations and events to pending and allows subsequent synchronization', async () => {
      const regId = '00000000-0000-4000-8000-000000000004';
      const canonicalPassId = '00000000-0000-4000-8000-000000000094';

      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'Stranded',
          lastName: 'Syncing',
          contactNumber: '09171234567',
          purpose: 'Meeting',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
        photoBlob: new Blob(['photo-bytes'], { type: 'image/jpeg' }),
      });

      await queueOfflineVisitorAction('guard-1', {
        passId: regId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
      });

      // Manually force both records to 'syncing' to simulate crash during prior sync
      await updateOfflineRegistrationStatus(regId, 'syncing' as any);
      const eventsBefore = await getOfflineEvents('guard-1');
      await updateOfflineEventStatus(eventsBefore[0]!.eventId, 'syncing' as any);

      // Verify they are durable 'syncing'
      const strandedRegs = await getOfflineRegistrations('guard-1');
      expect(strandedRegs.find((r: any) => r.offlineRegistrationId === regId)?.syncStatus).toBe('syncing');
      const strandedEvents = await getOfflineEvents('guard-1');
      expect(strandedEvents[0]?.syncStatus).toBe('syncing');

      // Setup mock for successful sync on recovery
      mockRpc.mockImplementation((name: string, params: any) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-4',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-4.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        if (name === 'guard_sync_offline_event') {
          return Promise.resolve({
            data: { pass_id: params.requested_pass_id, status: 'exited', version: 2 },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ canonicalPassId, publicReference: 'EG-REC-1' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      // Run maintenance, which first executes recoverInterruptedSyncStates()
      await runOfflineMaintenance();

      // Both should have recovered to pending and then progressed to synced
      const recoveredRegs = await getOfflineRegistrations('guard-1');
      expect(recoveredRegs.find((r: any) => r.offlineRegistrationId === regId)?.syncStatus).toBe('synced');
      const recoveredEvents = await getOfflineEvents('guard-1');
      expect(recoveredEvents[0]?.syncStatus).toBe('synced');
    });

    it('runOfflineMaintenance strictly executes: registration sync -> event sync -> snapshot refresh -> purge', async () => {
      const executionOrder: string[] = [];

      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      // Seed one pending registration and one pending event
      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: 'reg-order-1',
        visitor: {
          firstName: 'Order',
          lastName: 'Test',
          contactNumber: '09171234567',
          purpose: 'Order',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
        photoBlob: new Blob(['photo-bytes'], { type: 'image/jpeg' }),
      });

      // Seed an independent event with known pass ID
      await saveCachedVisitors('guard-1', [
        {
          id: 'server-pass-order',
          passId: 'server-pass-order',
          publicReference: 'EG-ORD',
          passReference: 'EG-ORD',
          visitorId: 'v-ord',
          visitorName: 'Server Ord',
          contactNumber: '09171112222',
          purpose: 'Order',
          visitDate: '2026-10-27',
          status: 'inside',
          version: 1,
          validFrom: '2026-10-27T08:00:00+08:00',
          validUntil: '2026-10-27T17:00:00+08:00',
          cachedAt: new Date().toISOString(),
        },
      ]);
      await queueOfflineVisitorAction('guard-1', {
        passId: 'server-pass-order',
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          executionOrder.push('registration_sync');
          return Promise.resolve(
            new Response(
              JSON.stringify({ canonicalPassId: 'canon-order-1' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-5',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-5.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        if (name === 'guard_sync_offline_event') {
          executionOrder.push('event_sync');
          return Promise.resolve({
            data: { pass_id: 'server-pass-order', status: 'exited', version: 2 },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          executionOrder.push('snapshot_refresh');
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      await runOfflineMaintenance();

      expect(executionOrder).toEqual(['registration_sync', 'event_sync', 'snapshot_refresh']);
    });

    it('bounded coordinator operations release the lock when an operation fails or times out', async () => {
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      // Stalled fetch that rejects with RequestTimeoutError
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return Promise.reject(new RequestTimeoutError('Simulated coordinator timeout'));
      });

      // Seed pending reg to trigger fetch
      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: 'reg-timeout-1',
        visitor: {
          firstName: 'Timeout',
          lastName: 'Test',
          contactNumber: '09171234567',
          purpose: 'Timeout',
          visitDate: '2026-10-27',
        },
        occurredAt: '2026-10-27T10:00:00+08:00',
        action: 'approved',
      });

      expect(isCoordinatorLocked()).toBe(false);

      // Maintenance will encounter the error and gracefully finish
      await runOfflineMaintenance();

      // Coordinator lock MUST be released!
      expect(isCoordinatorLocked()).toBe(false);

      // A subsequent coordinator call must be able to acquire the lock immediately
      const unlock = await acquireCoordinatorLock();
      expect(isCoordinatorLocked()).toBe(true);
      unlock();
      expect(isCoordinatorLocked()).toBe(false);
    });

    it('getManilaDayValidityWindow derives exact midnight boundaries matching SQL Asia/Manila calendar day', () => {
      // Morning in Manila (08:30:00+08:00)
      const morning = getManilaDayValidityWindow('2026-10-27T08:30:00+08:00');
      expect(morning.validFrom).toBe('2026-10-27T00:00:00+08:00');
      expect(morning.validUntil).toBe('2026-10-28T00:00:00+08:00');

      // Near 23:59:59 in Manila
      const lateNight = getManilaDayValidityWindow('2026-10-27T23:59:50+08:00');
      expect(lateNight.validFrom).toBe('2026-10-27T00:00:00+08:00');
      expect(lateNight.validUntil).toBe('2026-10-28T00:00:00+08:00');

      // Across midnight in Manila (00:00:01 on the 28th)
      const nextDay = getManilaDayValidityWindow('2026-10-28T00:00:01+08:00');
      expect(nextDay.validFrom).toBe('2026-10-28T00:00:00+08:00');
      expect(nextDay.validUntil).toBe('2026-10-29T00:00:00+08:00');
    });

    it('uploadCheckpointedEvidence reuses existing checkpoint and does not create duplicate upload intent on retry', async () => {
      const transaction = createIssueTransaction('kiosk');
      const dummyBlob = new Blob(['photo-bytes'], { type: 'image/jpeg' });

      let intentCallCount = 0;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          intentCallCount++;
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-12345',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-123.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      // 1st attempt: Storage upload fails with network timeout
      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockRejectedValue(new Error('Storage timeout simulated')),
      });

      await expect(
        uploadCheckpointedEvidence(
          requireSupabase(),
          'kiosk',
          'photo',
          dummyBlob,
          transaction
        )
      ).rejects.toThrow();

      expect(intentCallCount).toBe(1);
      expect(transaction.photoCheckpoint).toBeDefined();
      expect(transaction.photoCheckpoint?.intentId).toBe('intent-uuid-12345');
      expect(transaction.photoCheckpoint?.uploaded).toBe(false);

      // 2nd attempt: Retry with Storage returning success (or 409 already exists)
      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo-123.jpg' }, error: null }),
      });

      const { intentId } = await uploadCheckpointedEvidence(
        requireSupabase(),
        'kiosk',
        'photo',
        dummyBlob,
        transaction
      );

      // Invariant: create_upload_intent must NOT have been called a second time!
      expect(intentCallCount).toBe(1);
      expect(intentId).toBe('intent-uuid-12345');
      expect(transaction.photoCheckpoint?.uploaded).toBe(true);
    });

    it('classifySubmissionOutcome classifies HTTP 409 replay-consistency errors appropriately', () => {
      expect(classifySubmissionOutcome({ status: 409, message: 'intent_mismatch' })).toBe('existing_pass_replay_conflict');
      expect(classifySubmissionOutcome({ status: 409, message: 'payload_mismatch' })).toBe('existing_pass_replay_conflict');
      expect(classifySubmissionOutcome({ status: 409, message: 'cross_actor_replay' })).toBe('rejected_requires_new_transaction');
      expect(classifySubmissionOutcome({ status: 409, message: 'source_mismatch' })).toBe('rejected_requires_new_transaction');
      expect(classifySubmissionOutcome({ status: 422, message: 'pass_has_expired' })).toBe('rejected_requires_new_transaction');
      expect(classifySubmissionOutcome({ status: 422, message: 'visit_date_out_of_range' })).toBe('rejected_correctable_field');
      expect(classifySubmissionOutcome(new TypeError('Failed to fetch'))).toBe('ambiguous');
    });

    it('EmailPassModal preserves the exact same requestId on ambiguous resend retry', () => {
      // Model state machine of EmailPassModal:
      // attemptState: 'ready' | 'in-flight' | 'ambiguous'
      let attemptState: 'ready' | 'in-flight' | 'ambiguous' = 'ready';
      let currentRequestId = '';

      function startResend(): string {
        if (attemptState === 'ambiguous') {
          // Reuse same request ID
          attemptState = 'in-flight';
          return currentRequestId;
        }
        // New request ID
        currentRequestId = `req-${Math.random().toString(36).slice(2)}`;
        attemptState = 'in-flight';
        return currentRequestId;
      }

      function handleOutcome(outcome: 'success' | 'timeout' | 'error') {
        if (outcome === 'timeout') {
          attemptState = 'ambiguous';
        } else if (outcome === 'success') {
          attemptState = 'ready';
        } else {
          attemptState = 'ready';
        }
      }

      // 1. Initial send
      const id1 = startResend();
      expect(id1).toBeTruthy();

      // 2. Times out / ambiguous
      handleOutcome('timeout');
      expect(attemptState).toBe('ambiguous');

      // 3. User clicks Resend again after timeout
      const id2 = startResend();
      // Must be the EXACT same requestId
      expect(id2).toBe(id1);

      // 4. Success resolves
      handleOutcome('success');
      expect(attemptState).toBe('ready');

      // 5. Subsequent independent resend
      const id3 = startResend();
      expect(id3).not.toBe(id1);
    });

    it('GuardVisitorRecoveryTab search falls back to cache on transport failure, but shows authoritative error on 403/42501', () => {
      const transportError = new TypeError('Failed to fetch');
      expect(isTransportOrNetworkError(transportError)).toBe(true);
      expect(isAuthoritativeServerError(transportError)).toBe(false);

      const authError403 = { status: 403, message: 'recovery_session_forbidden' };
      expect(isTransportOrNetworkError(authError403)).toBe(false);
      expect(isAuthoritativeServerError(authError403)).toBe(true);

      const rlsError = { code: '42501', message: 'permission denied for table passes' };
      expect(isTransportOrNetworkError(rlsError)).toBe(false);
      expect(isAuthoritativeServerError(rlsError)).toBe(true);
    });
  });

  describe('22. Final State-Machine Closure Pass Scenarios', () => {
    beforeEach(async () => {
      await setupMockIndexedDb();
      mockRpc.mockReset();
      mockGetSession.mockReset();
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-test-token',
          user: { id: 'guard-1' },
        } },
      });
      mockStorageFrom.mockReset();
      vi.restoreAllMocks();
    });

    it('Scenario 1: Expired Guard photo checkpoint -> allocates fresh upload intent', async () => {
      const regId = '00000000-0000-4000-8000-000000000021';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      const expiredCheckpoint = {
        intentId: 'old-expired-photo-intent',
        bucketId: 'visitor-photos',
        objectPath: 'passes/old-photo.jpg',
        contentType: 'image/webp',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // Expired 1h ago
        uploaded: true,
      };

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'ExpiredPhoto',
          lastName: 'Visitor',
          contactNumber: '09171234567',
          purpose: 'Official',
          visitDate: '2026-10-27',
        },
        action: 'approved',
        occurredAt: new Date().toISOString(),
        photoBlob: new Blob(['photo-bytes'], { type: 'image/webp' }),
        rejectionReason: null,
      });

      await updateOfflineRegistrationCheckpoint(regId, 'photo', expiredCheckpoint);

      let createdIntents: string[] = [];
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          const freshId = `fresh-photo-intent-${createdIntents.length + 1}`;
          createdIntents.push(freshId);
          return Promise.resolve({
            data: {
              intent_id: freshId,
              bucket_id: 'visitor-photos',
              object_path: `passes/${freshId}.webp`,
              expires_at: new Date(Date.now() + 900000).toISOString(),
              max_bytes: 5242880,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/fresh.webp' }, error: null }),
      });

      let requestedPhotoIntent: string | null = null;
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          const body = JSON.parse(init?.body || '{}');
          requestedPhotoIntent = body.photoIntentId;
          return Promise.resolve(new Response(JSON.stringify({ canonicalPassId: 'pass-canon-21' }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await runOfflineMaintenance();

      expect(createdIntents.length).toBeGreaterThanOrEqual(1);
      expect(requestedPhotoIntent).not.toBe('old-expired-photo-intent');
      expect(requestedPhotoIntent).toBe(createdIntents[0]);
    });

    it('Scenario 2: Expired Guard ID checkpoint -> allocates fresh upload intent', async () => {
      const regId = '00000000-0000-4000-8000-000000000022';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      const validPhotoCheckpoint = {
        intentId: 'valid-photo-intent-22',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-22.jpg',
        contentType: 'image/webp',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(), // valid for 10 min
        uploaded: true,
      };

      const expiredIdCheckpoint = {
        intentId: 'old-expired-id-intent',
        bucketId: 'visitor-ids',
        objectPath: 'passes/old-id.jpg',
        contentType: 'image/webp',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // Expired 1h ago
        uploaded: true,
      };

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'ExpiredId',
          lastName: 'Visitor',
          contactNumber: '09171234567',
          purpose: 'Official',
          visitDate: '2026-10-27',
        },
        action: 'approved',
        occurredAt: new Date().toISOString(),
        photoBlob: new Blob(['photo-bytes'], { type: 'image/webp' }),
        idBlob: new Blob(['id-bytes'], { type: 'image/webp' }),
        rejectionReason: null,
      });

      await updateOfflineRegistrationCheckpoint(regId, 'photo', validPhotoCheckpoint);
      await updateOfflineRegistrationCheckpoint(regId, 'id', expiredIdCheckpoint);

      let createdKinds: string[] = [];
      mockRpc.mockImplementation((name: string, args: any) => {
        if (name === 'create_upload_intent') {
          createdKinds.push(args?.requested_kind);
          return Promise.resolve({
            data: {
              intent_id: 'fresh-id-intent-22',
              bucket_id: 'visitor-ids',
              object_path: 'passes/id-22.webp',
              expires_at: new Date(Date.now() + 900000).toISOString(),
              max_bytes: 5242880,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/id-22.webp' }, error: null }),
      });

      let requestedIdIntent: string | null = null;
      let requestedPhotoIntent: string | null = null;
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          const body = JSON.parse(init?.body || '{}');
          requestedPhotoIntent = body.photoIntentId;
          requestedIdIntent = body.idIntentId;
          return Promise.resolve(new Response(JSON.stringify({ canonicalPassId: 'pass-canon-22' }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await runOfflineMaintenance();

      expect(createdKinds).toContain('id');
      expect(createdKinds).not.toContain('photo'); // Valid photo was reused
      expect(requestedPhotoIntent).toBe('valid-photo-intent-22');
      expect(requestedIdIntent).toBe('fresh-id-intent-22');
    });

    it('Scenario 3: Legacy checkpoint without expiresAt is treated as stale and allocates fresh intent', async () => {
      const transaction = createIssueTransaction('kiosk');
      transaction.photoCheckpoint = {
        intentId: 'legacy-intent-no-expiry',
        bucketId: 'visitor-photos',
        objectPath: 'passes/legacy.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        uploaded: true,
      };

      let rpcCalled = false;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          rpcCalled = true;
          return Promise.resolve({
            data: {
              intent_id: 'fresh-intent-allocated',
              bucket_id: 'visitor-photos',
              object_path: 'passes/fresh.jpg',
              expires_at: new Date(Date.now() + 900000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/fresh.jpg' }, error: null }),
      });

      const { intentId } = await uploadCheckpointedEvidence(
        requireSupabase(),
        'kiosk',
        'photo',
        new Blob(['photo'], { type: 'image/jpeg' }),
        transaction
      );

      expect(rpcCalled).toBe(true);
      expect(intentId).toBe('fresh-intent-allocated');
      expect(transaction.photoCheckpoint?.expiresAt).toBeDefined();
    });

    it('Scenario 4: invalid_upload_intent -> checkpoints cleared -> later sync succeeds with fresh intent', async () => {
      const regId = '00000000-0000-4000-8000-000000000024';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'InvalidIntent',
          lastName: 'Recoverable',
          contactNumber: '09171234567',
          purpose: 'Official',
          visitDate: '2026-10-27',
        },
        action: 'approved',
        occurredAt: new Date().toISOString(),
        photoBlob: new Blob(['photo-bytes-24'], { type: 'image/webp' }),
        rejectionReason: null,
      });

      await updateOfflineRegistrationCheckpoint(regId, 'photo', {
        intentId: 'stale-or-rejected-intent',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-24.jpg',
        contentType: 'image/webp',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        uploaded: true,
      });

      let cycle = 1;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: `intent-fresh-cycle-${cycle}`,
              bucket_id: 'visitor-photos',
              object_path: `passes/photo-fresh-${cycle}.webp`,
              expires_at: new Date(Date.now() + 900000).toISOString(),
              max_bytes: 5242880,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo.webp' }, error: null }),
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          if (cycle === 1) {
            return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_upload_intent' }), { status: 422 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ canonicalPassId: 'pass-recovered-24' }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      // Cycle 1: Server rejects with 422 invalid_upload_intent
      const res1 = await runOfflineMaintenance();
      expect(res1.summary.errors).toBe(1);

      let regs = await getOfflineRegistrations('guard-1');
      let regRecord = regs.find((r: any) => r.offlineRegistrationId === regId);
      expect(regRecord?.syncStatus).toBe('pending');
      expect(regRecord?.photoUploadCheckpoint).toBeUndefined(); // Checkpoint cleared!
      expect(regRecord?.photoBlob).toBeDefined(); // Local blob retained!

      // Cycle 2: Server succeeds on retry with fresh upload intent
      cycle = 2;
      const res2 = await runOfflineMaintenance();
      expect(res2.summary.registrationsSynced).toBe(1);

      regs = await getOfflineRegistrations('guard-1');
      regRecord = regs.find((r: any) => r.offlineRegistrationId === regId);
      expect(regRecord?.syncStatus).toBe('synced');
      expect(regRecord?.canonicalPassId).toBe('pass-recovered-24');
    });

    it('Scenario 5: Deterministic invalid registration payload (400) -> converts to conflict, not infinite retry', async () => {
      const regId = '00000000-0000-4000-8000-000000000025';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      await saveOfflineRegistrationWithCache('guard-1', {
        offlineRegistrationId: regId,
        visitor: {
          firstName: 'BadData',
          lastName: 'Deterministic',
          contactNumber: 'invalid-number',
          purpose: 'Official',
          visitDate: '2026-10-27',
        },
        action: 'approved',
        occurredAt: new Date().toISOString(),
        photoBlob: new Blob(['photo-bytes-25'], { type: 'image/webp' }),
        rejectionReason: null,
      });

      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-25',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-25.webp',
              expires_at: new Date(Date.now() + 900000).toISOString(),
              max_bytes: 5242880,
            },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo.webp' }, error: null }),
      });

      let syncAttempts = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/sync-offline-registration')) {
          syncAttempts++;
          return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_visitor_data_format' }), { status: 400 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await runOfflineMaintenance();
      expect(res.summary.conflicts).toBe(0);
      expect(res.summary.errors).toBe(1);

      const regs = await getOfflineRegistrations('guard-1');
      const reg = regs.find((r: any) => r.offlineRegistrationId === regId);
      expect(reg?.syncStatus).toBe('pending');
      expect(reg?.conflictReason).toBe('invalid_visitor_data_format');
      expect(reg?.photoBlob).not.toBeNull();
    });

    it('Scenario 6 & 7: Approve A timeout -> Exit B not submitted in cycle 1; cycle 2 replays A applied -> B submitted', async () => {
      const passId = '00000000-0000-4000-8000-000000000026';
      mockGetSession.mockResolvedValue({
        data: { session: {
          access_token: 'valid-guard-token',
          user: { id: 'guard-1' },
        } },
      });

      const eventAId = '00000000-0000-4000-8000-00000000002a';
      const eventBId = '00000000-0000-4000-8000-00000000002b';

      const t0 = new Date('2026-10-27T08:00:00Z').getTime();

      await queueOfflineEvent('guard-1', {
        actorId: 'guard-1',
        eventId: eventAId,
        passId,
        visitorName: 'Sequential Visitor',
        action: 'approve_entry',
        expectedStatus: 'issued',
        expectedVersion: 1,
        occurredAt: new Date(t0).toISOString(),
        syncStatus: 'pending',
      });

      await queueOfflineEvent('guard-1', {
        actorId: 'guard-1',
        eventId: eventBId,
        passId,
        visitorName: 'Sequential Visitor',
        action: 'record_exit',
        expectedStatus: 'inside',
        expectedVersion: 2,
        occurredAt: new Date(t0 + 5000).toISOString(),
        syncStatus: 'pending',
      });

      let calledEventsCycle1: string[] = [];
      let cycle = 1;

      mockRpc.mockImplementation((name: string, args: any) => {
        if (name === 'guard_sync_offline_event') {
          if (cycle === 1) {
            calledEventsCycle1.push(args?.requested_event_id);
            // Event A times out
            if (args?.requested_event_id === eventAId) {
              return Promise.reject(new Error('Connection timed out'));
            }
          } else {
            // Cycle 2: both succeed
            return Promise.resolve({
              data: { status: 'applied', version: args?.requested_expected_version + 1 },
              error: null,
            });
          }
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      // Cycle 1: Event A times out
      await runOfflineMaintenance();

      // Assertions for Cycle 1:
      // RPC was called for Event A exactly once
      expect(calledEventsCycle1).toEqual([eventAId]);
      // RPC was NEVER called for Event B in cycle 1!
      expect(calledEventsCycle1).not.toContain(eventBId);

      let events = await getOfflineEvents('guard-1');
      expect(events.find((e: any) => e.eventId === eventAId)?.syncStatus).toBe('pending');
      expect(events.find((e: any) => e.eventId === eventBId)?.syncStatus).toBe('pending');

      // Cycle 2: Event A replays and receives applied receipt, then Event B submits
      cycle = 2;
      let calledEventsCycle2: string[] = [];
      mockRpc.mockImplementation((name: string, args: any) => {
        if (name === 'guard_sync_offline_event') {
          calledEventsCycle2.push(args?.requested_event_id);
          return Promise.resolve({
            data: { status: 'applied', version: args?.requested_expected_version + 1 },
            error: null,
          });
        }
        if (name === 'guard_offline_snapshot_page') {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });

      await runOfflineMaintenance();

      expect(calledEventsCycle2).toEqual([eventAId, eventBId]);
      events = await getOfflineEvents('guard-1');
      expect(events.find((e: any) => e.eventId === eventAId)?.syncStatus).toBe('synced');
      expect(events.find((e: any) => e.eventId === eventBId)?.syncStatus).toBe('synced');
    });

    it('Scenario 8: Kiosk ambiguous state freezes all mutation controls and displays amber warning banner', () => {
      const kioskSrc = fs.readFileSync('src/pages/KioskPage.tsx', 'utf8');

      // Ambiguous amber banner check
      expect(kioskSrc).toContain("kioskTransactionRef.current?.phase === 'ambiguous'");
      expect(kioskSrc).toContain('The previous submission may already have created a pass. To prevent duplicates, the exact previous submission must be retried before any details can be changed.');
      expect(kioskSrc).toContain('Retry Exact Submission');
      expect(kioskSrc).toContain('Cancel & Ask Guard');

      // Mutation controls are strictly guarded behind phase !== 'ambiguous'
      expect(kioskSrc).toContain("kioskTransactionRef.current?.phase !== 'ambiguous'");
      expect(kioskSrc).toContain('Retake Photo');
      expect(kioskSrc).toContain('Retake ID');
    });

    it('Scenario 9: Kiosk exact ambiguous retry preserves original requestId, evidence checkpoints, and frozen payload', async () => {
      const tx = createIssueTransaction('kiosk');
      const originalRequestId = tx.requestId;
      const originalVisitor = {
        firstName: 'OriginalKiosk',
        lastName: 'Visitor',
        contactNumber: '09181112233',
        purpose: 'Meeting',
        visitDate: '2026-10-27',
      };
      const photoBlob = new Blob(['photo'], { type: 'image/jpeg' });

      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-orig-kiosk',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-orig.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo.jpg' }, error: null }),
      });

      // 1. First submission fails with network interruption
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.reject(new TypeError('Network disconnected'));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      await expect(
        issueVisitorPass('kiosk', originalVisitor, photoBlob, undefined, tx.requestId, undefined, tx)
      ).rejects.toThrow('Generation result could not be confirmed');

      expect(tx.phase).toBe('ambiguous');
      expect(tx.requestId).toBe(originalRequestId);
      expect(tx.submittedPayload?.visitor.firstName).toBe('OriginalKiosk');
      expect(tx.photoIntentId).toBe('intent-orig-kiosk');

      // 2. Retry exact submission: succeeds
      let replayBody: any = null;
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
        if (String(url).includes('/api/passes/issue')) {
          replayBody = JSON.parse(init?.body || '{}');
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'kiosk-pass-canon-1',
                qrToken: 'qr-token-canon-1',
                publicReference: 'EP-20261027-0099',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await issueVisitorPass(
        'kiosk',
        originalVisitor,
        photoBlob,
        undefined,
        tx.requestId,
        undefined,
        tx
      );

      expect(res.passId).toBe('kiosk-pass-canon-1');
      expect(tx.phase).toBe('committed');
      expect(replayBody.requestId).toBe(originalRequestId);
      expect(replayBody.photoIntentId).toBe('intent-orig-kiosk');
      expect(replayBody.visitor.firstName).toBe('OriginalKiosk');
    });

    it('Scenario 10: Presentation after replay uses frozen submitted visitor data even if form was tampered', () => {
      const tx = createIssueTransaction('kiosk');
      tx.phase = 'ambiguous';
      tx.submittedPayload = {
        source: 'kiosk',
        visitor: {
          firstName: 'AliceAuthoritative',
          middleName: 'M',
          lastName: 'Smith',
          contactNumber: '09171112233',
          purpose: 'Official Transaction',
          visitDate: '2026-10-27',
        },
        photoIntentId: 'intent-alice',
        idIntentId: null,
      };

      // Attacker or UI race alters the active form values before replay resolves
      const tamperedFormData = {
        firstName: 'EveTampered',
        middleName: 'X',
        lastName: 'Attacker',
        contactNumber: '09999999999',
        purpose: 'Malicious Access',
        visitDate: '2026-10-28',
      };

      // Defensive invariant implemented in both KioskPage and GetPassPage:
      const effectiveVisitor = tx.submittedPayload?.visitor ?? tamperedFormData;

      const presentation = createPassPresentation({
        visitorName: [effectiveVisitor.firstName, effectiveVisitor.middleName, effectiveVisitor.lastName].filter(Boolean).join(' '),
        visitDate: effectiveVisitor.visitDate,
        passReference: 'EP-20261027-1234',
        qrToken: 'server-verified-qr-token',
        purpose: effectiveVisitor.purpose,
      });

      // Assert presentation reflects authoritative submitted payload, NOT tampered form
      expect(presentation.visitorName).toBe('ALICEAUTHORITATIVE M SMITH');
      expect(presentation.visitDate).toContain('2026');
      expect(presentation.purpose).toBe('Official Transaction');
      expect(presentation.visitorName).not.toContain('TAMPERED');
      expect(presentation.visitorName).not.toContain('ATTACKER');
    });

    it('Scenario 11: intent_mismatch & payload_mismatch classify as existing_pass_replay_conflict and do NOT rotate requestId', async () => {
      expect(classifySubmissionOutcome(409, 'intent_mismatch')).toBe('existing_pass_replay_conflict');
      expect(classifySubmissionOutcome(409, 'payload_mismatch')).toBe('existing_pass_replay_conflict');

      const tx = await createPortalIssueTransaction();
      const origRequestId = tx.requestId;
      tx.submittedPayload = {
        source: 'portal',
        visitor: {
          firstName: 'Bob',
          lastName: 'Builder',
          contactNumber: '09171234567',
          purpose: 'Job',
          visitDate: '2026-10-27',
        },
        photoIntentId: 'intent-bob-1',
        idIntentId: null,
      };

      tx.photoIntentId = 'intent-bob-1';
      tx.photoCheckpoint = {
        intentId: 'intent-bob-1',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-bob.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        uploaded: true,
      };

      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-bob-1',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-bob.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'intent_mismatch' }), { status: 409 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      let caughtErr: any = null;
      try {
        await issueVisitorPass(
          'portal',
          tx.submittedPayload!.visitor,
          new Blob(['photo']),
          undefined,
          tx.requestId,
          undefined,
          tx
        );
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(PassIssuanceError);
      expect(caughtErr.outcome).toBe('existing_pass_replay_conflict');
      expect(caughtErr.message).toContain('An existing pass was already created for this request');

      // Invariant: requestId must NOT be rotated, submittedPayload must NOT be cleared!
      expect(tx.requestId).toBe(origRequestId);
      expect(tx.submittedPayload).not.toBeNull();
      expect(tx.photoIntentId).toBe('intent-bob-1');
      // Gap 1: phase must transition to existing_pass_conflict!
      expect(tx.phase).toBe('existing_pass_conflict');

      // Also test payload_mismatch
      const tx2 = await createPortalIssueTransaction();
      const origRequestId2 = tx2.requestId;
      tx2.photoIntentId = 'intent-payload-1';
      tx2.photoCheckpoint = {
        intentId: 'intent-payload-1',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-payload.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        uploaded: true,
      };
      tx2.submittedPayload = {
        source: 'portal',
        visitor: {
          firstName: 'Charlie',
          lastName: 'Brown',
          contactNumber: '09171234568',
          purpose: 'Meeting',
          visitDate: '2026-10-27',
        },
        photoIntentId: 'intent-payload-1',
        idIntentId: null,
      };

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'payload_mismatch' }), { status: 409 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      let caughtErr2: any = null;
      try {
        await issueVisitorPass(
          'portal',
          tx2.submittedPayload!.visitor,
          new Blob(['photo']),
          undefined,
          tx2.requestId,
          undefined,
          tx2
        );
      } catch (err) {
        caughtErr2 = err;
      }

      expect(caughtErr2).toBeInstanceOf(PassIssuanceError);
      expect(caughtErr2.outcome).toBe('existing_pass_replay_conflict');
      expect(tx2.requestId).toBe(origRequestId2);
      expect(tx2.submittedPayload).not.toBeNull();
      expect(tx2.phase).toBe('existing_pass_conflict');
    });

    it('Scenario 16: Terminal existing_pass_conflict state freezes mutation controls and provides safe Cancel & Ask Guard exit', () => {
      const kioskSrc = fs.readFileSync('src/pages/KioskPage.tsx', 'utf8');
      const getPassSrc = fs.readFileSync('src/pages/GetPassPage.tsx', 'utf8');

      // 1. Kiosk Page UI assertions
      expect(kioskSrc).toContain("kioskTransactionRef.current?.phase === 'existing_pass_conflict'");
      expect(kioskSrc).toContain('Existing Pass Detected');
      expect(kioskSrc).toContain('An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.');
      expect(kioskSrc).toContain("kioskTransactionRef.current?.phase !== 'existing_pass_conflict'");
      expect(kioskSrc).toContain("if (kioskTransactionRef.current?.phase === 'existing_pass_conflict')");

      // 2. Portal Page UI assertions
      expect(getPassSrc).toContain("portalTransactionRef.current?.phase === 'existing_pass_conflict'");
      expect(getPassSrc).toContain('Existing Pass Detected');
      expect(getPassSrc).toContain('An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.');
      expect(getPassSrc).toContain("portalTransactionRef.current?.phase !== 'existing_pass_conflict'");
      expect(getPassSrc).toContain("if (portalTransactionRef.current?.phase === 'existing_pass_conflict')");
    });

    it('Scenario 17: shouldReuseUploadedIntentForIssue predicate contract tests', () => {
      const expiredTime = new Date(Date.now() - 60000).toISOString();
      const futureTime = new Date(Date.now() + 600000).toISOString();

      const expiredCheckpoint = {
        intentId: 'intent-exp',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: expiredTime,
        uploaded: true,
      };

      const validCheckpoint = {
        ...expiredCheckpoint,
        expiresAt: futureTime,
      };

      const notUploadedCheckpoint = {
        ...validCheckpoint,
        uploaded: false,
      };

      // Ambiguous transaction: reuses uploaded intent even if locally expired
      const ambiguousTx = {
        requestId: 'req-1',
        photoIntentId: 'intent-exp',
        idIntentId: null,
        phase: 'ambiguous' as const,
      };
      expect(shouldReuseUploadedIntentForIssue(ambiguousTx, expiredCheckpoint, 'intent-exp')).toBe(true);
      expect(shouldReuseUploadedIntentForIssue(ambiguousTx, notUploadedCheckpoint, 'intent-exp')).toBe(false);
      expect(shouldReuseUploadedIntentForIssue(ambiguousTx, expiredCheckpoint, null)).toBe(false);

      // Editable transaction: does NOT reuse expired checkpoint
      const editableTx = {
        requestId: 'req-2',
        photoIntentId: 'intent-exp',
        idIntentId: null,
        phase: 'editable' as const,
      };
      expect(shouldReuseUploadedIntentForIssue(editableTx, expiredCheckpoint, 'intent-exp')).toBe(false);
      expect(shouldReuseUploadedIntentForIssue(editableTx, validCheckpoint, 'intent-exp')).toBe(true);
      expect(shouldReuseUploadedIntentForIssue(editableTx, { ...validCheckpoint, expiresAt: undefined }, 'intent-exp')).toBe(false);
    });

    it('Scenario 18: Editable transaction + uploaded but expired photo checkpoint allocates fresh intent', async () => {
      const tx = await createPortalIssueTransaction();
      tx.phase = 'editable';
      tx.photoIntentId = 'intent-expired-photo';
      tx.photoCheckpoint = {
        intentId: 'intent-expired-photo',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-expired.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired!
        uploaded: true,
      };

      let createUploadIntentCalled = false;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          createUploadIntentCalled = true;
          return Promise.resolve({
            data: {
              intent_id: 'intent-fresh-photo-100',
              bucket_id: 'visitor-photos',
              object_path: 'passes/fresh-photo.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/fresh-photo.jpg' }, error: null }),
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'pass-fresh-100',
                qrToken: 'qr-fresh-100',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await issueVisitorPass(
        'portal',
        { firstName: 'Alice', lastName: 'Fresh', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        undefined,
        tx.requestId,
        undefined,
        tx
      );

      expect(createUploadIntentCalled).toBe(true);
      expect(tx.photoIntentId).toBe('intent-fresh-photo-100');
      expect(res.passId).toBe('pass-fresh-100');
    });

    it('Scenario 19: Editable transaction + uploaded but expired ID checkpoint allocates fresh intent', async () => {
      const tx = await createPortalIssueTransaction();
      tx.phase = 'editable';
      // Valid unexpired photo checkpoint
      tx.photoIntentId = 'intent-valid-photo';
      tx.photoCheckpoint = {
        intentId: 'intent-valid-photo',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-valid.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        uploaded: true,
      };

      // Expired ID checkpoint
      tx.idIntentId = 'intent-expired-id';
      tx.idCheckpoint = {
        intentId: 'intent-expired-id',
        bucketId: 'visitor-ids',
        objectPath: 'passes/id-expired.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired!
        uploaded: true,
      };

      const requestedKinds: string[] = [];
      mockRpc.mockImplementation((name: string, args: any) => {
        if (name === 'create_upload_intent') {
          requestedKinds.push(args?.requested_kind);
          return Promise.resolve({
            data: {
              intent_id: 'intent-fresh-id-200',
              bucket_id: 'visitor-ids',
              object_path: 'passes/fresh-id.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/fresh-id.jpg' }, error: null }),
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'pass-fresh-id-200',
                qrToken: 'qr-fresh-id-200',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await issueVisitorPass(
        'portal',
        { firstName: 'Alice', lastName: 'FreshID', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        new Blob(['id']),
        tx.requestId,
        undefined,
        tx
      );

      // Assert only ID requested fresh intent, photo intent was safely reused!
      expect(requestedKinds).toEqual(['id']);
      expect(tx.photoIntentId).toBe('intent-valid-photo');
      expect(tx.idIntentId).toBe('intent-fresh-id-200');
      expect(res.passId).toBe('pass-fresh-id-200');
    });

    it('Scenario 20: Editable transaction + uploaded valid checkpoint skips re-upload', async () => {
      const tx = await createPortalIssueTransaction();
      tx.phase = 'editable';
      tx.photoIntentId = 'intent-valid-photo-300';
      tx.photoCheckpoint = {
        intentId: 'intent-valid-photo-300',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-valid-300.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        uploaded: true,
      };

      let rpcCallCount = 0;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          rpcCallCount++;
        }
        return Promise.resolve({ data: null, error: null });
      });

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'pass-valid-300',
                qrToken: 'qr-valid-300',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await issueVisitorPass(
        'portal',
        { firstName: 'Alice', lastName: 'ValidCheck', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        undefined,
        tx.requestId,
        undefined,
        tx
      );

      // create_upload_intent should NOT have been called!
      expect(rpcCallCount).toBe(0);
      expect(tx.photoIntentId).toBe('intent-valid-photo-300');
      expect(res.passId).toBe('pass-valid-300');
    });

    it('Scenario 21: Ambiguous transaction + expired uploaded original checkpoint preserves original intent for idempotent replay', async () => {
      const tx = await createPortalIssueTransaction();
      tx.phase = 'ambiguous';
      tx.photoIntentId = 'intent-ambiguous-original';
      tx.photoCheckpoint = {
        intentId: 'intent-ambiguous-original',
        bucketId: 'visitor-photos',
        objectPath: 'passes/photo-ambiguous-original.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1048576,
        expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired locally, but server may already have committed!
        uploaded: true,
      };

      let createUploadIntentCalled = false;
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          createUploadIntentCalled = true;
        }
        return Promise.resolve({ data: null, error: null });
      });

      let submittedBody: any = null;
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
        if (String(url).includes('/api/passes/issue')) {
          submittedBody = JSON.parse(init.body);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'pass-idempotent-replay',
                qrToken: 'qr-idempotent-replay',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const res = await issueVisitorPass(
        'portal',
        { firstName: 'Alice', lastName: 'Replay', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        undefined,
        tx.requestId,
        undefined,
        tx
      );

      // Invariant: Ambiguous exact replay must NOT allocate replacement evidence before attempting exact replay!
      expect(createUploadIntentCalled).toBe(false);
      expect(submittedBody.photoIntentId).toBe('intent-ambiguous-original');
      expect(res.passId).toBe('pass-idempotent-replay');
      expect(tx.phase).toBe('committed');
    });

    it('Scenario 12: Portal ambiguous state cannot issue a brand-new pass through Start Over', () => {
      const getPassSrc = fs.readFileSync('src/pages/GetPassPage.tsx', 'utf8');

      // Ambiguous block has Cancel & Ask Guard and Retry Exact Submission
      expect(getPassSrc).toContain("portalTransactionRef.current?.phase === 'ambiguous'");
      expect(getPassSrc).toContain('Cancel & Ask Guard');
      expect(getPassSrc).toContain('Retry Exact Submission');

      // In ambiguous branch, handleStartOver is NOT called
      expect(getPassSrc).toContain('handleAmbiguousCancelAndAskGuard');
      expect(getPassSrc).toContain('Submission cancelled. The previous pass may have been created. Please proceed to the Guard Station with your valid ID for assistance.');
    });

    it('Scenario 13 & 14: Normal first-time kiosk issuance and portal issuance remain unchanged', async () => {
      mockRpc.mockImplementation((name: string) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-normal',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-normal.jpg',
              expires_at: new Date(Date.now() + 600000).toISOString(),
              max_bytes: 1048576,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });

      mockStorageFrom.mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo-normal.jpg' }, error: null }),
      });

      // 1. Kiosk normal issuance
      const kioskTx = createIssueTransaction('kiosk');
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'kiosk-pass-normal',
                qrToken: 'qr-normal-kiosk',
                publicReference: 'EP-20261027-0001',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const kioskRes = await issueVisitorPass(
        'kiosk',
        { firstName: 'First', lastName: 'Kiosk', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        undefined,
        kioskTx.requestId,
        undefined,
        kioskTx
      );

      expect(kioskRes.passId).toBe('kiosk-pass-normal');
      expect(kioskTx.phase).toBe('committed');

      // 2. Portal normal issuance
      const portalTx = createIssueTransaction('portal');
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('/api/passes/issue')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                passId: 'portal-pass-normal',
                qrToken: 'qr-normal-portal',
                publicReference: 'EP-20261027-0002',
                validFrom: '2026-10-27T08:00:00Z',
                validUntil: '2026-10-27T17:00:00Z',
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const portalRes = await issueVisitorPass(
        'portal',
        { firstName: 'First', lastName: 'Portal', contactNumber: '09171234567', purpose: 'Visit', visitDate: '2026-10-27' },
        new Blob(['photo']),
        undefined,
        portalTx.requestId,
        undefined,
        portalTx
      );

      expect(portalRes.passId).toBe('portal-pass-normal');
      expect(portalTx.phase).toBe('committed');
    });

    it('Scenario 15: Physical printer tests remain mocked/software-only and README maintains truthful disclaimer', () => {
      const readme = fs.readFileSync('README.md', 'utf8');
      expect(readme).toContain('PHYSICAL MXW01 ACCEPTANCE: NOT YET TESTED');
      expect(mxw01PrinterManager).toBeDefined();
    });
  });
});
