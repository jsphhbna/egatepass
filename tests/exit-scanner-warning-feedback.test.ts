import { describe, it, expect, vi, beforeEach } from 'vitest';
import scanPassRoute from '../server/routes/gate/scan-pass.js';
import * as actors from '../server/actors.js';
import * as supabaseMod from '../server/supabase.js';

describe('Exit Scanner Audio & Warning Feedback Contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves code: office_unconfirmed on 200 response when exit attendance is unconfirmed', async () => {
    const mockRpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: {
          ok: true,
          result_status: 'ok',
          code: 'office_unconfirmed',
          message: 'Exit recorded with warning: Office attendance unconfirmed.',
        },
        error: null,
      }),
    });

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    };

    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      userClient: {} as any,
    });

    vi.spyOn(actors, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'guard-user-uuid' },
      isRecoverySession: false,
    } as any);

    const request = new Request('http://localhost:3000/api/gate/scan-pass', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-scanner-token',
      },
      body: JSON.stringify({
        passId: 'valid-pass-token-string-at-least-20-chars',
        mode: 'exit',
      }),
    });

    const response = await scanPassRoute.fetch(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      status: 'ok',
      code: 'office_unconfirmed',
      message: 'Exit recorded with warning: Office attendance unconfirmed.',
    });
  });

  it('returns normal ok status without code when exit is fully confirmed', async () => {
    const mockRpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: {
          ok: true,
          result_status: 'ok',
          code: null,
          message: 'Exit recorded successfully.',
        },
        error: null,
      }),
    });

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: mockRpc,
      }),
    };

    vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      userClient: {} as any,
    });

    vi.spyOn(actors, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'guard-user-uuid' },
      isRecoverySession: false,
    } as any);

    const request = new Request('http://localhost:3000/api/gate/scan-pass', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-scanner-token',
      },
      body: JSON.stringify({
        passId: 'valid-pass-token-string-at-least-20-chars',
        mode: 'exit',
      }),
    });

    const response = await scanPassRoute.fetch(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.code).toBeNull();
  });
});
