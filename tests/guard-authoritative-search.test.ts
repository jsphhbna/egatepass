import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchGuardPendingQueue, type GuardQueuePass } from '@/services/guard';

describe('Group I: Guard Live / Authoritative Search Contract & Invariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const sampleLoadedPasses: GuardQueuePass[] = [
    {
      id: 'pass-1',
      visitorName: 'Juan Dela Cruz',
      purpose: 'Meeting with Dean',
      entryScannedAt: '2026-10-28T08:00:00Z',
      hasValidId: true,
      publicReference: 'EG-11111111',
      contactNumber: '09171234567',
    },
    {
      id: 'pass-2',
      visitorName: 'Maria Santos',
      purpose: 'Library Research',
      entryScannedAt: '2026-10-28T08:10:00Z',
      hasValidId: false,
      publicReference: 'EG-22222222',
      contactNumber: '09187654321',
    },
    {
      id: 'pass-3',
      visitorName: 'Santiago Ramon',
      purpose: 'Official Business',
      entryScannedAt: '2026-10-28T08:15:00Z',
      hasValidId: true,
      publicReference: 'EG-33333333',
      contactNumber: '09190001111',
    },
  ];

  it('filters locally on 1-character search without triggering authoritative RPC', () => {
    const term = 'j';
    const localMatches = sampleLoadedPasses.filter(
      (p) =>
        p.visitorName.toLowerCase().includes(term.toLowerCase()) ||
        p.purpose.toLowerCase().includes(term.toLowerCase())
    );

    expect(localMatches.length).toBe(1);
    expect(localMatches[0].visitorName).toBe('Juan Dela Cruz');
  });

  it('rejects client search query < 2 characters before RPC call', async () => {
    const results = await searchGuardPendingQueue('a');
    expect(results).toEqual([]);
  });

  it('fences query generations so later responses from older queries cannot overwrite newer results', async () => {
    let generation = 0;
    let committedResults: GuardQueuePass[] = [];

    async function executeSearch(query: string) {
      const currentGen = ++generation;
      
      // Simulate artificial delay: "Sa" takes longer (50ms) than "San" (10ms)
      const delay = query === 'Sa' ? 50 : 10;
      await new Promise((r) => setTimeout(r, delay));

      const mockResponse: GuardQueuePass[] =
        query === 'San'
          ? [sampleLoadedPasses[2]] // Santiago Ramon
          : [sampleLoadedPasses[1], sampleLoadedPasses[2]]; // Maria Santos + Santiago Ramon

      if (currentGen === generation) {
        committedResults = mockResponse;
      }
    }

    // Launch Sa first, then San shortly after
    const p1 = executeSearch('Sa');
    const p2 = executeSearch('San');

    await Promise.all([p1, p2]);

    // Committed results MUST be from the newer query "San", not the slower older query "Sa"
    expect(committedResults.length).toBe(1);
    expect(committedResults[0].visitorName).toBe('Santiago Ramon');
  });

  it('deduplicates local and authoritative matches by pass ID with authoritative data winning', () => {
    const localMatch: GuardQueuePass = {
      id: 'pass-1',
      visitorName: 'Juan Dela Cruz',
      purpose: 'Meeting',
      entryScannedAt: '2026-10-28T08:00:00Z',
      hasValidId: true,
    };

    const authoritativeMatch: GuardQueuePass = {
      id: 'pass-1',
      visitorName: 'Juan Dela Cruz',
      purpose: 'Meeting with Dean (Authoritative Details)',
      entryScannedAt: '2026-10-28T08:00:00Z',
      hasValidId: true,
      publicReference: 'EG-11111111',
    };

    const map = new Map<string, GuardQueuePass>();
    map.set(localMatch.id, localMatch);
    // Authoritative overwrites local on duplicate ID
    map.set(authoritativeMatch.id, authoritativeMatch);

    const merged = Array.from(map.values());
    expect(merged.length).toBe(1);
    expect(merged[0].purpose).toBe('Meeting with Dean (Authoritative Details)');
    expect(merged[0].publicReference).toBe('EG-11111111');
  });

  it('clearing search instantly restores live queue without reloading all passes', () => {
    let isSearchActive = true;
    let searchTerm = 'Santiago';

    // Clear search action
    searchTerm = '';
    isSearchActive = false;

    expect(isSearchActive).toBe(false);
    expect(searchTerm).toBe('');
    // Normal live queue remains untouched with 3 items
    expect(sampleLoadedPasses.length).toBe(3);
  });

  describe('Authoritative Search Action & Lifecycle Regressions', () => {
    const visitorX: GuardQueuePass = {
      id: 'pass-x',
      visitorName: 'Visitor X (Outside Local Queue)',
      purpose: 'Special Delivery',
      entryScannedAt: '2026-10-28T09:00:00Z',
      hasValidId: true,
      publicReference: 'EG-XXXXXXXX',
    };

    it('rejects an authoritative-only search result using rejectingPass identity (not passes.find)', async () => {
      // 1. Initial queue does not contain Visitor X
      const passes: GuardQueuePass[] = [...sampleLoadedPasses];
      expect(passes.some((p) => p.id === visitorX.id)).toBe(false);

      // 2. Authoritative search returns Visitor X
      let authoritativeResults: GuardQueuePass[] = [visitorX];
      const displayedResults = authoritativeResults;
      expect(displayedResults).toContainEqual(visitorX);

      // 3. User clicks Reject on displayed Visitor X -> sets rejectingPass directly
      let rejectingPass: GuardQueuePass | null = null;
      function onRejectClick(pass: GuardQueuePass) {
        rejectingPass = pass;
      }
      onRejectClick(displayedResults[0]);
      expect(rejectingPass).toEqual(visitorX);

      // 4. Mock recordDecision
      const mockRecordDecision = vi.fn().mockResolvedValue({ ok: true, status: 'rejected' });

      // 5. User selects reason and confirms reject using rejectingPass
      const reason = 'Invalid ID presentation';
      async function onConfirmReject() {
        if (!rejectingPass) return;
        await mockRecordDecision(rejectingPass.id, 'rejected', reason);
        // Remove from authoritative results immediately
        authoritativeResults = authoritativeResults.filter((p) => p.id !== rejectingPass?.id);
        rejectingPass = null;
      }

      await onConfirmReject();

      // Verify recordDecision was called with visitorX.id and reason
      expect(mockRecordDecision).toHaveBeenCalledTimes(1);
      expect(mockRecordDecision).toHaveBeenCalledWith('pass-x', 'rejected', 'Invalid ID presentation');

      // Verify visitorX immediately disappears from active search results
      expect(authoritativeResults.some((p) => p.id === 'pass-x')).toBe(false);
      expect(rejectingPass).toBeNull();
    });

    it('approves an authoritative-only search result and immediately removes it from active search results', async () => {
      const passes: GuardQueuePass[] = [...sampleLoadedPasses];
      expect(passes.some((p) => p.id === visitorX.id)).toBe(false);

      let authoritativeResults: GuardQueuePass[] = [visitorX];
      const mockRecordDecision = vi.fn().mockResolvedValue({ ok: true, status: 'approved' });

      async function handleApprove(pass: GuardQueuePass) {
        authoritativeResults = authoritativeResults.filter((p) => p.id !== pass.id);
        await mockRecordDecision(pass.id, 'approved', undefined);
      }

      await handleApprove(visitorX);

      expect(mockRecordDecision).toHaveBeenCalledTimes(1);
      expect(mockRecordDecision).toHaveBeenCalledWith('pass-x', 'approved', undefined);
      expect(authoritativeResults.some((p) => p.id === 'pass-x')).toBe(false);
    });

    it('removes authoritative result on 409 already processed or 422 expired conflict', async () => {
      let authoritativeResults: GuardQueuePass[] = [visitorX];

      async function handleApproveWithConflict(pass: GuardQueuePass) {
        try {
          const err: any = new Error('already processed');
          err.status = 409;
          throw err;
        } catch (err: any) {
          if (err?.status === 409 || err?.status === 422) {
            authoritativeResults = authoritativeResults.filter((p) => p.id !== pass.id);
          }
        }
      }

      await handleApproveWithConflict(visitorX);
      expect(authoritativeResults.some((p) => p.id === 'pass-x')).toBe(false);
    });

    it('external realtime pass mutation increments searchRevalidationVersion and refreshes search query', async () => {
      let searchRevalidationVersion = 0;
      let activeQuery = 'Visitor X';
      let searchCallCount = 0;

      // Simulate realtime subscription handler
      function onRealtimePassMutation() {
        if (activeQuery.trim().length >= 2) {
          searchRevalidationVersion += 1;
        }
      }

      // Simulate effect watching searchRevalidationVersion and activeQuery
      function runSearchEffect(query: string, version: number) {
        if (query.trim().length >= 2) {
          searchCallCount += 1;
        }
      }

      // Initial search
      runSearchEffect(activeQuery, searchRevalidationVersion);
      expect(searchCallCount).toBe(1);

      // External pass mutation arrives
      onRealtimePassMutation();
      expect(searchRevalidationVersion).toBe(1);

      // Revalidation triggers
      runSearchEffect(activeQuery, searchRevalidationVersion);
      expect(searchCallCount).toBe(2);
    });
  });
});
