import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveCachedVisitors,
  searchCachedVisitors,
  atomicReplaceCachedVisitors,
  purgeStaleLocalData,
  queueOfflineEvent,
  getOfflineEvents,
  type CachedVisitorPass,
} from '@/lib/offline/guardIndexedDb';
import { refreshOperationalCache } from '@/lib/offline/guardSyncManager';

// Mock dependencies for guardSyncManager
const mockRpc = vi.fn();
const mockGetSession = vi.fn();
vi.mock('@/lib/supabase', () => ({
  requireSupabase: () => ({
    auth: {
      getSession: mockGetSession,
    },
    rpc: mockRpc,
  }),
}));

// Mock global fetch for evidence blob retrieval
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Section F: Guard Offline Cache Behavior Tests (CACHE-T01 - CACHE-T05)', () => {
  beforeEach(() => {
    setupMockIndexedDb();
    vi.clearAllMocks();

    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'guard-test-token-xyz',
        },
      },
    });

    mockFetch.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['fake-image-bytes'], { type: 'image/webp' }),
    });
  });

  // CACHE-T01: More than 50 visitors paginated
  it('CACHE-T01: exhausts all pages to cache > 50 visitors (125 total), not capped at 50', async () => {
    // Generate 125 synthetic visitors across 3 pages: 50, 50, 25
    const totalVisitors = 125;
    const allVisitors = Array.from({ length: totalVisitors }, (_, i) => ({
      passId: `pass-${i + 1}`,
      publicReference: `ref-${i + 1}-uuid`,
      visitorId: `vis-${i + 1}`,
      visitorName: `Visitor ${i + 1}`,
      contactNumber: `0917000${String(i).padStart(4, '0')}`,
      purpose: 'Official Business',
      visitDate: '2026-10-27',
      status: 'inside',
      version: 1,
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      timeIn: '2026-10-27T08:30:00+08:00',
      gate: 'Main Gate',
      photoEvidenceId: null,
      idEvidenceId: null,
    }));

    mockRpc.mockImplementation((name: string, params: any) => {
      if (name === 'guard_offline_snapshot_page') {
        const cursor = params.requested_cursor;
        const startIndex = cursor ? parseInt(cursor.replace('cursor-', ''), 10) : 0;
        const pageItems = allVisitors.slice(startIndex, startIndex + 50);
        const nextIndex = startIndex + 50;
        const hasMore = nextIndex < totalVisitors;

        return Promise.resolve({
          data: {
            items: pageItems,
            nextCursor: hasMore ? `cursor-${nextIndex}` : null,
            hasMore: hasMore,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const cachedCount = await refreshOperationalCache();
    expect(cachedCount).toBe(125);

    const cached = await searchCachedVisitors('');
    expect(cached.length).toBe(125);
    expect(cached[0]?.visitorName).toBe('Visitor 1');
    expect(cached[124]?.visitorName).toBe('Visitor 125');
  });

  // CACHE-T02: No letter-a dependency
  it('CACHE-T02: caches and searches visitors with no letter "a" in name, contact, or reference', async () => {
    const noA_Visitors = [
      {
        passId: 'pass-no-a-1',
        publicReference: 'bcdef012-3456-7890-bcde-f01234567890',
        visitorId: 'vis-no-a-1',
        visitorName: 'John Cruz', // No letter 'a'
        contactNumber: '09180001111',
        purpose: 'Office Visit',
        visitDate: '2026-10-27',
        status: 'issued',
        version: 1,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        photoEvidenceId: null,
        idEvidenceId: null,
      },
      {
        passId: 'pass-no-a-2',
        publicReference: '78901234-5678-9012-7890-123456789012',
        visitorId: 'vis-no-a-2',
        visitorName: 'Bobby Lim', // No letter 'a'
        contactNumber: '09192223333',
        purpose: 'Consult',
        visitDate: '2026-10-27',
        status: 'inside',
        version: 1,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        photoEvidenceId: null,
        idEvidenceId: null,
      },
      {
        passId: 'pass-no-a-3',
        publicReference: '34567890-1234-5678-3456-789012345678',
        visitorId: 'vis-no-a-3',
        visitorName: 'Jun Rico', // No letter 'a'
        contactNumber: '09204445555',
        purpose: 'Billing',
        visitDate: '2026-10-27',
        status: 'pending',
        version: 1,
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        photoEvidenceId: null,
        idEvidenceId: null,
      },
    ];

    mockRpc.mockResolvedValue({
      data: {
        items: noA_Visitors,
        nextCursor: null,
        hasMore: false,
      },
      error: null,
    });

    const cachedCount = await refreshOperationalCache();
    expect(cachedCount).toBe(3);

    // Assert every one is found without requiring 'a'
    const searchCruz = await searchCachedVisitors('Cruz');
    expect(searchCruz.length).toBe(1);
    expect(searchCruz[0]?.visitorName).toBe('John Cruz');

    const searchLim = await searchCachedVisitors('Bobby');
    expect(searchLim.length).toBe(1);
    expect(searchLim[0]?.visitorName).toBe('Bobby Lim');

    const searchRico = await searchCachedVisitors('Rico');
    expect(searchRico.length).toBe(1);
    expect(searchRico[0]?.visitorName).toBe('Jun Rico');
  });

  // CACHE-T03: Evidence offline display
  it('CACHE-T03: caches photo and ID Blobs in IndexedDB and retrieves them with zero network dependency', async () => {
    const photoBlobBytes = new Blob(['photo-bytes-xyz'], { type: 'image/jpeg' });
    const idBlobBytes = new Blob(['id-bytes-123'], { type: 'image/png' });

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('evi-photo-777')) {
        return { ok: true, blob: async () => photoBlobBytes };
      }
      if (url.includes('evi-id-888')) {
        return { ok: true, blob: async () => idBlobBytes };
      }
      throw new Error('Unknown URL');
    });

    mockRpc.mockResolvedValue({
      data: {
        items: [
          {
            passId: 'pass-offline-ev',
            publicReference: 'ref-ev-1111',
            visitorId: 'vis-offline-ev',
            visitorName: 'Offline Evidence Visitor',
            contactNumber: '09178889999',
            purpose: 'Evidence Verification',
            visitDate: '2026-10-27',
            status: 'inside',
            version: 1,
            validFrom: '2026-10-27T08:00:00+08:00',
            validUntil: '2026-10-27T17:00:00+08:00',
            photoEvidenceId: 'evi-photo-777',
            idEvidenceId: 'evi-id-888',
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
      error: null,
    });

    await refreshOperationalCache();

    // Now disconnect network completely
    mockFetch.mockRejectedValue(new Error('Network offline (failed to fetch)'));
    mockRpc.mockRejectedValue(new Error('Network offline'));

    // Search cached visitor
    const results = await searchCachedVisitors('Offline Evidence Visitor');
    expect(results.length).toBe(1);
    const visitor = results[0]!;

    expect(visitor.photoBlob).not.toBeNull();
    expect(visitor.idBlob).not.toBeNull();
    expect(visitor.photoBlob?.type).toBe('image/jpeg');
    expect(visitor.idBlob?.type).toBe('image/png');
  });

  // CACHE-T04: Failed refresh preserves previous snapshot
  it('CACHE-T04: aborts and preserves previous valid snapshot if download fails halfway', async () => {
    // 1. Establish valid previous snapshot with 2 visitors
    const initialVisitors: CachedVisitorPass[] = [
      {
        id: 'initial-1',
        visitorId: 'v-init-1',
        visitorName: 'Initial Person 1',
        contactNumber: '09171111111',
        purpose: 'Initial Test',
        visitDate: '2026-10-27',
        status: 'issued',
        passReference: 'EG-11111111',
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: new Date().toISOString(),
        photoBlob: null,
        idBlob: null,
      },
      {
        id: 'initial-2',
        visitorId: 'v-init-2',
        visitorName: 'Initial Person 2',
        contactNumber: '09172222222',
        purpose: 'Initial Test',
        visitDate: '2026-10-27',
        status: 'inside',
        passReference: 'EG-22222222',
        validFrom: '2026-10-27T08:00:00+08:00',
        validUntil: '2026-10-27T17:00:00+08:00',
        cachedAt: new Date().toISOString(),
        photoBlob: null,
        idBlob: null,
      },
    ];
    await atomicReplaceCachedVisitors(initialVisitors);

    // 2. Next refresh fails during evidence download for item 2
    mockRpc.mockResolvedValue({
      data: {
        items: [
          {
            passId: 'new-1',
            publicReference: 'ref-new-1',
            visitorId: 'vis-new-1',
            visitorName: 'New Person 1',
            contactNumber: '09173333333',
            purpose: 'New Test',
            visitDate: '2026-10-27',
            status: 'issued',
            photoEvidenceId: 'evi-ok',
          },
          {
            passId: 'new-2',
            publicReference: 'ref-new-2',
            visitorId: 'vis-new-2',
            visitorName: 'New Person 2',
            contactNumber: '09174444444',
            purpose: 'New Test',
            visitDate: '2026-10-27',
            status: 'inside',
            photoEvidenceId: 'evi-fail', // Triggers network error
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
      error: null,
    });

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('evi-ok')) {
        return { ok: true, blob: async () => new Blob(['ok-bytes']) };
      }
      throw new Error('Connection reset while downloading evidence');
    });

    await expect(refreshOperationalCache()).rejects.toThrow('Evidence download failed');

    // 3. Verify previous snapshot is completely intact
    const remaining = await searchCachedVisitors('');
    expect(remaining.length).toBe(2);
    expect(remaining.some((v) => v.id === 'initial-1')).toBe(true);
    expect(remaining.some((v) => v.id === 'initial-2')).toBe(true);
    expect(remaining.some((v) => v.id === 'new-1')).toBe(false);
  });

  // CACHE-T05: Purge stale records on date change
  it('CACHE-T05: purges yesterday visitor metadata and blobs without deleting pending offline events', async () => {
    // 1. Setup yesterday visitor and today visitor
    const yesterdayVisitor: CachedVisitorPass = {
      id: 'pass-yesterday',
      visitorId: 'vis-yesterday',
      visitorName: 'Yesterday Visitor',
      contactNumber: '09175555555',
      purpose: 'Yesterday Audit',
      visitDate: '2026-10-26', // Yesterday
      status: 'inside',
      passReference: 'EG-55555555',
      validFrom: '2026-10-26T08:00:00+08:00',
      validUntil: '2026-10-26T17:00:00+08:00',
      cachedAt: new Date().toISOString(),
      photoBlob: new Blob(['yesterday-photo']),
      idBlob: new Blob(['yesterday-id']),
    };

    const todayVisitor: CachedVisitorPass = {
      id: 'pass-today',
      visitorId: 'vis-today',
      visitorName: 'Today Visitor',
      contactNumber: '09176666666',
      purpose: 'Today Audit',
      visitDate: '2026-10-27', // Today
      status: 'inside',
      passReference: 'EG-66666666',
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      cachedAt: new Date().toISOString(),
      photoBlob: new Blob(['today-photo']),
      idBlob: new Blob(['today-id']),
    };

    await saveCachedVisitors([yesterdayVisitor, todayVisitor]);

    // 2. Queue a pending offline event that must NOT be purged
    await queueOfflineEvent({
      eventId: 'evt-pending-outbox-999',
      passId: 'pass-yesterday',
      action: 'record_exit',
      expectedStatus: 'inside',
      occurredAt: '2026-10-26T18:00:00+08:00',
      syncStatus: 'pending',
    });

    // 3. Purge for today: '2026-10-27'
    const purgeReport = await purgeStaleLocalData('2026-10-27');
    expect(purgeReport.purgedVisitors).toBeGreaterThanOrEqual(1);

    // 4. Assert yesterday visitor was purged, today visitor remains
    const activeCached = await searchCachedVisitors('');
    expect(activeCached.some((v) => v.id === 'pass-yesterday')).toBe(false);
    expect(activeCached.some((v) => v.id === 'pass-today')).toBe(true);

    // 5. Assert pending offline outbox was preserved
    const pendingEvents = await getOfflineEvents('pending');
    expect(pendingEvents.length).toBe(1);
    expect(pendingEvents[0]?.eventId).toBe('evt-pending-outbox-999');
  });
});
