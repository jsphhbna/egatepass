import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGuardDashboard } from '@/services/guard';
import * as supabaseLib from '@/lib/supabase';

describe('Guard Dashboard Frontend Contract Regression (fetchGuardDashboard)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const validItem = {
    id: '11111111-1111-4111-8111-111111111111',
    visitorName: 'Juan Dela Cruz',
    purpose: 'Official Business',
    source: 'portal' as const,
    status: 'pending' as const,
    validFrom: '2026-10-21T08:00:00Z',
    validUntil: '2026-10-21T17:00:00Z',
    scannedAt: '2026-10-21T09:00:00Z',
    gate: 'Gate 1',
    photoEvidenceId: '22222222-2222-4222-8222-222222222222',
    idEvidenceId: '33333333-3333-4333-8333-333333333333',
  };

  const validPayload = {
    queue: [validItem],
    stats: {
      inside: 12,
      exited: 25,
      rejected: 3,
      total: 40,
    },
    rejectionReasons: ['Expired Pass', 'No Valid ID', 'Security Incident'],
    pendingTotal: 10,
    hasMore: true,
  };

  function mockRpcReturn(payload: unknown, error: unknown = null) {
    const mockRpc = vi.fn().mockResolvedValue({
      data: payload,
      error,
    });
    vi.spyOn(supabaseLib, 'requireSupabase').mockReturnValue({
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    } as any);
    return mockRpc;
  }

  it('1. Maps valid canonical database payload accurately to frontend GuardDashboardData contract', async () => {
    const mockRpc = mockRpcReturn(validPayload);

    const result = await fetchGuardDashboard({ limit: 1, offset: 0 });

    expect(mockRpc).toHaveBeenCalledWith('guard_dashboard', {
      requested_limit: 1,
      requested_offset: 0,
    });

    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].photoPublicId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.queue[0].idImagePublicId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.stats).toEqual({
      inside: 12,
      exited: 25,
      rejected: 3,
      total: 40,
    });
    expect(result.pendingTotal).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.rejectionReasons).toEqual(['Expired Pass', 'No Valid ID', 'Security Incident']);
  });

  it('2. Accepts idEvidenceId as null (e.g. portal pass without separate ID document)', async () => {
    const payload = {
      ...validPayload,
      queue: [{ ...validItem, idEvidenceId: null }],
    };
    mockRpcReturn(payload);

    const result = await fetchGuardDashboard();
    expect(result.queue[0].idImagePublicId).toBeNull();
  });

  it('3. Rejects payload when photoEvidenceId is missing', async () => {
    const badItem: any = { ...validItem };
    delete badItem.photoEvidenceId;
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.photoEvidenceId/
    );
  });

  it('4. Rejects payload when photoEvidenceId is null', async () => {
    const badItem = { ...validItem, photoEvidenceId: null as any };
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.photoEvidenceId/
    );
  });

  it('5. Rejects payload when photoEvidenceId is malformed type (numeric/invalid UUID)', async () => {
    const badItem = { ...validItem, photoEvidenceId: 12345 as any };
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.photoEvidenceId/
    );
  });

  it('6. Rejects payload when idEvidenceId is numeric or object', async () => {
    const badItem = { ...validItem, idEvidenceId: 12345 as any };
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.idEvidenceId/
    );
  });

  it('7. Rejects payload when pendingTotal is negative', async () => {
    mockRpcReturn({ ...validPayload, pendingTotal: -1 });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: pendingTotal/
    );
  });

  it('8. Rejects payload when pendingTotal is fractional', async () => {
    mockRpcReturn({ ...validPayload, pendingTotal: 2.5 });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: pendingTotal/
    );
  });

  it('9. Rejects payload when stats.total is missing', async () => {
    const badStats: any = { ...validPayload.stats };
    delete badStats.total;
    mockRpcReturn({ ...validPayload, stats: badStats });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: stats.total/
    );
  });

  it('10. Rejects payload when stats.total is negative', async () => {
    mockRpcReturn({
      ...validPayload,
      stats: { ...validPayload.stats, total: -5 },
    });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: stats.total/
    );
  });

  it('11. Rejects payload when source is unexpected (e.g. invalid string)', async () => {
    const badItem = { ...validItem, source: 'mobile_app' as any };
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.source/
    );
  });

  it('12. Rejects payload when status is not "pending"', async () => {
    const badItem = { ...validItem, status: 'approved' as any };
    mockRpcReturn({ ...validPayload, queue: [badItem] });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: queue.0.status/
    );
  });

  it('13. Rejects payload when hasMore is not boolean', async () => {
    mockRpcReturn({ ...validPayload, hasMore: 'true' as any });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: hasMore/
    );
  });

  it('14. Rejects payload when rejectionReasons contains non-strings', async () => {
    mockRpcReturn({ ...validPayload, rejectionReasons: [123, 'valid reason'] as any });

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: rejectionReasons.0/
    );
  });

  it('15. Rejects payload with totalPending instead of canonical pendingTotal', async () => {
    const badPayload: any = { ...validPayload };
    delete badPayload.pendingTotal;
    badPayload.totalPending = 10;
    mockRpcReturn(badPayload);

    await expect(fetchGuardDashboard()).rejects.toThrow(
      /api.guard_dashboard contract violation: pendingTotal/
    );
  });

  it('16. Handles database RPC error by throwing directly', async () => {
    mockRpcReturn(null, { message: 'permission denied', code: '42501' });

    await expect(fetchGuardDashboard()).rejects.toEqual({
      message: 'permission denied',
      code: '42501',
    });
  });
});
