import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';
import sessionActivityRoute from '../server/routes/auth/session-activity.js';
import dashboardRoute from '../server/routes/admin/dashboard.js';
import recordsRoute from '../server/routes/admin/records.js';
import retentionMaintenanceRoute from '../server/routes/admin/retention-maintenance.js';
import purgeImagesHandler from '../server/routes/system/purge-images.js';
import capabilitiesRoute from '../server/routes/passes/capabilities.js';
import lookupReturningRoute from '../server/routes/passes/lookup-returning.js';
import * as clientSupabaseModule from '../src/lib/supabase';
import { issueVisitorPass } from '../src/services/visitorRegistration';

function makeQueryBuilder(resolved: { data?: any; count?: number | null; error?: any } = { data: [], count: 0, error: null }) {
  const builder: any = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => Promise.resolve(resolved)),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    is: vi.fn(() => builder),
    not: vi.fn(() => builder),
    or: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => resolved),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
  };
  return builder;
}

describe('Session Timeout, Period Analytics, Retention Freeze, Turnstile & Approval Policy Regression Suite', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  it('enforces 15-minute idle expiration for human staff sessions while exempting managed devices', async () => {
    const rpcCalls: Array<{ fn: string; args: any }> = [];

    // Case 1: Managed device is exempt
    const deviceAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'staff_profiles') return makeQueryBuilder({ data: null, error: null });
        if (table === 'devices') return makeQueryBuilder({ data: { type: 'emergency_device', status: 'active' }, error: null });
        return makeQueryBuilder();
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          return { data: null, error: null };
        }),
      })),
    };
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: deviceAdmin, anon: deviceAdmin } as any);
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'device-u1', email: 'emg@devices.egatepass.invalid' } as any,
      claims: { session_id: 'sess-dev-1' },
      amr: [{ method: 'password' }],
      isRecoverySession: false,
      isAnonymous: false,
      sessionId: 'sess-dev-1',
    });

    const devRes = await sessionActivityRoute.fetch(
      new Request('http://localhost/api/auth/session-activity', { headers: { Authorization: 'Bearer dev-jwt' } }),
    );
    expect(devRes.status).toBe(200);
    const devBody = await devRes.json();
    expect(devBody).toEqual({
      kind: 'device',
      deviceType: 'emergency_device',
      exemptFromIdleTimeout: true,
    });
    expect(rpcCalls).toHaveLength(0);

    // Case 2: Human staff expired after 15 minutes returns 401 session_idle_expired
    const staffAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'staff_profiles') return makeQueryBuilder({ data: { role: 'admin', active: true }, error: null });
        return makeQueryBuilder();
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          if (fn === 'touch_staff_session') {
            return { data: { valid: false, expired: true, reason: 'idle_timeout_15m', expiredAt: '2026-11-12T08:15:00Z' }, error: null };
          }
          return { data: { ok: true }, error: null };
        }),
      })),
    };
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: staffAdmin, anon: staffAdmin } as any);

    const staffRes = await sessionActivityRoute.fetch(
      new Request('http://localhost/api/auth/session-activity', { headers: { Authorization: 'Bearer staff-jwt' } }),
    );
    expect(staffRes.status).toBe(401);
    const staffBody = await staffRes.json();
    expect(staffBody.error).toBe('session_idle_expired');
    expect(staffBody.reason).toBe('idle_timeout_15m');

    // Case 3: Expire action calls api.expire_staff_session
    const expireRes = await sessionActivityRoute.fetch(
      new Request('http://localhost/api/auth/session-activity', {
        method: 'POST',
        headers: { Authorization: 'Bearer staff-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'expire', reason: 'idle_timeout_15m' }),
      }),
    );
    expect(expireRes.status).toBe(200);
    expect(rpcCalls.some((c) => c.fn === 'expire_staff_session')).toBe(true);
  });

  it('computes Manila-timezone dashboard period filters, isolates OFFLINE MODE RECORDED metrics, and sets truncated flag past 5000 rows', async () => {
    vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
      id: 'admin-1',
      email: 'admin@earist.edu.ph',
      role: 'superadmin',
    });

    const mockPasses = [
      {
        id: 'p-1',
        source: 'portal',
        status: 'inside',
        valid_from: '2026-11-12T00:00:00Z',
        valid_until: '2026-11-12T09:00:00Z',
        issued_at: '2026-11-12T01:00:00Z',
        entry_scanned_at: '2026-11-12T02:00:00Z',
        decided_at: '2026-11-12T02:00:00Z',
        time_in: '2026-11-12T02:00:00Z',
        time_out: null,
        entry_device_id: null,
        exit_device_id: null,
        decided_by: null,
        rejection_reason: null,
        gate: 'Main Gate',
        expected_gate: 'Main Gate',
        visitors: { full_name: 'Ana Reyes', purpose: 'Registrar', visit_date: '2026-11-12', visitor_evidence: [] },
      },
    ];
    const mockOffline = [
      {
        id: 'off-1',
        device_user_id: 'dev-1',
        gate: 'Main Gate',
        visitor_full_name: 'Carlos Offline',
        declared_address: 'Tondo, Manila',
        address_status: 'declared_offline_unverified',
        purpose: 'Cashier',
        destination_office_name_snapshot: 'Cashier Office',
        office_resolution_status: 'resolved_snapshot',
        id_physically_inspected: true,
        record_classification: 'OFFLINE MODE RECORDED',
        local_recorded_at: '2026-11-12T02:10:00Z',
        server_received_at: '2026-11-12T03:00:00Z',
        local_sequence: 1,
        snapshot_version: 'snap-1',
        emergency_exception_applied: false,
        reconciliation_status: 'received',
        reconciliation_notes: null,
        reconciled_at: null,
      },
    ];

    const mockAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'passes') {
          return makeQueryBuilder({ data: mockPasses, count: 5005, error: null });
        }
        if (table === 'emergency_gate_records') {
          return makeQueryBuilder({ data: mockOffline, count: 1, error: null });
        }
        if (table === 'audit_events') {
          return makeQueryBuilder({ data: [], count: 0, error: null });
        }
        return makeQueryBuilder();
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string) => {
          if (fn === 'dashboard_calendar_counts') return { data: {}, error: null };
          if (fn === 'dashboard_today_insights') {
            return {
              data: {
                topPurpose: { label: 'Registrar', count: 1 },
                busiestGate: { label: 'Main Gate', count: 1 },
                topRejection: { label: 'None', count: 0 },
                avgApprovalTime: '1m',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        }),
      })),
    };
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);

    // Invalid period rejected 400
    const badRes = await dashboardRoute.fetch(
      new Request('http://localhost/api/admin/dashboard?period=quarter', { headers: { Authorization: 'Bearer admin-jwt' } }),
    );
    expect(badRes.status).toBe(400);

    // Month period with report rows validates Manila boundaries, isolated offline metrics, and >5000 truncation flag
    const monthRes = await dashboardRoute.fetch(
      new Request('http://localhost/api/admin/dashboard?period=month&month=2026-11&includeReportRows=true', {
        headers: { Authorization: 'Bearer admin-jwt' },
      }),
    );
    expect(monthRes.status).toBe(200);
    const body = await monthRes.json();
    expect(body.periodMeta).toMatchObject({
      period: 'month',
      periodStart: '2026-11-01T00:00:00+08:00',
      periodEnd: '2026-11-30T23:59:59.999+08:00',
      timezone: 'Asia/Manila',
    });
    expect(body.offlineModeMetrics).toMatchObject({
      classification: 'OFFLINE MODE RECORDED',
      total: 1,
      received: 1,
    });
    expect(body.reportRows.truncated).toBe(true);
    expect(body.reportRows.offlineRecords).toHaveLength(1);
    expect(body.reportRows.offlineRecords[0].classification).toBe('OFFLINE MODE RECORDED');

    // /api/admin/records?mode=offline exposes offlineRecords cleanly
    const recOfflineRes = await recordsRoute.fetch(
      new Request('http://localhost/api/admin/records?mode=offline', { headers: { Authorization: 'Bearer admin-jwt' } }),
    );
    expect(recOfflineRes.status).toBe(200);
    const recOfflineBody = await recOfflineRes.json();
    expect(recOfflineBody.offlineClassification).toBe('OFFLINE MODE RECORDED');
    expect(recOfflineBody.offlineRecords).toHaveLength(1);
  });

  it('halts both scheduled/manual retention maintenance and image purge when global_retention_freeze is enabled', async () => {
    const deleteCalls: string[] = [];
    const auditInserts: any[] = [];

    process.env.CRON_SECRET = 'cron-test-secret';

    const mockAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'app_settings') {
          return makeQueryBuilder({
            data: {
              automatic_cleanup_enabled: true,
              global_retention_freeze: true,
              global_retention_freeze_reason: 'Board audit preservation hold',
              photo_retention_days: 7,
              id_retention_days: 30,
              visitor_retention_days: 90,
            },
            error: null,
          });
        }
        if (table === 'audit_events') {
          return {
            insert: vi.fn(async (row: any) => {
              auditInserts.push(row);
              return { error: null };
            }),
          };
        }
        deleteCalls.push(table);
        return makeQueryBuilder();
      }),
      storage: { from: vi.fn() },
    };
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
    vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
      id: 'sa-1',
      email: 'sa@earist.edu.ph',
      role: 'superadmin',
    });

    const cronRes = await retentionMaintenanceRoute.fetch(
      new Request('http://localhost/api/admin/retention-maintenance', {
        method: 'GET',
        headers: { Authorization: 'Bearer cron-test-secret' },
      }),
    );
    expect(cronRes.status).toBe(200);
    const cronBody = await cronRes.json();
    expect(cronBody).toMatchObject({
      success: true,
      result: 'frozen',
      frozen: true,
      reason: 'global_retention_freeze_active',
      freezeReason: 'Board audit preservation hold',
    });

    const purgeRes = await purgeImagesHandler(
      new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      }),
    );
    expect(purgeRes.status).toBe(200);
    const purgeBody = await purgeRes.json();
    expect(purgeBody).toMatchObject({
      result: 'frozen',
      frozen: true,
      reason: 'global_retention_freeze_active',
      evidenceDeleted: 0,
    });
    expect(deleteCalls).toHaveLength(0);
    expect(auditInserts.every((a) => a.action === 'maintenance.retention_frozen_skip')).toBe(true);
  });

  it('fails closed 503 when TURNSTILE_SECRET_KEY is missing and reports truthful biometric/Turnstile diagnostics and pre-approval general visits', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.VITE_TURNSTILE_SITE_KEY;

    const mockAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'app_settings') {
          return makeQueryBuilder({
            data: {
              working_hours_start: '08:00:00',
              working_hours_end: '17:00:00',
              timezone: 'Asia/Manila',
              scheduling_days_ahead: 3,
              peak_mode: 'off',
              visit_purposes: ['Inquiry'],
              visitor_instructions: ['Bring ID.'],
              default_expected_gate: 'Main Gate',
              photo_retention_days: 7,
              id_retention_days: 30,
              vehicle_photo_retention_days: 30,
              visitor_retention_days: 90,
              returning_profile_retention_days: 30,
              automatic_cleanup_enabled: true,
            },
            error: null,
          });
        }
        return makeQueryBuilder();
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async () => ({ data: true, error: null })),
      })),
    };
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'anon-1', email: undefined, is_anonymous: true } as any,
      claims: null,
      amr: [],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const capRes = await capabilitiesRoute.fetch(new Request('http://localhost/api/passes/capabilities'));
    expect(capRes.status).toBe(200);
    const capBody = await capRes.json();
    expect(capBody.biometricStorageRetired).toBe(true);
    expect(capBody.turnstile).toEqual({
      siteKeyConfigured: false,
      serverVerifierConfigured: false,
      verified: false,
    });

    const lookupRes = await lookupReturningRoute.fetch(
      new Request('http://localhost/api/passes/lookup-returning', {
        method: 'POST',
        headers: { Authorization: 'Bearer anon-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Juan', lastName: 'Cruz', contactNumber: '09171234567' }),
      }),
    );
    expect(lookupRes.status).toBe(503);
    const lookupBody = await lookupRes.json();
    expect(lookupBody.error).toBe('missing_validation_runtime_secret');

    // issueVisitorPass cleanly accepts HTTP 201 approvalRequired: true without treating null passId/qrToken as network ambiguity
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          approvalRequired: true,
          passId: null,
          publicReference: null,
          qrToken: null,
          visitId: 'visit-1',
          officeName: 'Registrar',
          trackingUrl: 'https://egatepass.tech/track#t=tok123',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as any;

    const tx = {
      client: {
        auth: {
          getSession: vi.fn(async () => ({
            data: {
              session: {
                access_token: 'visitor-token',
                user: { id: 'anon-1', is_anonymous: true },
              },
            },
            error: null,
          })),
        },
      } as any,
      token: 'visitor-token',
      actorId: 'anon-1',
      expiresAt: Date.now() + 60_000,
      requestId: '88888888-8888-4888-8888-888888888888',
      photoIntentId: '99999999-9999-4999-8999-999999999991',
      idIntentId: '99999999-9999-4999-8999-999999999992',
      vehiclePhotoIntentId: null,
      photoCheckpoint: { blobSize: 100, blobType: 'image/webp' },
      idCheckpoint: { blobSize: 100, blobType: 'image/webp' },
      vehiclePhotoCheckpoint: null,
      submittedPayload: null,
      phase: 'editable' as const,
    };

    vi.spyOn(clientSupabaseModule, 'requirePortalSupabase').mockReturnValue(tx.client);

    const result = await issueVisitorPass(
      'portal',
      {
        firstName: 'Ana',
        lastName: 'Reyes',
        contactNumber: '09171234567',
        purpose: 'Document Request',
        visitDate: '2026-11-12',
        arrivalMode: 'no_vehicle',
        officeId: 'office-1',
      },
      null,
      null,
      tx.requestId,
      undefined,
      tx,
    );
    expect(result.approvalRequired).toBe(true);
    expect(result.trackingUrl).toBe('https://egatepass.tech/track#t=tok123');
    expect(tx.phase).toBe('committed');
  });
});
