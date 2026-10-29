import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  prepareGuardOfflineStoreForActor,
  getActiveGuardActorId,
  saveOfflineRegistrationWithCache,
  queueOfflineEvent,
  getOfflineRegistrations,
  getOfflineEvents,
  getPendingSyncCount,
  searchCachedVisitors,
  atomicReplaceCachedVisitors,
  clearAllGuardOfflineData,
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
    await prepareGuardOfflineStoreForActor(GUARD_A);
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
    await queueOfflineEvent({
      eventId: 'evt-001',
      passId: 'pass-001',
      action: 'record_entry',
      expectedStatus: 'issued',
      expectedVersion: 1,
      occurredAt: new Date().toISOString(),
      entryGate: 'Gate 1',
      actorId: GUARD_A,
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
    await prepareGuardOfflineStoreForActor(GUARD_A);
    const serverPasses: CachedVisitorPass[] = [
      {
        id: 'pass-a-1',
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
    await atomicReplaceCachedVisitors(serverPasses);

    // Guard A can see the visitor
    const searchA = await searchCachedVisitors('Confidential Visitor');
    expect(searchA.length).toBe(1);

    // 2. Guard B logs in on same device
    await prepareGuardOfflineStoreForActor(GUARD_B);
    expect(await getActiveGuardActorId()).toBe(GUARD_B);

    // Guard B's search MUST NOT reveal Guard A's cached visitor
    const searchB = await searchCachedVisitors('Confidential Visitor');
    expect(searchB.length).toBe(0);
  });

  it('runOfflineMaintenance only synchronizes records belonging to active actor', async () => {
    // Guard A creates offline registration
    await prepareGuardOfflineStoreForActor(GUARD_A);
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

    // Guard B logs in and runs maintenance
    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'guard-b-token',
          user: { id: GUARD_B },
        },
      },
    });

    const res = await runOfflineMaintenance();
    // Guard B has 0 records, so 0 registrations synced
    expect(res.summary.registrationsSynced).toBe(0);

    // Guard A's record remains pending
    const regsA = await getOfflineRegistrations(GUARD_A, 'pending');
    expect(regsA.length).toBe(1);
    expect(regsA[0]?.offlineRegistrationId).toBe('reg-a-only');
  });

  it('clearAllGuardOfflineData removes all offline data across stores', async () => {
    await prepareGuardOfflineStoreForActor(GUARD_A);
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

    await clearAllGuardOfflineData();

    const counts = await getPendingSyncCount();
    expect(counts.total).toBe(0);
    const regs = await getOfflineRegistrations();
    expect(regs.length).toBe(0);
  });
});
