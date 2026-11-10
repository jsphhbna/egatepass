import { describe, it, expect, vi, beforeEach } from 'vitest';
import recordsRoute from '../server/routes/admin/records';

vi.mock('../server/supabase.js', () => ({
  getServerSupabaseClients: vi.fn(),
}));

vi.mock('../server/actors.js', () => ({
  HttpError: class HttpError extends Error {
    constructor(public status: number, public code: string) {
      super(code);
    }
  },
  requireStaffActor: vi.fn().mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000001',
    role: 'superadmin',
  }),
}));

describe('Phase A: Visitor Records and Guard Workflow Invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('server/routes/admin/records.ts - Multi-status & Non-blocking Expiry', () => {
    it('supports comma-separated status values (exited,expired,rejected) via query.in', async () => {
      const mockQuery: any = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              visitor_id: '22222222-2222-2222-2222-222222222222',
              source: 'portal',
              status: 'exited',
              valid_from: '2026-11-10T08:00:00Z',
              valid_until: '2026-11-10T17:00:00Z',
              issued_at: '2026-11-10T08:00:00Z',
              entry_scanned_at: '2026-11-10T08:30:00Z',
              decided_at: null,
              time_in: '2026-11-10T08:30:00Z',
              time_out: '2026-11-10T16:00:00Z',
              entry_device_id: null,
              exit_device_id: null,
              decided_by: null,
              rejection_reason: null,
              gate: 'Gate 1',
              visitors: {
                full_name: 'Juan Dela Cruz',
                purpose: 'Meeting',
                visit_date: '2026-11-10',
                visitor_evidence: [],
              },
            },
          ],
          error: null,
        }),
      };

      const mockAdmin: any = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
        }),
        from: vi.fn().mockReturnValue(mockQuery),
      };

      const { getServerSupabaseClients } = await import('../server/supabase.js');
      vi.mocked(getServerSupabaseClients).mockReturnValue({ admin: mockAdmin } as any);

      const request = new Request('https://egatepass.tech/api/admin/records?status=exited,expired,rejected', {
        headers: { Authorization: 'Bearer mock_staff_token' },
      });

      const response = await recordsRoute.fetch(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.passes).toHaveLength(1);
      expect(json.passes[0].status).toBe('exited');

      // Verify query.in was called with array of statuses
      expect(mockQuery.in).toHaveBeenCalledWith('status', ['exited', 'expired', 'rejected']);
      expect(mockQuery.eq).not.toHaveBeenCalledWith('status', expect.anything());
    });

    it('supports single status value (inside) via query.eq', async () => {
      const mockQuery: any = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              id: '33333333-3333-3333-3333-333333333333',
              visitor_id: '44444444-4444-4444-4444-444444444444',
              source: 'portal',
              status: 'inside',
              valid_from: '2026-11-10T08:00:00Z',
              valid_until: '2026-11-10T17:00:00Z',
              issued_at: '2026-11-10T08:00:00Z',
              entry_scanned_at: '2026-11-10T08:30:00Z',
              decided_at: null,
              time_in: '2026-11-10T08:30:00Z',
              time_out: null,
              entry_device_id: null,
              exit_device_id: null,
              decided_by: null,
              rejection_reason: null,
              gate: 'Gate 2',
              visitors: {
                full_name: 'Maria Santos',
                purpose: 'Document submission',
                visit_date: '2026-11-10',
                visitor_evidence: [],
              },
            },
          ],
          error: null,
        }),
      };

      const mockAdmin: any = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
        }),
        from: vi.fn().mockReturnValue(mockQuery),
      };

      const { getServerSupabaseClients } = await import('../server/supabase.js');
      vi.mocked(getServerSupabaseClients).mockReturnValue({ admin: mockAdmin } as any);

      const request = new Request('https://egatepass.tech/api/admin/records?status=inside', {
        headers: { Authorization: 'Bearer mock_staff_token' },
      });

      const response = await recordsRoute.fetch(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.passes).toHaveLength(1);
      expect(json.passes[0].status).toBe('inside');
      expect(mockQuery.eq).toHaveBeenCalledWith('status', 'inside');
    });

    it('does not fail with 503 if expire_stale_passes RPC throws an error', async () => {
      const mockQuery: any = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        ilike: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      };

      const mockAdmin: any = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC timeout' } }),
        }),
        from: vi.fn().mockReturnValue(mockQuery),
      };

      const { getServerSupabaseClients } = await import('../server/supabase.js');
      vi.mocked(getServerSupabaseClients).mockReturnValue({ admin: mockAdmin } as any);

      const request = new Request('https://egatepass.tech/api/admin/records', {
        headers: { Authorization: 'Bearer mock_staff_token' },
      });

      // Must NOT fail with 503; must log warning and successfully return 200 with records
      const response = await recordsRoute.fetch(request);
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.passes).toEqual([]);
    });
  });
});
