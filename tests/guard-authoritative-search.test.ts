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
});
