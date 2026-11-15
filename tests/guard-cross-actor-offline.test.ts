import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  transitionGuardOfflineStore,
  getActiveGuardActorId,
  saveOfflineRegistrationWithCache,
  queueOfflineEvent,
  getOfflineRegistrations,
  getOfflineEvents,
  getPendingSyncCount,
  searchCachedVisitors,
  atomicReplaceCachedVisitors,
  clearAllGuardOfflineData,
  saveCachedVisitors,
  type CachedVisitorPass,
} from '@/lib/offline/guardIndexedDb';
import { runOfflineMaintenance } from '@/lib/offline/guardSyncManager';

const { mockRpc, mockGetSession } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const client: any = {
    auth: {
      getSession: mockGetSession,
    },
    rpc: mockRpc,
    schema: () => client,
  };
  return {
    supabase: client,
    requireSupabase: () => client,
    getSupabaseAvailabilityMessage: () => null,
  };
});

describe('Cross-Guard Actor Isolation & Session Management (P1 Invariants)', () => {
  const GUARD_A = '11111111-1111-4000-8000-111111111111';
  const GUARD_B = '22222222-2222-4000-8000-222222222222';

  beforeEach(async () => {
    await setupMockIndexedDb();
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it('binds IndexedDB store to actor and isolates pending registrations and events', async () => {
    // Initialize store for Guard A
    await transitionGuardOfflineStore(GUARD_A);
    expect(await getActiveGuardActorId()).toBe(GUARD_A);

    // Guard A saves an offline registration
    const regA = 'reg-guard-a-001';
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: regA,
      visitor: {
        firstName: 'Alice',
        lastName: 'Visitor',
        contactNumber: '09171111111',
        purpose: 'Meeting A',
        visitDate: '2026-10-29',
      },
      occurredAt: new Date().toISOString(),
      action: 'approved',
    });

    // Guard A queues an offline event
    await queueOfflineEvent(GUARD_A, {
      eventId: 'evt-001',
      passId: 'pass-001',
      visitorName: 'Alice Visitor',
      action: 'record_exit',
      expectedStatus: 'inside',
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      syncStatus: 'pending',
    });

    // Verify Guard A pending counts
    const countsA = await getPendingSyncCount(GUARD_A);
    expect(countsA.registrations).toBe(1);
    expect(countsA.events).toBe(1);
    expect(countsA.total).toBe(2);

    // Verify Guard B cannot see Guard A's pending counts
    const countsB = await getPendingSyncCount(GUARD_B);
    expect(countsB.registrations).toBe(0);
    expect(countsB.events).toBe(0);
    expect(countsB.total).toBe(0);

    // Verify getOfflineRegistrations isolates by actorId
    const regsA = await getOfflineRegistrations(GUARD_A);
    expect(regsA.length).toBe(1);
    expect(regsA[0]?.actorId).toBe(GUARD_A);

    const regsB = await getOfflineRegistrations(GUARD_B);
    expect(regsB.length).toBe(0);
  });

  it('switching actor invalidates operational visitor cache to prevent cross-guard data leakage', async () => {
    // 1. Guard A logs in and populates operational cache
    await transitionGuardOfflineStore(GUARD_A);
    const serverPasses: CachedVisitorPass[] = [
      {
        id: 'pass-a-1',
        actorId: GUARD_A,
        passId: 'pass-a-1',
        publicReference: 'EG-PASS-A',
        passReference: 'EG-PASS-A',
        visitorId: 'vis-a-1',
        visitorName: 'Confidential Visitor of Guard A',
        contactNumber: '09170000001',
        purpose: 'Executive Meeting',
        visitDate: '2026-10-29',
        status: 'issued',
        version: 1,
        validFrom: '2026-10-29T08:00:00+08:00',
        validUntil: '2026-10-29T17:00:00+08:00',
        cachedAt: new Date().toISOString(),
      },
    ];
    await atomicReplaceCachedVisitors(GUARD_A, serverPasses);

    // Guard A can see the visitor
    const searchA = await searchCachedVisitors(GUARD_A, 'Confidential Visitor');
    expect(searchA.length).toBe(1);

    // 2. Guard B logs in on same device
    await transitionGuardOfflineStore(GUARD_B);
    expect(await getActiveGuardActorId()).toBe(GUARD_B);

    // Guard B's search MUST NOT reveal Guard A's cached visitor
    const searchB = await searchCachedVisitors(GUARD_B, 'Confidential Visitor');
    expect(searchB.length).toBe(0);
  });

  it('preserves Guard A pending records across Guard B session and re-accesses upon Guard A reauthentication (Requirement R3 & ADR-001)', async () => {
    // 1. Guard A creates offline registration
    await transitionGuardOfflineStore(GUARD_A);
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: 'reg-a-only',
      visitor: {
        firstName: 'GuardA',
        lastName: 'Visitor',
        contactNumber: '09170000001',
        purpose: 'Test',
        visitDate: '2026-10-29',
      },
      occurredAt: new Date().toISOString(),
      action: 'approved',
    });

    // Verify Guard A has 1 pending registration
    const initialRegsA = await getOfflineRegistrations(GUARD_A, 'pending');
    expect(initialRegsA.length).toBe(1);
    expect(initialRegsA[0]?.offlineRegistrationId).toBe('reg-a-only');

    // 2. Guard B logs in on same device
    await transitionGuardOfflineStore(GUARD_B);
    expect(await getActiveGuardActorId()).toBe(GUARD_B);

    // Guard B has 0 records and cannot see Guard A's data
    const regsBInitial = await getOfflineRegistrations(GUARD_B, 'pending');
    expect(regsBInitial.length).toBe(0);

    const searchB = await searchCachedVisitors(GUARD_B, 'GuardA');
    expect(searchB.length).toBe(0);

    // Guard B runs offline maintenance - must NOT sync or destroy Guard A's records
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'guard-b-token',
          user: { id: GUARD_B },
        },
      },
    });

    const res = await runOfflineMaintenance();
    expect(res.summary.registrationsSynced).toBe(0);

    // Invariant (R3): Guard A's pending registration is preserved intact
    const regsAPreserved = await getOfflineRegistrations(GUARD_A, 'pending');
    expect(regsAPreserved.length).toBe(1);
    expect(regsAPreserved[0]?.offlineRegistrationId).toBe('reg-a-only');

    // 3. Guard B creates their own offline registration
    await saveOfflineRegistrationWithCache(GUARD_B, {
      offlineRegistrationId: 'reg-b-only',
      visitor: {
        firstName: 'GuardB',
        lastName: 'Visitor',
        contactNumber: '09170000002',
        purpose: 'Test B',
        visitDate: '2026-10-29',
      },
      occurredAt: new Date().toISOString(),
      action: 'approved',
    });

    // Guard B has 1 pending registration
    const regsB = await getOfflineRegistrations(GUARD_B, 'pending');
    expect(regsB.length).toBe(1);
    expect(regsB[0]?.offlineRegistrationId).toBe('reg-b-only');

    // 4. Guard A reauthenticates on next shift
    await transitionGuardOfflineStore(GUARD_A);
    expect(await getActiveGuardActorId()).toBe(GUARD_A);

    // Guard A re-accesses their original pending registration
    const regsARestored = await getOfflineRegistrations(GUARD_A, 'pending');
    expect(regsARestored.length).toBe(1);
    expect(regsARestored[0]?.offlineRegistrationId).toBe('reg-a-only');
    expect(regsARestored[0]?.visitor.firstName).toBe('GuardA');

    // Guard A cannot access Guard B's registration
    expect(regsARestored.some((r) => r.offlineRegistrationId === 'reg-b-only')).toBe(false);

    // Guard B's records also remain preserved in storage
    const regsBStillPreserved = await getOfflineRegistrations(GUARD_B, 'pending');
    expect(regsBStillPreserved.length).toBe(1);
    expect(regsBStillPreserved[0]?.offlineRegistrationId).toBe('reg-b-only');
  });

  it('clearAllGuardOfflineData locks/clears session metadata and cached visitors while preserving pending offline records (Requirement R3 & ADR-001)', async () => {
    await transitionGuardOfflineStore(GUARD_A);
    await saveOfflineRegistrationWithCache(GUARD_A, {
      offlineRegistrationId: 'reg-to-clear',
      visitor: {
        firstName: 'Clear',
        lastName: 'Me',
        contactNumber: '09170000000',
        purpose: 'Clear test',
        visitDate: '2026-10-29',
      },
      occurredAt: new Date().toISOString(),
      action: 'approved',
    });

    // Verify record exists before sign-out
    const countsBefore = await getPendingSyncCount(GUARD_A);
    expect(countsBefore.total).toBe(1);

    // Sign out clears session metadata and cached passes
    await clearAllGuardOfflineData();

    // Session metadata is cleared
    expect(await getActiveGuardActorId()).toBeNull();

    // Cached visitors are wiped from operational cache
    const searchAfter = await searchCachedVisitors(GUARD_A, 'Clear');
    expect(searchAfter.length).toBe(0);

    // Invariant (R3): Pending unsynchronized offline registration is preserved in storage
    const regsAfter = await getOfflineRegistrations(GUARD_A);
    expect(regsAfter.length).toBe(1);
    expect(regsAfter[0]?.offlineRegistrationId).toBe('reg-to-clear');

    // Reauthenticating as Guard A immediately restores full access to pending sync count
    await transitionGuardOfflineStore(GUARD_A);
    expect(await getActiveGuardActorId()).toBe(GUARD_A);
    const countsRestored = await getPendingSyncCount(GUARD_A);
    expect(countsRestored.total).toBe(1);
  });

  it('fails closed when attempting to save without valid actorId (Requirement 25)', async () => {
    await expect(
      saveOfflineRegistrationWithCache('', {
        offlineRegistrationId: 'no-actor-reg',
        visitor: {
          firstName: 'No',
          lastName: 'Actor',
          contactNumber: '09170000000',
          purpose: 'No Actor Test',
          visitDate: '2026-10-29',
        },
        occurredAt: new Date().toISOString(),
        action: 'approved',
      })
    ).rejects.toThrow('actorId required');

    await expect(
      queueOfflineEvent('', {
        eventId: 'no-actor-evt',
        passId: 'pass-1',
        visitorName: 'No Actor',
        action: 'record_exit',
        expectedStatus: 'inside',
        occurredAt: new Date().toISOString(),
        syncStatus: 'pending',
      })
    ).rejects.toThrow('actorId required');

    await expect(
      saveCachedVisitors('', [
        {
          id: 'pass-no-actor',
          actorId: '',
          visitorId: 'vis-1',
          visitorName: 'No Actor Visitor',
          contactNumber: '09170000000',
          purpose: 'Test',
          visitDate: '2026-10-29',
          status: 'issued',
          validFrom: '2026-10-29T08:00:00+08:00',
          validUntil: '2026-10-29T17:00:00+08:00',
          cachedAt: new Date().toISOString(),
        },
      ])
    ).rejects.toThrow('actorId required');
  });

  it('corrupted or unowned records with empty actorId are not visible or counted (Requirement 25)', async () => {
    await transitionGuardOfflineStore(GUARD_A);
    // Directly inject an unowned record into IndexedDB
    const { setupMockIndexedDb } = await import('./helpers/mockIndexedDb');
    const db = await setupMockIndexedDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('offline_registrations', 'readwrite');
      tx.objectStore('offline_registrations').put({
        offlineRegistrationId: 'corrupted-unowned-reg',
        actorId: '', // unowned / empty
        visitor: {
          firstName: 'Corrupted',
          lastName: 'Record',
          contactNumber: '09170000000',
          purpose: 'Corrupted',
          visitDate: '2026-10-29',
        },
        action: 'approved',
        occurredAt: new Date().toISOString(),
        syncStatus: 'pending',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const counts = await getPendingSyncCount(GUARD_A);
    expect(counts.total).toBe(0);
    const regs = await getOfflineRegistrations(GUARD_A);
    expect(regs.length).toBe(0);
  });
});
