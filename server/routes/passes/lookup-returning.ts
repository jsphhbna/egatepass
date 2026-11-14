/**
 * server/routes/passes/lookup-returning.ts
 *
 * Frontdoor for Returning Visitor 1:1 Verification:
 * Accepts registered name (first, last, optional middle) and an additional matching factor
 * (contact number or residential locality) to discover matching active returning profiles.
 *
 * Anti-Abuse & Anti-Enumeration Protections:
 * 1. Rejects SQL wildcard characters ('%', '_', '*', '\') to prevent pattern enumeration.
 * 2. Normalizes input without damaging valid Filipino names, hyphens, spaces, apostrophes, and Unicode.
 * 3. Requires an additional matching factor (Philippine mobile number or PSGC locality) in BOTH
 *    'auto' and 'manual' lookup modes.
 * 4. Limits discovered candidates to at most 3 records.
 * 5. Returns privacy-masked attributes (maskedName, maskedContact, partialLocality).
 * 6. Generates HMAC-signed portrait preview tokens strictly bound to kind='photo' and 300s TTL.
 * 7. Enforces dual-bucket rate limiting (actor bucket and client network bucket).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { normalizePhMobile } from '../../../src/lib/phPhone.js';
import { getClientNetworkIdentifier } from './issue.js';
import { createPreviewToken } from './returning-photo-preview.js';

// Rejects wildcards, control characters, and common injection patterns
const safeNameRegex = /^[^%_*\\<>=;`$[\]{}|]+$/u;

const lookupSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  middleName: z.string().trim().max(50).optional(),
  contactNumber: z.string().trim().optional(),
  psgcCityCode: z.string().trim().optional(),
  psgcBarangayCode: z.string().trim().optional(),
  captchaToken: z.string().trim().optional(),
  mode: z.enum(['auto', 'manual']).default('manual'),
}).strict().superRefine((val, ctx) => {
  // Reject SQL pattern wildcard characters
  if (!safeNameRegex.test(val.firstName) || /[%_\\]/.test(val.firstName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'First name contains invalid or wildcard characters.',
      path: ['firstName'],
    });
  }
  if (!safeNameRegex.test(val.lastName) || /[%_\\]/.test(val.lastName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Last name contains invalid or wildcard characters.',
      path: ['lastName'],
    });
  }
  if (val.middleName && (!safeNameRegex.test(val.middleName) || /[%_\\]/.test(val.middleName))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Middle name contains invalid or wildcard characters.',
      path: ['middleName'],
    });
  }

  // Require additional matching factor in both auto and manual modes to prevent enumeration
  const hasPhone = Boolean(val.contactNumber && val.contactNumber.trim().length > 0);
  const hasLocation = Boolean(val.psgcCityCode && val.psgcCityCode.trim().length > 0);
  if (!hasPhone && !hasLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Additional verification factor required (registered mobile number or locality).',
      path: ['contactNumber'],
    });
  }
});

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
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

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

    // 1. Rate limiting - Actor Bucket (15 lookups per 5 minutes)
    const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
    const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: actorKeyHex,
      requested_action: 'portal.lookup_returning',
      requested_max_requests: 15,
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

    // 2. Rate limiting - Network Bucket (45 lookups per 5 minutes)
    const networkKeyHex = getClientNetworkIdentifier(request);
    const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
      requested_key_hex: networkKeyHex,
      requested_action: 'portal.network_lookup',
      requested_max_requests: 45,
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

    // Validate phone number if provided
    let normalizedPhone: string | null = null;
    if (parsed.data.contactNumber && parsed.data.contactNumber.trim().length > 0) {
      normalizedPhone = normalizePhMobile(parsed.data.contactNumber);
      if (!normalizedPhone) {
        return jsonResponse(400, {
          error: 'invalid_contact_number',
          message: 'Please provide a valid Philippine mobile number (e.g. 09171234567 or +639171234567).',
        });
      }
    }

    // 3. Search for matching active profiles (functional index lower(first_name), lower(last_name))
    // Escapes any literal pattern characters to guarantee exact string matching
    const safeFirst = parsed.data.firstName.trim().replace(/[%_\\]/g, '\\$&');
    const safeLast = parsed.data.lastName.trim().replace(/[%_\\]/g, '\\$&');
    const nowIso = new Date().toISOString();

    let query = admin
      .from('returning_visitor_profiles')
      .select(`
        id, first_name, middle_name, last_name, contact_number_e164,
        psgc_city_code, psgc_barangay_code,
        psgc_city_municipality_name, psgc_barangay_name, psgc_province_name, psgc_region_name,
        created_at
      `)
      .ilike('first_name', safeFirst)
      .ilike('last_name', safeLast)
      .gt('expires_at', nowIso)
      .is('revoked_at', null);

    if (parsed.data.middleName && parsed.data.middleName.trim().length > 0) {
      const safeMiddle = parsed.data.middleName.trim().replace(/[%_\\]/g, '\\$&');
      query = query.ilike('middle_name', safeMiddle);
    }

    const cityCode = parsed.data.psgcCityCode?.trim();
    const brgyCode = parsed.data.psgcBarangayCode?.trim();

    // Push secondary factor into SQL when supported to prevent premature namesake cutoff
    if (typeof (query as any).eq === 'function') {
      if (normalizedPhone && cityCode && typeof (query as any).or === 'function') {
        query = query.or(`contact_number_e164.eq.${normalizedPhone},psgc_city_code.eq.${cityCode}`);
      } else if (normalizedPhone) {
        query = query.eq('contact_number_e164', normalizedPhone);
      } else if (cityCode) {
        query = query.eq('psgc_city_code', cityCode);
        if (brgyCode) {
          query = query.eq('psgc_barangay_code', brgyCode);
        }
      }
    }

    // Retrieve candidate set (expanded to 25 to accommodate metropolitan namesakes)
    const { data: matches, error: searchError } = await query.limit(25);

    if (searchError) {
      console.error('Profile search error in lookup-returning:', searchError);
      return jsonResponse(500, { error: 'search_failed' });
    }

    let filtered = matches || [];

    // Filter by additional factor (phone match OR locality match)
    filtered = filtered.filter((m) => {
      const phoneMatch = Boolean(normalizedPhone && m.contact_number_e164 === normalizedPhone);
      const addressMatch = Boolean(
        cityCode && m.psgc_city_code === cityCode &&
        (!brgyCode || m.psgc_barangay_code === brgyCode)
      );
      return phoneMatch || addressMatch;
    });

    // Enforce strict enumeration cap: at most 3 candidates returned
    const cappedCandidates = filtered.slice(0, 3);

    const tokenSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
    if (!tokenSecret || tokenSecret.length < 32) {
      console.error('RETURNING_MATCH_TOKEN_SECRET missing or insecure in lookup-returning');
      return jsonResponse(503, {
        error: 'signing_key_unavailable',
        message: 'Returning visitor search is temporarily unavailable.',
      });
    }

    const candidates = cappedCandidates.map((m) => {
      const localityParts = [
        m.psgc_barangay_name,
        m.psgc_city_municipality_name || m.psgc_province_name,
      ].filter(Boolean);

      // Create v3 preview token bound strictly to profileId, actorId, kind='photo', and 300s TTL
      const previewToken = createPreviewToken(m.id, actorId, tokenSecret, 300, 'photo');

      return {
        profileId: m.id,
        maskedName: maskName(m.first_name, m.middle_name, m.last_name),
        maskedContact: maskContact(m.contact_number_e164),
        partialLocality: localityParts.length > 0 ? localityParts.join(', ') : 'Philippines',
        registeredAt: m.created_at,
        previewUrl: `/api/passes/returning-photo-preview?profileId=${m.id}&token=${previewToken}&kind=photo`,
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
