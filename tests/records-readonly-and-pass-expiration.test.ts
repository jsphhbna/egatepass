import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleRequest as recordsHandler } from '../server/routes/admin/records.js';
import { handleRequest as retentionHandler } from '../server/routes/admin/retention-maintenance.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

describe('Phase C — Read-Only Records GET & Authoritative Stale Pass Expiry', () => {
  const ADMIN_ID = '11111111-1111-4000-a000-000000000001';

  // 1. Static Contract Tests
  describe('Static Contract Tests', () => {
    const recordsSrc = readFileSync('server/routes/admin/records.ts', 'utf8');
    const maintenanceSrc = readFileSync('server/routes/admin/retention-maintenance.ts', 'utf8');

    it('proves records.ts does NOT call expire_stale_passes or mutate records during GET', () => {
      expect(recordsSrc).not.toContain('expire_stale_passes');
      expect(recordsSrc).not.toContain('.update(');
      expect(recordsSrc).not.toContain('.delete(');
      expect(recordsSrc).not.toContain('.insert(');
      expect(recordsSrc).not.toContain('.rpc(');
    });

    it('proves retention-maintenance.ts authoritatively executes stale pass expiry', () => {
      expect(maintenanceSrc).toContain('8.5 AUTHORITATIVE PASS EXPIRATION');
      expect(maintenanceSrc).toContain("rpc('expire_stale_passes')");
      expect(maintenanceSrc).toContain('stalePassesExpired');
    });
  });

  // 2. Runtime Behavior Tests
  describe('Runtime Behavior Tests', () => {
    let rpcCalls: string[];
    let mockPasses: any[];

    beforeEach(() => {
      rpcCalls = [];
      mockPasses = [
        {
          id: 'pass-1',
          visitor_id: 'vis-1',
          source: 'portal',
          status: 'issued',
          valid_from: new Date(Date.now() - 3600000).toISOString(),
          valid_until: new Date(Date.now() + 3600000).toISOString(),
          issued_at: new Date(Date.now() - 3600000).toISOString(),
          entry_scanned_at: null,
          decided_at: null,
          time_in: null,
          time_out: null,
          entry_device_id: null,
          exit_device_id: null,
          decided_by: null,
          rejection_reason: null,
          gate: null,
          visitors: {
            full_name: 'John Doe',
            purpose: 'Registrar Inquiry',
            visit_date: '2026-11-10',
            visitor_evidence: [],
          },
        },
      ];

      const mockAdmin: any = {
        auth: {
          getUser: vi.fn(async () => ({
            data: {
              user: {
                id: ADMIN_ID,
                email: 'admin@earist.edu.ph',
                email_confirmed_at: new Date().toISOString(),
              },
            },
            error: null,
          })),
        },
        from: vi.fn((tableName: string) => {
          if (tableName === 'staff_profiles') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      role: 'admin',
                      active: true,
                      must_change_password: false,
                      privacy_accepted_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }

          if (tableName === 'passes') {
            const builder: any = {
              select: () => builder,
              order: () => builder,
              eq: () => builder,
              gte: () => builder,
              lte: () => builder,
              or: () => builder,
              limit: () => Promise.resolve({ data: mockPasses, error: null }),
            };
            return builder;
          }

          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          };
        }),
        rpc: vi.fn(async (rpcName: string) => {
          rpcCalls.push(rpcName);
          if (rpcName === 'expire_stale_passes') {
            return { data: 5, error: null };
          }
          return { data: null, error: null };
        }),
      };

      setServerSupabaseClientsForTest({ admin: mockAdmin, anon: mockAdmin });
    });

    it('records GET request does not invoke any RPC and remains strictly read-only', async () => {
      const req = new Request('https://egatepass.tech/api/admin/records?status=issued', {
        headers: {
          authorization: `Bearer test-token-${ADMIN_ID}`,
        },
      });

      const res1 = await recordsHandler(req);
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.passes).toHaveLength(1);
      expect(data1.passes[0].status).toBe('issued');

      // Subsequent call
      const res2 = await recordsHandler(req);
      expect(res2.status).toBe(200);

      // Verify that no RPC calls were made during records GET
      expect(rpcCalls).toHaveLength(0);
      expect(rpcCalls).not.toContain('expire_stale_passes');
    });
  });
});
