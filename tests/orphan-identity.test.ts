import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('FIX GROUP F: Orphan Auth Identity Conflict Detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects unprovisioned orphan auth identity and returns 409 existing_auth_identity_unprovisioned', async () => {
    const { default: handler } = await import('../server/routes/system/create-user.js');

    // Mock admin client
    const rpcSpy = vi.fn();
    const mockAdmin = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { code: 'email_exists', message: 'User already registered' },
          }),
          listUsers: vi.fn().mockResolvedValue({
            data: {
              users: [
                { id: 'orphan-uuid-1234', email: 'orphan.user@earist.edu.ph' },
              ],
            },
          }),
        },
        resend: vi.fn(),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // No staff_profiles or devices row
          })),
        })),
      })),
      schema: vi.fn(() => ({
        rpc: rpcSpy,
      })),
    };

    // Mock actors and supabase helpers
    const actorsMod = await import('../server/actors.js');
    vi.spyOn(actorsMod, 'requireStaffActor').mockResolvedValue({
      id: 'super-admin-1',
      userId: 'sa-user-1',
      role: 'superadmin',
      fullName: 'Super Admin',
      email: 'sa@earist.edu.ph',
      status: 'active',
      isBootstrap: false,
    });

    const supabaseMod = await import('../server/supabase.js');
    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });

    const req = new Request('http://localhost/api/create-user', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'New Staff',
        email: 'orphan.user@earist.edu.ph',
        password: 'ValidPassword123!',
        role: 'admin',
      }),
    });

    const res = await handler.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('existing_auth_identity_unprovisioned');

    // CRITICAL SECURITY INVARIANT: Must NEVER have called create_staff_profile (no automatic role adoption)
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('returns 409 user_already_exists when email belongs to an already provisioned staff profile', async () => {
    const { default: handler } = await import('../server/routes/system/create-user.js');

    const mockAdmin = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: null },
            error: { code: 'email_exists', message: 'User already registered' },
          }),
          listUsers: vi.fn().mockResolvedValue({
            data: {
              users: [
                { id: 'provisioned-uuid-5678', email: 'existing.guard@earist.edu.ph' },
              ],
            },
          }),
        },
        resend: vi.fn(),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue(
              table === 'staff_profiles'
                ? { data: { user_id: 'provisioned-uuid-5678' }, error: null }
                : { data: null, error: null }
            ),
          })),
        })),
      })),
      schema: vi.fn(() => ({
        rpc: vi.fn(),
      })),
    };

    const actorsMod = await import('../server/actors.js');
    vi.spyOn(actorsMod, 'requireStaffActor').mockResolvedValue({
      id: 'super-admin-1',
      userId: 'sa-user-1',
      role: 'superadmin',
      fullName: 'Super Admin',
      email: 'sa@earist.edu.ph',
      status: 'active',
      isBootstrap: false,
    });

    const supabaseMod = await import('../server/supabase.js');
    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });

    const req = new Request('http://localhost/api/create-user', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Another Guard',
        email: 'existing.guard@earist.edu.ph',
        password: 'ValidPassword123!',
        role: 'admin',
      }),
    });

    const res = await handler.fetch(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('email_exists');
  });

  it('successfully creates new staff user when email is clean and unassigned', async () => {
    const { default: handler } = await import('../server/routes/system/create-user.js');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { id: 'new-profile-id' }, error: null });
    const mockAdmin = {
      auth: {
        admin: {
          createUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'new-auth-user-999', email: 'brandnew@earist.edu.ph' } },
            error: null,
          }),
        },
        resend: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      schema: vi.fn(() => ({
        rpc: rpcSpy,
      })),
    };

    const actorsMod = await import('../server/actors.js');
    vi.spyOn(actorsMod, 'requireStaffActor').mockResolvedValue({
      id: 'super-admin-1',
      userId: 'sa-user-1',
      role: 'superadmin',
      fullName: 'Super Admin',
      email: 'sa@earist.edu.ph',
      status: 'active',
      isBootstrap: false,
    });

    const supabaseMod = await import('../server/supabase.js');
    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });

    const req = new Request('http://localhost/api/create-user', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Brand New Staff',
        email: 'brandnew@earist.edu.ph',
        password: 'ValidPassword123!',
        role: 'admin',
      }),
    });

    const res = await handler.fetch(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe('new-auth-user-999');
    expect(body.confirmationPending).toBe(true);
    expect(rpcSpy).toHaveBeenCalledWith('create_staff_profile', expect.objectContaining({
      requested_user_id: 'new-auth-user-999',
      requested_name: 'Brand New Staff',
      requested_role: 'admin',
    }));
  });
});
