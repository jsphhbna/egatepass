import { createHash } from 'node:crypto';
import { jsonResponse } from '../../http.js';
import { normalizeCoordinates } from '../../lib/home-location.js';
import { getServerSupabaseClients } from '../../supabase.js';

interface NominatimResult {
  place_id: number;
  licence: string;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  type: string;
  importance: number;
}

export interface LocationSearchResult {
  displayName: string;
  lat: number;
  lon: number;
}

// In-memory fallback cache for repeated search queries (1 hour TTL)
const inMemoryCache = new Map<string, { results: LocationSearchResult[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory fallback rate limiter if database is temporarily unavailable
let localLastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1100;
let localQueue: Promise<void> = Promise.resolve();

function localThrottle(): Promise<void> {
  const next = localQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - localLastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    localLastRequestTime = Date.now();
  });
  localQueue = next.catch(() => {});
  return next;
}

export async function handleLocationSearch(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const rawQuery = url.searchParams.get('q')?.trim() || '';

  if (!rawQuery || rawQuery.length < 2) {
    return jsonResponse(400, { error: 'invalid_query', message: 'Search query must be at least 2 characters.' });
  }

  if (rawQuery.length > 100) {
    return jsonResponse(400, { error: 'query_too_long', message: 'Search query is too long.' });
  }

  const normalizedQuery = rawQuery.toLowerCase();
  const queryHash = createHash('sha256').update(normalizedQuery).digest('hex');

  let adminClient: any = null;
  try {
    const { admin } = getServerSupabaseClients();
    adminClient = admin;
  } catch {
    // Database client unavailable; gracefully fallback to in-memory mechanisms
  }

  // 1. Check distributed database cache first
  if (adminClient) {
    try {
      const { data: cachedRow, error: cacheLookupErr } = await adminClient
        .from('location_search_cache')
        .select('results')
        .eq('query_hash', queryHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (!cacheLookupErr && cachedRow?.results && Array.isArray(cachedRow.results)) {
        return jsonResponse(200, { results: cachedRow.results as LocationSearchResult[], cached: true });
      }
    } catch (cacheErr) {
      console.warn('Location search distributed cache lookup failed:', cacheErr);
    }
  }

  // 2. Check local in-memory fallback cache
  const cachedLocal = inMemoryCache.get(queryHash);
  if (cachedLocal && Date.now() - cachedLocal.timestamp < CACHE_TTL_MS) {
    return jsonResponse(200, { results: cachedLocal.results, cached: true });
  }

  // 3. Acquire rate-limiting slot (Priority 2: Enforces OpenStreetMap 1 req/sec policy across all serverless instances)
  let slotAcquired = false;
  if (adminClient) {
    try {
      const rpcCaller = typeof adminClient.schema === 'function' ? adminClient.schema('api') : adminClient;
      const { data: slotRes, error: slotErr } = await rpcCaller.rpc('acquire_nominatim_slot', {
        p_min_interval_ms: 1100,
      });

      if (!slotErr && slotRes) {
        if (slotRes.acquired === true) {
          slotAcquired = true;
        } else if (typeof slotRes.wait_ms === 'number' && slotRes.wait_ms <= 2000) {
          // Bounded wait and single retry
          await new Promise((resolve) => setTimeout(resolve, slotRes.wait_ms + 50));
          const { data: retryRes, error: retryErr } = await rpcCaller.rpc('acquire_nominatim_slot', {
            p_min_interval_ms: 1100,
          });
          if (!retryErr && retryRes?.acquired === true) {
            slotAcquired = true;
          }
        }

        if (!slotAcquired) {
          return jsonResponse(429, {
            error: 'rate_limited',
            message: 'Location search is momentarily busy. Please tap the map directly to place your pin.',
          });
        }
      }
    } catch (rpcErr) {
      console.warn('Distributed rate limiter RPC failed, using local fallback:', rpcErr);
    }
  }

  if (!slotAcquired) {
    await localThrottle();
  }

  try {
    const nominatimUrl = new URL('https://nominatim.openstreetmap.org/search');
    nominatimUrl.searchParams.set('format', 'json');
    nominatimUrl.searchParams.set('countrycodes', 'ph');
    nominatimUrl.searchParams.set('limit', '5');
    nominatimUrl.searchParams.set('addressdetails', '0');
    nominatimUrl.searchParams.set('q', rawQuery);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(nominatimUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'EARIST-EGatePass/1.0 (https://egatepass.tech; contact: notifications@egatepass.tech)',
        'Referer': 'https://egatepass.tech/',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      if (response.status === 429) {
        return jsonResponse(429, {
          error: 'rate_limited',
          message: 'Location search is momentarily busy. Please tap the map directly to place your pin.',
        });
      }
      return jsonResponse(502, {
        error: 'search_service_unavailable',
        message: 'Location search is temporarily unavailable. Please tap the map directly to place your pin.',
      });
    }

    const rawData = (await response.json()) as NominatimResult[];
    const results: LocationSearchResult[] = [];

    for (const item of rawData) {
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      const norm = normalizeCoordinates(lat, lon);
      if (norm.valid) {
        results.push({
          displayName: item.display_name,
          lat: norm.location.lat,
          lon: norm.location.lon,
        });
      }
    }

    // 4. Update in-memory fallback cache
    inMemoryCache.set(queryHash, { results, timestamp: Date.now() });
    if (inMemoryCache.size > 500) {
      const oldestKey = inMemoryCache.keys().next().value;
      if (oldestKey) inMemoryCache.delete(oldestKey);
    }

    // 5. Persist distributed database cache (bounded timeout prevents serverless execution truncation)
    if (adminClient) {
      const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      try {
        const cachePromise = adminClient
          .from('location_search_cache')
          .upsert({
            query_hash: queryHash,
            query: rawQuery,
            results,
            expires_at: expiresAt,
          });
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 800));
        await Promise.race([cachePromise, timeoutPromise]);
      } catch (err: any) {
        console.warn('Failed to persist location search cache:', err);
      }
    }

    return jsonResponse(200, { results, cached: false });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return jsonResponse(504, {
        error: 'search_timeout',
        message: 'Location search timed out. Please tap the map directly to place your pin.',
      });
    }
    console.error('Location search proxy error:', err);
    return jsonResponse(500, {
      error: 'search_failed',
      message: 'Could not complete location search. Please tap the map directly to place your pin.',
    });
  }
}

export default { fetch: handleLocationSearch };
