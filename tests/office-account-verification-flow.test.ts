import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleRequest } from '../server/routes/admin/offices.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { requireStaffActor, HttpError } from '../server/actors.js';

describe('Office Staff Email Verification Lifecycle & Password Reset Safety', () => {
  const ADMIN_ID = '11111111-1111-4000-a000-000000000001';
  const SUPERADMIN_ID = '22222222-2222-4000-a000-000000000002';
  const OFFICE_ID = '44444444-4444-4000-a000-000000000004';
  const OTHER_OFFICE_ID = '55555555-5555-4000-a000-000000000005';
  const STAFF_USER_ID = '66666666-6666-4000-a000-000000000006';

  let mockUsers: Record<string, any> = {};
  let mockStaffProfiles: Record<string, any> = {};
  let mockAssignments: any[] = [];
  let resendCalls: any[] = [];
  let reconciliationTasks: any[] = [];

  beforeEach(() => {
    resendCalls = [];
    reconciliationTasks = [];

    mockUsers = {
      [ADMIN_ID]: {
        id: ADMIN_ID,
        email: 'admin@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [SUPERADMIN_ID]: {
        id: SUPERADMIN_ID,
        email: 'superadmin@earist.edu.ph',
        email_confirmed_at: '2026-01-01T00:00:00Z',
        is_anonymous: false,
      },
      [STAFF_USER_ID]: {
        id: STAFF_USER_ID,
        email: 'registrar.staff@earist.edu.ph',
        email_confirmed_at: null, // initially unverified
        is_anonymous: false,
      },
    };

    mockStaffProfiles = {
      [ADMIN_ID]: {
        user_id: ADMIN_ID,
        display_name: 'Admin',
        role: 'admin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
      [SUPERADMIN_ID]: {
        user_id: SUPERADMIN_ID,
        display_name: 'Superadmin',
        role: 'superadmin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
      [STAFF_USER_ID]: {
        user_id: STAFF_USER_ID,
        display_name: 'Registrar Staff',
        role: 'office_staff',
        active: true,
        must_change_password: true,
        privacy_accepted_at: '2026-01-01T00:00:00Z',
      },
    };

    mockAssignments = [
      {
        user_id: STAFF_USER_ID,
        office_id: OFFICE_ID,
        created_by: ADMIN_ID,
      },
    ];

    const mockAdmin: any = {
      auth: {
        admin: {
          createUser: vi.fn(async (params: any) => {
            const id = 'new-user-' + Math.random().toString(36).slice(2, 9);
            mockUsers[id] = {
              id,
              email: params.email,
              email_confirmed_at: params.email_confirm ? new Date().toISOString() : null,
              password: params.password,
              is_anonymous: false,
            };
            return {
              data: { user: mockUsers[id] },
              error: null,
            };
          }),
          updateUserById: vi.fn(async (id: string, updates: any) => {
            if (!mockUsers[id]) return { data: null, error: new Error('user_not_found') };
            mockUsers[id] = { ...mockUsers[id], ...updates };
            return { data: { user: mockUsers[id] }, error: null };
          }),
          getUserById: vi.fn(async (id: string) => {
            if (!mockUsers[id]) return { data: null, error: new Error('user_not_found') };
            return { data: { user: mockUsers[id] }, error: null };
          }),
          deleteUser: vi.fn(async (id: string) => {
            delete mockUsers[id];
            return { data: {}, error: null };
          }),
          listUsers: vi.fn(async () => {
            return { data: { users: Object.values(mockUsers) }, error: null };
          }),
        },
        getUser: vi.fn(async (token: string) => {
          const userId = token.replace('bearer-', '');
          const user = mockUsers[userId];
          if (!user) return { data: { user: null }, error: new Error('invalid_token') };
          return { data: { user }, error: null };
        }),
        resend: vi.fn(async (params: any) => {
          resendCalls.push(params);
          return { data: {}, error: null };
        }),
      },
      from: vi.fn((table: string) => {
        return {
          select: vi.fn((cols: string) => ({
            eq: vi.fn((col: string, val: any) => ({
              eq: vi.fn((c2: string, v2: any) => ({
                maybeSingle: async () => {
                  if (table === 'office_staff_assignments') {
                    const match = mockAssignments.find((a) => a[col] === val && a[c2] === v2);
                    return { data: match || null, error: null };
                  }
                  return { data: null, error: null };
                },
              })),
              maybeSingle: async () => {
                if (table === 'offices') {
                  if (val === OFFICE_ID) {
                    return { data: { id: OFFICE_ID, name: 'Registrar', active: true }, error: null };
                  }
                  return { data: null, error: null };
                }
                if (table === 'staff_profiles') {
                  return { data: mockStaffProfiles[val] || null, error: null };
                }
                if (table === 'office_staff_assignments') {
                  const match = mockAssignments.find((a) => a[col] === val);
                  return { data: match || null, error: null };
                }
                return { data: null, error: null };
              },
            })),
            order: vi.fn(() => ({
              data: [
                { id: OFFICE_ID, name: 'Registrar', active: true, verified: false },
              ],
              error: null,
            })),
          })),
          insert: vi.fn(async (row: any) => {
            if (table === 'reconciliation_tasks') {
              reconciliationTasks.push(row);
            }
            return { error: null };
          }),
        };
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (name: string, args: any) => {
          if (name === 'provision_office_staff_account') {
            mockStaffProfiles[args.requested_user_id] = {
              user_id: args.requested_user_id,
              display_name: args.requested_name,
              role: 'office_staff',
              active: true,
              must_change_password: true,
              created_by: args.requested_actor_id,
            };
            mockAssignments.push({
              user_id: args.requested_user_id,
              office_id: args.requested_office_id,
              created_by: args.requested_actor_id,
            });
            return { data: null, error: null };
          }
          if (name === 'reset_staff_temporary_password') {
            if (mockStaffProfiles[args.requested_user_id]) {
              mockStaffProfiles[args.requested_user_id].must_change_password = true;
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        }),
      })),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, anon: mockAdmin });
  });

  function makeRequest(actorId: string, method: string, path: string, body?: any): Request {
    return new Request(`https://egatepass.tech${path}`, {
      method,
      headers: {
        authorization: `Bearer bearer-${actorId}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('proves office provisioning creates unconfirmed Auth user (email_confirm: false) and triggers email verification', async () => {
    const req = makeRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'provision_account',
      officeId: OFFICE_ID,
      staffEmail: 'new.staff@earist.edu.ph',
      displayName: 'New Office Staff',
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.email).toBe('new.staff@earist.edu.ph');
    expect(data.temporaryPassword).toBeDefined();
    expect(data.mustChangePassword).toBe(true);
    expect(data.emailConfirmed).toBe(false);
    expect(data.verificationEmailSent).toBe(true);

    // Verify Auth user in DB has email_confirmed_at = null
    const createdUser = mockUsers[data.userId];
    expect(createdUser).toBeDefined();
    expect(createdUser.email_confirmed_at).toBeNull();

    // Verify verification email was dispatched via admin.auth.resend
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]).toEqual({
      type: 'signup',
      email: 'new.staff@earist.edu.ph',
      options: { emailRedirectTo: 'https://egatepass.tech/auth/verified' },
    });
  });

  it('proves unverified staff account cannot access normal application functionality', async () => {
    const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

    // Attempting to authenticate unverified staff member throws email_verification_required
    await expect(requireStaffActor(admin, `bearer-${STAFF_USER_ID}`, ['office_staff'])).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'email_verification_required' })
    );
  });

  it('proves verified staff account with must_change_password=true is blocked from normal operational routes', async () => {
    const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

    // Confirm the staff email
    mockUsers[STAFF_USER_ID].email_confirmed_at = new Date().toISOString();

    // Still blocked from operational staff actions until first login password change is completed
    await expect(requireStaffActor(admin, `bearer-${STAFF_USER_ID}`, ['office_staff'])).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'access_denied' })
    );
  });

  it('proves completing password change clears must_change_password and grants full operational access', async () => {
    const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

    // Confirm email
    mockUsers[STAFF_USER_ID].email_confirmed_at = new Date().toISOString();
    // Complete first-login password change
    mockStaffProfiles[STAFF_USER_ID].must_change_password = false;

    const actor = await requireStaffActor(admin, `bearer-${STAFF_USER_ID}`, ['office_staff']);
    expect(actor).toEqual({
      id: STAFF_USER_ID,
      email: 'registrar.staff@earist.edu.ph',
      role: 'office_staff',
    });
  });

  it('allows Admin to resend verification email for unverified staff account', async () => {
    const req = makeRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'resend_verification_email',
      userId: STAFF_USER_ID,
      officeId: OFFICE_ID,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.email).toBe('registrar.staff@earist.edu.ph');
    expect(data.verificationEmailSent).toBe(true);

    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]).toEqual({
      type: 'signup',
      email: 'registrar.staff@earist.edu.ph',
      options: { emailRedirectTo: 'https://egatepass.tech/auth/verified' },
    });
  });

  it('rejects resend verification if the account email is already verified', async () => {
    mockUsers[STAFF_USER_ID].email_confirmed_at = new Date().toISOString();

    const req = makeRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'resend_verification_email',
      userId: STAFF_USER_ID,
      officeId: OFFICE_ID,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('email_already_verified');
  });

  it('rejects resend verification if staff is not assigned to the specified office', async () => {
    const req = makeRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'resend_verification_email',
      userId: STAFF_USER_ID,
      officeId: OTHER_OFFICE_ID,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('staff_not_assigned_to_office');
  });

  it('actively revokes temporary password from Auth if reset enforcement RPC fails', async () => {
    const { admin } = (await import('../server/supabase.js')).getServerSupabaseClients();

    // Force RPC to fail
    (admin.schema as any).mockReturnValue({
      rpc: vi.fn(async () => ({ data: null, error: new Error('db_constraint_violation') })),
    });

    const req = makeRequest(ADMIN_ID, 'POST', '/api/admin/offices', {
      action: 'reset_account_credentials',
      userId: STAFF_USER_ID,
      officeId: OFFICE_ID,
    });

    const res = await handleRequest(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('reset_enforcement_failed');
    expect(body.temporaryPassword).toBeUndefined();

    // Verify the Auth user's password was actively overwritten with an unguessable 64-char hex secret
    const updatedUser = mockUsers[STAFF_USER_ID];
    expect(updatedUser.password).toHaveLength(64);

    // Verify reconciliation task was recorded
    expect(reconciliationTasks).toHaveLength(1);
    expect(reconciliationTasks[0].operation).toBe('office.reset_enforcement_failed');
  });
});
