import { describe, it, expect, vi, beforeEach } from 'vitest';

// Synthetic database state representing `passes`
interface SyntheticPass {
  id: string;
  visitor_id: string;
  gate: string | null;
  time_in: string | null;
  time_out: string | null;
  issued_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  status: 'inside' | 'exited' | 'issued' | 'expired';
  visitors: {
    full_name: string;
    purpose: string;
  } | null;
}

let dbPasses: SyntheticPass[] = [];

// Helper to simulate PostgREST filter on passes
function simulateQuery(filters: {
  snapshotAt: string;
  afterTimeIn?: string;
  afterId?: string;
  gate?: string;
  limit: number;
}) {
  let matched = dbPasses.filter((p) => {
    if (!p.time_in) return false;
    // time_in <= snapshotAt
    if (new Date(p.time_in).getTime() > new Date(filters.snapshotAt).getTime()) return false;
    // time_out IS NULL OR time_out > snapshotAt
    if (p.time_out !== null && new Date(p.time_out).getTime() <= new Date(filters.snapshotAt).getTime()) {
      return false;
    }
    if (filters.gate && p.gate !== filters.gate) return false;
    return true;
  });

  // Sort time_in DESC, id DESC
  matched.sort((a, b) => {
    const timeCmp = new Date(b.time_in!).getTime() - new Date(a.time_in!).getTime();
    if (timeCmp !== 0) return timeCmp;
    return b.id.localeCompare(a.id);
  });

  // Keyset cursor: time_in < afterTimeIn OR (time_in = afterTimeIn AND id < afterId)
  if (filters.afterTimeIn && filters.afterId) {
    const afterTime = new Date(filters.afterTimeIn).getTime();
    matched = matched.filter((p) => {
      const pTime = new Date(p.time_in!).getTime();
      if (pTime < afterTime) return true;
      if (pTime === afterTime && p.id.localeCompare(filters.afterId!) < 0) return true;
      return false;
    });
  }

  return matched.slice(0, filters.limit);
}

function countSnapshot(snapshotAt: string, gate?: string): number {
  return dbPasses.filter((p) => {
    if (!p.time_in) return false;
    if (new Date(p.time_in).getTime() > new Date(snapshotAt).getTime()) return false;
    if (p.time_out !== null && new Date(p.time_out).getTime() <= new Date(snapshotAt).getTime()) return false;
    if (gate && p.gate !== gate) return false;
    return true;
  }).length;
}

vi.mock('../server/actors.js', () => ({
  requireStaffActor: vi.fn(async () => ({ id: 'admin-1', role: 'admin' })),
  HttpError: class HttpError extends Error {
    constructor(public status: number, public code: string) {
      super(code);
    }
  },
}));

vi.mock('../server/supabase.js', () => {
  return {
    getServerSupabaseClients: () => ({
      admin: {
        from: (_table: string) => ({
          select: (_cols: string, opts?: any) => {
            if (opts?.count === 'exact' && opts?.head === true) {
              return {
                lte: (_field: string, snapshotAt: string) => ({
                  or: (_orStr: string) => ({
                    eq: (_gField: string, gVal: string) => Promise.resolve({
                      count: countSnapshot(snapshotAt, gVal),
                      error: null,
                    }),
                    then: (resolve: any) => resolve({
                      count: countSnapshot(snapshotAt),
                      error: null,
                    }),
                  }),
                }),
              };
            }

            let capturedSnapshotAt = '';
            let capturedCursorTimeIn: string | undefined;
            let capturedCursorId: string | undefined;
            let capturedGate: string | undefined;
            let capturedLimit = 1000;

            const queryObj: any = {
              lte: (_f: string, snap: string) => {
                capturedSnapshotAt = snap;
                return queryObj;
              },
              or: (clause: string) => {
                if (clause.includes('time_in.lt.')) {
                  // Parse keyset cursor: time_in.lt.<cursorTime>,and(time_in.eq.<cursorTime>,id.lt.<cursorId>)
                  const match = clause.match(/time_in\.lt\.([^,]+),and\(time_in\.eq\.[^,]+,id\.lt\.([^)]+)\)/);
                  if (match) {
                    capturedCursorTimeIn = match[1];
                    capturedCursorId = match[2];
                  }
                }
                return queryObj;
              },
              order: () => queryObj,
              limit: (lim: number) => {
                capturedLimit = lim;
                return queryObj;
              },
              eq: (_f: string, val: string) => {
                capturedGate = val;
                return queryObj;
              },
              then: (resolve: any) => {
                const rows = simulateQuery({
                  snapshotAt: capturedSnapshotAt,
                  afterTimeIn: capturedCursorTimeIn,
                  afterId: capturedCursorId,
                  gate: capturedGate,
                  limit: capturedLimit,
                });
                return resolve({ data: rows, error: null });
              },
            };
            return queryObj;
          },
        }),
      },
    }),
  };
});

