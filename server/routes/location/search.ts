import { jsonResponse } from '../../http.js';
import { normalizeCoordinates } from '../../lib/home-location.js';

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

// In-memory cache for repeated search queries (1 hour TTL)
const searchCache = new Map<string, { results: LocationSearchResult[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Global Nominatim rate limiter: Maximum 1 request per second across the entire application
let lastNominatimRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1050; // slightly > 1000ms for safety margin

let pendingQueue: Promise<void> = Promise.resolve();

function throttleNominatim(): Promise<void> {
  const next = pendingQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastNominatimRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    lastNominatimRequestTime = Date.now();
  });
  pendingQueue = next.catch(() => {});
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

  // Normalize query key for cache lookup
  const cacheKey = rawQuery.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return jsonResponse(200, { results: cached.results, cached: true });
  }

  try {
    // Enforce global 1 req/sec rate limit per Nominatim policy
    await throttleNominatim();

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

    // Cache results
    searchCache.set(cacheKey, { results, timestamp: Date.now() });

    // Limit cache size to 500 entries
    if (searchCache.size > 500) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey) searchCache.delete(oldestKey);
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
