import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateTemporaryPassword, handleRequest } from '../server/routes/admin/offices';
import { getPasswordPolicyError, passwordSchema } from '../server/password-policy';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

describe('Admin Dedicated Office Account Provisioning & Governance (Phase A & F)', () => {
  const ADMIN_ID = '11111111-1111-4000-a000-000000000001';
  const SUPERADMIN_ID = '22222222-2222-4000-a000-000000000002';
  const OFFICE_STAFF_ID = '33333333-3333-4000-a000-000000000003';
  const TARGET_OFFICE_ID = '44444444-4444-4000-a000-000000000004';
  const OTHER_OFFICE_ID = '55555555-5555-4000-a000-000000000005';
  const TARGET_USER_ID = '66666666-6666-4000-a000-000000000006';

  let mockDbData: {
    offices: any[];
    staff_profiles: any[];
    office_staff_assignments: any[];
    audit_events: any[];
  };

  let createdAuthUsers: any[] = [];
  let deletedAuthUsers: string[] = [];
  let updatedAuthUsers: Record<string, any> = {};
  let rpcFailures: Record<string, boolean> = {};

  beforeEach(() => {
    createdAuthUsers = [];
    deletedAuthUsers = [];
    updatedAuthUsers = {};
    rpcFailures = {};

    mockDbData = {
      offices: [
        {
          id: TARGET_OFFICE_ID,
          name: 'Office of the University Registrar',
          description: 'Academic records',
          active: true,
          verified: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: OTHER_OFFICE_ID,
          name: 'Accounting Office',
          description: 'Student finances',
          active: false,
          verified: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      staff_profiles: [
        {
          user_id: ADMIN_ID,
          display_name: 'Admin User',
          role: 'admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          user_id: SUPERADMIN_ID,
          display_name: 'Super Admin User',
          role: 'superadmin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          user_id: OFFICE_STAFF_ID,
          display_name: 'Office Staff User',
          role: 'office_staff',
          active: true,
          must_change_password: false,
          privacy_accepted_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          user_id: TARGET_USER_ID,
          display_name: 'Registrar Staff Account',
          role: 'office_staff',
          active: true,
          must_change_password: true,
          created_at: new Date().toISOString(),
        },
      ],
      office_staff_assignments: [
        {
          user_id: TARGET_USER_ID,
          office_id: TARGET_OFFICE_ID,
          assigned_at: new Date().toISOString(),
          created_by: ADMIN_ID,
        },
      ],
      audit_events: [],
    };

    const mockAdmin: any = {
      auth: {
        getUser: vi.fn(async (token) => {
          const actorId = token ? token.replace('test-token-', '') : null;
          const found = mockDbData.staff_profiles.find((p) => p.user_id === actorId);
          if (!found) return { data: { user: null }, error: { message: 'User not found' } };
          return { data: { user: { id: actorId, email: `${found.role}@earist.edu.ph`, email_confirmed_at: new Date().toISOString() } }, error: null };
        }),
        admin: {
          getUserById: vi.fn(async (uid: string) => {
            const found = mockDbData.staff_profiles.find((p) => p.user_id === uid);
            if (!found) return { data: { user: null }, error: { message: 'User not found' } };
            return { data: { user: { id: uid, email: `${found.role}@earist.edu.ph` } }, error: null };
          }),
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
          createUser: vi.fn(async (params: any) => {
            const newUid = randomUUID();
            createdAuthUsers.push({ id: newUid, ...params });
            return { data: { user: { id: newUid, email: params.email } }, error: null };
          }),
          deleteUser: vi.fn(async (uid: string) => {
            deletedAuthUsers.push(uid);
            return { data: {}, error: null };
          }),
          updateUserById: vi.fn(async (uid: string, params: any) => {
            updatedAuthUsers[uid] = params;
            return { data: { user: { id: uid, ...params } }, error: null };
          }),
        },
      },
      from: vi.fn((tableName: string) => {
        let currentRows: any[] = (mockDbData as any)[tableName] || [];
        const queryBuilder: any = {
          select: vi.fn((cols?: string) => queryBuilder),
          order: vi.fn(() => queryBuilder),
          is: vi.fn(() => queryBuilder),
          in: vi.fn((field: string, values: any[]) => {
            currentRows = currentRows.filter((r) => values.includes(r[field]));
            return queryBuilder;
          }),
          eq: vi.fn((field: string, val: any) => {
            currentRows = currentRows.filter((r) => r[field] === val);
            return queryBuilder;
          }),
          maybeSingle: vi.fn(async () => ({
            data: currentRows.length > 0 ? { ...currentRows[0] } : null,
            error: null,
          })),
          single: vi.fn(async () => ({
            data: currentRows.length > 0 ? { ...currentRows[0] } : null,
            error: currentRows.length > 0 ? null : { message: 'Row not found' },
          })),
          insert: vi.fn((record: any) => {
            const item = Array.isArray(record) ? record[0] : record;
            currentRows.push(item);
            const builder: any = {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: item, error: null })),
                maybeSingle: vi.fn(async () => ({ data: item, error: null })),
              })),
              then: (resolve: any) => resolve({ data: item, error: null }),
            };
            return builder;
          }),
          update: vi.fn((updates: any) => ({
            eq: vi.fn((field: string, val: any) => ({
              select: () => ({
                single: async () => {
                  const idx = currentRows.findIndex((r) => r[field] === val);
                  if (idx >= 0) {
                    currentRows[idx] = { ...currentRows[idx], ...updates };
                    return { data: currentRows[idx], error: null };
                  }
                  return { data: null, error: { message: 'not found' } };
                },
              }),
            })),
          })),
          upsert: vi.fn(async (record: any) => {
            currentRows.push(record);
            return { data: record, error: null };
          }),
          delete: vi.fn(() => ({
            eq: vi.fn((field1: string, val1: any) => ({
              eq: vi.fn(async (field2: string, val2: any) => {
                const idx = currentRows.findIndex((r) => r[field1] === val1 && r[field2] === val2);
                if (idx >= 0) currentRows.splice(idx, 1);
                return { data: null, error: null };
              }),
            })),
          })),
        };
        queryBuilder.then = (onfulfilled: any) => Promise.resolve({ data: currentRows, error: null }).then(onfulfilled);
        return queryBuilder;
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (name: string, args: any) => {
          if (rpcFailures[name]) {
            return { data: null, error: { message: `Simulated failure for ${name}` } };
          }
          if (name === 'provision_office_staff_account') {
            mockDbData.staff_profiles.push({
              user_id: args.requested_user_id,
              display_name: args.requested_name,
              role: 'office_staff',
              active: true,
              must_change_password: true,
            });
            mockDbData.office_staff_assignments.push({
              user_id: args.requested_user_id,
              office_id: args.requested_office_id,
            });
            return { data: null, error: null };
          }
          if (name === 'reset_staff_temporary_password') {
            const staff = mockDbData.staff_profiles.find((p) => p.user_id === args.requested_user_id);
            if (staff) staff.must_change_password = true;
            return { data: null, error: null };
          }
          return { data: null, error: null };
        }),
      })),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, anon: mockAdmin });
  });

  function makeAuthRequest(actorId: string, method: string, path: string, body?: any): Request {
    return new Request(`https://egatepass.tech${path}`, {
      method,
      headers: {
        authorization: `Bearer test-token-${actorId}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Password Policy
  it('generates high-entropy temporary passwords meeting institutional password policy', () => {
    for (let i = 0; i < 20; i++) {
      const pwd = generateTemporaryPassword();
      expect(pwd.length).toBe(16);
      expect(getPasswordPolicyError(pwd)).toBeNull();
      const parseResult = passwordSchema.safeParse(pwd);
      expect(parseResult.success).toBe(true);
      expect(/[A-Z]/.test(pwd)).toBe(true);
      expect(/[a-z]/.test(pwd)).toBe(true);
      expect(/\d/.test(pwd)).toBe(true);
      expect(/[^A-Za-z0-9]/.test(pwd)).toBe(true);
    }
  });

  // Authorization Contract
  it('permits Admin to create a new office', async () => {
    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'create_office',
      name: 'College of Engineering Office',
      description: 'Department of computer engineering',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.office.name).toBe('College of Engineering Office');
  });

  it('permits Admin to provision dedicated office account with reachable email', async () => {
    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'provision_account',
      officeId: TARGET_OFFICE_ID,
      staffEmail: 'custodian.registrar@earist.edu.ph',
      displayName: 'Registrar Custodian Staff',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.email).toBe('custodian.registrar@earist.edu.ph');
    expect(body.temporaryPassword).toHaveLength(16);
    expect(body.mustChangePassword).toBe(true);

    expect(createdAuthUsers).toHaveLength(1);
    expect(createdAuthUsers[0].email).toBe('custodian.registrar@earist.edu.ph');
  });

  it('rejects office provisioning when staff email is missing or invalid', async () => {
    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'provision_account',
      officeId: TARGET_OFFICE_ID,
      staffEmail: 'invalid-email-format',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects office provisioning for inactive offices', async () => {
    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'provision_account',
      officeId: OTHER_OFFICE_ID, // inactive office
      staffEmail: 'accounting.staff@earist.edu.ph',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('office_inactive');
  });

  it('restricts office verification exclusively to Superadmin', async () => {
    // Admin attempting to verify office -> 403 Forbidden
    const adminReq = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'verify_office',
      officeId: TARGET_OFFICE_ID,
    });
    const adminRes = await handleRequest(adminReq);
    expect(adminRes.status).toBe(403);
    const adminBody = await adminRes.json();
    expect(adminBody.error).toBe('superadmin_required');

    // Superadmin attempting to verify office -> 200 OK
    const superReq = makeAuthRequest(SUPERADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'verify_office',
      officeId: TARGET_OFFICE_ID,
    });
    const superRes = await handleRequest(superReq);
    expect(superRes.status).toBe(200);
    const superBody = await superRes.json();
    expect(superBody.ok).toBe(true);
    expect(superBody.office.verified).toBe(true);
  });

  it('rejects Office Staff from creating offices or provisioning accounts', async () => {
    const req = makeAuthRequest(OFFICE_STAFF_ID, 'POST', '/api/admin/offices', {
      action: 'create_office',
      name: 'Unauthorized Office',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
  });

  // Compensation Behavior
  it('rolls back created Auth user and surfaces error if database provisioning fails', async () => {
    rpcFailures['provision_office_staff_account'] = true;

    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'provision_account',
      officeId: TARGET_OFFICE_ID,
      staffEmail: 'compensation.test@earist.edu.ph',
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('provisioning_failed');
    expect(body.temporaryPassword).toBeUndefined();

    // Verify Auth user creation was rolled back via deleteUser
    expect(createdAuthUsers).toHaveLength(1);
    expect(deletedAuthUsers).toContain(createdAuthUsers[0].id);
  });

  // Credential Reset Safety
  it('rejects credential reset if staff is not assigned to the specified office', async () => {
    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'reset_account_credentials',
      userId: TARGET_USER_ID,
      officeId: OTHER_OFFICE_ID, // mismatch office
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('staff_not_assigned_to_office');
  });

  it('fails closed and does not return password if reset_staff_temporary_password RPC fails', async () => {
    rpcFailures['reset_staff_temporary_password'] = true;

    const req = makeAuthRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'reset_account_credentials',
      userId: TARGET_USER_ID,
      officeId: TARGET_OFFICE_ID,
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('reset_enforcement_failed');
    expect(body.temporaryPassword).toBeUndefined();
  });
});