import emergencyRoute from '../server/routes/admin/emergency';

describe('Repair Group 2: Emergency Evacuation Roster Keyset Snapshot Pagination', () => {
  beforeEach(() => {
    dbPasses = [];
  });

  it('Stable roster: 2,500 visitors inside are all retrieved exactly once across multiple pages', async () => {
    const baseTime = new Date('2026-10-26T08:00:00.000Z').getTime();
    for (let i = 0; i < 2500; i++) {
      const timeIn = new Date(baseTime + i * 1000).toISOString();
      const id = `pass-${String(i).padStart(5, '0')}`;
      dbPasses.push({
        id,
        visitor_id: `v-${i}`,
        gate: 'Gate 1',
        time_in: timeIn,
        time_out: null,
        issued_at: timeIn,
        valid_from: timeIn,
        valid_until: new Date(baseTime + 86400000).toISOString(),
        status: 'inside',
        visitors: { full_name: `Visitor ${i}`, purpose: 'Event' },
      });
    }

    const req = new Request('http://localhost/api/admin/emergency', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });

    const res = await emergencyRoute.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(2500);
    expect(body.snapshotTotal).toBe(2500);
    expect(body.truncated).toBe(false);

    // Verify all 2500 IDs present and no duplicates
    const returnedIds = new Set(body.passes.map((p: any) => p.id));
    expect(returnedIds.size).toBe(2500);
  });

  it('ADVERSARIAL CASE B: Exit during traversal keeps visitor in snapshot (snapshot membership unchanged)', async () => {
    const baseTime = new Date('2026-10-26T08:00:00.000Z').getTime();
    for (let i = 0; i < 1500; i++) {
      const timeIn = new Date(baseTime + i * 1000).toISOString();
      dbPasses.push({
        id: `pass-${String(i).padStart(5, '0')}`,
        visitor_id: `v-${i}`,
        gate: 'Gate 1',
        time_in: timeIn,
        time_out: null,
        issued_at: timeIn,
        valid_from: timeIn,
        valid_until: new Date(baseTime + 86400000).toISOString(),
        status: 'inside',
        visitors: { full_name: `Visitor ${i}`, purpose: 'Event' },
      });
    }

    // Visitor X is in page 2 (index 1200)
    const visitorX = dbPasses[1200]!;

    // Simulate visitor X exiting AFTER snapshotAt was established
    // snapshotAt is ~Date.now(), visitor X exits after snapshot
    const futureTime = new Date(Date.now() + 60000).toISOString();
    visitorX.status = 'exited';
    visitorX.time_out = futureTime;

    const req = new Request('http://localhost/api/admin/emergency', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });

    const res = await emergencyRoute.fetch(req);
    const body = await res.json();

    // Visitor X was inside at snapshotAt and MUST remain in the returned roster
    const foundX = body.passes.find((p: any) => p.id === visitorX.id);
    expect(foundX).toBeDefined();
    expect(body.total).toBe(1500);
  });

  it('ADVERSARIAL CASE C: Entry during traversal is not injected into current snapshot traversal', async () => {
    const pastTime = new Date(Date.now() - 3600000).toISOString();
    for (let i = 0; i < 50; i++) {
      dbPasses.push({
        id: `old-pass-${i}`,
        visitor_id: `v-${i}`,
        gate: 'Gate 1',
        time_in: pastTime,
        time_out: null,
        issued_at: pastTime,
        valid_from: pastTime,
        valid_until: new Date(Date.now() + 86400000).toISOString(),
        status: 'inside',
        visitors: { full_name: `Visitor ${i}`, purpose: 'Event' },
      });
    }

    // New visitor enters AFTER snapshot instant
    const futureEntryTime = new Date(Date.now() + 5000).toISOString();
    dbPasses.push({
      id: 'new-entrant-mid-traversal',
      visitor_id: 'v-new',
      gate: 'Gate 1',
      time_in: futureEntryTime,
      time_out: null,
      issued_at: futureEntryTime,
      valid_from: futureEntryTime,
      valid_until: new Date(Date.now() + 86400000).toISOString(),
      status: 'inside',
      visitors: { full_name: 'Late Entrant', purpose: 'Event' },
    });

    const req = new Request('http://localhost/api/admin/emergency', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });

    const res = await emergencyRoute.fetch(req);
    const body = await res.json();

    expect(body.total).toBe(50);
    const lateEntrant = body.passes.find((p: any) => p.id === 'new-entrant-mid-traversal');
    expect(lateEntrant).toBeUndefined();
  });

  it('Same-timestamp tie breaker: identical time_in sorts deterministically with no omissions or duplicates', async () => {
    const identicalTime = '2026-10-26T09:00:00.000Z';
    // 1,500 visitors with the exact same second
    for (let i = 0; i < 1500; i++) {
      dbPasses.push({
        id: `pass-id-${String(i).padStart(4, '0')}`,
        visitor_id: `v-${i}`,
        gate: 'Main Gate',
        time_in: identicalTime,
        time_out: null,
        issued_at: identicalTime,
        valid_from: identicalTime,
        valid_until: '2026-10-26T17:00:00.000Z',
        status: 'inside',
        visitors: { full_name: `Visitor ${i}`, purpose: 'Ceremony' },
      });
    }

    const req = new Request('http://localhost/api/admin/emergency', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });

    const res = await emergencyRoute.fetch(req);
    const body = await res.json();

    expect(body.total).toBe(1500);
    const uniqueIds = new Set(body.passes.map((p: any) => p.id));
    expect(uniqueIds.size).toBe(1500);
  });

  it('10,000 Safety Ceiling: sets truncated = true and snapshotTotal > returned count', async () => {
    // Simulate count query returning 12,500
    const originalCountSnapshot = countSnapshot;
    const pastTime = new Date(Date.now() - 3600000).toISOString();

    // Populate 10,005 items
    for (let i = 0; i < 10005; i++) {
      dbPasses.push({
        id: `pass-${String(i).padStart(6, '0')}`,
        visitor_id: `v-${i}`,
        gate: 'Main Gate',
        time_in: pastTime,
        time_out: null,
        issued_at: pastTime,
        valid_from: pastTime,
        valid_until: new Date(Date.now() + 86400000).toISOString(),
        status: 'inside',
        visitors: { full_name: `Visitor ${i}`, purpose: 'Mass' },
      });
    }

    const req = new Request('http://localhost/api/admin/emergency', {
      headers: { Authorization: 'Bearer test-admin-token' },
    });

    const res = await emergencyRoute.fetch(req);
    const body = await res.json();

    expect(body.total).toBe(10000); // capped at safety ceiling
    expect(body.snapshotTotal).toBe(10005);
    expect(body.truncated).toBe(true);
  });
});
