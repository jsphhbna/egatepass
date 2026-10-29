// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  transitionGuardOfflineStore,
  saveOfflineRegistrationWithCache,
  queueOfflineVisitorAction,
  queueOfflineEvent,
  getOfflineRegistrations,
  getOfflineEvents,
  getPendingSyncCount,
  saveCachedVisitors,
  recoverInterruptedSyncStates,
  getActiveGuardActorId,
  type CachedVisitorPass,
} from '@/lib/offline/guardIndexedDb';
import { runOfflineMaintenance } from '@/lib/offline/guardSyncManager';

const { mockRpc, mockGetSession, mockStorageUpload } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockGetSession: vi.fn(),
  mockStorageUpload: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const client: any = {
    auth: {
      getSession: mockGetSession,
    },
    rpc: mockRpc,
    schema: () => client,
    from: () => ({
      select: () => ({
        eq: () => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload: mockStorageUpload,
      }),
    },
  };
  return {
    supabase: client,
    requireSupabase: () => client,
    getSupabaseAvailabilityMessage: () => null,
  };
});

vi.mock('@/lib/scheduling', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getManilaDateString: () => '2026-10-30',
  };
});

describe('Workstream A: Guard Offline Authority Closure (Section 15 Regressions)', () => {
  const GUARD_A = 'guard-actor-aaa-111';
  const GUARD_B = 'guard-actor-bbb-222';
  let mockDb: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = setupMockIndexedDb();
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: GUARD_A },
          access_token: 'valid-token-guard-a',
        },
      },
      error: null,
    });
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockStorageUpload.mockResolvedValue({ error: null });

    await transitionGuardOfflineStore(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 15.A: No session means zero local mutation
  it('A. unauthenticated maintenance causes zero IndexedDB mutations and zero network/RPC calls', async () => {
    await transitionGuardOfflineStore(GUARD_A);

    // Seed Guard A registration directly in syncing state with a photoBlob
    const photoBlob = new Blob(['sample-photo-data'], { type: 'image/webp' });
    const idBlob = new Blob(['sample-id-data'], { type: 'image/webp' });
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: 'reg-a-initial-1',
      visitor: {
        firstName: 'Offline',
        lastName: 'Visitor Test',
        contactNumber: '09171234567',
        purpose: 'Official Business',
        visitDate: '2026-10-30',
      },
      action: 'approved',
      photoBlob,
      idBlob,
      occurredAt: '2026-10-30T10:00:00Z',
    });

    // Mark as syncing
    const reg = (await getOfflineRegistrations(GUARD_A))[0];
    await new Promise<void>((resolve, reject) => {
      const tx = mockDb.transaction('offline_registrations', 'readwrite');
      tx.objectStore('offline_registrations').put({
        ...reg,
        syncStatus: 'syncing',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Verify seeded status is syncing
    const seeded = (await getOfflineRegistrations(GUARD_A))[0];
    expect(seeded.syncStatus).toBe('syncing');

    // MOCK session = null
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    // Run maintenance
    const res = await runOfflineMaintenance();

    // Assert: error reported, zero network/RPC calls
    expect(res.summary.errors).toBe(1);
    expect(mockRpc).not.toHaveBeenCalled();

    // Assert: syncStatus remains 'syncing', blob is preserved, meta unchanged
    const after = (await getOfflineRegistrations(GUARD_A))[0];
    expect(after.syncStatus).toBe('syncing');
    expect(after.photoBlob).toBeDefined();
    expect(await getActiveGuardActorId()).toBe(GUARD_A);
  });

  // 15.B: Interrupted recovery is actor-scoped
  it('B. recoverInterruptedSyncStates is strictly actor-scoped', async () => {
    await transitionGuardOfflineStore(GUARD_A);

    // Seed records for Guard A
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: 'reg-a-1',
      visitor: {
        firstName: 'Visitor',
        lastName: 'A',
        contactNumber: '09170000001',
        purpose: 'Meeting',
        visitDate: '2026-10-30',
      },
      action: 'approved',
      photoBlob: new Blob(['photo-a']),
      occurredAt: '2026-10-30T10:00:00Z',
    });
    await queueOfflineEvent(GUARD_A, {
      eventId: 'evt-a-1',
      action: 'approve_entry',
      passId: 'pass-a-1',
      occurredAt: '2026-10-30T10:01:00Z',
      expectedStatus: 'pending',
      syncStatus: 'pending',
      retryCount: 0,
    });

    // Mark Guard A records as syncing
    const [regA] = await getOfflineRegistrations(GUARD_A);
    const [evtA] = await getOfflineEvents(GUARD_A);

    await new Promise<void>((resolve, reject) => {
      const tx = mockDb.transaction(['offline_registrations', 'offline_events'], 'readwrite');
      tx.objectStore('offline_registrations').put({ ...regA, syncStatus: 'syncing' });
      tx.objectStore('offline_events').put({ ...evtA, syncStatus: 'syncing' });
      // Inject Guard B records as syncing directly
      tx.objectStore('offline_registrations').put({
        offlineRegistrationId: 'reg-b-1',
        actorId: GUARD_B,
        visitor: {
          firstName: 'Visitor',
          lastName: 'B',
          contactNumber: '09170000002',
          purpose: 'Delivery',
          visitDate: '2026-10-30',
        },
        action: 'approved',
        occurredAt: '2026-10-30T10:05:00Z',
        syncStatus: 'syncing',
        retryCount: 0,
        rejectionReason: null,
      });
      tx.objectStore('offline_events').put({
        eventId: 'evt-b-1',
        actorId: GUARD_B,
        action: 'record_exit',
        passId: 'pass-b-1',
        occurredAt: '2026-10-30T10:06:00Z',
        expectedStatus: 'inside',
        syncStatus: 'syncing',
        retryCount: 0,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Call recoverInterruptedSyncStates for Guard A
    const recoveredA = await recoverInterruptedSyncStates(GUARD_A);
    expect(recoveredA.recoveredRegistrations).toBe(1);
    expect(recoveredA.recoveredEvents).toBe(1);

    // Guard A records transitioned to pending
    const regsA = await getOfflineRegistrations(GUARD_A);
    expect(regsA[0].syncStatus).toBe('pending');
    const evtsA = await getOfflineEvents(GUARD_A);
    expect(evtsA[0].syncStatus).toBe('pending');

    // Guard B records remained 'syncing'
    const regsB = await getOfflineRegistrations(GUARD_B);
    expect(regsB[0].syncStatus).toBe('syncing');
    const evtsB = await getOfflineEvents(GUARD_B);
    expect(evtsB[0].syncStatus).toBe('syncing');

    // Repeat inversely for B
    const recoveredB = await recoverInterruptedSyncStates(GUARD_B);
    expect(recoveredB.recoveredRegistrations).toBe(1);
    expect(recoveredB.recoveredEvents).toBe(1);
    const regsBAfter = await getOfflineRegistrations(GUARD_B);
    expect(regsBAfter[0].syncStatus).toBe('pending');
  });

  // 15.C: Initial offline reload shows real outbox
  it('C. initial offline reload immediately reflects truthful pending count and outbox without extra action', async () => {
    await transitionGuardOfflineStore(GUARD_A);

    // Seed actor A: one pending registration, one pending event
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: 'reg-c-1',
      visitor: {
        firstName: 'Reload',
        lastName: 'Visitor',
        contactNumber: '09171112222',
        purpose: 'Audit Verification',
        visitDate: '2026-10-30',
      },
      action: 'approved',
      photoBlob: new Blob(['photo-c']),
      occurredAt: '2026-10-30T09:00:00Z',
    });

    await queueOfflineEvent(GUARD_A, {
      eventId: 'evt-c-1',
      action: 'approve_entry',
      passId: 'pass-c-1',
      occurredAt: '2026-10-30T09:01:00Z',
      expectedStatus: 'pending',
      syncStatus: 'pending',
      retryCount: 0,
    });

    // Verify pending count in store
    const preCount = await getPendingSyncCount(GUARD_A);
    expect(preCount.total).toBe(2);

    // Test Harness matching GuardPage initialization and state management
    let latestState: any = null;
    function OutboxHarness({ uid }: { uid: string | null }) {
      const [storePrepared, setStorePrepared] = React.useState(false);
      const [pendingSyncCount, setPendingSyncCount] = React.useState({ registrations: 0, events: 0, total: 0 });
      const [outboxRegistrations, setOutboxRegistrations] = React.useState<any[]>([]);
      const [outboxEvents, setOutboxEvents] = React.useState<any[]>([]);

      const resetOutboxView = React.useCallback(() => {
        setPendingSyncCount({ registrations: 0, events: 0, total: 0 });
        setOutboxRegistrations([]);
        setOutboxEvents([]);
      }, []);

      const refreshPendingCounts = React.useCallback(async (actorId: string) => {
        try {
          const counts = await getPendingSyncCount(actorId);
          setPendingSyncCount(counts);
          const [regs, evts] = await Promise.all([
            getOfflineRegistrations(actorId),
            getOfflineEvents(actorId),
          ]);
          setOutboxRegistrations(regs);
          setOutboxEvents(evts);
        } catch (e) {
          console.warn('Could not read offline outbox count:', e);
        }
      }, []);

      React.useEffect(() => {
        let active = true;
        setStorePrepared(false);
        transitionGuardOfflineStore(uid ?? null).then(() => {
          if (active && uid) {
            setStorePrepared(true);
          }
        });
        return () => { active = false; };
      }, [uid]);

      React.useEffect(() => {
        if (!uid || !storePrepared) {
          resetOutboxView();
          return;
        }
        void refreshPendingCounts(uid);
      }, [uid, storePrepared, refreshPendingCounts, resetOutboxView]);

      latestState = { storePrepared, pendingSyncCount, outboxRegistrations, outboxEvents };
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(OutboxHarness, { uid: GUARD_A }));
    });

    // Allow promise resolution
    for (let i = 0; i < 15; i++) {
      await React.act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      if (latestState?.storePrepared && latestState?.outboxRegistrations?.length === 1 && latestState?.outboxEvents?.length === 1) {
        break;
      }
    }

    expect(latestState.storePrepared).toBe(true);
    expect(latestState.pendingSyncCount.total).toBe(2);
    expect(latestState.pendingSyncCount.registrations).toBe(1);
    expect(latestState.pendingSyncCount.events).toBe(1);
    expect(latestState.outboxRegistrations.length).toBe(1);
    expect(latestState.outboxEvents.length).toBe(1);

    await React.act(async () => {
      root.unmount();
    });
  });

  // 15.D: Maintenance and identity transition cannot double-clear (deterministic deferred race)
  it('D. maintenance and identity transition cannot double-clear B data (controlled ordering)', async () => {
    await transitionGuardOfflineStore(GUARD_A);
    await saveCachedVisitors(GUARD_A, [{
      id: 'pass-a-test',
      actorId: GUARD_A,
      fullName: 'Visitor Guard A',
      status: 'pending',
      visitDate: '2026-10-30',
      purpose: 'Meeting',
    }]);

    // Switch session to Guard B
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          user: { id: GUARD_B },
          access_token: 'valid-token-guard-b',
        },
      },
      error: null,
    });

    // Controlled ordering with deferred promises:
    // 1. transition B begins
    // 2. B preparation pauses
    // 3. maintenance attempts transition
    // 4. first transition completes
    // 5. B data is created
    // 6. queued maintenance transition resolves
    // 7. B data remains intact without second destructive clear
    let pauseBResolve!: () => void;
    const pauseBPromise = new Promise<void>((resolve) => {
      pauseBResolve = resolve;
    });

    let bStartedResolve!: () => void;
    const bStartedPromise = new Promise<void>((resolve) => {
      bStartedResolve = resolve;
    });

    const originalTransaction = mockDb.transaction.bind(mockDb);
    let intercepted = false;
    mockDb.transaction = (storeNames: any, mode: any) => {
      const tx = originalTransaction(storeNames, mode);
      if (!intercepted && Array.isArray(storeNames) && storeNames.includes('cached_visitors')) {
        intercepted = true;
        bStartedResolve();
        const originalOnComplete = tx.oncomplete;
        tx.oncomplete = async () => {
          await pauseBPromise;
          if (originalOnComplete) originalOnComplete();
        };
      }
      return tx;
    };

    // 1. Launch transition B (will pause in transaction)
    const pTransitionB = transitionGuardOfflineStore(GUARD_B);

    // 2. Wait until transition B has begun and paused
    await bStartedPromise;

    // 3. While transition B is paused, maintenance attempts transition
    const pMaintenance = runOfflineMaintenance();

    // 4. Complete first transition
    pauseBResolve();
    await pTransitionB;

    expect(await getActiveGuardActorId()).toBe(GUARD_B);

    // 5. Guard B creates local data
    await saveOfflineRegistrationWithCache(GUARD_B, {
      offlineRegistrationId: 'reg-b-walkin-1',
      visitor: {
        firstName: 'Guard B',
        lastName: 'Walk-in',
        contactNumber: '09179998888',
        purpose: 'Official Business',
        visitDate: '2026-10-30',
      },
      action: 'approved',
      photoBlob: new Blob(['photo-b']),
      occurredAt: '2026-10-30T11:00:00Z',
    });

    // 6. Await queued maintenance transition
    await pMaintenance;

    // 7. Assert: no second destructive clear, one actor assignment, Guard B data remains intact
    expect(await getActiveGuardActorId()).toBe(GUARD_B);
    const bRegs = await getOfflineRegistrations(GUARD_B);
    expect(bRegs.length).toBe(1);
    expect(bRegs[0].visitor.lastName).toBe('Walk-in');
  });

  // 15.E: Explicit saveCachedVisitors actor
  it('E. saveCachedVisitors requires explicit actorId and overwrites visitor-supplied actorId', async () => {
    await transitionGuardOfflineStore(GUARD_A);

    // Rejects empty actorId
    await expect(
      saveCachedVisitors('', [{
        id: 'pass-empty-test',
        actorId: '',
        fullName: 'Test',
        status: 'pending',
        visitDate: '2026-10-30',
        purpose: 'Test',
      }])
    ).rejects.toThrow('actorId required to save cached visitor');

    // Overwrites visitor.actorId with explicit actorId argument
    const visitorWithForeignActor: CachedVisitorPass = {
      id: 'pass-foreign-test',
      actorId: 'attacker-actor-xyz',
      fullName: 'Overwritten Actor Test',
      status: 'pending',
      visitDate: '2026-10-30',
      purpose: 'Infiltration Test',
    };

    await saveCachedVisitors(GUARD_A, [visitorWithForeignActor]);

    const stored = await new Promise<CachedVisitorPass>((resolve, reject) => {
      const tx = mockDb.transaction('cached_visitors', 'readonly');
      const req = tx.objectStore('cached_visitors').get('pass-foreign-test');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(stored).toBeDefined();
    expect(stored.actorId).toBe(GUARD_A);
    expect(stored.actorId).not.toBe('attacker-actor-xyz');
  });

  // 15.F: Local action actor mismatch
  it('F. queueOfflineVisitorAction throws actor_mismatch when actor does not own cached visitor', async () => {
    await transitionGuardOfflineStore(GUARD_A);

    await saveCachedVisitors(GUARD_A, [{
      id: 'pass-guard-a-owned',
      actorId: GUARD_A,
      fullName: 'Legitimate Visitor for A',
      status: 'pending',
      visitDate: '2026-10-30',
      purpose: 'Meeting',
    }]);

    // Guard B attempts to approve Guard A's visitor
    await expect(
      queueOfflineVisitorAction(GUARD_B, {
        passId: 'pass-guard-a-owned',
        action: 'approve_entry',
      })
    ).rejects.toThrow('actor_mismatch');

    // Zero events created
    const events = await getOfflineEvents(GUARD_B);
    expect(events.length).toBe(0);

    // Visitor status remains unchanged
    const visitor = await new Promise<CachedVisitorPass>((resolve, reject) => {
      const tx = mockDb.transaction('cached_visitors', 'readonly');
      const req = tx.objectStore('cached_visitors').get('pass-guard-a-owned');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(visitor.status).toBe('pending');
  });
});
