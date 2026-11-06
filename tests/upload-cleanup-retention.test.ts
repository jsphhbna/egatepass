import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import retentionMaintenanceHandler from '../server/routes/admin/retention-maintenance.js';

describe('Upload Cleanup Retention Maintenance & Durable Completion Tracking', () => {
  const CRON_SECRET = 'test_cron_secret_upload_retention';
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const originalEnv = { ...process.env };

  let uploadIntentsTable: any[] = [];
  let storageFiles: Map<string, Set<string>> = new Map();
  let recordReconciliationSpy: any;

  beforeEach(() => {
    process.env = { ...originalEnv, CRON_SECRET };
    uploadIntentsTable = [];
    storageFiles = new Map();
    recordReconciliationSpy = vi.spyOn(actorsModule, 'recordReconciliation').mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setServerSupabaseClientsForTest(null);
    vi.restoreAllMocks();
  });

  function setupMockAdmin(options: {
    storageRemoveError?: any;
    dbExpireError?: any;
    markerUpdateError?: any;
  } = {}) {
    const mockStorageRemove = vi.fn(async (paths: string[]) => {
      if (options.storageRemoveError) {
        return { data: null, error: options.storageRemoveError };
      }
      return { data: paths.map((p) => ({ name: p })), error: null };
    });

    const mockAdmin: any = {
      auth: {
        admin: {
          listUsers: vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
          deleteUser: vi.fn().mockResolvedValue({ error: null }),
        },
      },
      storage: {
        from: vi.fn(() => ({
          remove: mockStorageRemove,
        })),
      },
      schema: vi.fn(() => ({
        rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
      })),
      from: vi.fn((table: string) => {
        let filters: Array<(row: any) => boolean> = [];
        let limitVal: number | null = null;
        let selectedCols = '*';

        const chain: any = {
          select: (cols: string = '*') => {
            selectedCols = cols;
            return chain;
          },
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
          is: (col: string, val: any) => {
            filters.push((row) => row[col] === val);
            return chain;
          },
          in: (col: string, vals: any[]) => {
            filters.push((row) => vals.includes(row[col]));
            return chain;
          },
          or: (clause: string) => {
            return chain;
          },
          not: () => chain,
          order: () => chain,
          limit: (n: number) => {
            limitVal = n;
            return chain;
          },
          maybeSingle: async () => {
            if (table === 'app_settings') {
              return {
                data: {
                  singleton: true,
                  automatic_cleanup_enabled: true,
                  image_retention_days: 30,
                  visitor_retention_days: 30,
                  reconciliation_retention_days: 90,
                  audit_retention_days: 365,
                },
                error: null,
              };
            }
            if (table !== 'upload_intents') {
              return { data: null, error: null };
            }
            const matching = uploadIntentsTable.filter((r) => filters.every((f) => f(r)));
            return { data: matching[0] || null, error: null };
          },
          single: async () => {
            if (table === 'app_settings') {
              return {
                data: {
                  singleton: true,
                  automatic_cleanup_enabled: true,
                  image_retention_days: 30,
                  visitor_retention_days: 30,
                  reconciliation_retention_days: 90,
                  audit_retention_days: 365,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
          update: (updates: any) => {
            return {
              eq: (col: string, val: any) => {
                filters.push((row) => row[col] === val);
                return {
                  eq: (col2: string, val2: any) => {
                    filters.push((row) => row[col2] === val2);
                    return {
                      is: (col3: string, val3: any) => {
                        filters.push((row) => row[col3] === val3);
                        return {
                          select: async () => {
                            if (options.dbExpireError) {
                              return { data: null, error: options.dbExpireError };
                            }
                            const updated: any[] = [];
                            uploadIntentsTable.forEach((row) => {
                              if (filters.every((f) => f(row))) {
                                Object.assign(row, updates);
                                updated.push(row);
                              }
                            });
                            return { data: updated, error: null };
                          },
                          then: (resolve: any) => {
                            if (options.markerUpdateError) {
                              return resolve({ error: options.markerUpdateError });
                            }
                            uploadIntentsTable.forEach((row) => {
                              if (filters.every((f) => f(row))) {
                                Object.assign(row, updates);
                              }
                            });
                            return resolve({ error: null });
                          },
                        };
                      },
                      select: async () => {
                        if (options.dbExpireError) {
                          return { data: null, error: options.dbExpireError };
                        }
                        const updated: any[] = [];
                        uploadIntentsTable.forEach((row) => {
                          if (filters.every((f) => f(row))) {
                            Object.assign(row, updates);
                            updated.push(row);
                          }
                        });
                        return { data: updated, error: null };
                      },
                    };
                  },
                  is: (col2: string, val2: any) => {
                    filters.push((row) => row[col2] === val2);
                    return {
                      eq: (col3: string, val3: any) => {
                        filters.push((row) => row[col3] === val3);
                        return {
                          then: (resolve: any) => {
                            if (options.markerUpdateError) {
                              return resolve({ error: options.markerUpdateError });
                            }
                            uploadIntentsTable.forEach((row) => {
                              if (filters.every((f) => f(row))) {
                                Object.assign(row, updates);
                              }
                            });
                            return resolve({ error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
          upsert: async () => ({ error: null }),
          insert: async () => ({ error: null }),
          delete: () => chain,
          then: (resolve: any) => {
            if (table === 'upload_intents') {
              let rows = uploadIntentsTable.filter((r) => filters.every((f) => f(r)));
              if (limitVal !== null) rows = rows.slice(0, limitVal);
              return resolve({ data: rows, error: null });
            }
            if (table === 'settings') {
              return resolve({ data: { evidence_retention_days: 90 }, error: null });
            }
            return resolve({ data: [], error: null });
          },
        };

        return chain;
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });
    return { mockAdmin, mockStorageRemove };
  }

  it('1. queries .is("storage_cleaned_at", null) and successfully marks cleaned intents', async () => {
    const { mockStorageRemove } = setupMockAdmin();

    uploadIntentsTable.push({
      id: 'intent-uncleaned-1',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-uncleaned-1/photo.jpg',
      status: 'expired',
      visitor_id: null,
      storage_cleaned_at: null,
      expires_at: twoHoursAgo,
    });

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.maintenance.abandonedIntentsCleaned).toBe(1);
    expect(mockStorageRemove).toHaveBeenCalledWith(['portal/intent-uncleaned-1/photo.jpg']);
    expect(uploadIntentsTable[0].storage_cleaned_at).toBeDefined();
    expect(uploadIntentsTable[0].storage_cleaned_at).not.toBeNull();
  });

  it('2. second retention run ignores already-cleaned intents (0 cleaned on run 2)', async () => {
    const { mockStorageRemove } = setupMockAdmin();

    // Already cleaned intent
    uploadIntentsTable.push({
      id: 'intent-already-cleaned-2',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-already-cleaned-2/photo.jpg',
      status: 'expired',
      visitor_id: null,
      storage_cleaned_at: '2026-11-04T00:00:00.000Z',
      expires_at: twoHoursAgo,
    });

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.maintenance.abandonedIntentsCleaned).toBe(0);
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it('3. enforces database-first safety: failed DB transition aborts storage deletion', async () => {
    const { mockStorageRemove } = setupMockAdmin({
      dbExpireError: { message: 'Database lock or constraint error' },
    });

    uploadIntentsTable.push({
      id: 'intent-pending-transition-fail',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-pending-transition-fail/photo.jpg',
      status: 'pending',
      visitor_id: null,
      storage_cleaned_at: null,
      expires_at: twoHoursAgo,
    });

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
    expect(json.maintenance.abandonedIntentsCleaned).toBe(0);

    // Storage removal MUST NOT have been called because DB update failed
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(uploadIntentsTable[0].storage_cleaned_at).toBeNull();
    expect(uploadIntentsTable[0].status).toBe('pending');
    expect(recordReconciliationSpy).toHaveBeenCalledWith(
      expect.anything(),
      'upload_intent.db_expire_failed',
      'upload_intents',
      'intent-pending-transition-fail',
      expect.stringContaining('Database lock'),
      expect.anything(),
    );
  });

  it('4. claimed intent protection: never deletes storage for claimed evidence or non-null visitor_id', async () => {
    const { mockStorageRemove } = setupMockAdmin();

    uploadIntentsTable.push({
      id: 'intent-claimed-123',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-claimed-123/photo.jpg',
      status: 'claimed',
      visitor_id: 'visitor-profile-uuid',
      storage_cleaned_at: null,
      expires_at: twoHoursAgo,
    });

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.maintenance.abandonedIntentsCleaned).toBe(0);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(uploadIntentsTable[0].storage_cleaned_at).toBeNull();
  });

  it('5. treats Supabase Storage 404 / object-not-found as already cleaned and marks storage_cleaned_at', async () => {
    const { mockStorageRemove } = setupMockAdmin({
      storageRemoveError: { message: 'The resource was not found', statusCode: '404' },
    });

    uploadIntentsTable.push({
      id: 'intent-404-absent',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-404-absent/photo.jpg',
      status: 'expired',
      visitor_id: null,
      storage_cleaned_at: null,
      expires_at: twoHoursAgo,
    });

    const req = new Request('http://localhost/api/admin/retention-maintenance', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ dryRun: false }),
    });

    const res = await retentionMaintenanceHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.maintenance.abandonedIntentsCleaned).toBe(1);
    expect(uploadIntentsTable[0].storage_cleaned_at).toBeDefined();
    expect(uploadIntentsTable[0].storage_cleaned_at).not.toBeNull();
    expect(recordReconciliationSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'upload_intent.storage_delete_failed',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('6. storage removal failure leaves storage_cleaned_at NULL and records reconciliation task', async () => {
    const { mockStorageRemove } = setupMockAdmin({
      storageRemoveError: { message: 'S3 Connection Reset / Internal Server Error', statusCode: '500' },
    });

    uploadIntentsTable.push({
      id: 'intent-s3-fail',
      bucket_id: 'visitor-evidence',
      object_path: 'portal/intent-s3-fail/photo.jpg',
      status: 'expired',
      visitor_id: null,
      storage_cleaned_at: null,
      expires_at: twoHoursAgo,
    });

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

    expect(json.maintenance.abandonedIntentsCleaned).toBe(0);
    expect(uploadIntentsTable[0].storage_cleaned_at).toBeNull();
    expect(recordReconciliationSpy).toHaveBeenCalledWith(
      expect.anything(),
      'upload_intent.storage_delete_failed',
      'upload_intents',
      'intent-s3-fail',
      expect.stringContaining('S3 Connection Reset'),
      expect.objectContaining({
        bucket_id: 'visitor-evidence',
        object_path: 'portal/intent-s3-fail/photo.jpg',
      }),
    );
  });
});
