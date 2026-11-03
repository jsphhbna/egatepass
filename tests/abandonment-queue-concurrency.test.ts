import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createIssueTransaction,
  abandonPortalEvidence,
  drainPendingAbandonments,
  uploadPortalEvidence,
  PendingAbandonmentError,
} from '../src/services/visitorRegistration.js';
import * as visitorReg from '../src/services/visitorRegistration.js';

const mockClient: any = {
  auth: {
    getSession: vi.fn().mockResolvedValue({
      data: { session: { user: { id: 'test-user-id', is_anonymous: true }, access_token: 'test-jwt' } },
      error: null,
    }),
  },
  schema: vi.fn().mockReturnValue({
    rpc: vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          intent_id: 'new-intent-id',
          bucket_id: 'visitor-evidence',
          object_path: 'portal/test/photo.jpg',
          content_type: 'image/jpeg',
          max_bytes: 5242880,
          expires_at: new Date(Date.now() + 900000).toISOString(),
        },
        error: null,
      }),
    }),
  }),
  storage: {
    from: vi.fn().mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'portal/test/photo.jpg' }, error: null }),
    }),
  },
};

vi.mock('@/lib/supabase', () => ({
  requirePortalSupabase: () => mockClient,
  requireSupabase: () => mockClient,
}));

describe('Abandonment Queue Concurrency & Deterministic Drain Serialization', () => {
  let fetchSpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockClient.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'test-user-id', is_anonymous: true }, access_token: 'test-jwt' } },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. registers intent into pendingAbandonments synchronously before network request resolves', async () => {
    const tx = createIssueTransaction('portal');
    tx.photoIntentId = 'sync-register-intent-1';

    let resolveFetch: (val: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => pendingPromise as any);

    // Call abandonPortalEvidence without awaiting it yet
    const abandonPromise = abandonPortalEvidence(tx, 'photo', mockClient);

    // Synchronous assertion: pendingAbandonments MUST already contain the intentId!
    expect(tx.pendingAbandonments).toContain('sync-register-intent-1');
    expect(tx.photoIntentId).toBeNull(); // memory cleared immediately

    // Resolve fetch
    resolveFetch!(
      new Response(JSON.stringify({ ok: true, code: 'abandoned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await abandonPromise;
    expect(res.success).toBe(true);
    expect(res.status).toBe('abandoned');
    // On success, removed from queue
    expect(tx.pendingAbandonments).not.toContain('sync-register-intent-1');
  });

  it('2. deduplicates concurrent abandonPortalEvidence calls for the same intent', async () => {
    const tx = createIssueTransaction('portal');
    tx.photoIntentId = 'concurrent-abandon-intent';

    let fetchCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ ok: true, code: 'abandoned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Initiate two concurrent abandonments for the same intent
    // (e.g. rapid user clicks on retake)
    const [res1, res2] = await Promise.all([
      abandonPortalEvidence(tx, 'photo', mockClient),
      abandonPortalEvidence(tx, 'photo', mockClient),
    ]);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    // Second call saw no intent (already cleared) or reused in-flight promise
    // Crucially, fetch was called at most once for the intent
    expect(fetchCount).toBe(1);
    expect(tx.pendingAbandonments?.length ?? 0).toBe(0);
  });

  it('3. deduplicates concurrent drainPendingAbandonments calls', async () => {
    const tx = createIssueTransaction('portal');
    tx.pendingAbandonments = ['drain-intent-1', 'drain-intent-2'];

    let fetchCallCount = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ ok: true, code: 'abandoned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Invoke drain twice concurrently
    const [drain1, drain2] = await Promise.all([
      drainPendingAbandonments(tx, mockClient),
      drainPendingAbandonments(tx, mockClient),
    ]);

    expect(drain1.safeToContinue).toBe(true);
    expect(drain2.safeToContinue).toBe(true);
    expect(drain1.pendingCount).toBe(0);
    expect(drain2.pendingCount).toBe(0);
    // Concurrent drain shared the in-flight promise; total calls equals number of distinct intents (2)
    expect(fetchCallCount).toBe(2);
    expect(tx.pendingAbandonments).toEqual([]);
  });

  it('4. uploadPortalEvidence awaits drain before attempting new upload', async () => {
    const tx = createIssueTransaction('portal');
    tx.actorId = 'test-user-id';
    tx.token = 'test-jwt';
    tx.pendingAbandonments = ['stale-intent-await'];

    const executionOrder: string[] = [];

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      executionOrder.push('drain:abandon-intent');
      return new Response(JSON.stringify({ ok: true, code: 'abandoned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    mockClient.schema.mockReturnValue({
      rpc: vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(async () => {
          executionOrder.push('uploadCheckpointedEvidence');
          return {
            data: {
              intent_id: 'new-intent-id',
              bucket_id: 'visitor-evidence',
              object_path: 'portal/test/photo.jpg',
              content_type: 'image/jpeg',
              maxBytes: 5242880,
              expires_at: new Date(Date.now() + 900000).toISOString(),
            },
            error: null,
          };
        }),
      }),
    });

    const blob = new Blob(['photo-bytes'], { type: 'image/jpeg' });
    const result = await uploadPortalEvidence(tx, 'photo', blob);

    expect(result.intentId).toBe('new-intent-id');
    expect(executionOrder).toEqual(['drain:abandon-intent', 'uploadCheckpointedEvidence']);
    expect(tx.pendingAbandonments).not.toContain('stale-intent-await');
  });

  it('5. throws PendingAbandonmentError if drain fails to clear queue', async () => {
    const tx = createIssueTransaction('portal');
    tx.actorId = 'test-user-id';
    tx.token = 'test-jwt';
    tx.pendingAbandonments = ['unresolvable-intent-429'];

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Simulate repeated server failure
      return new Response(JSON.stringify({ error: 'server_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const blob = new Blob(['photo-bytes'], { type: 'image/jpeg' });

    await expect(uploadPortalEvidence(tx, 'photo', blob)).rejects.toThrow(PendingAbandonmentError);
    expect(tx.pendingAbandonments).toContain('unresolvable-intent-429');
  });

  it('6. terminal statuses (409 claimed and 403 forbidden) release item from pending queue', async () => {
    const tx = createIssueTransaction('portal');
    tx.pendingAbandonments = ['claimed-intent', 'forbidden-intent'];

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.intentId === 'claimed-intent') {
        return new Response(JSON.stringify({ error: 'intent_claimed' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await drainPendingAbandonments(tx, mockClient);

    expect(result.safeToContinue).toBe(true);
    expect(result.pendingCount).toBe(0);
    expect(tx.pendingAbandonments).toEqual([]);
  });
});
