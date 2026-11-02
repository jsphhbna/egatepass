/**
 * server/routes/passes/lookup-returning.ts
 *
 * Frontdoor for Returning Visitor 1:1 Verification:
 * Accepts registered name (first, last, optional middle) and discovers
 * matching active returning profiles, returning privacy-masked disambiguation records.
 *
 * Prevents plaintext PII leakage while enabling visitors to select their profile
 * before capturing a fresh selfie for 1:1 biometric comparison.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';

const lookupSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  middleName: z.string().trim().max(50).optional(),
}).strict();

function maskContact(contact: string): string {
  const cleaned = contact.replace(/\s+/g, '');
  if (cleaned.length >= 10) {
    return cleaned.slice(0, 4) + '***' + cleaned.slice(-4);
  }
  return '***' + cleaned.slice(-4);
}

function maskName(first: string, middle: string | null | undefined, last: string): string {
  const mInitial = middle && middle.trim().length > 0 ? ` ${middle.trim().charAt(0).toUpperCase()}.` : '';
  const lastTrimmed = last.trim();
  const lastMasked = lastTrimmed.length > 1
    ? `${lastTrimmed.charAt(0).toUpperCase()}${'*'.repeat(Math.min(lastTrimmed.length - 1, 4))}`
    : lastTrimmed;
  return `${first.trim()}${mInitial} ${lastMasked}`;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const parsed = lookupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'invalid_session' });
    }

    if (session.isRecoverySession || !session.isAnonymous) {
      return jsonResponse(403, { error: 'anonymous_visitor_required' });
    }

    const actorId = session.user.id;

    // 1. Rate limiting - Actor Bucket (10 lookups per 5 minutes)
    const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
    const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: actorKeyHex,
      requested_action: 'portal.lookup_returning',
      requested_max_requests: 10,
      requested_window_seconds: 300,
    });

    if (actorRlError) {
      console.error('Rate limit actor RPC error in lookup-returning:', actorRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Returning visitor search is temporarily unavailable.',
      });
    }

    if (actorAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many search attempts for this session. Please wait before retrying.',
      });
    }

    // 2. Rate limiting - Network Bucket (30 lookups per 5 minutes)
    const networkKeyHex = getClientNetworkIdentifier(request);
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.network_lookup',
      requested_max_requests: 30,
      requested_window_seconds: 300,
    });

    if (netRlError) {
      console.error('Rate limit network RPC error in lookup-returning:', netRlError);
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Returning visitor search is temporarily unavailable.',
      });
    }

    if (netAllowed === false) {
      return jsonResponse(429, {
        error: 'rate_limit_exceeded',
        message: 'Too many search attempts from this network. Please wait before retrying.',
      });
    }

    // 3. Search for matching active profiles (functional index lower(first_name), lower(last_name))
    const nowIso = new Date().toISOString();
    let query = admin
      .from('returning_visitor_profiles')
      .select(`
        id, first_name, middle_name, last_name, contact_number_e164,
        psgc_city_municipality_name, psgc_barangay_name, psgc_province_name, psgc_region_name
      `)
      .ilike('first_name', parsed.data.firstName)
      .ilike('last_name', parsed.data.lastName)
      .gt('expires_at', nowIso)
      .is('revoked_at', null);

    if (parsed.data.middleName && parsed.data.middleName.trim().length > 0) {
      query = query.ilike('middle_name', parsed.data.middleName.trim());
    }

    const { data: matches, error: searchError } = await query.limit(10);

    if (searchError) {
      console.error('Profile search error in lookup-returning:', searchError);
      return jsonResponse(500, { error: 'search_failed' });
    }

    const candidates = (matches || []).map((m) => {
      const localityParts = [
        m.psgc_barangay_name,
        m.psgc_city_municipality_name || m.psgc_province_name,
      ].filter(Boolean);

      return {
        profileId: m.id,
        maskedName: maskName(m.first_name, m.middle_name, m.last_name),
        maskedContact: maskContact(m.contact_number_e164),
        partialLocality: localityParts.length > 0 ? localityParts.join(', ') : 'Philippines',
      };
    });

    return jsonResponse(200, {
      found: candidates.length > 0,
      count: candidates.length,
      candidates,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Lookup returning failed:', error);
    return jsonResponse(500, { error: 'lookup_failed' });
  }
}

export default { fetch: handleRequest };
