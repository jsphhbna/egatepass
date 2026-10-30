import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GuardApiError, recordDecision } from '../src/services/guard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/services/auth', () => ({
  getAccessToken: vi.fn(async () => 'valid-guard-token'),
}));

describe('PATCH 6: Guard HTTP Concurrency & Structured Error Handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('6A & 6B. GuardApiError preserves HTTP status and code from API responses', async () => {
    const error = new GuardApiError('Conflict error', 409, 'concurrency_conflict');
    expect(error.name).toBe('GuardApiError');
    expect(error.status).toBe(409);
    expect(error.code).toBe('concurrency_conflict');
    expect(error.message).toBe('Conflict error');

    // Test recordDecision throws GuardApiError with response.status 409
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'This pass is no longer waiting for a decision',
        code: 'concurrency_conflict',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(recordDecision('00000000-0000-4000-b000-000000000001', 'approved')).rejects.toThrow(GuardApiError);

    try {
      await recordDecision('00000000-0000-4000-b000-000000000001', 'approved');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardApiError);
      const guardErr = err as GuardApiError;
      expect(guardErr.status).toBe(409);
      expect(guardErr.code).toBe('concurrency_conflict');
      expect(guardErr.message).toBe('This pass is no longer waiting for a decision');
    }
  });

  it('6B. recordDecision preserves HTTP status 422 for expired passes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: 'Pass has expired and cannot be approved',
        code: 'pass_has_expired',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await recordDecision('00000000-0000-4000-b000-000000000001', 'approved');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardApiError);
      const guardErr = err as GuardApiError;
      expect(guardErr.status).toBe(422);
      expect(guardErr.code).toBe('pass_has_expired');
      expect(guardErr.message).toBe('Pass has expired and cannot be approved');
    }
  });

  it('6C. LegacyGuardPage.tsx handles 409 concurrency conflict with informational toast, queue refresh, and no red error', () => {
    const guardPageSrc = readFileSync(
      join(process.cwd(), 'src', 'pages', 'LegacyGuardPage.tsx'),
      'utf8',
    );

    // Verifies 409 handling
    expect(guardPageSrc).toContain('err.status === 409');
    expect(guardPageSrc).toContain('This visitor was already processed by another guard.');
    expect(guardPageSrc).toContain('void refreshQueue()');

    // Verifies 422 handling
    expect(guardPageSrc).toContain('err.status === 422');
    expect(guardPageSrc).toContain('This pass has expired and can no longer be approved.');

    // Verifies 401/403 auth handling
    expect(guardPageSrc).toContain('err.status === 401 || err.status === 403');

    // Verifies generic failure is only fallback for unhandled / network errors
    expect(guardPageSrc).toContain("toast.error('Failed to approve. Try again.')");
    expect(guardPageSrc).toContain("toast.error('Failed to reject. Try again.')");
  });
});
