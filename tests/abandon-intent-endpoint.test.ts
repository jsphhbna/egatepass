import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import abandonIntentHandler from '../server/routes/passes/abandon-intent.js';

describe('Upload Intent Abandonment API Contract (abandon-intent)', () => {
  const originalEnv = { ...process.env };
  const visitorUserId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const testIntentId = '33333333-3333-4333-8333-333333333333';
  const testToken = 'valid-visitor-jwt-token';

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    supabaseModule.setServerSupabaseClientsForTest(null);
    supabaseModule.setVisitorClientFactoryForTest(null);
    vi.restoreAllMocks();
  });

  it('1. rejects non-POST requests with 405 Method Not Allowed', async () => {
    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'GET',
    });
    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error).toBe('method_not_allowed');
  });

  it('2. rejects requests without Bearer token with 401 Authentication Required', async () => {
    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId: testIntentId }),
    });
    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('authentication_required');
  });

  it('3. rejects requests with invalid payload with 400', async () => {
    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: 'not-a-uuid' }),
    });
    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('4. rejects non-anonymous session tokens with 403 visitor_identity_required', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, email: 'guard@earist.ph' } as any,
      claims: { is_anonymous: false },
      amr: [],
      isRecoverySession: false,
      isAnonymous: false,
    });

    const mockAdmin = {} as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('visitor_identity_required');
  });

  it('5. returns 200 idempotent when target intent does not exist', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.code).toBe('not_found');
    expect(json.databaseExpired).toBe(true);
    expect(json.storageCleaned).toBe(true);
  });

  it('6. rejects cross-tenant intent with 403 forbidden', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: otherUserId, // belongs to someone else
            source: 'portal',
            status: 'pending',
            visitor_id: null,
          },
          error: null,
        }),
      }),
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('forbidden');
  });

  it('7. rejects non-portal intents with 400 unsupported_source', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: visitorUserId,
            source: 'kiosk', // only portal intents can be abandoned via this endpoint
            status: 'pending',
            visitor_id: null,
          },
          error: null,
        }),
      }),
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('unsupported_source');
  });

  it('8. rejects already claimed intents with 409 intent_claimed', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: visitorUserId,
            source: 'portal',
            status: 'claimed',
            visitor_id: 'visitor-profile-uuid',
          },
          error: null,
        }),
      }),
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('intent_claimed');
  });

  it('9. executes DB RPC first via visitor-scoped client and removes storage object only after DB success', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const callOrder: string[] = [];

    const mockStorageRemove = vi.fn().mockImplementation(async () => {
      callOrder.push('storage.remove');
      return { data: [{ name: 'portal/file.jpg' }], error: null };
    });

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: visitorUserId,
            source: 'portal',
            status: 'pending',
            visitor_id: null,
            bucket_id: 'visitor-evidence',
            object_path: 'portal/visitor-uuid/photo.jpg',
          },
          error: null,
        }),
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          remove: mockStorageRemove,
        }),
      },
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    const mockVisitorRpc = vi.fn().mockImplementation(async () => {
      callOrder.push('db.abandon_upload_intent');
      return {
        data: [{ ok: true, code: 'abandoned', message: 'Intent abandoned' }],
        error: null,
      };
    });

    let receivedVisitorToken: string | null = null;
    supabaseModule.setVisitorClientFactoryForTest((token: string) => {
      receivedVisitorToken = token;
      return {
        schema: vi.fn().mockReturnValue({
          rpc: mockVisitorRpc,
        }),
      } as any;
    });

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.success).toBe(true);
    expect(json.databaseExpired).toBe(true);
    expect(json.storageCleaned).toBe(true);
    expect(json.code).toBe('abandoned');

    // Token was forwarded to visitor client factory
    expect(receivedVisitorToken).toBe(testToken);

    // Strict execution order: DB RPC must complete BEFORE storage removal
    expect(callOrder).toEqual(['db.abandon_upload_intent', 'storage.remove']);
    expect(mockStorageRemove).toHaveBeenCalledWith(['portal/visitor-uuid/photo.jpg']);
  });

  it('10. records reconciliation task and returns 200 with storageCleaned=false when storage removal fails', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const recordReconciliationSpy = vi.spyOn(actorsModule, 'recordReconciliation').mockResolvedValue(true);

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: visitorUserId,
            source: 'portal',
            status: 'pending',
            visitor_id: null,
            bucket_id: 'visitor-evidence',
            object_path: 'portal/visitor-uuid/photo.jpg',
          },
          error: null,
        }),
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          remove: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Object not found or storage error' },
          }),
        }),
      },
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    supabaseModule.setVisitorClientFactoryForTest(() => ({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: [{ ok: true, code: 'abandoned', message: 'Intent abandoned' }],
          error: null,
        }),
      }),
    } as any));

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.databaseExpired).toBe(true);
    expect(json.storageCleaned).toBe(false);
    expect(json.warning).toBeDefined();

    expect(recordReconciliationSpy).toHaveBeenCalledWith(
      mockAdmin,
      'upload_intent.abandon_storage_failed',
      'upload_intent',
      testIntentId,
      'Object not found or storage error',
      expect.objectContaining({
        bucketId: 'visitor-evidence',
        objectPath: 'portal/visitor-uuid/photo.jpg',
      })
    );
  });

  it('11. never attempts storage deletion if database RPC fails', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: visitorUserId, is_anonymous: true } as any,
      claims: { is_anonymous: true },
      amr: [{ method: 'anonymous' }],
      isRecoverySession: false,
      isAnonymous: true,
    });

    const mockStorageRemove = vi.fn();

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id: testIntentId,
            owner_id: visitorUserId,
            source: 'portal',
            status: 'pending',
            visitor_id: null,
            bucket_id: 'visitor-evidence',
            object_path: 'portal/visitor-uuid/photo.jpg',
          },
          error: null,
        }),
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          remove: mockStorageRemove,
        }),
      },
    } as any;
    supabaseModule.setServerSupabaseClientsForTest({ admin: mockAdmin, passwordVerifier: mockAdmin });

    // Simulate database RPC returning 42501 (visitor identity required or permission error)
    supabaseModule.setVisitorClientFactoryForTest(() => ({
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { code: '42501', message: 'visitor identity required' },
        }),
      }),
    } as any));

    const req = new Request('http://localhost/api/passes/abandon-intent', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ intentId: testIntentId }),
    });

    const res = await abandonIntentHandler.fetch(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('visitor_identity_required');

    // Storage removal MUST NOT be called!
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});
