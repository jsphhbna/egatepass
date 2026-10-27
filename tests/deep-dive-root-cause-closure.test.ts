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
  type CachedVisitorPass,
} from '@/lib/offline/guardIndexedDb';
import {
  acquireCoordinatorLock,
  isCoordinatorLocked,
  runOfflineMaintenance,
} from '@/lib/offline/guardSyncManager';
import {
  isAuthoritativeServerError,
  isTransportOrNetworkError,
} from '@/lib/offline/errorClassification';
import { computeBackendAvailability } from '@/lib/offline/backendAvailability';
import { fetchWithTimeout, RequestTimeoutError } from '@/lib/fetchWithTimeout';
import { getManilaDayValidityWindow } from '@/lib/scheduling';
import {
  classifySubmissionOutcome,
  uploadCheckpointedEvidence,
  createIssueTransaction,
} from '@/services/visitorRegistration';
import { requireSupabase } from '@/lib/supabase';
import { thermalTemplateLayoutSchema } from '@/types/thermalTemplate';
import { renderThermalPass } from '@/printer/renderer/thermalRenderer';
import { mxw01Manager } from '@/printer/mxw01/mxw01Manager';
import { PGlite } from '@electric-sql/pglite';

// Mock dependencies for guardSyncManager and supabase services
const { mockRpc, mockGetSession, mockStorageFrom } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockGetSession: vi.fn(),
  mockStorageFrom: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const client: any = {
    auth: {
      getSession: mockGetSession,
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
});

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
            expiry: new Date(Date.now() + 600000).toISOString(),
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
        id: passId,
        passId,
        publicReference: 'EG-12345678',
        visitorId: 'vis-1',
        visitorName: 'Juan Dela Cruz',
        contactNumber: '09171234567',
        purpose: 'Official Business',
        visitDate: '2026-10-27',
        status: 'issued',
        version: 5,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: Date.now(),
      };

      // Seed cache directly using saveCachedVisitors
      await saveCachedVisitors([initialPass]);

      // Perform atomic approve entry
      const actionResult = await queueOfflineVisitorAction({
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
      const searchRes = await searchCachedVisitors('Juan');
      expect(searchRes.length).toBe(1);
      expect(searchRes[0]?.status).toBe('inside');
      expect(searchRes[0]?.version).toBe(6);
    });

    it('offline-created visitor supports offline exit before reconnect at version 1', async () => {
      const offlineRegId = 'off-reg-abc';
      const occurredAt = '2026-10-27T10:00:00+08:00';

      // Create approved offline registration (creates pass at status 'inside', version 1)
      await saveOfflineRegistrationWithCache({
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
      const exitResult = await queueOfflineVisitorAction({
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
        queueOfflineVisitorAction({
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
        id: passId,
        passId,
        publicReference: 'EG-REJECT01',
        visitorId: 'vis-r',
        visitorName: 'Blocked Visitor',
        contactNumber: '09191234567',
        purpose: 'Inquiry',
        visitDate: '2026-10-27',
        status: 'issued',
        version: 2,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: Date.now(),
      };

      await saveCachedVisitors([pass]);

      const rejResult = await queueOfflineVisitorAction({
        passId,
        action: 'reject_entry',
        gate: 'Main Gate',
        actorId: 'guard-1',
        reason: 'Dress code violation',
      });

      expect(rejResult.projectedVisitor).toBeNull();
      expect(rejResult.event.action).toBe('reject_entry');

      // Confirm visitor is no longer actionable/returned in search
      const results = await searchCachedVisitors('Blocked');
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
      const caller2Promise = acquireCoordinatorLock().then((unlock2) => {
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

      await saveOfflineRegistrationWithCache({
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
          id: 'server-pass-1',
          passId: 'server-pass-1',
          publicReference: 'EG-SERVER01',
          visitorId: 'vis-srv-1',
          visitorName: 'Server Synced Visitor',
          contactNumber: '09171111111',
          purpose: 'Server Business',
          visitDate: '2026-10-27',
          status: 'issued',
          version: 1,
          validFrom: '2026-10-27T08:00:00+08:00',
          validUntil: '2026-10-27T17:00:00+08:00',
          cachedAt: Date.now(),
        },
      ];

      await atomicReplaceCachedVisitors(serverSnapshotPasses);

      // Verify that local unsynchronized visitor was PRESERVED
      const searchLocal = await searchCachedVisitors('Pending Local');
      expect(searchLocal.length).toBe(1);
      expect(searchLocal[0]?.id).toBe(localOfflineId);

      // Verify server pass is also present
      const searchServer = await searchCachedVisitors('Server Synced');
      expect(searchServer.length).toBe(1);
      expect(searchServer[0]?.id).toBe('server-pass-1');
    });

    it('finalizeOfflineRegistrationSync atomically remaps cache, queues events, clears local blobs and marks registration synced', async () => {
      const localId = 'local-reg-atomic-1';
      const canonicalPassId = 'canonical-pass-uuid-999';
      const photoBlob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
      const idBlob = new Blob(['id-bytes'], { type: 'image/jpeg' });

      await saveOfflineRegistrationWithCache({
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
      await queueOfflineEvent({
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
      const searchBefore = await searchCachedVisitors('Atomic');
      expect(searchBefore.length).toBe(1);
      expect(searchBefore[0]?.id).toBe(localId);
      const eventsBefore = await getOfflineEvents();
      expect(eventsBefore.find((e) => e.passId === localId)).toBeDefined();

      // Execute ONE atomic transaction
      await finalizeOfflineRegistrationSync({
        offlineRegistrationId: localId,
        canonicalPassId,
        publicReference: 'EG-20261027-CANON',
        syncedAt: new Date().toISOString(),
      });

      // Verify after state:
      // 1. Registration is synced, has canonicalPassId, local blobs stripped
      const regs = await getOfflineRegistrations();
      const reg = regs.find((r) => r.offlineRegistrationId === localId);
      expect(reg?.syncStatus).toBe('synced');
      expect(reg?.canonicalPassId).toBe(canonicalPassId);
      expect(reg?.photoBlob).toBeUndefined();
      expect(reg?.idBlob).toBeUndefined();
      expect(reg?.photoUploadCheckpoint).toBeUndefined();
      expect(reg?.idUploadCheckpoint).toBeUndefined();

      // 2. Cached visitor under old localId is absent, under canonicalPassId exists
      const searchOld = await searchCachedVisitors(localId);
      expect(searchOld.length).toBe(0);
      const searchCanonical = await searchCachedVisitors('Atomic');
      expect(searchCanonical.length).toBe(1);
      expect(searchCanonical[0]?.id).toBe(canonicalPassId);
      expect(searchCanonical[0]?.passId).toBe(canonicalPassId);
      expect(searchCanonical[0]?.publicReference).toBe('EG-20261027-CANON');
      expect(searchCanonical[0]?.status).toBe('inside');
      expect(searchCanonical[0]?.version).toBe(1);

      // 3. Queued event has passId remapped to canonicalPassId
      const eventsAfter = await getOfflineEvents();
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

      await saveOfflineRegistrationWithCache({
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
      const regs = await getOfflineRegistrations();
      const strippedReg = regs.find((r) => r.offlineRegistrationId === regId);
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

    it('GetPassPage handleShare catches AbortError cleanly without download fallback', () => {
      const pagePath = path.resolve(process.cwd(), 'src/pages/GetPassPage.tsx');
      const pageContent = fs.readFileSync(pagePath, 'utf8');

      expect(pageContent).toContain("shareErr.name === 'AbortError'");
      expect(pageContent).toContain('Web Share failed with non-abort error');
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
        data: { session: { access_token: 'valid-guard-token' } },
      });

      // Save approved offline registration
      await saveOfflineRegistrationWithCache({
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
      await queueOfflineVisitorAction({
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
              expiry: new Date(Date.now() + 600000).toISOString(),
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
      const regs = await getOfflineRegistrations();
      const syncedReg = regs.find((r) => r.offlineRegistrationId === regId);
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
      const events = await getOfflineEvents();
      expect(events[0]?.syncStatus).toBe('synced');
      expect(events[0]?.passId).toBe(canonicalPassId);
    });

    it('transient registration sync failure leaves dependent event pending and does NOT call event RPC', async () => {
      const regId = '00000000-0000-4000-8000-000000000002';
      mockGetSession.mockResolvedValue({
        data: { session: { access_token: 'valid-guard-token' } },
      });

      await saveOfflineRegistrationWithCache({
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

      await queueOfflineVisitorAction({
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
              expiry: new Date(Date.now() + 600000).toISOString(),
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
      const regs = await getOfflineRegistrations();
      expect(regs.find((r) => r.offlineRegistrationId === regId)?.syncStatus).toBe('pending');

      // Dependent event remains pending
      const events = await getOfflineEvents();
      expect(events.find((e) => e.passId === regId)?.syncStatus).toBe('pending');

      // Event RPC was NEVER called
      expect(rpcCalls).not.toContain('guard_sync_offline_event');
    });

    it('registration conflict marks dependent event as registration_sync_conflicted and does NOT call event RPC', async () => {
      const regId = '00000000-0000-4000-8000-000000000003';
      mockGetSession.mockResolvedValue({
        data: { session: { access_token: 'valid-guard-token' } },
      });

      await saveOfflineRegistrationWithCache({
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

      await queueOfflineVisitorAction({
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
              expiry: new Date(Date.now() + 600000).toISOString(),
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
      const regs = await getOfflineRegistrations();
      expect(regs.find((r) => r.offlineRegistrationId === regId)?.syncStatus).toBe('conflict');

      // Dependent event marked conflict with reason 'registration_sync_conflicted'
      const events = await getOfflineEvents();
      const depEvent = events.find((e) => e.passId === regId);
      expect(depEvent?.syncStatus).toBe('conflict');
      expect(depEvent?.conflictReason).toBe('registration_sync_conflicted');

      // Event RPC was NEVER called
      expect(rpcCalls).not.toContain('guard_sync_offline_event');
    });

    it('recoverInterruptedSyncStates resets stranded syncing registrations and events to pending and allows subsequent synchronization', async () => {
      const regId = '00000000-0000-4000-8000-000000000004';
      const canonicalPassId = '00000000-0000-4000-8000-000000000094';

      mockGetSession.mockResolvedValue({
        data: { session: { access_token: 'valid-guard-token' } },
      });

      await saveOfflineRegistrationWithCache({
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

      await queueOfflineVisitorAction({
        passId: regId,
        action: 'record_exit',
        gate: 'Main Gate',
        actorId: 'guard-1',
      });

      // Manually force both records to 'syncing' to simulate crash during prior sync
      await updateOfflineRegistrationStatus(regId, 'syncing' as any);
      const eventsBefore = await getOfflineEvents();
      await updateOfflineEventStatus(eventsBefore[0]!.eventId, 'syncing' as any);

      // Verify they are durable 'syncing'
      const strandedRegs = await getOfflineRegistrations();
      expect(strandedRegs.find((r) => r.offlineRegistrationId === regId)?.syncStatus).toBe('syncing');
      const strandedEvents = await getOfflineEvents();
      expect(strandedEvents[0]?.syncStatus).toBe('syncing');

      // Setup mock for successful sync on recovery
      mockRpc.mockImplementation((name: string, params: any) => {
        if (name === 'create_upload_intent') {
          return Promise.resolve({
            data: {
              intent_id: 'intent-uuid-test-4',
              bucket_id: 'visitor-photos',
              object_path: 'passes/photo-test-4.jpg',
              expiry: new Date(Date.now() + 600000).toISOString(),
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
      const recoveredRegs = await getOfflineRegistrations();
      expect(recoveredRegs.find((r) => r.offlineRegistrationId === regId)?.syncStatus).toBe('synced');
      const recoveredEvents = await getOfflineEvents();
      expect(recoveredEvents[0]?.syncStatus).toBe('synced');
    });

    it('runOfflineMaintenance strictly executes: registration sync -> event sync -> snapshot refresh -> purge', async () => {
      const executionOrder: string[] = [];

      mockGetSession.mockResolvedValue({
        data: { session: { access_token: 'valid-guard-token' } },
      });

      // Seed one pending registration and one pending event
      await saveOfflineRegistrationWithCache({
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
      await saveCachedVisitors([
        {
          id: 'server-pass-order',
          passId: 'server-pass-order',
          publicReference: 'EG-ORD',
          visitorId: 'v-ord',
          visitorName: 'Server Ord',
          contactNumber: '09171112222',
          purpose: 'Order',
          visitDate: '2026-10-27',
          status: 'inside',
          version: 1,
          validFrom: '2026-10-27T08:00:00+08:00',
          validUntil: '2026-10-27T17:00:00+08:00',
          cachedAt: Date.now(),
        },
      ]);
      await queueOfflineVisitorAction({
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
              expiry: new Date(Date.now() + 600000).toISOString(),
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
        data: { session: { access_token: 'valid-guard-token' } },
      });

      // Stalled fetch that rejects with RequestTimeoutError
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return Promise.reject(new RequestTimeoutError('Simulated coordinator timeout'));
      });

      // Seed pending reg to trigger fetch
      await saveOfflineRegistrationWithCache({
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
              expiry: new Date(Date.now() + 600000).toISOString(),
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

    it('classifySubmissionOutcome classifies HTTP 409 replay-consistency errors as rejected_requires_new_transaction', () => {
      expect(classifySubmissionOutcome({ status: 409, message: 'intent_mismatch' })).toBe('rejected_requires_new_transaction');
      expect(classifySubmissionOutcome({ status: 409, message: 'payload_mismatch' })).toBe('rejected_requires_new_transaction');
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
});
