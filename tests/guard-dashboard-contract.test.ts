import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGuardDashboard } from '@/services/guard';
import * as supabaseLib from '@/lib/supabase';

describe('Guard Dashboard Frontend Contract Regression (fetchGuardDashboard)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Maps canonical database payload accurately to frontend GuardDashboardData contract', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: {
        queue: [
          {
            id: 'pass-uuid-1',
            visitorName: 'Juan Dela Cruz',
            purpose: 'Official Business',
            source: 'portal',
            status: 'pending',
            validFrom: '2026-10-21T08:00:00Z',
            validUntil: '2026-10-21T17:00:00Z',
            scannedAt: '2026-10-21T09:00:00Z',
            gate: 'Gate 1',
            photoEvidenceId: 'photo-uuid-123',
            idEvidenceId: 'id-uuid-456',
          },
          {
            id: 'pass-uuid-2',
            visitorName: 'Maria Santos',
            purpose: 'Delivery',
            source: 'kiosk',
            status: 'pending',
            validFrom: '2026-10-21T08:00:00Z',
            validUntil: '2026-10-21T17:00:00Z',
            scannedAt: '2026-10-21T09:15:00Z',
            gate: 'Gate 2',
            photoEvidenceId: 'photo-uuid-789',
            idEvidenceId: null,
          },
        ],
        stats: {
          inside: 12,
          exited: 25,
          rejected: 3,
          total: 40,
        },
        rejectionReasons: ['Expired Pass', 'No Valid ID', 'Security Incident'],
        pendingTotal: 10,
        hasMore: true,
      },
      error: null,
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    } as any);

    const result = await fetchGuardDashboard({ limit: 2, offset: 0 });

    expect(mockRpc).toHaveBeenCalledWith('guard_dashboard', {
      requested_limit: 2,
      requested_offset: 0,
    });

    // Verify queue mapping
    expect(result.queue).toHaveLength(2);
    expect(result.queue[0].photoPublicId).toBe('photo-uuid-123');
    expect(result.queue[0].idImagePublicId).toBe('id-uuid-456');
    expect(result.queue[1].photoPublicId).toBe('photo-uuid-789');
    expect(result.queue[1].idImagePublicId).toBeNull();

    // Verify stats
    expect(result.stats).toEqual({
      inside: 12,
      exited: 25,
      rejected: 3,
      total: 40,
    });
    expect(result.stats.total).toBe(40);

    // Verify pagination and metadata
    expect(result.pendingTotal).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.rejectionReasons).toEqual(['Expired Pass', 'No Valid ID', 'Security Incident']);
  });

  it('2. MALFORMED CONTRACT REGRESSION: Fails visibly if pendingTotal is missing (e.g. renamed to totalPending)', async () => {
    // Simulates the regression introduced when RPC returned totalPending instead of pendingTotal
    const brokenRpc = vi.fn().mockResolvedValue({
      data: {
        queue: [],
        stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
        rejectionReasons: [],
        totalPending: 50, // BROKEN KEY
        hasMore: false,
      },
      error: null,
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: brokenRpc,
      }),
    } as any);

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /Malformed guard dashboard payload: missing canonical contract properties/
    );
  });

  it('3. MALFORMED CONTRACT REGRESSION: Fails visibly if stats.total is missing (e.g. replaced by stats.pending)', async () => {
    // Simulates the regression when stats returned { pending, inside, exited, rejected } without total
    const brokenRpc = vi.fn().mockResolvedValue({
      data: {
        queue: [],
        stats: { pending: 5, inside: 2, exited: 3, rejected: 1 }, // MISSING total
        rejectionReasons: [],
        pendingTotal: 5,
        hasMore: false,
      },
      error: null,
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: brokenRpc,
      }),
    } as any);

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /Malformed guard dashboard payload: missing canonical contract properties/
    );
  });

  it('4. MALFORMED CONTRACT REGRESSION: Fails visibly if queue items lack photoEvidenceId/idEvidenceId (e.g. replaced by evidence array)', async () => {
    // Simulates the regression when queue items returned evidence: [{ id, kind }] instead of photoEvidenceId/idEvidenceId
    const brokenRpc = vi.fn().mockResolvedValue({
      data: {
        queue: [
          {
            id: 'pass-uuid-1',
            visitorName: 'Juan Dela Cruz',
            purpose: 'Official Business',
            source: 'portal',
            status: 'pending',
            validFrom: '2026-10-21T08:00:00Z',
            validUntil: '2026-10-21T17:00:00Z',
            scannedAt: '2026-10-21T09:00:00Z',
            gate: 'Gate 1',
            evidence: [{ id: 'photo-1', kind: 'photo' }], // BROKEN EVIDENCE FORMAT
          },
        ],
        stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
        rejectionReasons: [],
        pendingTotal: 1,
        hasMore: false,
      },
      error: null,
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: brokenRpc,
      }),
    } as any);

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /Malformed guard queue item: missing canonical evidence properties/
    );
  });

  it('5. Handles database RPC error by throwing directly', async () => {
    const errorRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'permission denied', code: '42501' },
    });

    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: errorRpc,
      }),
    } as any);

    await expect(fetchGuardDashboard()).rejects.toEqual({
      message: 'permission denied',
      code: '42501',
    });
  });
});
