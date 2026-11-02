import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as supabaseModule from '../server/supabase.js';
import searchHandler from '../server/routes/location/search.js';

describe('Distributed Location Search Rate Limiter & Shared Cache (Priority 2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Returns cached results from distributed location_search_cache without external call', async () => {
    const mockResults = [
      { displayName: 'Manila, Metro Manila, Philippines', lat: 14.5995, lon: 120.9842 },
    ];

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'location_search_cache') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { results: mockResults },
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

    const req = new Request('http://localhost/api/location/search?q=Manila', { method: 'GET' });
    const res = await searchHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cached).toBe(true);
    expect(json.results).toEqual(mockResults);
    // External Nominatim fetch must NEVER be invoked on cache hit
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('2. Enforces distributed rate limit and returns 429 when slot cannot be acquired', async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'location_search_cache') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {};
      }),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: { acquired: false, wait_ms: 3000, elapsed_ms: 100 },
          error: null,
        }),
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

    const req = new Request('http://localhost/api/location/search?q=Quezon+City', { method: 'GET' });
    const res = await searchHandler.fetch(req);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('rate_limited');
    expect(json.message).toContain('Please tap the map directly');
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('3. Rejects invalid queries (<2 chars, >100 chars, non-GET methods)', async () => {
    // Non-GET
    const postReq = new Request('http://localhost/api/location/search?q=Manila', { method: 'POST' });
    const postRes = await searchHandler.fetch(postReq);
    expect(postRes.status).toBe(405);

    // Empty/short query
    const shortReq = new Request('http://localhost/api/location/search?q=a', { method: 'GET' });
    const shortRes = await searchHandler.fetch(shortReq);
    expect(shortRes.status).toBe(400);

    // Too long query
    const longQuery = 'x'.repeat(105);
    const longReq = new Request(`http://localhost/api/location/search?q=${longQuery}`, { method: 'GET' });
    const longRes = await searchHandler.fetch(longReq);
    expect(longRes.status).toBe(400);
  });
});
