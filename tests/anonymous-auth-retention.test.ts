import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import retentionMaintenanceHandler from '../server/routes/admin/retention-maintenance.js';

describe('Repair Group 10: Orphan Anonymous Auth User Retention', () => {
  const CRON_SECRET = 'test_cron_secret_retention';
  const OLD_TIME = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago (>24h threshold)
  const RECENT_TIME = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h ago (<24h threshold)

  let authUsers: any[] = [];
  let visitors: any[] = [];
  let uploadIntents: any[] = [];
  let staffProfiles: any[] = [];
  let devices: any[] = [];
  let reconciliationTasks: any[] = [];
  let failDeleteUserIds = new Set<string>();

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    authUsers = [];
    visitors = [];
    uploadIntents = [];
    staffProfiles = [];
    devices = [];
    reconciliationTasks = [];
    failDeleteUserIds.clear();

    const mockAdminClient: any = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => {
            return {
              data: { users: authUsers },
              error: null,
            };
          }),
          deleteUser: vi.fn(async (uid: string) => {
            if (failDeleteUserIds.has(uid)) {
              return { error: new Error(`Simulated delete failure for ${uid}`) };
            }
            authUsers = authUsers.filter((u) => u.id !== uid);
            return { error: null };
          }),
        },
      },
      storage: {
        from: () => ({
          remove: async () => ({ error: null }),
        }),
      },
      schema: () => ({
        rpc: async () => ({ data: 0, error: null }),
      }),
      from: (table: string) => {
        let filters: Array<(row: any) => boolean> = [];
        let limitVal: number | null = null;
        let isDelete = false;

        const chain: any = {
          select: () => chain,
          eq: (col: string, val: any) => {
            filters.push((row) => row[col] === val);
            return chain;
          },
          lt: (col: string, val: any) => {
            filters.push((row) => row[col] < val);
            return chain;
          },
          lte: (col: string, val: any) => {
            filters.push((row) => row[col] <= val);
            return chain;
          },
          gt: (col: string, val: any) => {
            filters.push((row) => row[col] > val);
            return chain;
          },
          is: (col: string, val: any) => {
            filters.push((row) => row[col] === val);
            return chain;
          },
          in: (col: string, vals: any[]) => {
            filters.push((row) => vals.includes(row[col]));
            return chain;
          },
          not: () => chain,
          neq: () => chain,
          filter: () => chain,
          contains: () => chain,
          or: () => chain,
          order: () => chain,
          limit: (n: number) => {
            limitVal = n;
            return chain;
          },
          maybeSingle: async () => {
            let data: any[] = [];
            if (table === 'app_settings') {
              data = [{ id: 'settings', image_retention_days: 7, visitor_retention_days: 30 }];
            } else if (table === 'visitors') {
              data = visitors.filter((r) => filters.every((f) => f(r)));
            }
            return { data: data[0] ?? null, error: null };
          },
          single: async () => {
            let data: any[] = [];
            if (table === 'app_settings') {
              data = [{ id: 'settings', image_retention_days: 7, visitor_retention_days: 30 }];
            }
            return { data: data[0] ?? null, error: null };
          },
          delete: () => {
            isDelete = true;
            return chain;
          },
          update: () => chain,
          upsert: async () => ({ data: null, error: null }),
          insert: async (data: any) => {
            if (table === 'reconciliation_tasks') {
              reconciliationTasks.push(data);
            }
            return { data: null, error: null };
          },
          then: (resolve: any) => {
            let data: any[] = [];
            if (table === 'app_settings') {
              data = [{ id: 'settings', image_retention_days: 7, visitor_retention_days: 30 }];
            } else if (table === 'visitors') {
              data = visitors.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'upload_intents') {
              data = uploadIntents.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'staff_profiles') {
              data = staffProfiles.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'devices') {
              data = devices.filter((r) => filters.every((f) => f(r)));
            } else if (table === 'incident_holds') {
              data = [];
            } else if (table === 'passes') {
              data = [];
            } else if (table === 'visitor_evidence') {
              data = [];
            } else if (table === 'audit_events') {
              data = [];
            } else if (table === 'reconciliation_tasks') {
              data = [];
            } else if (table === 'pass_email_verifications') {
              data = [];
            }

            if (limitVal !== null) {
              data = data.slice(0, limitVal);
            }

            return resolve({ data, count: data.length, error: null });
          },
        };
        return chain;
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdminClient,
      passwordVerifier: mockAdminClient,
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    setServerSupabaseClientsForTest(null);
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE J: Old orphan anonymous user is cleaned, while recent/referenced/staff/device accounts remain protected', async () => {
    // 1. Old orphan anonymous user (should be cleaned)
    authUsers.push({
      id: 'anon-orphan-old',
      is_anonymous: true,
      created_at: OLD_TIME,
    });

    // 2. Recent anonymous user (<24h) -> protected
    authUsers.push({
      id: 'anon-recent',
      is_anonymous: true,
      created_at: RECENT_TIME,
    });

    // 3. Old anonymous user referenced by visitor -> protected
    authUsers.push({
      id: 'anon-visitor-linked',
      is_anonymous: true,
      created_at: OLD_TIME,
    });
    visitors.push({
      id: 'vis-1',
      owner_id: 'anon-visitor-linked',
      anonymized_at: null,
      created_at: OLD_TIME,
    });

    // 4. Old anonymous user with pending upload intent -> protected
    authUsers.push({
      id: 'anon-intent-linked',
      is_anonymous: true,
      created_at: OLD_TIME,
    });
    uploadIntents.push({
      id: 'intent-1',
      owner_id: 'anon-intent-linked',
      status: 'pending',
      bucket_id: 'visitor-evidence',
      object_path: 'temp.jpg',
      expires_at: RECENT_TIME,
    });

    // 5. Staff user -> never eligible
    authUsers.push({
      id: 'staff-user-id',
      is_anonymous: false,
      created_at: OLD_TIME,
    });
    staffProfiles.push({
      user_id: 'staff-user-id',
      display_name: 'Admin Alice',
      role: 'admin',
    });

    // 6. Device user -> never eligible
    authUsers.push({
      id: 'device-user-id',
      is_anonymous: false,
      created_at: OLD_TIME,
    });
    devices.push({
      user_id: 'device-user-id',
      alias: 'kiosk-lobby',
    });

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false, batchSize: 50 }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.maintenance).toBeDefined();

    // Invariant: Only the old orphan was eligible and deleted
    expect(json.maintenance.anonymousAuthEligible).toBe(1);
    expect(json.maintenance.anonymousAuthDeleted).toBe(1);
    expect(json.maintenance.anonymousAuthDeleteFailures).toBe(0);

    // Protected accounts remain in authUsers
    const remainingIds = authUsers.map((u) => u.id);
    expect(remainingIds).not.toContain('anon-orphan-old');
    expect(remainingIds).toContain('anon-recent');
    expect(remainingIds).toContain('anon-visitor-linked');
    expect(remainingIds).toContain('anon-intent-linked');
    expect(remainingIds).toContain('staff-user-id');
    expect(remainingIds).toContain('device-user-id');
  });

  it('Partial Auth delete failure records reconciliation and reflects failure truthfully in metrics', async () => {
    authUsers.push(
      { id: 'anon-orphan-1', is_anonymous: true, created_at: OLD_TIME },
      { id: 'anon-orphan-fail', is_anonymous: true, created_at: OLD_TIME }
    );

    failDeleteUserIds.add('anon-orphan-fail');

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    const json = await res.json();

    expect(json.maintenance.anonymousAuthEligible).toBe(2);
    expect(json.maintenance.anonymousAuthDeleted).toBe(1);
    expect(json.maintenance.anonymousAuthDeleteFailures).toBe(1);
    expect(json.maintenance.errors).toContainEqual(
      expect.stringContaining('anonymous_auth_delete_failed for user anon-orphan-fail')
    );

    // Invariant: Reconciliation task recorded for the failed user deletion
    const reconEntry = reconciliationTasks.find(
      (t) => t.operation === 'maintenance.anonymous_auth_delete_failed' && t.reference_id === 'anon-orphan-fail'
    );
    expect(reconEntry).toBeDefined();
    expect(reconEntry.last_error_code).toContain('Simulated delete failure');
  });
});
