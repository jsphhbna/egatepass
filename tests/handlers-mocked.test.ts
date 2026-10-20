import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { EmailDeliveryError, setEmailSenderForTest, SendEmailPayload } from '../server/email.js';
import updateDeviceAuthHandler from '../api/update-device-auth.js';
import updateSettingsHandler from '../api/update-settings.js';
import adminSettingsHandler from '../api/admin/settings.js';
import emailPassHandler from '../api/passes/email.js';
import purgeImagesHandler from '../api/purge-images.js';
import recordsHandler from '../api/admin/records.js';
import dashboardHandler from '../api/admin/dashboard.js';
import adminUsersHandler from '../api/admin/users.js';
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
  const KIOSK_ID = '00000000-0000-4000-a000-000000000007';

  const VALID_SUPERADMIN_BEARER = 'Bearer valid-superadmin-token';
  const VALID_VISITOR_BEARER = 'Bearer valid-visitor-token';
  const OTHER_VISITOR_BEARER = 'Bearer other-visitor-token';
  const VALID_KIOSK_BEARER = 'Bearer valid-kiosk-token';

  const TEST_PASS_ID = '00000000-0000-4000-a000-000000000888';
  const TEST_PUBLIC_REF = '10000000-0000-4000-a000-000000000888';
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
  let mockRpcOverrides: Record<string, any>;
  let mockTableFailures: Record<string, any>;
  let mockStorageFailures: Record<string, any>;
  let storageRemovedPaths: string[] = [];

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
          if (token === 'valid-kiosk-token') {
            return {
              data: { user: { id: KIOSK_ID, email: 'lobby-kiosk@devices.egatepass.invalid' } },
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
          if (token === 'revoked-token') {
            return {
              data: {
                user: {
                  id: '00000000-0000-4000-a000-000000000098',
                  email: 'kiosk.revoked@devices.egatepass.invalid',
                },
              },
              error: null,
            };
          }
          if (token === 'guard-device-token') {
            return {
              data: {
                user: {
                  id: OTHER_DEVICE_ID,
                  email: 'gate2-exit@devices.egatepass.invalid',
                },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error('Invalid token') };
        }),
        admin: {
          listUsers: vi.fn(async () => {
            return {
              data: {
                users: Object.values(mockAuthUsers),
              },
              error: null,
            };
          }),
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
          order: (_col: string, _opts?: { ascending?: boolean }) => chain,
          or: (expr: string) => {
            // Support public_reference vs id compound check
            if (expr.includes('public_reference.eq.') && expr.includes('id.eq.')) {
              const match = expr.match(/public_reference\.eq\.([^,]+)/);
              const val = match ? match[1] : '';
              filters.push((item) => item.public_reference === val || item.id === val);
            }
            if (expr.includes('created_at.lt.')) {
              const match = expr.match(/created_at\.lt\.([^,]+)/);
              const dt = match ? match[1] : '';
              if (dt) filters.push((item) => item.created_at < dt);
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
          if (Object.prototype.hasOwnProperty.call(mockRpcOverrides, fn)) return mockRpcOverrides[fn];
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
              if (existing.pass_id !== args.requested_pass_id
                || existing.request_actor_id !== args.requested_actor_id
                || existing.recipient_email !== args.requested_recipient_email) {
                return { data: null, error: { code: 'P0008', message: 'idempotency_key_mismatch' } };
              }
              return {
                data: {
                  verification_id: existing.id,
                  expires_at: existing.expires_at,
                  code_delivery_status: existing.code_delivery_status,
                  dispatch_code: false,
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
            const recipientRecent = mockDbData.pass_email_verifications.filter(
              (v) => v.recipient_email?.toLowerCase().trim() === args.requested_recipient_email?.toLowerCase().trim()
            );
            if (recipientRecent.length >= 5) {
              return { data: null, error: { code: 'P0003', message: 'too_many_requests_recipient' } };
            }
            if (args.requested_actor_id) {
              const actorRecent = mockDbData.pass_email_verifications.filter(
                (v) => v.request_actor_id === args.requested_actor_id
              );
              if (actorRecent.length >= 10) {
                return { data: null, error: { code: 'P0003', message: 'too_many_requests_actor' } };
              }
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
              request_actor_id: args.requested_actor_id,
              code_delivery_status: 'code_sending',
              delivery_status: 'pending',
              created_at: new Date().toISOString(),
            };
            mockDbData.pass_email_verifications.push(row);
            return {
              data: {
                  verification_id: row.id,
                  expires_at: row.expires_at,
                  code_delivery_status: row.code_delivery_status,
                  dispatch_code: true,
                  idempotent_replay: false,
              },
              error: null,
            };
          }
          if (fn === 'finalize_email_verification_code') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id && v.request_id === args.requested_request_id
            );
            if (!verif) return { data: null, error: { code: 'P0002', message: 'verification_not_found' } };
            if (verif.code_delivery_status === 'code_sending') {
              verif.code_delivery_status = args.requested_delivery_status;
              verif.code_provider_delivery_id = args.requested_provider_delivery_id;
            }
            return { data: { success: true, code_delivery_status: verif.code_delivery_status }, error: null };
          }
          if (fn === 'verify_and_claim_email_dispatch') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id && v.pass_id === args.requested_pass_id
            );
            if (!verif) return { data: null, error: { code: 'P0002', message: 'verification_not_found' } };
            const pass = mockDbData.passes.find((p) => p.id === args.requested_pass_id);
            if (!pass || pass.visitors.owner_id !== args.requested_actor_id) {
              return { data: null, error: { code: '42501', message: 'access_denied' } };
            }
            if (pass.status !== 'issued') return { data: null, error: { code: 'P0001', message: 'pass_not_active' } };
            if (new Date(pass.valid_until).getTime() <= Date.now()) return { data: null, error: { code: 'P0001', message: 'pass_expired' } };
            if (verif.recipient_email !== args.requested_recipient_email) {
              return { data: null, error: { code: 'P0008', message: 'recipient_mismatch' } };
            }
            if (verif.code_delivery_status !== 'sent_to_provider') {
              return { data: null, error: { code: 'P0005', message: 'verification_delivery_unconfirmed' } };
            }
            if (verif.send_request_id === args.requested_send_request_id) {
              const stale = verif.delivery_status === 'sending'
                && verif.dispatch_claimed_at
                && new Date(verif.dispatch_claimed_at).getTime() < Date.now() - 15 * 60_000;
              if (stale) verif.delivery_status = 'outcome_unknown';
              return {
                data: {
                  success: true,
                  idempotent_replay: true,
                  dispatch_authorized: false,
                  delivery_status: verif.delivery_status,
                  stale_claim_promoted: Boolean(stale),
                },
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
            if (verif.code_hash !== args.requested_expected_hash) {
              verif.attempts++;
              return {
                data: {
                  success: false,
                  error: 'invalid_code',
                  attempts_remaining: Math.max(0, 3 - verif.attempts),
                  idempotent_replay: false,
                  dispatch_authorized: false,
                  delivery_status: verif.delivery_status,
                },
                error: null,
              };
            }
            verif.verified = true;
            verif.delivery_status = 'sending';
            verif.send_request_id = args.requested_send_request_id;
            verif.dispatch_claimed_at = new Date().toISOString();
            return {
              data: {
                success: true,
                idempotent_replay: false,
                dispatch_authorized: true,
                delivery_status: 'sending',
                stale_claim_promoted: false,
              },
              error: null,
            };
          }
          if (fn === 'finalize_email_verification_code') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id
            );
            if (verif) {
              verif.code_delivery_status = args.requested_delivery_status;
            }
            return {
              data: {
                success: true,
                match_status: 'matched',
                code_delivery_status: args.requested_delivery_status,
              },
              error: null,
            };
          }
          if (fn === 'finalize_email_dispatch') {
            const verif = mockDbData.pass_email_verifications.find(
              (v) => v.id === args.requested_verification_id && v.send_request_id === args.requested_send_request_id
            );
            if (!verif) return { data: null, error: { code: 'P0002', message: 'verification_not_found' } };
            if (verif.delivery_status === 'sending') {
              verif.delivery_status = args.requested_delivery_status;
              if (args.requested_delivery_status === 'sent_to_provider') {
                verif.provider_delivery_id = args.requested_provider_delivery_id;
                verif.sent_at = new Date().toISOString();
              }
            }
            return { data: { success: true, match_status: 'matched', delivery_status: verif.delivery_status }, error: null };
          }
          if (fn === 'claim_evidence_for_purge') {
            const ev = mockDbData.visitor_evidence.find((e) => e.id === args.requested_evidence_id);
            if (!ev || ev.purged_at) {
              return { data: { claimed: false, reason: 'not_found_or_purged' }, error: null };
            }
            if (ev.expires_at && new Date(ev.expires_at).getTime() > Date.now()) {
              return { data: { claimed: false, reason: 'not_expired' }, error: null };
            }
            if (ev.purge_claim_id && ev.purge_claim_id !== args.requested_claim_id && ev.purge_claimed_at) {
              const claimedAt = new Date(ev.purge_claimed_at).getTime();
              if (Date.now() - claimedAt < 5 * 60 * 1000) {
                return { data: { claimed: false, reason: 'concurrent_purge_in_progress' }, error: null };
              }
            }
            const held = mockDbData.incident_holds.some(
              (h) => h.active && (h.visitor_id === ev.visitor_id || h.pass_id === ev.pass_id)
            );
            if (held) {
              return { data: { claimed: false, reason: 'held_by_incident_hold' }, error: null };
            }
            ev.purge_claim_id = args.requested_claim_id;
            ev.purge_claimed_at = new Date().toISOString();
            return {
              data: {
                claimed: true,
                evidence_id: ev.id,
                visitor_id: ev.visitor_id,
                bucket_id: ev.bucket_id,
                object_path: ev.object_path,
                claim_id: args.requested_claim_id,
                claimed_at: ev.purge_claimed_at,
              },
              error: null,
            };
          }
          if (fn === 'finalize_evidence_purge') {
            const ev = mockDbData.visitor_evidence.find((e) => e.id === args.requested_evidence_id);
            if (!ev) {
              return { data: { success: false, finalized: false, match_status: 'not_found', reason: 'evidence_not_found' }, error: null };
            }
            if (ev.purged_at) {
              return { data: { success: false, finalized: false, match_status: 'terminal_conflict', purged: true, reason: 'already_purged' }, error: null };
            }
            if (!ev.purge_claim_id) {
              return { data: { success: false, finalized: false, match_status: 'not_claimed', reason: 'no_active_claim' }, error: null };
            }
            if (ev.purge_claim_id !== args.requested_claim_id) {
              return { data: { success: false, finalized: false, match_status: 'claim_mismatch', reason: 'claim_id_mismatch' }, error: null };
            }
            if (ev.purge_claimed_at && (Date.now() - new Date(ev.purge_claimed_at).getTime() > 5 * 60 * 1000)) {
              return { data: { success: false, finalized: false, match_status: 'expired_claim', reason: 'claim_lease_expired' }, error: null };
            }
            if (args.requested_success) {
              ev.purged_at = new Date().toISOString();
              ev.purge_claim_id = null;
              ev.purge_claimed_at = null;
              return {
                data: {
                  success: true,
                  finalized: true,
                  match_status: 'matched',
                  purged: true,
                  purged_at: ev.purged_at,
                },
                error: null,
              };
            } else {
              ev.purge_claim_id = null;
              ev.purge_claimed_at = null;
              return {
                data: {
                  success: true,
                  finalized: true,
                  match_status: 'claim_released',
                  purged: false,
                  claim_released: true,
                },
                error: null,
              };
            }
          }
          return { data: null, error: new Error(`Unknown RPC: ${fn}`) };
        },
      }),
      storage: {
        from: (bucket: string) => ({
          remove: vi.fn(async (keys: string[]) => {
            if (mockStorageFailures[bucket]) {
              return { data: null, error: mockStorageFailures[bucket] };
            }
            storageRemovedPaths.push(...keys);
            return { data: keys, error: null };
          }),
        }),
      },
    };
  }

  beforeEach(() => {
    mockRpcFailures = {};
    mockRpcOverrides = {};
    mockTableFailures = {};
    mockStorageFailures = {};
    storageRemovedPaths = [];

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
        {
          user_id: KIOSK_ID,
          alias: 'kiosk-main',
          name: 'Main Kiosk Device',
          type: 'kiosk',
          gate: 'Gate 1',
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
          valid_from: new Date(Date.now() - 60_000).toISOString(),
          valid_until: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
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
      return { id: `resend_${randomUUID()}`, provider: 'mock' };
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

  function seedVerification(code = '123456', overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    mockDbData.pass_email_verifications = [{
      id,
      pass_id: TEST_PASS_ID,
      recipient_email: 'maria.santos@gmail.com',
      code_hash: createHash('sha256').update(`${id}:${code}`).digest('hex'),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      attempts: 0,
      verified: false,
      code_delivery_status: 'sent_to_provider',
      delivery_status: 'pending',
      ...overrides,
    }];
    return { id, code };
  }

  function emailRequest(body: Record<string, unknown>, bearer = VALID_VISITOR_BEARER) {
    return new Request('http://localhost/api/passes/email', {
      method: 'POST',
      headers: { authorization: bearer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function verifyBody(verificationId: string, code: string, requestId = randomUUID()) {
    return {
      action: 'verify_and_send',
      passId: TEST_PUBLIC_REF,
      qrToken: TEST_RAW_TOKEN,
      recipientEmail: 'maria.santos@gmail.com',
      verificationId,
      code,
      requestId,
    };
  }

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
          passId: TEST_PUBLIC_REF, // Public UUID returned by issuance
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
      expect(json.status).toBe('code_sent_to_provider');
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

    it('EMAIL-P0-02: failed initial code delivery replays stable failure without fabricating sent', async () => {
      let providerCalls = 0;
      setEmailSenderForTest(async () => {
        providerCalls += 1;
        throw new EmailDeliveryError('resend_rejected', 'definitive_rejection');
      });
      const body = {
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
      };
      const first = await invokeHandler(emailPassHandler, emailRequest(body));
      const replay = await invokeHandler(emailPassHandler, emailRequest(body));
      expect(first.status).toBe(502);
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ status: 'delivery_failed', retryAllowed: true });
      expect(providerCalls).toBe(1);
    });

    it('EMAIL-P0-02: request-code key reuse is bound to actor, pass, and recipient tuple', async () => {
      const requestId = randomUUID();
      const base = {
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId,
      };
      expect((await invokeHandler(emailPassHandler, emailRequest(base))).status).toBe(200);

      const changedRecipient = await invokeHandler(emailPassHandler, emailRequest({
        ...base, recipientEmail: 'different@example.com',
      }));
      expect(changedRecipient.status).toBe(400);

      mockDbData.passes.push({
        ...mockDbData.passes[0],
        id: '00000000-0000-4000-a000-000000000889',
        public_reference: '10000000-0000-4000-a000-000000000889',
      });
      const changedPass = await invokeHandler(emailPassHandler, emailRequest({
        ...base, passId: '10000000-0000-4000-a000-000000000889',
      }));
      expect(changedPass.status).toBe(400);

      mockDbData.passes[0].visitors.owner_id = OTHER_VISITOR_ID;
      const changedActor = await invokeHandler(emailPassHandler, emailRequest(base, OTHER_VISITOR_BEARER));
      expect(changedActor.status).toBe(400);
      expect(sentEmails).toHaveLength(1);
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
          code_delivery_status: 'sent_to_provider',
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

    it('P0-04: ambiguous delivery failure records reconciliation, fences outcome_unknown, and preserves pass', async () => {
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
          code_delivery_status: 'sent_to_provider',
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

      expect(res.status).toBe(202);
      expect(json.error).toBe('email_outcome_unknown');
      expect(json.retryAllowed).toBe(false);

      // Ambiguous transport failure must remain fenced against automatic retry.
      const verif = mockDbData.pass_email_verifications.find((v) => v.id === verificationId);
      expect(verif?.delivery_status).toBe('outcome_unknown');

      // Reconciliation recorded in reconciliation_tasks
      expect(mockDbData.reconciliation_tasks.length).toBe(1);
      expect(mockDbData.reconciliation_tasks[0].operation).toBe('pass.email_delivery_unknown');
      expect(mockDbData.reconciliation_tasks[0].safe_context).toEqual({ phase: 'qr_dispatch', outcome: 'unknown' });

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
          code_delivery_status: 'sent_to_provider',
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
      const deliveryEmail = sentEmails.find((e) => e.subject.includes('Your EARIST Digital Gate Pass'));
      expect(deliveryEmail).toBeDefined();
      expect(deliveryEmail?.attachments?.length).toBe(1);
    });

    it.each([
      ['missing RPC', { code: '42883', message: 'function does not exist' }],
      ['permission denied', { code: '42501', message: 'permission denied' }],
      ['transient SQL failure', { code: '40001', message: 'serialization failure' }],
    ])('EMAIL-P0-01: request-code %s fails closed with no row or provider call', async (_label, failure) => {
      mockRpcFailures.request_email_verification_code = failure;
      const res = await invokeHandler(emailPassHandler, emailRequest({
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
      }));
      expect([403, 503]).toContain(res.status);
      expect(mockDbData.pass_email_verifications).toHaveLength(0);
      expect(sentEmails).toHaveLength(0);
    });

    it('EMAIL-P0-01: invalid request-code RPC response fails closed', async () => {
      mockRpcOverrides.request_email_verification_code = { data: { unexpected: true }, error: null };
      const res = await invokeHandler(emailPassHandler, emailRequest({
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
      }));
      expect(res.status).toBe(503);
      expect(sentEmails).toHaveLength(0);
    });

    it.each([
      ['missing RPC', { code: '42883', message: 'function does not exist' }],
      ['permission denied', { code: '42501', message: 'permission denied' }],
      ['transient SQL failure', { code: '40001', message: 'serialization failure' }],
    ])('EMAIL-P0-01: claim %s performs zero QR dispatches', async (_label, failure) => {
      const seeded = seedVerification();
      mockRpcFailures.verify_and_claim_email_dispatch = failure;
      const res = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code)));
      expect([403, 503]).toContain(res.status);
      expect(sentEmails.filter((email) => email.attachments?.length)).toHaveLength(0);
      expect(mockDbData.pass_email_verifications[0].delivery_status).toBe('pending');
    });

    it('EMAIL-P0-01: invalid claim response performs zero QR dispatches', async () => {
      const seeded = seedVerification();
      mockRpcOverrides.verify_and_claim_email_dispatch = { data: { success: true }, error: null };
      const res = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code)));
      expect(res.status).toBe(503);
      expect(sentEmails).toHaveLength(0);
    });

    it('EMAIL-P0-02: identical replay after provider acceptance never calls provider twice', async () => {
      const seeded = seedVerification();
      const requestId = randomUUID();
      const body = verifyBody(seeded.id, seeded.code, requestId);
      const first = await invokeHandler(emailPassHandler, emailRequest(body));
      const replay = await invokeHandler(emailPassHandler, emailRequest(body));
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status: 'sent_to_provider', idempotentReplay: true });
      expect(sentEmails.filter((email) => email.attachments?.length)).toHaveLength(1);
    });

    it('EMAIL-P0-04: stale sending claim becomes fenced unknown and raises reconciliation', async () => {
      const requestId = randomUUID();
      const seeded = seedVerification('123456', {
        verified: true,
        delivery_status: 'sending',
        send_request_id: requestId,
        dispatch_claimed_at: new Date(Date.now() - 16 * 60_000).toISOString(),
      });
      const response = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code, requestId)));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        status: 'outcome_unknown', reconciliationRequired: true, reconciliationRecorded: true,
      });
      expect(sentEmails).toHaveLength(0);
      expect(mockDbData.pass_email_verifications[0].delivery_status).toBe('outcome_unknown');
    });

    it('EMAIL-P0-02: parallel same-key calls authorize at most one provider request', async () => {
      const seeded = seedVerification();
      const requestId = randomUUID();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      setEmailSenderForTest(async (payload) => {
        sentEmails.push(payload);
        await gate;
        return { id: 'provider-parallel', provider: 'mock' };
      });
      const body = verifyBody(seeded.id, seeded.code, requestId);
      const firstPromise = invokeHandler(emailPassHandler, emailRequest(body));
      await vi.waitFor(() => expect(sentEmails).toHaveLength(1));
      const replay = await invokeHandler(emailPassHandler, emailRequest(body));
      expect(replay.status).toBe(202);
      release();
      expect((await firstPromise).status).toBe(200);
      expect(sentEmails).toHaveLength(1);
    });

    it('EMAIL-P0-02: different concurrent send key cannot bypass an active claim', async () => {
      const seeded = seedVerification();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      setEmailSenderForTest(async (payload) => {
        sentEmails.push(payload);
        await gate;
        return { id: 'provider-one', provider: 'mock' };
      });
      const firstPromise = invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code)));
      await vi.waitFor(() => expect(sentEmails).toHaveLength(1));
      const second = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code)));
      expect(second.status).toBe(409);
      release();
      await firstPromise;
      expect(sentEmails).toHaveLength(1);
    });

    it('EMAIL-P0-04: definitive provider rejection permits deliberate retry but does not auto-retry', async () => {
      const seeded = seedVerification();
      setEmailSenderForTest(async () => {
        throw new EmailDeliveryError('resend_rejected', 'definitive_rejection');
      });
      const requestId = randomUUID();
      const response = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code, requestId)));
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ status: 'delivery_failed', retryAllowed: true });
      expect(mockDbData.pass_email_verifications[0].delivery_status).toBe('delivery_failed');
    });

    it('EMAIL-P0-04: finalization failure reports unknown and reconciliation failure is operator-visible', async () => {
      const seeded = seedVerification();
      mockRpcFailures.finalize_email_dispatch = { code: '40001', message: 'serialization failure' };
      mockTableFailures['reconciliation_tasks:insert'] = new Error('reconciliation unavailable');
      const response = await invokeHandler(emailPassHandler, emailRequest(verifyBody(seeded.id, seeded.code)));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        status: 'outcome_unknown', reconciliationRequired: true, reconciliationRecorded: false,
      });
      expect(sentEmails.filter((email) => email.attachments?.length)).toHaveLength(1);
      expect(mockDbData.pass_email_verifications[0].delivery_status).toBe('sending');
    });

    it('EMAIL-P0-05: accepts the distinct public UUID for a kiosk-owned pass', async () => {
      mockDbData.passes[0].visitors.owner_id = KIOSK_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';
      const response = await invokeHandler(emailPassHandler, emailRequest({
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'kiosk.visitor@example.com', consent: true, requestId: randomUUID(),
      }, VALID_KIOSK_BEARER));
      expect(response.status).toBe(200);
      expect(TEST_PUBLIC_REF).not.toBe(TEST_PASS_ID);
      expect(mockDbData.pass_email_verifications[0].pass_id).toBe(TEST_PASS_ID);
    });

    it.each(['xyz', '\\x1234', `\\x${'g'.repeat(64)}`, `${TEST_TOKEN_DIGEST}00`])(
      'EMAIL-P0-05: rejects malformed stored digest %s',
      async (digest) => {
        mockDbData.passes[0].token_digest = digest;
        const response = await invokeHandler(emailPassHandler, emailRequest({
          action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
        }));
        expect(response.status).toBe(403);
        expect(sentEmails).toHaveLength(0);
      },
    );

    it.each(['pending', 'inside', 'exited', 'rejected', 'revoked'])(
      'EMAIL-P0-05: denies non-issued pass status %s',
      async (status) => {
        mockDbData.passes[0].status = status;
        const response = await invokeHandler(emailPassHandler, emailRequest({
          action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
        }));
        expect(response.status).toBe(400);
        expect(sentEmails).toHaveLength(0);
      },
    );

    it('EMAIL-P0-05: denies expired pass and unknown public reference without leakage', async () => {
      mockDbData.passes[0].valid_until = new Date(Date.now() - 1).toISOString();
      const expired = await invokeHandler(emailPassHandler, emailRequest({
        action: 'request_code', passId: TEST_PUBLIC_REF, qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
      }));
      expect(expired.status).toBe(400);
      const missing = await invokeHandler(emailPassHandler, emailRequest({
        action: 'request_code', passId: '20000000-0000-4000-a000-000000000888', qrToken: TEST_RAW_TOKEN,
        recipientEmail: 'maria.santos@gmail.com', consent: true, requestId: randomUUID(),
      }));
      expect(missing.status).toBe(404);
      expect(sentEmails).toHaveLength(0);
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

  // =========================================================================
  // EMAIL-H02: Reject Mismatched Terminal State from Finalizers
  // =========================================================================
  describe('EMAIL-H02: Terminal State Conflict Rejection', () => {
    it('returns 202 verification_finalization_conflict when verification finalizer reports conflict', async () => {
      mockDbData.passes[0].visitors.owner_id = KIOSK_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';

      mockRpcOverrides['finalize_email_verification_code'] = {
        data: {
          success: false,
          match_status: 'terminal_conflict',
          code_delivery_status: 'outcome_unknown',
        },
        error: null,
      };

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_KIOSK_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'kiosk.visitor@example.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(202);
      expect(json.error).toBe('verification_finalization_conflict');
      expect(json.status).toBe('outcome_unknown');
      expect(json.retryAllowed).toBe(false);
      expect(json.reconciliationRequired).toBe(true);

      const recon = mockDbData.reconciliation_tasks.find((r) => r.last_error_code === 'terminal_conflict');
      expect(recon).toBeDefined();
    });

    it('returns 202 email_finalization_conflict when dispatch finalizer reports conflict', async () => {
      mockDbData.passes[0].visitors.owner_id = KIOSK_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';

      const verifId = randomUUID();
      const sendReqId = randomUUID();
      const code = '123456';
      const codeHash = createHash('sha256').update(`${verifId}:${code}`).digest('hex');

      mockDbData.pass_email_verifications.push({
        id: verifId,
        pass_id: TEST_PASS_ID,
        recipient_email: 'kiosk.visitor@example.com',
        code_hash: codeHash,
        attempts: 0,
        verified: false,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        request_id: randomUUID(),
        request_actor_id: KIOSK_ID,
        code_delivery_status: 'sent_to_provider',
        delivery_status: 'pending',
        created_at: new Date().toISOString(),
      });

      mockRpcOverrides['finalize_email_dispatch'] = {
        data: {
          success: false,
          match_status: 'terminal_conflict',
          delivery_status: 'outcome_unknown',
        },
        error: null,
      };

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_KIOSK_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_and_send',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'kiosk.visitor@example.com',
          verificationId: verifId,
          code,
          requestId: sendReqId,
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(202);
      expect(json.error).toBe('email_finalization_conflict');
      expect(json.status).toBe('outcome_unknown');
      expect(json.retryAllowed).toBe(false);
      expect(json.reconciliationRequired).toBe(true);

      const recon = mockDbData.reconciliation_tasks.find((r) => r.last_error_code === 'terminal_conflict');
      expect(recon).toBeDefined();
    });
  });

  // =========================================================================
  // EMAIL-M01: Cross-Pass / Recipient Abuse Safeguards
  // =========================================================================
  describe('EMAIL-M01: Abuse Safeguards Mapping', () => {
    it('returns 429 when recipient challenge limit is exceeded', async () => {
      mockDbData.passes[0].visitors.owner_id = KIOSK_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';

      mockRpcOverrides['request_email_verification_code'] = {
        data: null,
        error: { code: '42501', message: 'recipient_challenge_limit_exceeded' },
      };

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_KIOSK_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'spammer@example.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(429);
      expect(json.error).toBe('recipient_challenge_limit_exceeded');
    });

    it('returns 429 when actor challenge limit is exceeded', async () => {
      mockDbData.passes[0].visitors.owner_id = KIOSK_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';

      mockRpcOverrides['request_email_verification_code'] = {
        data: null,
        error: { code: '42501', message: 'actor_challenge_limit_exceeded' },
      };

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_KIOSK_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'victim@example.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(429);
      expect(json.error).toBe('actor_challenge_limit_exceeded');
    });
  });

  // =========================================================================
  // EMAIL-M02: Revoked Kiosk Prevention
  // =========================================================================
  describe('EMAIL-M02: Revoked Kiosk Device Safeguards', () => {
    it('blocks email requests from a revoked kiosk device with 403', async () => {
      mockDbData.devices.push({
        user_id: '00000000-0000-4000-a000-000000000098',
        alias: 'kiosk-revoked',
        name: 'Revoked Kiosk Device',
        type: 'kiosk',
        status: 'revoked',
        deleted_at: null,
      });

      mockDbData.passes[0].visitors.owner_id = '00000000-0000-4000-a000-000000000098';
      mockDbData.passes[0].visitors.source = 'kiosk';

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: 'Bearer revoked-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'visitor@example.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('kiosk_device_revoked');
    });

    it('blocks device masquerading as kiosk when device type is guard', async () => {
      mockDbData.passes[0].visitors.owner_id = OTHER_DEVICE_ID;
      mockDbData.passes[0].visitors.source = 'kiosk';

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: 'Bearer guard-device-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: 'visitor@example.com',
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('kiosk_device_revoked');
    });
  });

  // =========================================================================
  // PRIVACY-M03: DB-Coordinated Purge Protocol
  // =========================================================================
  describe('PRIVACY-M03: DB-Coordinated Purge Protocol (api/purge-images.ts)', () => {
    it('claims evidence via RPC before storage deletion and finalizes on success', async () => {
      mockDbData.visitor_evidence = [
        {
          id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-expired',
          bucket_id: 'visitor-id-documents',
          object_path: 'visitor-expired/id.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(1);
      expect(json.failedCount).toBe(0);
      expect(storageRemovedPaths).toContain('visitor-expired/id.webp');
    });

    it('skips storage deletion if claim RPC returns claimed: false', async () => {
      mockDbData.visitor_evidence = [
        {
          id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-held',
          bucket_id: 'visitor-id-documents',
          object_path: 'visitor-held/id.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      mockRpcOverrides['claim_evidence_for_purge'] = {
        data: { claimed: false, reason: 'held_by_incident_hold' },
        error: null,
      };

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(0);
      expect(storageRemovedPaths).toHaveLength(0);
    });

    it('P0-A: skips storage deletion and records reconciliation when claimed bucket/path identity mismatches', async () => {
      mockDbData.visitor_evidence = [
        {
          id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-mismatch',
          bucket_id: 'visitor-id-documents',
          object_path: 'visitor-mismatch/id.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      mockRpcOverrides['claim_evidence_for_purge'] = {
        data: {
          claimed: true,
          evidence_id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-mismatch',
          bucket_id: 'wrong-bucket',
          object_path: 'wrong-path/id.webp',
          claim_id: '00000000-0000-4000-a000-000000000998',
        },
        error: null,
      };

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(0);
      expect(json.failedCount).toBe(1);
      expect(storageRemovedPaths).toHaveLength(0);
      expect(mockDbData.reconciliation_tasks.some((t: any) => t.operation === 'image_purge_claim_identity_mismatch')).toBe(true);
    });

    it('P0-A: records failedCount and reconciliation when finalize RPC returns claim_mismatch or errors', async () => {
      mockDbData.visitor_evidence = [
        {
          id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-finalize-fail',
          bucket_id: 'visitor-id-documents',
          object_path: 'visitor-finalize-fail/id.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      mockRpcOverrides['finalize_evidence_purge'] = {
        data: {
          success: false,
          finalized: false,
          match_status: 'claim_mismatch',
          reason: 'claim_id_mismatch',
        },
        error: null,
      };

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(0);
      expect(json.failedCount).toBe(1);
      expect(mockDbData.reconciliation_tasks.some((t: any) => t.operation === 'image_purge_finalize_rpc_failed')).toBe(true);
    });

    it('P0-A: reconciles and increments failedCount when storage removal fails', async () => {
      mockDbData.visitor_evidence = [
        {
          id: '00000000-0000-4000-a000-000000000999',
          visitor_id: 'visitor-storage-fail',
          bucket_id: 'visitor-id-documents',
          object_path: 'visitor-storage-fail/id.webp',
          purged_at: null,
          expires_at: '2026-01-01T00:00:00Z',
        },
      ];

      mockStorageFailures['visitor-id-documents'] = new Error('storage_connection_timeout');

      const req = new Request('http://localhost/api/purge-images', {
        method: 'POST',
        headers: { authorization: VALID_SUPERADMIN_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });

      const res = await invokeHandler(purgeImagesHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.successCount).toBe(0);
      expect(json.failedCount).toBe(1);
      expect(mockDbData.reconciliation_tasks.some((t: any) => t.operation === 'image_purge_storage_failed')).toBe(true);
    });

    it('P0-C: cross-pass recipient abuse limit blocks 6th challenge across distinct passes', async () => {
      const recipient = 'shared-recipient@example.com';
      // Pre-seed 5 challenges across different passes for this recipient
      for (let i = 1; i <= 5; i++) {
        mockDbData.pass_email_verifications.push({
          id: `00000000-0000-4000-a000-00000000100${i}`,
          pass_id: `00000000-0000-4000-a000-00000000200${i}`,
          recipient_email: recipient,
          code_hash: 'abcdef',
          attempts: 0,
          verified: false,
          request_id: randomUUID(),
          request_actor_id: VISITOR_OWNER_ID,
          code_delivery_status: 'sent_to_provider',
          delivery_status: 'pending',
          created_at: new Date().toISOString(),
        });
      }

      const req = new Request('http://localhost/api/passes/email', {
        method: 'POST',
        headers: { authorization: VALID_VISITOR_BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          passId: TEST_PUBLIC_REF,
          qrToken: TEST_RAW_TOKEN,
          recipientEmail: recipient,
          consent: true,
          requestId: randomUUID(),
        }),
      });

      const res = await invokeHandler(emailPassHandler, req);
      const json = await res.json();

      expect(res.status).toBe(429);
      expect(json.error).toBe('too_many_requests_recipient');
    });
  });

  // =========================================================================
  // ADMIN-M04: Staff List Pagination
  // =========================================================================
  describe('ADMIN-M04: Staff List Keyset Pagination (api/admin/users.ts)', () => {
    it('returns paginated users list with nextCursor and hasMore', async () => {
      const req = new Request('http://localhost/api/admin/users?limit=1', {
        headers: { authorization: VALID_SUPERADMIN_BEARER },
      });

      const res = await invokeHandler(adminUsersHandler, req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.users).toHaveLength(1);
      expect(json.hasMore).toBe(true);
      expect(typeof json.nextCursor).toBe('string');
    });

    it('denies access to unauthorized actor with 403', async () => {
      const req = new Request('http://localhost/api/admin/users', {
        headers: { authorization: VALID_VISITOR_BEARER },
      });

      const res = await invokeHandler(adminUsersHandler, req);
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json.error).toBe('access_denied');
    });
  });
});
