import { describe, it, expect, vi, beforeEach } from 'vitest';
import verifyEmailRoute from '../server/routes/office/verify-email.js';
import * as actors from '../server/actors.js';
import * as supabaseMod from '../server/supabase.js';
import * as officeLib from '../server/lib/office.js';

describe('Office Email Verification Actor-Binding Contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OFFICE_VISIT_HMAC_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  it('strictly binds email verification lookup to authenticated session.user.id', async () => {
    let capturedActorFilter: string | null = null;
    let capturedEmailFilter: string | null = null;

    const mockAdmin = {
      from: vi.fn(),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((fnName: string, args: any) => {
          if (fnName === 'verify_office_email_challenge') {
            capturedActorFilter = args.requested_actor_id;
            capturedEmailFilter = args.requested_email;
            return Promise.resolve({
              data: [{ status: 'expired_or_not_found', attempts_remaining: 0, challenge_id: null }],
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }),
    };

    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      userClient: {} as any,
    });

    const callingActorId = 'target-actor-uuid-1111';
    vi.spyOn(actors, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: callingActorId, is_anonymous: true },
      isAnonymous: true,
      isRecoverySession: false,
    } as any);

    const request = new Request('http://localhost:3000/api/office/verify-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-user-token',
      },
      body: JSON.stringify({
        action: 'verify_code',
        email: 'Visitor@Example.Com',
        code: '123456',
      }),
    });

    const response = await verifyEmailRoute.fetch(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('invalid_or_expired_code');

    // Invariant: The query builder MUST have filtered by actor_id = callingActorId and normalized email
    expect(capturedActorFilter).toBe(callingActorId);
    expect(capturedEmailFilter).toBe('visitor@example.com');
  });

  it('rejects verification if caller has recovery session', async () => {
    const mockAdmin = {
      from: vi.fn(),
    };

    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      userClient: {} as any,
    });

    vi.spyOn(actors, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'some-actor' },
      isRecoverySession: true,
    } as any);

    const request = new Request('http://localhost:3000/api/office/verify-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer recovery-token',
      },
      body: JSON.stringify({
        action: 'verify_code',
        email: 'visitor@example.com',
        code: '123456',
      }),
    });

    await expect(verifyEmailRoute.fetch(request)).rejects.toThrow();
  });

  it('rejects verification if caller has non-anonymous staff session', async () => {
    const mockAdmin = {
      from: vi.fn(),
    };

    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      userClient: {} as any,
    });

    vi.spyOn(actors, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'staff-actor', is_anonymous: false },
      isAnonymous: false,
      isRecoverySession: false,
    } as any);

    const request = new Request('http://localhost:3000/api/office/verify-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({
        action: 'verify_code',
        email: 'visitor@example.com',
        code: '123456',
      }),
    });

    await expect(verifyEmailRoute.fetch(request)).rejects.toThrow(/anonymous_visitor_session_required/);
  });
});
