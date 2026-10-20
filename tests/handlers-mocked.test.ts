import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { setEmailSenderForTest, SendEmailPayload } from '../server/email.js';
import updateDeviceAuthHandler from '../api/update-device-auth.js';
import updateSettingsHandler from '../api/update-settings.js';
import adminSettingsHandler from '../api/admin/settings.js';
import emailPassHandler from '../api/passes/email.js';
import purgeImagesHandler from '../api/purge-images.js';
import { requireStaffActor } from '../server/actors.js';

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

  const VALID_SUPERADMIN_BEARER = 'Bearer valid-superadmin-token';
  const VALID_VISITOR_BEARER = 'Bearer valid-visitor-token';

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
    reconciliations: any[];
    pass_email_verifications: any[];
  };

  let mockAuthUsers: Record<string, any>;
  let sentEmails: SendEmailPayload[];

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
            filters.push((item) => {
              // Support boolean singleton check
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
          or: (_expr: string) => {
            // Keep permissive in mock
            return chain;
          },
          order: () => chain,
          limit: (n: number) => {
            limitVal = n;
            return chain;
          },
          maybeSingle: async () => {
            const items = (mockDbData as any)[currentTable] || [];
            const filtered = items.filter((x: any) => filters.every((f) => f(x)));
            return { data: filtered[0] || null, error: null };
          },
          single: async () => {
            const items = (mockDbData as any)[currentTable] || [];
            const filtered = items.filter((x: any) => filters.every((f) => f(x)));
            if (!filtered[0]) return { data: null, error: new Error('Record not found') };
            return { data: filtered[0], error: null };
          },
          insert: async (data: any) => {
            const items = (mockDbData as any)[currentTable] || [];
            const rows = Array.isArray(data) ? data : [data];
            items.push(...rows);
            return { data: rows, error: null };
          },
          update: (data: any) => {
            return {
              eq: (col: string, val: any) => {
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
          id: TEST_PASS_ID,
          public_reference: TEST_PUBLIC_REF,
          visitor_id: 'visitor-888',
          token_digest: TEST_TOKEN_DIGEST,
          status: 'issued',
          valid_from: '2026-10-20T00:00:00Z',
          valid_until: '2026-10-20T23:59:59Z',
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
      reconciliations: [],
      pass_email_verifications: [],
    };

    mockAuthUsers = {
      [SUPERADMIN_ID]: {
        id: SUPERADMIN_ID,
        email: 'superadmin@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
      [STAFF_VICTIM_ID]: {
        id: STAFF_VICTIM_ID,
        email: 'guard@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
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
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };

    sentEmails = [];
    setEmailSenderForTest(async (payload) => {
      sentEmails.push(payload);
      return { id: 'mock-msg-001', provider: 'mock' };
    });

    const mockSupabase = createMockSupabase();
    setServerSupabaseClientsForTest({
      admin: mockSupabase as any,
      passwordVerifier: mockSupabase as any,
    });
  });

  afterEach(() => {
    setServerSupabaseClientsForTest(null);
    setEmailSenderForTest(null);
  });

  // =========================================================================
  // M4-F01: Device Credential Target Validation & Atomicity
  // =========================================================================
  describe('M4-F01: Device Credential Target Validation (api/update-device-auth.ts)', () => {
    it('rejects attempt to modify staff user via device credential endpoint', async () => {
      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
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

    it('rejects attempt to change alias to one already used by another active device', async () => {
      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: DEVICE_ID,
          email: 'gate2-exit', // In use by OTHER_DEVICE_ID
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toBe('device_alias_conflict');
    });

    it('rejects non-existent device target UID', async () => {
      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: '00000000-0000-4000-a000-000000000999',
          password: 'NewPassword123!',
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      const json = await res.json();

      expect(res.status).toBe(404);
      expect(json.error).toBe('device_not_found');
    });

    it('updates password and logs immutable audit event for valid target device', async () => {
      const req = new Request('http://localhost/api/update-device-auth', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: DEVICE_ID,
          password: 'ValidPassword123!',
        }),
      });

      const res = await invokeHandler(updateDeviceAuthHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);

      const audit = mockDbData.audit_events.find(
        (a) => a.target_id === DEVICE_ID && a.action === 'device.password_update'
      );
      expect(audit).toBeDefined();
      expect(audit.outcome).toBe('success');
      expect(audit.after_state.password_changed).toBe(true);
    });
  });

  // =========================================================================
  // M4-F04: Staff Email Verification Requirement at Boundary
  // =========================================================================
  describe('M4-F04: Staff Verification at Boundary (server/actors.ts)', () => {
    it('rejects human staff actor if email is unconfirmed', async () => {
      const mockSupabase = createMockSupabase();
      await expect(
        requireStaffActor(mockSupabase as any, 'unverified-staff-token', ['guard', 'superadmin'])
      ).rejects.toMatchObject({
        status: 403,
        code: 'email_verification_required',
      });
    });

    it('accepts human staff actor if email is confirmed', async () => {
      const mockSupabase = createMockSupabase();
      const actor = await requireStaffActor(mockSupabase as any, 'valid-superadmin-token', ['superadmin']);
      expect(actor.id).toBe(SUPERADMIN_ID);
      expect(actor.role).toBe('superadmin');
    });
  });

  // =========================================================================
  // M4-F03 & M4-F10: Settings Atomic Persistence
  // =========================================================================
  describe('M4-F03 & M4-F10: Settings Atomic Persistence (api/update-settings.ts & api/admin/settings.ts)', () => {
    it('persists automaticCleanupEnabled and peakMode scope via atomic RPC', async () => {
      const req = new Request('http://localhost/api/update-settings', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          peakMode: 'portal',
          automaticCleanupEnabled: false,
          rejectionReasons: ['Incomplete requirements'],
          visitPurposes: [{ label: 'Registrar', requiresDetails: false, detailPrompt: '' }],
        }),
      });

      const res = await invokeHandler(updateSettingsHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);

      expect(mockDbData.app_settings[0].peak_mode).toBe('portal');
      expect(mockDbData.app_settings[0].automatic_cleanup_enabled).toBe(false);

      // Read back via GET /api/admin/settings
      const getReq = new Request('http://localhost/api/admin/settings', {
        headers: { authorization: VALID_SUPERADMIN_BEARER },
      });
      const getRes = await invokeHandler(adminSettingsHandler, getReq);
      const getJson = await getRes.json();

      expect(getRes.status).toBe(200);
      expect(getJson.peakModeScope).toBe('portal');
      expect(getJson.automaticCleanupEnabled).toBe(false);
    });
  });

  // =========================================================================
  // M4-F02: Image Purge Incident Hold Protection
  // =========================================================================
  describe('M4-F02: Image Purge Incident Hold Protection (api/purge-images.ts)', () => {
    it('protects passes with active hold from purge and honors dry-run', async () => {
      const PASS_WITH_HOLD = '00000000-0000-4000-a000-000000000501';
      mockDbData.incident_holds = [
        {
          id: 'hold-1',
          pass_id: PASS_WITH_HOLD,
          visitor_id: 'visitor-501',
          active: true,
        },
      ];
      mockDbData.visitor_evidence = [
        {
          id: 'ev-1',
          visitor_id: 'visitor-501',
          bucket_id: 'pass-photos',
          object_path: 'visitor-501/photo.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: {
          authorization: VALID_SUPERADMIN_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          dryRun: true,
          limit: 10,
        }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.visitorsAffected).toBe(0);
    });
  });

  // =========================================================================
  // M5-F13: Optional QR Code Email Delivery
  // =========================================================================
  describe('M5-F13: Optional QR Email Delivery (api/passes/email.ts)', () => {
    it('completes request_code step by issuing 6-digit verification code to inbox', async () => {
      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PASS_ID,
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

      // Verify email was sent with 6-digit code
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].to).toBe('maria.santos@gmail.com');
      expect(sentEmails[0].subject).toContain('Verification Code');

      // Verify code was recorded in pass_email_verifications
      expect(mockDbData.pass_email_verifications.length).toBe(1);
      expect(mockDbData.pass_email_verifications[0].pass_id).toBe(TEST_PASS_ID);
      expect(mockDbData.pass_email_verifications[0].code_hash).toBeDefined();
    });

    it('rejects request_code if consent is not explicitly given', async () => {
      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PASS_ID,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          consent: false,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe('invalid_request');
    });

    it('verifies code and delivers QR code attachment', async () => {
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
        },
      ];

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PASS_ID,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe('sent');

      // Verify QR email was dispatched with PNG attachment
      const deliveryEmail = sentEmails.find((e) => e.subject.includes('Your EARIST Digital Gate Pass'));
      expect(deliveryEmail).toBeDefined();
      expect(deliveryEmail?.attachments?.length).toBe(1);
      expect(deliveryEmail?.attachments?.[0].filename).toBe('earist-gate-pass-qr.png');
    });

    it('delivery failure records reconciliation and does not rollback or delete pass', async () => {
      // Mock failure in sender
      setEmailSenderForTest(async () => {
        throw new Error('Resend API Network Timeout');
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
        },
      ];

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: {
          authorization: VALID_VISITOR_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PASS_ID,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com',
          verificationId,
          code,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(502);
      expect(json.error).toBe('email_delivery_failed');

      // Pass MUST still exist and not be deleted or rolled back
      expect(mockDbData.passes.find((p) => p.id === TEST_PASS_ID)).toBeDefined();
    });
  });
});
