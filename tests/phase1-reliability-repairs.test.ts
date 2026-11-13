// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { randomUUID } from 'node:crypto';
import adminOfficesHandler from '../server/routes/admin/offices.js';
import adminUsersHandler from '../server/routes/admin/users.js';
import createUserHandler from '../server/routes/system/create-user.js';
import updateUserHandler from '../server/routes/system/update-user.js';
import adminSettingsHandler from '../server/routes/admin/settings.js';
import updateSettingsHandler from '../server/routes/system/update-settings.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';

const uiAuthState: {
  uid: string | null;
  role: 'admin' | 'superadmin' | 'office_staff' | null;
} = {
  uid: '11111111-1111-4111-8111-111111111111',
  role: 'admin',
};

const toastCalls: {
  success: string[];
  error: string[];
  warning: string[];
  info: string[];
} = {
  success: [],
  error: [],
  warning: [],
  info: [],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    uid: uiAuthState.uid,
    role: uiAuthState.role,
    status: 'authenticated',
    userData: null,
    serviceStatus: 'available',
    serviceMessage: null,
    refresh: async () => {},
  }),
}));

vi.mock('@/services/auth', () => ({
  getAccessToken: async () => 'test-phase1-jwt',
}));

vi.mock('@/components/ChangePasswordCard', () => ({
  PasswordResetCard: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => { toastCalls.success.push(msg); },
    error: (msg: string) => { toastCalls.error.push(msg); },
    warning: (msg: string) => { toastCalls.warning.push(msg); },
    info: (msg: string) => { toastCalls.info.push(msg); },
  },
}));

import { AdminSettings } from '../src/pages/AdminSettings';
import { AdminUsers } from '../src/pages/AdminUsers';

function invokeRoute(mod: ((req: Request) => Promise<Response>) | { fetch: (req: Request) => Promise<Response> }, req: Request) {
  return typeof mod === 'function' ? mod(req) : mod.fetch(req);
}

function setReactInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Phase 1 Reliability Repairs — Comprehensive Regression Suite', () => {
  const SUPERADMIN_ID = '11111111-1111-4111-8111-000000000001';
  const ADMIN_ID = '11111111-1111-4111-8111-000000000002';
  const STAFF_1_ID = '11111111-1111-4111-8111-000000000003';
  const STAFF_INACTIVE_ID = '11111111-1111-4111-8111-000000000004';
  const STAFF_DECOMM_ID = '11111111-1111-4111-8111-000000000005';
  const GUARD_USER_ID = '11111111-1111-4111-8111-000000000006';
  const EXISTING_STRANGER_AUTH_ID = '11111111-1111-4111-8111-000000000007';

  const OFFICE_ACTIVE_1 = '22222222-2222-4222-8222-000000000001';
  const OFFICE_ACTIVE_2 = '22222222-2222-4222-8222-000000000002';
  const OFFICE_INACTIVE = '22222222-2222-4222-8222-000000000003';
  const OFFICE_MISSING = '22222222-2222-4222-8222-000000000099';

  describe('1. Backend Office Directory & Assignments Reliability', () => {
    let offices: any[];
    let staffProfiles: any[];
    let assignments: any[];
    let personnel: any[];
    let devices: any[];
    let authUsers: any[];
    let reconciliationTasks: any[];
    let auditEvents: any[];
    let observedSelectColumns: Record<string, string[]>;
    let injectedErrors: {
      officesSelect?: { message: string };
      assignmentsSelect?: { message: string };
      staffProfilesSelect?: { message: string };
      personnelSelect?: { message: string };
      replaceRpc?: { code?: string; message: string };
    };

    beforeEach(() => {
      observedSelectColumns = {};
      injectedErrors = {};
      reconciliationTasks = [];
      auditEvents = [];

      offices = [
        { id: OFFICE_ACTIVE_1, name: 'Admissions Office', description: 'Admissions', active: true, verified: true },
        { id: OFFICE_ACTIVE_2, name: 'Registrar Office', description: 'Records', active: true, verified: true },
        { id: OFFICE_INACTIVE, name: 'Closed Office', description: 'Closed', active: false, verified: false },
      ];

      staffProfiles = [
        {
          user_id: SUPERADMIN_ID,
          display_name: 'Superadmin',
          role: 'superadmin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: null,
        },
        {
          user_id: ADMIN_ID,
          display_name: 'Admin',
          role: 'admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: null,
        },
        {
          user_id: STAFF_1_ID,
          display_name: 'Office Custodian',
          role: 'office_staff',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: null,
        },
        {
          user_id: STAFF_INACTIVE_ID,
          display_name: 'Inactive Staff',
          role: 'office_staff',
          active: false,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: null,
        },
        {
          user_id: STAFF_DECOMM_ID,
          display_name: 'Decommissioned Staff',
          role: 'office_staff',
          active: false,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: '2026-11-05T00:00:00Z',
        },
        {
          user_id: GUARD_USER_ID,
          display_name: 'Guard User',
          role: 'guard',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-11-01T00:00:00Z',
          decommissioned_at: null,
        },
      ];

      assignments = [
        {
          id: 'assign-1',
          user_id: STAFF_1_ID,
          office_id: OFFICE_ACTIVE_1,
          created_at: '2026-11-01T00:00:00Z',
          created_by: SUPERADMIN_ID,
        },
      ];

      personnel = [
        { id: 'pers-1', office_id: OFFICE_ACTIVE_1, name: 'Dr. Santos', title: 'Director', active: true },
      ];
      devices = [];

      // Create >200 users across 2 pages so paginated Auth resolution is genuinely exercised
      authUsers = Array.from({ length: 205 }, (_, i) => ({
        id: i === 204 ? STAFF_1_ID : `99990000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        email: i === 204 ? 'custodian.page2@earist.edu.ph' : `filler${i}@earist.edu.ph`,
        email_confirmed_at: '2026-11-01T00:00:00Z',
        app_metadata: {},
      }));

      const mockAdmin: any = {
        auth: {
          resend: vi.fn(async () => ({ data: {}, error: null })),
          admin: {
            listUsers: vi.fn(async ({ page = 1, perPage = 200 }: { page?: number; perPage?: number }) => {
              const start = (page - 1) * perPage;
              return { data: { users: authUsers.slice(start, start + perPage) }, error: null };
            }),
            getUserById: vi.fn(async (uid: string) => {
              const found = authUsers.find((u) => u.id === uid) || null;
              return { data: { user: found }, error: found ? null : { message: 'not found' } };
            }),
            createUser: vi.fn(async ({ email, app_metadata }: any) => {
              const id = randomUUID();
              const u = { id, email, email_confirmed_at: null, app_metadata: app_metadata || {} };
              authUsers.push(u);
              return { data: { user: u }, error: null };
            }),
            deleteUser: vi.fn(async (uid: string) => {
              authUsers = authUsers.filter((u) => u.id !== uid);
              return { data: {}, error: null };
            }),
          },
        },
        from: vi.fn((table: string) => {
          const buildQuery = (rowsSource: () => any[], tableErr: () => any) => {
            let filters: Array<(r: any) => boolean> = [];
            const builder: any = {
              select: vi.fn((cols: string) => {
                observedSelectColumns[table] = observedSelectColumns[table] || [];
                observedSelectColumns[table].push(cols);
                return builder;
              }),
              order: vi.fn(() => builder),
              limit: vi.fn(() => builder),
              eq: vi.fn((field: string, val: any) => {
                filters.push((r) => r[field] === val);
                return builder;
              }),
              in: vi.fn((field: string, vals: any[]) => {
                filters.push((r) => vals.includes(r[field]));
                return builder;
              }),
              maybeSingle: vi.fn(async () => {
                const err = tableErr();
                if (err) return { data: null, error: err };
                const matched = rowsSource().filter((r) => filters.every((f) => f(r)));
                return { data: matched[0] || null, error: null };
              }),
              then: (resolve: any) => {
                const err = tableErr();
                if (err) return resolve({ data: null, error: err });
                const matched = rowsSource().filter((r) => filters.every((f) => f(r)));
                return resolve({ data: matched, error: null });
              },
            };
            return builder;
          };

          if (table === 'offices') {
            return buildQuery(() => offices, () => injectedErrors.officesSelect || null);
          }
          if (table === 'office_staff_assignments') {
            return {
              ...buildQuery(() => assignments, () => injectedErrors.assignmentsSelect || null),
              upsert: vi.fn(async (row: any, opts?: { onConflict?: string }) => {
                expect(row).toHaveProperty('created_by');
                expect(row).not.toHaveProperty('assigned_by');
                expect(opts?.onConflict).toBe('user_id,office_id');
                const idx = assignments.findIndex(
                  (a) => a.user_id === row.user_id && a.office_id === row.office_id
                );
                if (idx >= 0) assignments[idx] = { ...assignments[idx], ...row };
                else assignments.push({ id: randomUUID(), created_at: new Date().toISOString(), ...row });
                return { error: null };
              }),
              delete: vi.fn(() => {
                let filters: Array<(r: any) => boolean> = [];
                const delBuilder: any = {
                  eq: vi.fn((field: string, val: any) => {
                    filters.push((r) => r[field] === val);
                    return delBuilder;
                  }),
                  then: (resolve: any) => {
                    assignments = assignments.filter((r) => !filters.every((f) => f(r)));
                    return resolve({ error: null });
                  },
                };
                return delBuilder;
              }),
            };
          }
          if (table === 'staff_profiles') {
            return buildQuery(() => staffProfiles, () => injectedErrors.staffProfilesSelect || null);
          }
          if (table === 'office_personnel') {
            return buildQuery(() => personnel, () => injectedErrors.personnelSelect || null);
          }
          if (table === 'devices') {
            return buildQuery(() => devices, () => null);
          }
          if (table === 'reconciliation_tasks') {
            return {
              insert: vi.fn(async (row: any) => {
                reconciliationTasks.push(row);
                return { error: null };
              }),
            };
          }
          if (table === 'audit_events') {
            return {
              insert: vi.fn(async (row: any) => {
                auditEvents.push(row);
                return { error: null };
              }),
            };
          }
          return {} as any;
        }),
        schema: vi.fn(() => ({
          rpc: vi.fn(async (fn: string, args: any) => {
            if (fn === 'create_staff_profile') {
              staffProfiles.push({
                user_id: args.requested_user_id,
                display_name: args.requested_name,
                role: args.requested_role,
                active: args.requested_active,
                must_change_password: true,
                privacy_accepted_at: null,
                decommissioned_at: null,
              });
              return { data: null, error: null };
            }
            if (fn === 'replace_staff_office_assignments') {
              if (injectedErrors.replaceRpc) {
                return { data: null, error: injectedErrors.replaceRpc };
              }
              const target = staffProfiles.find((s) => s.user_id === args.requested_user_id);
              if (!target) return { data: null, error: { code: 'P0002', message: 'staff user not found' } };
              if (target.decommissioned_at) return { data: null, error: { code: 'P0004', message: 'target_decommissioned' } };
              const ids: string[] = Array.isArray(args.requested_office_ids)
                ? [...new Set<string>(args.requested_office_ids)]
                : [];
              if (ids.length > 0) {
                if (!target.active) return { data: null, error: { code: '42501', message: 'staff account is inactive' } };
                if (target.role !== 'office_staff') return { data: null, error: { code: '22023', message: 'office assignments require office_staff role' } };
                const found = offices.filter((o) => ids.includes(o.id));
                if (found.length !== ids.length) return { data: null, error: { code: 'P0002', message: 'one or more office ids do not exist' } };
                const inactiveNew = found.filter(
                  (o) => !o.active && !assignments.some((a) => a.user_id === args.requested_user_id && a.office_id === o.id)
                );
                if (inactiveNew.length > 0) return { data: null, error: { code: '42501', message: 'office is inactive' } };
              }
              assignments = assignments.filter((a) => a.user_id !== args.requested_user_id);
              for (const oid of ids) {
                assignments.push({
                  id: randomUUID(),
                  user_id: args.requested_user_id,
                  office_id: oid,
                  created_at: new Date().toISOString(),
                  created_by: args.requested_actor_id,
                });
              }
              return { data: { userId: args.requested_user_id, officeIds: ids }, error: null };
            }
            return { data: null, error: null };
          }),
        })),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        anon: {} as any,
      });
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: SUPERADMIN_ID,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('GET /api/admin/offices queries only real columns, resolves page-2 Auth emails, and isolates optional office_personnel errors', async () => {
      injectedErrors.personnelSelect = { message: 'relation office_personnel timeout' };

      const res = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices?withPersonnel=true', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.personnelUnavailable).toBe(true);
      expect(body.warnings).toContain('personnel_unavailable');

      // Never selects missing assigned_at column
      const assignSelects = observedSelectColumns['office_staff_assignments'] || [];
      expect(assignSelects.length).toBeGreaterThan(0);
      expect(assignSelects.every((c) => !c.includes('assigned_at'))).toBe(true);

      const admissions = body.offices.find((o: any) => o.id === OFFICE_ACTIVE_1);
      expect(admissions.dedicatedAccount.email).toBe('custodian.page2@earist.edu.ph');
    });

    it('GET /api/admin/offices surfaces 503 errors when required assignments or staff_profiles queries fail', async () => {
      injectedErrors.assignmentsSelect = { message: 'db read failure' };
      const res1 = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        })
      );
      expect(res1.status).toBe(503);
      expect((await res1.json()).error).toBe('office_assignments_load_failed');

      injectedErrors.assignmentsSelect = undefined;
      injectedErrors.staffProfilesSelect = { message: 'profiles unavailable' };
      const res2 = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        })
      );
      expect(res2.status).toBe(503);
      expect((await res2.json()).error).toBe('staff_profiles_load_failed');
    });

    it('assign_staff rejects inactive/decommissioned/wrong-role staff & inactive office, uses created_by, and remove_staff removes only target relationship', async () => {
      const inactiveStaffRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign_staff', userId: STAFF_INACTIVE_ID, officeId: OFFICE_ACTIVE_1 }),
        })
      );
      expect(inactiveStaffRes.status).toBe(409);
      expect((await inactiveStaffRes.json()).error).toBe('staff_inactive');

      const decommStaffRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign_staff', userId: STAFF_DECOMM_ID, officeId: OFFICE_ACTIVE_1 }),
        })
      );
      expect(decommStaffRes.status).toBe(409);
      expect((await decommStaffRes.json()).error).toBe('target_decommissioned');

      const guardRoleRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign_staff', userId: GUARD_USER_ID, officeId: OFFICE_ACTIVE_1 }),
        })
      );
      expect(guardRoleRes.status).toBe(400);
      expect((await guardRoleRes.json()).error).toBe('invalid_staff_role');

      const inactiveOfficeRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign_staff', userId: STAFF_1_ID, officeId: OFFICE_INACTIVE }),
        })
      );
      expect(inactiveOfficeRes.status).toBe(400);
      expect((await inactiveOfficeRes.json()).error).toBe('office_inactive');

      // Assign STAFF_1_ID to OFFICE_ACTIVE_2 too, then remove only OFFICE_ACTIVE_1
      const assignRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'assign_staff', userId: STAFF_1_ID, officeId: OFFICE_ACTIVE_2 }),
        })
      );
      expect(assignRes.status).toBe(200);
      expect(assignments.some((a) => a.user_id === STAFF_1_ID && a.office_id === OFFICE_ACTIVE_2 && a.created_by === SUPERADMIN_ID)).toBe(true);

      const removeRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove_staff', userId: STAFF_1_ID, officeId: OFFICE_ACTIVE_1 }),
        })
      );
      expect(removeRes.status).toBe(200);
      expect(assignments.map((a) => a.office_id)).toEqual([OFFICE_ACTIVE_2]);
    });

    it('bulk replacement in /api/system/update-user preserves original assignments when RPC fails and /api/system/create-user validates offices before creating Auth user', async () => {
      const before = JSON.stringify(assignments);
      const failBulkRes = await invokeRoute(
        updateUserHandler,
        new Request('http://localhost/api/system/update-user', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUid: STAFF_1_ID, officeIds: [OFFICE_ACTIVE_2, OFFICE_MISSING] }),
        })
      );
      expect(failBulkRes.status).toBe(400);
      expect((await failBulkRes.json()).error).toBe('invalid_office_id');
      expect(JSON.stringify(assignments)).toBe(before);

      // Empty assignments return valid empty result in /api/admin/users
      assignments = [];
      const usersRes = await invokeRoute(
        adminUsersHandler,
        new Request('http://localhost/api/admin/users?limit=10', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        })
      );
      expect(usersRes.status).toBe(200);
      const usersJson = await usersRes.json();
      const s1 = usersJson.users.find((u: any) => u.uid === STAFF_1_ID);
      expect(s1.assignedOfficeIds).toEqual([]);

      // create-user rejects non-admin role (office_staff) BEFORE calling auth.admin.createUser
      const { admin } = supabaseModule.getServerSupabaseClients();
      const preCreateCalls = (admin.auth.admin.createUser as any).mock.calls.length;
      const createBadRes = await invokeRoute(
        createUserHandler,
        new Request('http://localhost/api/system/create-user', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'New Custodian',
            email: 'new.custodian@earist.edu.ph',
            password: 'ValidPassword123!',
            role: 'office_staff',
          }),
        })
      );
      expect(createBadRes.status).toBe(400);
      expect((await createBadRes.json()).error).toBe('invalid_request');
      expect((admin.auth.admin.createUser as any).mock.calls.length).toBe(preCreateCalls);
    });
  });

  describe('2. Backend Provisioning Idempotency, Conflict Guard & Compensation', () => {
    const OFFICE_ID = '33333333-3333-4333-8333-000000000001';
    const ACTOR_ID = '33333333-3333-4333-8333-000000000002';
    const OTHER_AUTH_ID = '33333333-3333-4333-8333-000000000003';
    const OP_ID = '44444444-4444-4444-8444-000000000001';

    let authUsers: any[];
    let staffProfiles: any[];
    let assignments: any[];
    let devices: any[];
    let ops: Record<string, any>;
    let reconciliations: any[];
    let failDbProvision: boolean;
    let failDeleteUser: boolean;
    let failResendEmail: boolean;

    beforeEach(() => {
      authUsers = [
        {
          id: OTHER_AUTH_ID,
          email: 'existing.admin@earist.edu.ph',
          email_confirmed_at: '2026-11-01T00:00:00Z',
          app_metadata: {},
        },
      ];
      staffProfiles = [
        { user_id: ACTOR_ID, display_name: 'Admin Actor', role: 'admin', active: true, must_change_password: false },
        { user_id: OTHER_AUTH_ID, display_name: 'Real Admin', role: 'admin', active: true, must_change_password: false },
      ];
      assignments = [];
      devices = [];
      ops = {};
      reconciliations = [];
      failDbProvision = false;
      failDeleteUser = false;
      failResendEmail = false;

      const mockAdmin: any = {
        auth: {
          resend: vi.fn(async ({ email }: { email: string }) => {
            if (failResendEmail) return { data: null, error: { message: 'Resend API restricted' } };
            return { data: { email }, error: null };
          }),
          admin: {
            listUsers: vi.fn(async ({ page = 1, perPage = 200 }: any) => ({
              data: { users: page === 1 ? authUsers.slice(0, perPage) : [] },
              error: null,
            })),
            getUserById: vi.fn(async (uid: string) => ({
              data: { user: authUsers.find((u) => u.id === uid) || null },
              error: null,
            })),
            createUser: vi.fn(async ({ email, app_metadata }: any) => {
              const dup = authUsers.find((u) => u.email.toLowerCase() === email.toLowerCase());
              if (dup) {
                return { data: { user: null }, error: { message: 'User already registered', code: 'email_exists' } };
              }
              const id = randomUUID();
              const u = { id, email, email_confirmed_at: null, app_metadata };
              authUsers.push(u);
              return { data: { user: u }, error: null };
            }),
            deleteUser: vi.fn(async (uid: string) => {
              if (failDeleteUser) return { error: { message: 'Auth service delete timeout' } };
              authUsers = authUsers.filter((u) => u.id !== uid);
              return { error: null };
            }),
          },
        },
        from: vi.fn((table: string) => {
          const query = (rows: () => any[]) => {
            let filters: Array<(r: any) => boolean> = [];
            const b: any = {
              select: vi.fn(() => b),
              eq: vi.fn((f: string, v: any) => { filters.push((r) => r[f] === v); return b; }),
              maybeSingle: vi.fn(async () => ({
                data: rows().find((r) => filters.every((fn) => fn(r))) || null,
                error: null,
              })),
            };
            return b;
          };
          if (table === 'offices') {
            return query(() => [{ id: OFFICE_ID, name: 'Guidance Office', active: true }]);
          }
          if (table === 'staff_profiles') return query(() => staffProfiles);
          if (table === 'devices') return query(() => devices);
          if (table === 'reconciliation_tasks') {
            return {
              insert: vi.fn(async (row: any) => {
                reconciliations.push(row);
                return { error: null };
              }),
            };
          }
          return {} as any;
        }),
        schema: vi.fn(() => ({
          rpc: vi.fn(async (fn: string, args: any) => {
            if (fn === 'claim_office_provisioning_operation') {
              const existing = ops[args.requested_operation_id];
              if (existing) {
                if (existing.office_id !== args.requested_office_id || existing.target_email !== args.requested_email) {
                  return { data: { action: 'operation_mismatch', operation: existing }, error: null };
                }
                if (existing.status === 'completed') {
                  return { data: { action: 'replay_completed', operation: existing }, error: null };
                }
                if (existing.status === 'compensation_failed') {
                  return { data: { action: 'compensation_failed', operation: existing }, error: null };
                }
                if (existing.status === 'started' || existing.status === 'auth_created') {
                  return { data: { action: 'resume_incomplete', operation: existing }, error: null };
                }
              }
              const row = {
                operation_id: args.requested_operation_id,
                office_id: args.requested_office_id,
                actor_id: args.requested_actor_id,
                target_email: args.requested_email,
                display_name: args.requested_display_name,
                auth_user_id: null,
                status: 'started',
                email_delivery_status: 'pending',
              };
              ops[args.requested_operation_id] = row;
              return { data: { action: 'proceed', operation: row }, error: null };
            }
            if (fn === 'update_office_provisioning_operation') {
              const row = ops[args.requested_operation_id];
              if (!row) return { data: null, error: { code: 'P0002', message: 'not found' } };
              if (args.requested_auth_user_id) row.auth_user_id = args.requested_auth_user_id;
              if (args.requested_status) row.status = args.requested_status;
              if (args.requested_email_delivery_status) row.email_delivery_status = args.requested_email_delivery_status;
              if (args.requested_reconciliation_recorded !== null) row.reconciliation_recorded = args.requested_reconciliation_recorded;
              return { data: row, error: null };
            }
            if (fn === 'provision_office_staff_account') {
              if (failDbProvision) return { data: null, error: { code: '23514', message: 'simulated db provision failure' } };
              if (!staffProfiles.some((s) => s.user_id === args.requested_user_id)) {
                staffProfiles.push({
                  user_id: args.requested_user_id,
                  display_name: args.requested_name,
                  role: 'office_staff',
                  active: true,
                  must_change_password: true,
                });
              }
              if (!assignments.some((a) => a.user_id === args.requested_user_id && a.office_id === args.requested_office_id)) {
                assignments.push({ user_id: args.requested_user_id, office_id: args.requested_office_id });
              }
              if (ops[args.requested_request_id]) {
                ops[args.requested_request_id].status = 'completed';
                ops[args.requested_request_id].auth_user_id = args.requested_user_id;
              }
              return { data: null, error: null };
            }
            return { data: null, error: null };
          }),
        })),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: {} as any });
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: ACTOR_ID,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('creates one account on initial request, replays without duplicating or returning plaintext password, and recovers lost response safely', async () => {
      const req1 = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'provision_account',
          officeId: OFFICE_ID,
          staffEmail: 'guidance@earist.edu.ph',
          operationId: OP_ID,
        }),
      });
      const res1 = await adminOfficesHandler.fetch(req1);
      expect(res1.status).toBe(200);
      const b1 = await res1.json();
      expect(b1.temporaryPasswordIssued).toBe(true);
      expect(typeof b1.temporaryPassword).toBe('string');
      expect(authUsers.filter((u) => u.email === 'guidance@earist.edu.ph').length).toBe(1);

      // Replay with same operationId returns 200 replayed without password replay
      const res2 = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'guidance@earist.edu.ph',
            operationId: OP_ID,
          }),
        })
      );
      expect(res2.status).toBe(200);
      const b2 = await res2.json();
      expect(b2.replayed).toBe(true);
      expect(b2.temporaryPasswordIssued).toBe(false);
      expect(b2.temporaryPassword).toBeUndefined();
      expect(authUsers.filter((u) => u.email === 'guidance@earist.edu.ph').length).toBe(1);

      // Simulate crashed attempt right after auth creation for another opId (status=auth_created, no profile yet)
      const OP_RESUME = '44444444-4444-4444-8444-000000000002';
      const partialAuthId = randomUUID();
      authUsers.push({
        id: partialAuthId,
        email: 'lost.response@earist.edu.ph',
        email_confirmed_at: null,
        app_metadata: {
          provisioning_source: 'office_account',
          provisioning_operation_id: OP_RESUME,
          provisioning_office_id: OFFICE_ID,
        },
      });
      ops[OP_RESUME] = {
        operation_id: OP_RESUME,
        office_id: OFFICE_ID,
        actor_id: ACTOR_ID,
        target_email: 'lost.response@earist.edu.ph',
        display_name: 'Guidance Resume',
        auth_user_id: partialAuthId,
        status: 'auth_created',
        email_delivery_status: 'pending',
      };
      const resResume = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'lost.response@earist.edu.ph',
            operationId: OP_RESUME,
          }),
        })
      );
      expect(resResume.status).toBe(200);
      const bResume = await resResume.json();
      expect(bResume.userId).toBe(partialAuthId);
      expect(bResume.temporaryPasswordIssued).toBe(false);
      expect(bResume.temporaryPassword).toBeUndefined();
      expect(assignments.some((a) => a.user_id === partialAuthId && a.office_id === OFFICE_ID)).toBe(true);
    });

    it('never adopts or deletes an unrelated existing Auth user (409 existing_account_conflict)', async () => {
      const res = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'existing.admin@earist.edu.ph',
            operationId: OP_ID,
          }),
        })
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('existing_account_conflict');
      expect(authUsers.some((u) => u.id === OTHER_AUTH_ID)).toBe(true);
      expect(assignments.some((a) => a.user_id === OTHER_AUTH_ID)).toBe(false);
    });

    it('distinguishes clean rollback compensation from compensation failure and preserves provisioned accounts when verification email fails', async () => {
      // 1. Clean compensation when DB fails
      failDbProvision = true;
      const failRoll = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'rollback.ok@earist.edu.ph',
            operationId: OP_ID,
          }),
        })
      );
      expect(failRoll.status).toBe(500);
      expect((await failRoll.json()).compensationStatus).toBe('rolled_back');
      expect(authUsers.some((u) => u.email === 'rollback.ok@earist.edu.ph')).toBe(false);

      // 2. Compensation failure records reconciliation
      const OP_COMP_FAIL = '44444444-4444-4444-8444-000000000003';
      failDeleteUser = true;
      const compFailRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'rollback.broken@earist.edu.ph',
            operationId: OP_COMP_FAIL,
          }),
        })
      );
      expect(compFailRes.status).toBe(500);
      const compFailBody = await compFailRes.json();
      expect(compFailBody.error).toBe('provisioning_compensation_failed');
      expect(compFailBody.reconciliationRequired).toBe(true);
      expect(reconciliations.some((r) => r.operation === 'office.provision_compensation_failed')).toBe(true);

      // 3. Verification email failure preserves provisioned account and warns honestly
      failDbProvision = false;
      failDeleteUser = false;
      failResendEmail = true;
      const OP_EMAIL_FAIL = '44444444-4444-4444-8444-000000000004';
      const emailFailRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'provision_account',
            officeId: OFFICE_ID,
            staffEmail: 'email.failed@earist.edu.ph',
            operationId: OP_EMAIL_FAIL,
          }),
        })
      );
      expect(emailFailRes.status).toBe(200);
      const emailFailBody = await emailFailRes.json();
      expect(emailFailBody.outcome).toBe('provisioned_email_failed');
      expect(emailFailBody.verificationEmailSent).toBe(false);
      expect(emailFailBody.staffAccountSummary.email).toBe('email.failed@earist.edu.ph');
      expect(reconciliations.some((r) => r.operation === 'office.verification_email_failed')).toBe(true);
    });

    it('rejects unauthenticated requests (401) and non-admin roles like office_staff or guard (403)', async () => {
      const noTokenRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'provision_account', officeId: OFFICE_ID, staffEmail: 'unauth@earist.edu.ph', operationId: OP_ID }),
        })
      );
      expect(noTokenRes.status).toBe(401);

      vi.spyOn(actorsModule, 'requireStaffActor').mockRejectedValueOnce(new actorsModule.HttpError(403, 'access_denied'));
      const officeStaffRes = await adminOfficesHandler.fetch(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer office-staff-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'provision_account', officeId: OFFICE_ID, staffEmail: 'forbidden@earist.edu.ph', operationId: OP_ID }),
        })
      );
      expect(officeStaffRes.status).toBe(403);
      expect(authUsers.some((u) => u.email === 'forbidden@earist.edu.ph')).toBe(false);
    });
  });

  describe('3. Backend Settings Contract & AdminSettings UI Regression', () => {
    let container: HTMLDivElement;
    let root: Root;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      toastCalls.success = [];
      toastCalls.error = [];
      toastCalls.warning = [];
      toastCalls.info = [];
    });

    afterEach(() => {
      act(() => { root.unmount(); });
      container.remove();
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('GET /api/admin/settings includes rejectionReasons and POST /api/update-settings returns actionable validation details', async () => {
      const settingsRow = {
        working_hours_start: '08:00',
        working_hours_end: '17:00',
        timezone: 'Asia/Manila',
        scheduling_days_ahead: 7,
        peak_mode: 'off',
        visit_purposes: [{ label: 'Meeting', requiresDetails: false, detailPrompt: '' }],
        rejection_reasons: ['Invalid ID', 'Expired Document'],
        visitor_instructions: ['Bring valid ID.'],
        image_retention_days: 7,
        photo_retention_days: 7,
        id_retention_days: 30,
        visitor_retention_days: 90,
        audit_retention_days: 365,
        reconciliation_retention_days: 90,
        automatic_cleanup_enabled: true,
        updated_at: '2026-11-11T00:00:00Z',
      };

      const mockAdmin: any = {
        from: vi.fn(() => {
          const b: any = {
            select: vi.fn(() => b),
            eq: vi.fn(() => b),
            maybeSingle: vi.fn(async () => ({ data: settingsRow, error: null })),
          };
          return b;
        }),
        schema: vi.fn(() => ({ rpc: vi.fn(async () => ({ data: settingsRow, error: null })) })),
      };
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: {} as any });
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({ id: ADMIN_ID, email: 'admin@earist.edu.ph', role: 'admin' });

      const getRes = await invokeRoute(
        adminSettingsHandler,
        new Request('http://localhost/api/admin/settings', { method: 'GET', headers: { Authorization: 'Bearer a' } })
      );
      expect(getRes.status).toBe(200);
      expect((await getRes.json()).rejectionReasons).toEqual(['Invalid ID', 'Expired Document']);

      const badSave = await updateSettingsHandler.fetch(
        new Request('http://localhost/api/system/update-settings', {
          method: 'POST',
          headers: { Authorization: 'Bearer a', 'Content-Type': 'application/json' },
          body: JSON.stringify({ peakMode: 'off', visitPurposes: settingsRow.visit_purposes }),
        })
      );
      expect(badSave.status).toBe(400);
      const badJson = await badSave.json();
      expect(badJson.error).toBe('invalid_settings');
      expect(badJson.message).toContain('rejectionReasons');
      expect(Array.isArray(badJson.details)).toBe(true);
    });

    it('AdminSettings preserves rejectionReasons in save payload for Admin & Superadmin, reloads after save, and surfaces validation details', async () => {
      uiAuthState.role = 'admin';
      uiAuthState.uid = ADMIN_ID;
      let capturedBodies: any[] = [];
      let getCount = 0;
      let nextPostShouldFail = false;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/admin/settings') {
          getCount += 1;
          return new Response(JSON.stringify({
            workingHours: { start: '08:00', end: '17:00', timezone: 'Asia/Manila' },
            peakMode: false,
            peakModeScope: 'off',
            rejectionReasons: ['Custom Campus Reason A', 'Custom Campus Reason B'],
            visitPurposes: [{ label: 'Consultation', requiresDetails: false, detailPrompt: '' }],
            visitorInstructions: ['Present your ID cleanly.'],
            photoRetentionDays: 7,
            idRetentionDays: 30,
            visitorRetentionDays: 90,
            auditRetentionDays: 365,
            reconciliationRetentionDays: 90,
            schedulingDaysAhead: 7,
            automaticCleanupEnabled: true,
          }), { status: 200 });
        }
        if (url === '/api/update-settings' && init?.method === 'POST') {
          capturedBodies.push(JSON.parse(String(init.body)));
          if (nextPostShouldFail) {
            return new Response(JSON.stringify({
              error: 'invalid_settings',
              details: [{ path: ['visitorInstructions'], message: 'Array must contain at most 8 items' }],
            }), { status: 400 });
          }
          return new Response(JSON.stringify({ success: true, atomic: true }), { status: 200 });
        }
        if (url === '/api/admin/calendar') {
          return new Response(JSON.stringify({ closures: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }) as typeof fetch;

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, { initialEntries: ['/admin/settings?tab=visitor_ux'] }, React.createElement(AdminSettings))
        );
        await new Promise((r) => setTimeout(r, 30));
      });

      const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Save Settings'))!;
      expect(saveBtn).toBeTruthy();

      await act(async () => {
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(capturedBodies[0].rejectionReasons).toEqual(['Custom Campus Reason A', 'Custom Campus Reason B']);
      expect(getCount).toBe(2); // Initial load + post-save authoritative reload
      expect(toastCalls.success).toContain('Settings saved successfully');

      // Surface detailed validation error inline instead of generic failure message
      nextPostShouldFail = true;
      await act(async () => {
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      const alertBanner = container.querySelector('[role="alert"]');
      expect(alertBanner?.textContent).toContain('visitorInstructions: Array must contain at most 8 items');

      // Superadmin save also includes rejectionReasons alongside security fields
      uiAuthState.role = 'superadmin';
      uiAuthState.uid = SUPERADMIN_ID;
      nextPostShouldFail = false;
      capturedBodies = [];
      await act(async () => {
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(capturedBodies[0].rejectionReasons).toEqual(['Custom Campus Reason A', 'Custom Campus Reason B']);
    });
  });

  describe('4. AdminUsers Provisioning Retry, Email Failure, Directory Refresh Failure & Assignments Error Banner', () => {
    let container: HTMLDivElement;
    let root: Root;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      uiAuthState.uid = ADMIN_ID;
      uiAuthState.role = 'admin';
      toastCalls.success = [];
      toastCalls.error = [];
      toastCalls.warning = [];
      toastCalls.info = [];
    });

    afterEach(() => {
      act(() => { root.unmount(); });
      container.remove();
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('retries with identical operationId preserving inputs, handles email warning + resend, and preserves created account if refresh GET fails', async () => {
      const capturedOps: string[] = [];
      let failFirstProvision = true;
      let failNextDirectoryGet = false;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices' && (!init?.method || init.method === 'GET')) {
          if (failNextDirectoryGet) {
            return new Response(JSON.stringify({ message: 'Transient directory read error' }), { status: 503 });
          }
          return new Response(JSON.stringify({
            offices: [
              { id: 'off-1', name: 'Registrar Office', description: 'Main', active: true, verified: true, dedicatedAccount: null },
            ],
          }), { status: 200 });
        }
        if (url === '/api/admin/offices' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          if (body.action === 'provision_account') {
            capturedOps.push(body.operationId);
            if (failFirstProvision) {
              failFirstProvision = false;
              return new Response(JSON.stringify({ error: 'provisioning_failed', message: 'Temporary DB timeout' }), { status: 500 });
            }
            failNextDirectoryGet = true;
            return new Response(JSON.stringify({
              ok: true,
              outcome: 'provisioned_email_failed',
              operationId: body.operationId,
              officeId: 'off-1',
              userId: 'new-staff-1',
              email: body.staffEmail,
              temporaryPassword: 'Temp#Password99',
              temporaryPasswordIssued: true,
              mustChangePassword: true,
              verificationEmailSent: false,
              warning: 'Verification email failed to deliver.',
              staffAccountSummary: {
                userId: 'new-staff-1',
                displayName: 'Registrar Office Staff',
                role: 'office_staff',
                active: true,
                mustChangePassword: true,
                email: body.staffEmail,
                emailConfirmed: false,
              },
            }), { status: 200 });
          }
          if (body.action === 'resend_verification_email') {
            return new Response(JSON.stringify({ ok: true, verificationEmailSent: true }), { status: 200 });
          }
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }) as typeof fetch;

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, { initialEntries: ['/admin/users?tab=directory'] }, React.createElement(AdminUsers))
        );
        await new Promise((r) => setTimeout(r, 30));
      });

      const provBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Provision Account'))!;
      await act(async () => {
        provBtn.click();
        await Promise.resolve();
      });

      const emailInput = document.body.querySelector('#provision-email') as HTMLInputElement;
      await act(async () => {
        setReactInputValue(emailInput, 'registrar@earist.edu.ph');
        await Promise.resolve();
      });

      const modalSubmit = () => Array.from(document.body.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('Provision Account')
      ).pop() as HTMLButtonElement;

      // First attempt fails -> modal stays open, input retained
      await act(async () => {
        modalSubmit().click();
        await new Promise((r) => setTimeout(r, 30));
      });
      expect((document.body.querySelector('#provision-email') as HTMLInputElement).value).toBe('registrar@earist.edu.ph');
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Temporary DB timeout');

      // Retry without changing email reuses EXACT same operationId
      await act(async () => {
        modalSubmit().click();
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(capturedOps.length).toBe(2);
      expect(capturedOps[0]).toBe(capturedOps[1]);

      // Verification email warning + Retry Verification Email visible in credentials modal
      expect(document.body.textContent).toContain('Verification email failed to deliver.');
      const resendBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Verification Email')
      );
      expect(resendBtn).toBeDefined();

      // Newly provisioned account remains visible in directory even though refresh GET returned 503
      expect(container.textContent).toContain('registrar@earist.edu.ph');
      expect(container.querySelector('[role="status"]')?.textContent).toContain('refreshing the office directory failed');
    });

    it('assignments tab surfaces office directory/users API failures cleanly instead of empty state', async () => {
      uiAuthState.role = 'superadmin';
      uiAuthState.uid = SUPERADMIN_ID;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices') {
          return new Response(JSON.stringify({ message: 'Failed to load office staff assignments.' }), { status: 503 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }) as typeof fetch;

      await act(async () => {
        root.render(
          React.createElement(MemoryRouter, { initialEntries: ['/admin/users?tab=assignments'] }, React.createElement(AdminUsers))
        );
        await new Promise((r) => setTimeout(r, 30));
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Failed to load office staff assignments.');
      expect(alert?.textContent).toContain('Retry');
    });
  });
});
