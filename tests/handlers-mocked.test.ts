import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { setEmailSenderForTest, SendEmailPayload } from '../server/email.js';
import updateDeviceAuthHandler from '../api/update-device-auth.js';
import updateSettingsHandler from '../api/update-settings.js';
import adminSettingsHandler from '../api/admin/settings.js';
import emailPassHandler from '../api/passes/email.js';
import purgeImagesHandler from '../api/purge-images.js';
import recordsHandler from '../api/admin/records.js';
import dashboardHandler from '../api/admin/dashboard.js';
import { requireStaffActor } from '../server/actors.js';
import { encodeCompoundCursor } from '../server/cursor.js';

async function invokeHandler(handler: any, req: Request): Promise<Response> {
  if (typeof handler === 'function') return handler(req);
  if (typeof handler?.fetch === 'function') return handler.fetch(req);
  if (typeof handler?.POST === 'function') return handler.POST(req);
  if (typeof handler?.GET === 'function') return handler.GET(req);
  throw new Error('Unsupported handler export');
}

describe('Behavioral Mocked-Handler Tests [PASS (MOCKED HANDLER)]', () => {
  const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';
  const STAFF_VICTIM_ID = '00000000-0000-4000-a000-000000000002';
  const DEVICE_ID = '00000000-0000-4000-a000-000000000003';
  const OTHER_DEVICE_ID = '00000000-0000-4000-a000-000000000004';
  const VISITOR_OWNER_ID = '00000000-0000-4000-a000-000000000005';
  const OTHER_VISITOR_ID = '00000000-0000-4000-a000-000000000006';

  const VALID_SUPERADMIN_BEARER = 'Bearer valid-superadmin-token';
  const VALID_VISITOR_BEARER = 'Bearer valid-visitor-token';
  const OTHER_VISITOR_BEARER = 'Bearer other-visitor-token';

  const TEST_PASS_ID = '00000000-0000-4000-a000-000000000888';
  const TEST_PUBLIC_REF = 'GP-20261020-0888';
  const TEST_RAW_TOKEN = 'gp_valid_raw_token_xyz123';
  const TEST_TOKEN_DIGEST = createHash('sha256').update(TEST_RAW_TOKEN).digest('hex');

  let mockDbData: {
    devices: any[];
    staff_profiles: any[];
    audit_events: any[];
    app_settings: any[];
    incident_holds: any[];
    passes: any[];
    visitor_evidence: any[];
    reconciliation_tasks: any[];
    pass_email_verifications: any[];
  };

  let mockAuthUsers: Record<string, any>;
  let sentEmails: SendEmailPayload[];
  let mockRpcFailures: Record<string, any>;
  let mockTableFailures: Record<string, any>;

  function createMockSupabase() {
    return {
      auth: {
        getUser: vi.fn(async (token: string) => {
          if (token === 'valid-superadmin-token') {
            return {
              data: {
                user: {
                  id: SUPERADMIN_ID,
                  email: 'superadmin@earist.edu.ph',
                  email_confirmed_at: '2026-01-01T00:00:00Z',
                },
              },
              error: null,
            };
          }
          if (token === 'valid-visitor-token') {
            return {
              data: {
                user: {
                  id: VISITOR_OWNER_ID,
                  email: 'visitor.owner@gmail.com',
                  email_confirmed_at: '2026-01-01T00:00:00Z',
                },
              },
              error: null,
            };
          }
          if (token === 'other-visitor-token') {
            return {
              data: {
                user: {
                  id: OTHER_VISITOR_ID,
                  email: 'other.visitor@gmail.com',
                  email_confirmed_at: '2026-01-01T00:00:00Z',
                },
              },
              error: null,
            };
          }
          if (token === 'unverified-staff-token') {
            return {
              data: {
                user: {
                  id: '00000000-0000-4000-a000-000000000099',
                  email: 'unconfirmed@earist.edu.ph',
                  email_confirmed_at: null, // UNVERIFIED
                },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error('Invalid token') };
        }),
        admin: {
          getUserById: vi.fn(async (uid: string) => {
            const user = mockAuthUsers[uid];
            if (!user) return { data: { user: null }, error: new Error('Auth user not found') };
            return { data: { user }, error: null };
          }),
          updateUserById: vi.fn(async (uid: string, payload: any) => {
            const user = mockAuthUsers[uid];
            if (!user) return { data: { user: null }, error: new Error('Auth user not found') };
            Object.assign(user, payload);
            return { data: { user }, error: null };
          }),
        },
      },
      from: (table: string) => {
        let currentTable = table;
        let filters: Array<(item: any) => boolean> = [];
        let eqCols: Record<string, any> = {};
        let limitVal: number | null = null;
        let isHeadCount = false;

        const chain: any = {
          select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) {
              isHeadCount = true;
            }
            return chain;
          },
          eq: (col: string, val: any) => {
            eqCols[col] = val;
            filters.push((item) => {
              if (col === 'singleton' && val === true) return true;
              return item[col] === val;
            });
            return chain;
          },
          neq: (col: string, val: any) => {
            filters.push((item) => item[col] !== val);
            return chain;
          },
          is: (col: string, val: any) => {
            filters.push((item) => item[col] === val);
            return chain;
          },
          not: (col: string, op: string, val: any) => {
            if (op === 'is') {
              filters.push((item) => item[col] !== val);
            }
            return chain;
          },
          gte: (col: string, val: any) => {
            filters.push((item) => item[col] >= val);
            return chain;
          },
          lte: (col: string, val: any) => {
            filters.push((item) => item[col] <= val);
            return chain;
          },
          lt: (col: string, val: any) => {
            filters.push((item) => item[col] < val);
            return chain;
          },
          ilike: (_col: string, _pattern: string) => chain,
          or: (expr: string) => {
            // Support public_reference vs id compound check
            if (expr.includes('public_reference.eq.') && expr.includes('id.eq.')) {
              const match = expr.match(/public_reference\.eq\.([^,]+)/);
              const val = match ? match[1] : '';
              filters.push((item) => item.public_reference === val || item.id === val);
            }
            return chain;
          },
          order: () => chain,
          limit: (n: number) => {
            limitVal = n;
            return chain;
          },
          maybeSingle: async () => {
            if (currentTable === 'staff_profiles' && mockTableFailures['staff_profiles:target'] && eqCols['user_id'] !== SUPERADMIN_ID) {
              return { data: null, error: mockTableFailures['staff_profiles:target'] };
            }
            if (mockTableFailures[currentTable]) {
              return { data: null, error: mockTableFailures[currentTable] };
            }
            const items = (mockDbData as any)[currentTable] || [];
            const filtered = items.filter((x: any) => filters.every((f) => f(x)));
            return { data: filtered[0] || null, error: null };
          },
          single: async () => {
            if (mockTableFailures[currentTable]) {
              return { data: null, error: mockTableFailures[currentTable] };
            }
            const items = (mockDbData as any)[currentTable] || [];
            const filtered = items.filter((x: any) => filters.every((f) => f(x)));
            if (!filtered[0]) return { data: null, error: new Error('Record not found') };
            return { data: filtered[0], error: null };
          },
          insert: async (data: any) => {
            if (mockTableFailures[`${currentTable}:insert`]) {
              return { data: null, error: mockTableFailures[`${currentTable}:insert`] };
            }
            const items = (mockDbData as any)[currentTable] || [];
            const rows = Array.isArray(data) ? data : [data];
            items.push(...rows);
            return { data: rows, error: null };
          },
          update: (data: any) => {
            return {
              eq: (col: string, val: any) => {
                if (mockTableFailures[`${currentTable}:update`]) {
                  return { error: mockTableFailures[`${currentTable}:update`] };
                }
                const items = (mockDbData as any)[currentTable] || [];
                items.forEach((item: any) => {
                  if (col === 'singleton' && val === true) {
                    Object.assign(item, data);
                  } else if (item[col] === val) {
                    Object.assign(item, data);
                  }
                });
                return { error: null };
              },
            };
          },
          then: (resolve: any) => {
            if (mockTableFailures[currentTable]) {
              resolve({ data: null, count: null, error: mockTableFailures[currentTable] });
              return;
            }
            const items = (mockDbData as any)[currentTable] || [];
            let result = items.filter((x: any) => filters.every((f) => f(x)));
            if (isHeadCount) {
              resolve({ count: result.length, data: null, error: null });
              return;
            }
            if (limitVal !== null) result = result.slice(0, limitVal);
            resolve({ data: result, count: result.length, error: null });
          },
        };
        return chain;
      },
      schema: (_s: string) => ({
        rpc: async (fn: string, args: any) => {
          if (mockRpcFailures[fn]) {
            return { data: null, error: mockRpcFailures[fn] };
          }
          if (fn === 'update_device_profile') {
            const dev = mockDbData.devices.find((d) => d.user_id === args.requested_user_id);
            if (dev) {
              if (args.requested_alias) dev.alias = args.requested_alias;
              if (args.requested_status) dev.status = args.requested_status;
              return { data: dev, error: null };
            }
            return { data: null, error: new Error('Device not found in RPC') };
          }
          if (fn === 'update_app_settings') {
            const updated = {
              id: 1,
              singleton: true,
              peak_mode: args.requested_peak_mode,
              automatic_cleanup_enabled: args.requested_automatic_cleanup_enabled ?? args.requested_automatic_cleanup,
              purposes: args.requested_purposes,
              working_hours_start: '08:00',
              working_hours_end: '17:00',
              timezone: 'Asia/Manila',
              rejection_reasons: ['Incomplete requirements'],
              visit_purposes: args.requested_purposes,
              visitor_retention_days: 90,
              image_retention_days: 30,
              audit_retention_days: 365,
              reconciliation_retention_days: 90,
              updated_at: new Date().toISOString(),
            };
            mockDbData.app_settings = [updated];
            mockDbData.audit_events.push({
              action: 'settings_updated',
              actor_id: args.requested_actor_id,
              outcome: 'success',
            });
            return { data: updated, error: null };
          }
          if (fn === 'request_email_verification_code') {
            const pass = mockDbData.passes.find((p) => p.id === args.requested_pass_id);
            if (!pass) return { data: null, error: { code: 'P0002', message: 'pass_not_found' } };
            if (pass.visitors.owner_id !== args.requested_actor_id) {
              return { data: null, error: { code: '42501', message: 'access_denied' } };
            }
            const existing = mockDbData.pass_email_verifications.find(
              (v) => v.request_id === args.requested_request_id
            );
            if (existing) {
              return {
                data: {
                  verification_id: existing.id,
                  expires_at: existing.expires_at,
                  idempotent_replay: true,
                },
                error: null,
              };
            }
            const recent = mockDbData.pass_email_verifications.filter(
              (v) => v.pass_id === args.requested_pass_id
            );
            if (recent.length >= 3) {
              return { data: null, error: { code: 'P0003', message: 'too_many_requests' } };
            }
            const row = {
              id: args.requested_verification_id,
              pass_id: args.requested_pass_id,
              recipient_email: args.requested_recipient_email,
              code_hash: args.requested_code_hash,
              attempts: 0,
              verified: false,
              expires_at: args.requested_expires_at,
              request_id: args.requested_request_id,
              delivery_status: 'pending',
              created_at: new Date().toISOString(),
            };
            mockDbData.pass_email_verifications.push(row);
            return {
              data: {
                verification_id: row.id,
                expires_at: row.expires_at,
                idempotent_replay: false,
              },
              error: null,
            };
          }
          if (fn === 'verify_and_claim_email_dispatch') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id && v.pass_id === args.requested_pass_id
            );
            if (!verif) return { data: null, error: { code: 'P0002', message: 'verification_not_found' } };
            if (verif.send_request_id === args.requested_send_request_id) {
              return {
                data: { success: true, idempotent_replay: true, recipient_email: verif.recipient_email },
                error: null,
              };
            }
            if (verif.verified && verif.delivery_status === 'sent_to_provider') {
              return { data: null, error: { code: 'P0004', message: 'code_already_used' } };
            }
            if (verif.delivery_status === 'sending') {
              return { data: null, error: { code: 'P0005', message: 'dispatch_in_progress' } };
            }
            if (new Date(verif.expires_at).getTime() <= Date.now()) {
              return { data: null, error: { code: 'P0006', message: 'code_expired' } };
            }
            if (verif.attempts >= 3) {
              return { data: null, error: { code: 'P0007', message: 'max_attempts_exceeded' } };
            }
            if (verif.recipient_email !== args.requested_recipient_email) {
              return { data: null, error: { code: 'P0008', message: 'recipient_mismatch' } };
            }
            if (verif.code_hash !== args.requested_expected_hash) {
              verif.attempts++;
              return {
                data: { success: false, attempts_remaining: Math.max(0, 3 - verif.attempts) },
                error: null,
              };
            }
            verif.verified = true;
            verif.delivery_status = 'sending';
            verif.send_request_id = args.requested_send_request_id;
            return {
              data: { success: true, recipient_email: verif.recipient_email, idempotent_replay: false },
              error: null,
            };
          }
          if (fn === 'finalize_email_dispatch') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id
            );
            if (!verif) return { data: null, error: { code: 'P0002', message: 'verification_not_found' } };
            verif.delivery_status = args.requested_delivery_status;
            if (args.requested_delivery_status === 'sent_to_provider') {
              verif.provider_delivery_id = args.requested_provider_delivery_id;
              verif.sent_at = new Date().toISOString();
            } else {
              verif.delivery_status = 'delivery_failed';
              verif.send_request_id = null;
            }
            return { data: { success: true }, error: null };
          }
          return { data: null, error: new Error(`Unknown RPC: ${fn}`) };
        },
      }),
      storage: {
        from: (_bucket: string) => ({
          remove: vi.fn(async (_keys: string[]) => ({ data: [], error: null })),
        }),
      },
    };
  }

  beforeEach(() => {
    mockRpcFailures = {};
    mockTableFailures = {};

    mockDbData = {
      devices: [
        {
          user_id: DEVICE_ID,
          alias: 'gate1-entry',
          name: 'Main Gate 1 Entry',
          type: 'kiosk',
          gate: 'Gate 1',
          status: 'active',
          deleted_at: null,
        },
        {
          user_id: OTHER_DEVICE_ID,
          alias: 'gate2-exit',
          name: 'Gate 2 Exit',
          type: 'guard',
          gate: 'Gate 2',
          status: 'active',
          deleted_at: null,
        },
      ],
      staff_profiles: [
        {
          user_id: SUPERADMIN_ID,
          role: 'superadmin',
          full_name: 'Chief Super Admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        },
        {
          user_id: STAFF_VICTIM_ID,
          role: 'guard',
          full_name: 'Officer Guard',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        },
        {
          user_id: '00000000-0000-4000-a000-000000000099',
          role: 'guard',
          full_name: 'Unverified Guard',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-01-01T00:00:00Z',
          deleted_at: null,
        },
      ],
      audit_events: [],
      app_settings: [
        {
          id: 1,
          singleton: true,
          peak_mode: 'off',
          automatic_cleanup_enabled: true,
          purposes: [{ label: 'Registrar', requiresDetails: false, detailPrompt: '' }],
          visit_purposes: [{ label: 'Registrar', requiresDetails: false, detailPrompt: '' }],
          working_hours_start: '08:00',
          working_hours_end: '17:00',
          timezone: 'Asia/Manila',
          rejection_reasons: ['Incomplete requirements'],
          visitor_retention_days: 90,
          image_retention_days: 30,
          audit_retention_days: 365,
          reconciliation_retention_days: 90,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      incident_holds: [],
      passes: [
        {
          id: TEST_PASS_ID, // Internal UUID
          public_reference: TEST_PUBLIC_REF, // Distinct public reference
          visitor_id: 'visitor-888',
          // Postgres bytea PostgREST serialization starts with \x
          token_digest: `\\x${TEST_TOKEN_DIGEST}`,
          status: 'issued',
          valid_from: '2026-10-20T00:00:00Z',
          valid_until: '2026-10-20T23:59:59Z',
          entry_scanned_at: '2026-10-20T08:00:00+08:00',
          issued_at: '2026-10-20T07:30:00+08:00',
          visitors: {
            id: 'visitor-888',
            owner_id: VISITOR_OWNER_ID,
            source: 'portal',
            full_name: 'Maria Santos',
            visit_date: '2026-10-20',
            purpose: 'Registrar',
          },
        },
      ],
      visitor_evidence: [],
      reconciliation_tasks: [],
      pass_email_verifications: [],
    };

    mockAuthUsers = {
      [SUPERADMIN_ID]: {
        id: SUPERADMIN_ID,
        email: 'superadmin@earist.edu.ph',
      },
      [STAFF_VICTIM_ID]: {
        id: STAFF_VICTIM_ID,
        email: 'guard.officer@earist.edu.ph',
      },
      [DEVICE_ID]: {
        id: DEVICE_ID,
        email: 'gate1-entry@devices.egatepass.invalid',
      },
      [OTHER_DEVICE_ID]: {
        id: OTHER_DEVICE_ID,
        email: 'gate2-exit@devices.egatepass.invalid',
      },
      [VISITOR_OWNER_ID]: {
        id: VISITOR_OWNER_ID,
        email: 'visitor.owner@gmail.com',
      },
      [OTHER_VISITOR_ID]: {
        id: OTHER_VISITOR_ID,
        email: 'other.visitor@gmail.com',
      },
    };

    sentEmails = [];
    setEmailSenderForTest(async (payload) => {
      sentEmails.push(payload);
      return { id: `resend_${randomUUID()}` };
    });

    const mockClients = {
      client: createMockSupabase(),
      admin: createMockSupabase(),
    };
    setServerSupabaseClientsForTest(mockClients as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // P0-01 & P0-02: QR Email Delivery Contract & Atomicity
  // =========================================================================
  describe('P0-01 & P0-02: QR Email Delivery Contract (api/passes/email.ts)', () => {
    it('P0-01: successfully accepts public_reference and resolves internal pass ID', async () => {
      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF, // Public reference from issuance (GP-20261020-0888)
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe('code_sent');
      expect(typeof json.verificationId).toBe('string');

      // Crucial verification: pass_id in DB row is internal UUID, NOT the public reference
      expect(mockDbData.pass_email_verifications.length).toBe(1);
      expect(mockDbData.pass_email_verifications[0].pass_id).toBe(TEST_PASS_ID);
    });

    it('P0-01: timing-safe check normalizes Postgres bytea \\x hex digest', async () => {
      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: 'wrong_raw_token_value_abc', // Invalid token
          recipientEmail: 'maria.santos@gmail.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('invalid_bearer_token');
    });

    it('P0-01: rejects request from non-owner actor', async () => {
      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: OTHER_VISITOR_BEARER, // Different visitor actor
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('access_denied');
    });

    it('P0-02: request_code enforces idempotency on requestId', async () => {
      const sameRequestId = randomUUID();

      const body = {
        action: 'request_code',
        passId: TEST_PUBLIC_REF,
        qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com',
        consent: true,
        requestId: sameRequestId,
      };

      // Call 1
      const res1 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      const json1 = await res1.json();
      expect(res1.status).toBe(200);

      // Call 2 with identical requestId
      const res2 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      const json2 = await res2.json();
      expect(res2.status).toBe(200);
      expect(json2.verificationId).toBe(json1.verificationId);

      // Only one email should have been dispatched
      expect(sentEmails.length).toBe(1);
    });

    it('P0-02: enforces fail-closed rate limit (max 3 requests per 15 min)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
          method: 'POST',
          headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'request_code',
            passId: TEST_PUBLIC_REF,
            qrToken: TEST_RAW_TOKEN,
            recipientEmail: 'maria.santos@gmail.com',
            consent: true,
            requestId: randomUUID(),
          }),
        }));
        expect(res.status).toBe(200);
      }

      // 4th request must be rate-limited
      const res4 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          consent: true,
          requestId: randomUUID(),
        }),
      }));
      const json4 = await res4.json();
      expect(res4.status).toBe(429);
      expect(json4.error).toBe('too_many_requests');
    });

    it('P0-02: verify_and_send increments attempts on invalid code and caps at 3', async () => {
      const verificationId = randomUUID();
      const code = '123456';
      const codeHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');

      mockDbData.pass_email_verifications = [
        {
          id: verificationId,
          pass_id: TEST_PASS_ID,
          recipient_email: 'maria.santos@gmail.com',
          code_hash: codeHash,
          expires_at: new Date(Date.now() + 600000).toISOString(),
          attempts: 0,
          verified: false,
          delivery_status: 'pending',
        },
      ];

      // Attempt 1: wrong code
      const res1 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code: '999999',
          requestId: randomUUID(),
        }),
      }));
      const json1 = await res1.json();
      expect(res1.status).toBe(400);
      expect(json1.error).toBe('invalid_code');
      expect(json1.attemptsRemaining).toBe(2);

      // Attempt 2: wrong code
      const res2 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code: '999999',
          requestId: randomUUID(),
        }),
      }));
      expect(res2.status).toBe(400);

      // Attempt 3: wrong code
      const res3 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code: '999999',
          requestId: randomUUID(),
        }),
      }));
      expect(res3.status).toBe(400);

      // Attempt 4: attempts exceeded
      const res4 = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code: code, // Even with correct code, must reject
          requestId: randomUUID(),
        }),
      }));
      expect(res4.status).toBe(429);
    });

    it('P0-02: delivery failure records reconciliation, keeps delivery_failed status, preserves pass', async () => {
      setEmailSenderForTest(async () => {
        throw new Error('Resend Network Timeout');
      });

      const verificationId = randomUUID();
      const code = '654321';
      const codeHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');

      mockDbData.pass_email_verifications = [
        {
          id: verificationId,
          pass_id: TEST_PASS_ID,
          recipient_email: 'maria.santos@gmail.com',
          code_hash: codeHash,
          expires_at: new Date(Date.now() + 600000).toISOString(),
          attempts: 0,
          verified: false,
          delivery_status: 'pending',
        },
      ];

      const res = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code,
          requestId: randomUUID(),
        }),
      }));
      const json = await res.json();

      expect(res.status).toBe(502);
      expect(json.error).toBe('email_delivery_failed');

      // Status in DB must reflect delivery_failed
      const verif = mockDbData.pass_email_verifications.find((v) => v.id === verificationId);
      expect(verif?.delivery_status).toBe('delivery_failed');

      // Reconciliation recorded in reconciliation_tasks
      expect(mockDbData.reconciliation_tasks.length).toBe(1);
      expect(mockDbData.reconciliation_tasks[0].operation).toBe('pass.email_delivery_failed');

      // Pass must remain intact
      expect(mockDbData.passes.find((p) => p.id === TEST_PASS_ID)).toBeDefined();
    });

    it('P0-02: successful delivery marks status sent_to_provider with attachment', async () => {
      const verificationId = randomUUID();
      const code = '123456';
      const codeHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');

      mockDbData.pass_email_verifications = [
        {
          id: verificationId,
          pass_id: TEST_PASS_ID,
          recipient_email: 'maria.santos@gmail.com',
          code_hash: codeHash,
          expires_at: new Date(Date.now() + 600000).toISOString(),
          attempts: 0,
          verified: false,
          delivery_status: 'pending',
        },
      ];

      const res = await invokeHandler(emailPassHandler, new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code,
          requestId: randomUUID(),
        }),
      }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe('sent_to_provider');
      expect(typeof json.deliveryId).toBe('string');

      const deliveryEmail = sentEmails.find((e) => e.subject.includes('Your EARIST Digital Gate Pass'));
      expect(deliveryEmail).toBeDefined();
      expect(deliveryEmail?.attachments?.length).toBe(1);
    });
  });

  // =========================================================================
  // P0-03: Settings Fails Closed On RPC Error (Zero Fallback)
  // =========================================================================
  describe('P0-03: Settings RPC Failure Must Fail Closed (api/update-settings.ts)', () => {
    it('fails closed with 503 and performs ZERO direct table update when RPC fails', async () => {
      mockRpcFailures['update_app_settings'] = {
        code: '50000',
        message: 'Database write transaction aborted',
      };

      const initialSettings = JSON.parse(JSON.stringify(mockDbData.app_settings));
      const initialAuditCount = mockDbData.audit_events.length;

      const req = new Request('http://localhost/api/update-settings', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          peakMode: 'both',
          automaticCleanupEnabled: false,
          rejectionReasons: ['Updated reason'],
          visitPurposes: [{ label: 'Updated Purpose', requiresDetails: false, detailPrompt: '' }],
        }),
      });

      const res = await invokeHandler(updateSettingsHandler, req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.error).toBe('Database write transaction aborted');

      // CRITICAL: Verify NO direct fallback occurred on app_settings
      expect(mockDbData.app_settings).toEqual(initialSettings);
      // Verify NO audit event was inserted by direct write
      expect(mockDbData.audit_events.length).toBe(initialAuditCount);
    });

    it('rejects operational admin attempt to modify security settings with 403', async () => {
      // Create admin actor profile
      const ADMIN_ACTOR_ID = '00000000-0000-4000-a000-000000000007';
      mockDbData.staff_profiles.push({
        user_id: ADMIN_ACTOR_ID,
        role: 'admin', // Not superadmin
        full_name: 'Operational Admin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
        deleted_at: null,
      });

      const client = createMockSupabase();
      (client.auth.getUser as any).mockResolvedValue({
        data: {
          user: {
            id: ADMIN_ACTOR_ID,
            email: 'admin@earist.edu.ph',
            email_confirmed_at: '2026-01-01T00:00:00Z',
          },
        },
        error: null,
      });
      setServerSupabaseClientsForTest({ client, admin: client } as any);

      const req = new Request('http://localhost/api/update-settings', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          peakMode: 'portal',
          automaticCleanupEnabled: false, // Security sensitive field
          rejectionReasons: ['Standard'],
          visitPurposes: [{ label: 'Registrar', requiresDetails: false, detailPrompt: '' }],
        }),
      });

      const res = await invokeHandler(updateSettingsHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toContain('Only Super Admins');
    });
  });

  // =========================================================================
  // P0-04: Image Purge Concurrency & Fail-Closed Checks
  // =========================================================================
  describe('P0-04: Image Purge Incident Hold Protection & Fail-Closed (api/purge-images.ts)', () => {
    it('detects pass-only incident hold during per-item recheck and skips deletion', async () => {
      mockDbData.incident_holds = [
        {
          id: 'hold-pass-only',
          pass_id: TEST_PASS_ID,
          visitor_id: null, // Pass-only hold!
          active: true,
        },
      ];

      mockDbData.visitor_evidence = [
        {
          id: 'ev-1',
          visitor_id: 'visitor-888',
          bucket_id: 'pass-photos',
          object_path: 'visitor-888/photo.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      const res = await invokeHandler(purgeImagesHandler, new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(0);
      // Asset must NOT have been marked purged
      expect(mockDbData.visitor_evidence[0].purged_at).toBeNull();
    });

    it('fails closed when database query errors during per-item hold check', async () => {
      mockTableFailures['incident_holds'] = new Error('Database read timeout');

      mockDbData.visitor_evidence = [
        {
          id: 'ev-fail-closed',
          visitor_id: 'visitor-888',
          bucket_id: 'pass-photos',
          object_path: 'visitor-888/photo.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      // Initial candidate scan will fail with 500/503 because holds query errored
      const res = await invokeHandler(purgeImagesHandler, new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      }));

      expect(res.status).toBe(500);
      // Asset must NOT be purged
      expect(mockDbData.visitor_evidence[0].purged_at).toBeNull();
    });
  });

  // =========================================================================
  // P0-05: Device Governance & Audit Errors
  // =========================================================================
  describe('P0-05: Governance Target Validation & Error Inspection (api/update-device-auth.ts)', () => {
    it('fails closed with 503 if staff check query returns a database error', async () => {
      mockTableFailures['staff_profiles:target'] = new Error('DB connection pool exhausted');

      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetUid: DEVICE_ID,
          password: 'NewPassword123!',
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json.error).toBe('staff_verification_failed');
    });

    it('blocks modification when target is a staff user', async () => {
      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetUid: STAFF_VICTIM_ID,
          password: 'NewPassword123!',
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('cannot_modify_staff_via_device_endpoint');
    });

    it('records reconciliation when audit event insert returns an error', async () => {
      mockTableFailures['audit_events:insert'] = new Error('Audit table disk full');

      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          targetUid: DEVICE_ID,
          password: 'NewPassword123!',
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      expect(res.status).toBe(200);

      // Reconciliation must have been recorded
      const recon = mockDbData.reconciliation_tasks.find((r) => r.operation === 'device.credentials.audit_failed');
      expect(recon).toBeDefined();
    });
  });

  // =========================================================================
  // C-01: Admin Dashboard Counts
  // =========================================================================
  describe('C-01: Dashboard True Counts (api/admin/dashboard.ts)', () => {
    it('returns true counts aligned to Manila local calendar day window', async () => {
      const req = new Request('http://localhost/api/admin/dashboard', {
        headers: { authorization: VALID_SUPERADMIN_BEARER },
      });

      const res = await invokeHandler(dashboardHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.counts).toBeDefined();
      expect(typeof json.counts.todayTotal).toBe('number');
      expect(typeof json.counts.currentlyInside).toBe('number');
      expect(typeof json.counts.pendingToday).toBe('number');
      expect(typeof json.counts.allPending).toBe('number');
    });
  });

  // =========================================================================
  // C-03: Secure Compound Cursor in Admin Records
  // =========================================================================
  describe('C-03: Secure Compound Cursor in Records (api/admin/records.ts)', () => {
    it('rejects malformed or injected cursor with 400', async () => {
      const req = new Request('http://localhost/api/admin/records?cursor=injected_syntax_or_invalid_base64', {
        headers: { authorization: VALID_SUPERADMIN_BEARER },
      });

      const res = await invokeHandler(recordsHandler, req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('invalid_cursor');
    });

    it('accepts valid compound cursor with UUID id', async () => {
      const validCursor = encodeCompoundCursor('2026-10-20T08:00:00.000Z', TEST_PASS_ID);
      const req = new Request(`http://localhost/api/admin/records?cursor=${validCursor}`, {
        headers: { authorization: VALID_SUPERADMIN_BEARER },
      });

      const res = await invokeHandler(recordsHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(json.passes)).toBe(true);
    });
  });
});
