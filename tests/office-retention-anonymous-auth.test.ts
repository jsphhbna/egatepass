import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import retentionMaintenanceHandler from '../server/routes/admin/retention-maintenance.js';

describe('Office Visit Anonymous Auth Retention Protection (Critical Correction B)', () => {
  const CRON_SECRET = 'test_cron_secret_office_retention';
  const OLD_TIME = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago (>24h threshold)
  const TERMINAL_OLD = new Date(Date.now() - 35 * 86_400_000).toISOString(); // 35 days ago (>30d retention)
  const TERMINAL_RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 days ago (<30d retention)

  let authUsers: any[] = [];
  let visitors: any[] = [];
  let uploadIntents: any[] = [];
  let staffProfiles: any[] = [];
  let devices: any[] = [];
  let officeVisits: any[] = [];
  let deleteUserCallCount = 0;
  let mockTableErrors: Record<string, any> = {};

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    authUsers = [];
    visitors = [];
    uploadIntents = [];
    staffProfiles = [];
    devices = [];
    officeVisits = [];
    deleteUserCallCount = 0;
    mockTableErrors = {};

    const mockAdminClient: any = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({
            data: { users: authUsers },
            error: null,
          })),
          deleteUser: vi.fn(async (uid: string) => {
            deleteUserCallCount++;
            authUsers = authUsers.filter((u) => u.id !== uid);
            return { error: null };
          }),
        },
      },
      storage: {
        from: vi.fn(() => ({
          remove: vi.fn(async () => ({ error: null })),
        })),
      },
      schema: () => ({
        rpc: async () => ({ data: 0, error: null }),
      }),
      from: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: any) => {
            filters.push((row) => row[col] === val);
            return chain;
          },
          in: (col: string, vals: any[]) => {
            filters.push((row) => vals.includes(row[col]));
            return chain;
          },
          is: () => chain,
          or: () => chain,
          not: () => chain,
          neq: () => chain,
          filter: () => chain,
          contains: () => chain,
          lt: () => chain,
          gt: () => chain,
          lte: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            if (mockTableErrors[table]) return { data: null, error: mockTableErrors[table] };
            if (table === 'app_settings') {
              return { data: { image_retention_days: 7, visitor_retention_days: 30 }, error: null };
            }
            return { data: null, error: null };
          },
          delete: () => chain,
          insert: async () => ({ data: null, error: null }),
          upsert: async () => ({ data: null, error: null }),
          update: () => chain,
          then: (resolve: any) => {
            if (mockTableErrors[table]) return resolve({ data: null, error: mockTableErrors[table] });
            let data: any[] = [];
            if (table === 'app_settings') {
              data = [{ image_retention_days: 7, visitor_retention_days: 30 }];
            } else if (table === 'visitors') {
              data = visitors.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'upload_intents') {
              data = uploadIntents.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'staff_profiles') {
              data = staffProfiles.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'devices') {
              data = devices.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'office_visits') {
              data = officeVisits.filter((r) => filters.every((f) => f(r)));
            }
            return resolve({ data, error: null });
          },
        };
        return chain;
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdminClient,
      anon: {} as any,
    });
  });

  function makeCronRequest() {
    return new Request('https://egatepass.tech/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false, batchSize: 50 }),
    });
  }

  it('1. Protects pending new visitor actor from anonymous Auth deletion', async () => {
    const actorId = '00000000-0000-0000-0000-000000000001';
    authUsers.push({ id: actorId, is_anonymous: true, created_at: OLD_TIME });
    officeVisits.push({
      visitor_actor_id: actorId,
      approval_status: 'pending',
      attendance_status: 'awaiting_entry',
      created_at: OLD_TIME,
    });

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(0);
    expect(body.maintenance.anonymousAuthDeleted).toBe(0);
    expect(authUsers.find((u) => u.id === actorId)).toBeDefined();
  });

  it('2. Protects pending returning visitor actor from anonymous Auth deletion even with zero upload intents', async () => {
    const returningActorId = '00000000-0000-0000-0000-000000000002';
    authUsers.push({ id: returningActorId, is_anonymous: true, created_at: OLD_TIME });
    // Zero upload intents for returning visitor
    officeVisits.push({
      visitor_actor_id: returningActorId,
      registration_mode: 'returning',
      approval_status: 'pending',
      attendance_status: 'awaiting_entry',
      created_at: OLD_TIME,
    });

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(0);
    expect(body.maintenance.anonymousAuthDeleted).toBe(0);
    expect(authUsers.find((u) => u.id === returningActorId)).toBeDefined();
  });

  it('3. Protects approved visitor actor awaiting entry or inside campus', async () => {
    const approvedActorId = '00000000-0000-0000-0000-000000000003';
    authUsers.push({ id: approvedActorId, is_anonymous: true, created_at: OLD_TIME });
    officeVisits.push({
      visitor_actor_id: approvedActorId,
      approval_status: 'approved',
      attendance_status: 'awaiting_entry',
      created_at: OLD_TIME,
    });

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(0);
    expect(authUsers.find((u) => u.id === approvedActorId)).toBeDefined();
  });

  it('4. Retains terminal office visit actor within the 30-day retention window', async () => {
    const recentRejectedActorId = '00000000-0000-0000-0000-000000000004';
    authUsers.push({ id: recentRejectedActorId, is_anonymous: true, created_at: OLD_TIME });
    officeVisits.push({
      visitor_actor_id: recentRejectedActorId,
      approval_status: 'rejected',
      attendance_status: 'cancelled',
      created_at: TERMINAL_RECENT,
      updated_at: TERMINAL_RECENT,
    });

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(0);
    expect(authUsers.find((u) => u.id === recentRejectedActorId)).toBeDefined();
  });

  it('5. Allows deletion of terminal office visit actor after retention window has expired', async () => {
    const oldRejectedActorId = '00000000-0000-0000-0000-000000000005';
    authUsers.push({ id: oldRejectedActorId, is_anonymous: true, created_at: TERMINAL_OLD });
    officeVisits.push({
      visitor_actor_id: oldRejectedActorId,
      approval_status: 'rejected',
      attendance_status: 'cancelled',
      created_at: TERMINAL_OLD,
      updated_at: TERMINAL_OLD,
    });

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(1);
    expect(body.maintenance.anonymousAuthDeleted).toBe(1);
    expect(authUsers.find((u) => u.id === oldRejectedActorId)).toBeUndefined();
  });

  it('6. Fails closed and prevents Auth deletion if office_visits protection query fails', async () => {
    const candidateActorId = '00000000-0000-0000-0000-000000000006';
    authUsers.push({ id: candidateActorId, is_anonymous: true, created_at: OLD_TIME });
    mockTableErrors['office_visits'] = new Error('Database connection timeout on office_visits');

    const res = await retentionMaintenanceHandler.fetch(makeCronRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.maintenance.anonymousAuthEligible).toBe(0);
    expect(body.maintenance.anonymousAuthDeleted).toBe(0);
    expect(body.maintenance.errors.some((e: string) => e.includes('anonymous_auth_protection_office_visit_failed'))).toBe(true);
    expect(authUsers.find((u) => u.id === candidateActorId)).toBeDefined();
  });
});
