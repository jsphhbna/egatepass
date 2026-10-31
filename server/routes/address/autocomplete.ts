import { jsonResponse } from '../../http.js';
import { getClientNetworkIdentifier } from '../passes/issue.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { searchAddressAutocomplete } from '../../lib/geoapify.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get('q');

  if (!q || q.trim().length < 4) {
    return jsonResponse(200, { suggestions: [] });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const networkKeyHex = getClientNetworkIdentifier(request);

    // Bounded rate limit per network: 60 requests per 2 minutes
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.address_autocomplete',
      requested_max_requests: 60,
      requested_window_seconds: 120,
    });

    if (netRlError) {
      console.error('Autocomplete rate limit check unavailable:', netRlError.message);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Address verification abuse protection is temporarily unavailable. Please try again shortly.',
      });
    } else if (netAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many address search requests from this network. Please wait a moment.',
      });
    }

    const suggestions = await searchAddressAutocomplete(q);

    return jsonResponse(
      200,
      { suggestions },
      {
        'Cache-Control': 'private, max-age=300',
      }
    );
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : 'address_lookup_failed';
    if (msg === 'address_rate_limited') {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Address search provider is temporarily busy. Please wait a moment.',
      });
    }
    return jsonResponse(503, {
      error: 'address_verification_unavailable',
      message: 'Address verification is temporarily unavailable. Please try again.',
    });
  }
}

export default { fetch: handleRequest };
