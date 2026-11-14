/**
 * server/lib/returningVisitorResolution.ts
 *
 * Unified Authoritative Resolution for Returning Visitors and Evidence:
 * Resolves historical visitor records and eligible original registration portraits
 * with deterministic precedence, strict unambiguous fallback, and retention enforcement.
 *
 * Rules:
 * 1. Prefer authoritative direct relationship: visitors.returning_profile_id = profile.id.
 * 2. Earliest registration visitor row is the authoritative original visit (created_at ASC).
 * 3. Fallback to historical records allowed ONLY when unambiguous:
 *    - Normalized first name, last name, and middle name (if present) match.
 *    - Contact number matches profile E.164.
 *    - PSGC locality (city/municipality) matches when both records have it populated.
 *    - Exactly ONE matching historical visitor record found.
 *    - If 0 matches: fails closed (no_historical_visitor_records).
 *    - If >1 matches: fails closed (ambiguous_historical_records). Never picks arbitrarily.
 * 4. Original registration portrait resolution:
 *    - Must be kind='photo'.
 *    - Must have purged_at IS NULL.
 *    - Must have expires_at > now().
 *    - Earliest created_at ASC (original registration portrait).
 * 5. Ephemeral only: zero permanent returning selfie storage or template persistence.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthoritativeVisitorMatch {
  visitor: {
    id: string;
    full_name: string;
    contact_number: string;
    returning_profile_id?: string | null;
    psgc_city_code: string | null;
    psgc_barangay_code: string | null;
    created_at: string;
  };
  visitorIds: string[];
  resolutionMethod: 'direct_linkage' | 'unambiguous_fallback';
}

export interface AuthoritativeVisitorResolutionResult {
  match: AuthoritativeVisitorMatch | null;
  error?: 'profile_not_found' | 'no_historical_visitor_records' | 'ambiguous_historical_records' | 'database_error';
  details?: string;
}

export interface EligiblePortraitEvidence {
  id: string;
  visitor_id: string;
  bucket_id: string;
  object_path: string;
  content_type: string;
  byte_size: number;
  sha256_hex: string;
  expires_at: string;
  purged_at: string | null;
  created_at: string;
}

/**
 * Normalizes a name string for deterministic comparison:
 * lowercases, removes punctuation, collapses whitespace.
 */
export function normalizeNameForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'/\\#\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks if a visitor's full_name matches a returning profile's name components.
 */
export function isNameMatching(
  visitorFullName: string,
  profileFirst: string,
  profileMiddle: string | null | undefined,
  profileLast: string
): boolean {
  const normVisitor = normalizeNameForComparison(visitorFullName);
  const normFirst = normalizeNameForComparison(profileFirst);
  const normLast = normalizeNameForComparison(profileLast);
  const normMiddle = profileMiddle ? normalizeNameForComparison(profileMiddle) : '';

  if (!normFirst || !normLast || !normVisitor) return false;

  // Expected combinations
  const firstLast = `${normFirst} ${normLast}`;
  if (normVisitor === firstLast) return true;

  if (normMiddle) {
    const firstMiddleLast = `${normFirst} ${normMiddle} ${normLast}`;
    if (normVisitor === firstMiddleLast) return true;

    // Check middle initial
    const middleInitial = normMiddle.charAt(0);
    const firstInitialLast = `${normFirst} ${middleInitial} ${normLast}`;
    if (normVisitor === firstInitialLast) return true;
  }

  // Check if visitor full name starts with first name and ends with last name
  if (normVisitor.startsWith(normFirst + ' ') && normVisitor.endsWith(' ' + normLast)) {
    const middlePart = normVisitor.slice(normFirst.length + 1, normVisitor.length - normLast.length - 1).trim();
    if (!middlePart) return true;
    if (!normMiddle) return true;
    if (middlePart === normMiddle) return true;
    if (normMiddle.length === 1 && middlePart.startsWith(normMiddle)) return true;
    if (middlePart.length === 1 && normMiddle.startsWith(middlePart)) return true;
  }

  return false;
}

/**
 * Resolves the authoritative historical visitor record for a given returning profile.
 * Prefers direct returning_profile_id linkage. Fallbacks only if unambiguous.
 */
export async function resolveAuthoritativeVisitorForProfile(
  admin: SupabaseClient,
  profileId: string
): Promise<AuthoritativeVisitorResolutionResult> {
  try {
    // 1. Authoritative check: visitors directly linked via returning_profile_id
    const visitorsFrom = admin.from('visitors');
    if (!visitorsFrom || typeof visitorsFrom.select !== 'function') {
      return { match: null, error: 'database_error', details: 'Invalid visitors query builder' };
    }

    let linkedQuery: any = visitorsFrom
      .select('id, full_name, contact_number, psgc_city_code, psgc_barangay_code, created_at');

    if (typeof linkedQuery.eq === 'function') {
      linkedQuery = linkedQuery.eq('returning_profile_id', profileId);
    }
    if (typeof linkedQuery.order === 'function') {
      linkedQuery = linkedQuery.order('created_at', { ascending: true });
    }

    const linkedResult = await linkedQuery;
    const linkedVisitors = linkedResult?.data;
    const linkedError = linkedResult?.error;

    if (linkedError) {
      console.error('Database error querying linked visitors:', linkedError);
      return { match: null, error: 'database_error', details: linkedError.message };
    }

    if (linkedVisitors && linkedVisitors.length > 0) {
      return {
        match: {
          visitor: linkedVisitors[0],
          visitorIds: linkedVisitors.map((v: any) => v.id),
          resolutionMethod: 'direct_linkage',
        },
      };
    }

    // 2. Fallback check: Fetch returning profile attributes for strict matching
    const profileFrom = admin.from('returning_visitor_profiles');
    if (!profileFrom || typeof profileFrom.select !== 'function') {
      return { match: null, error: 'database_error', details: 'Invalid profile query builder' };
    }

    let profileQuery: any = profileFrom
      .select('id, first_name, middle_name, last_name, contact_number_e164, psgc_city_code, psgc_barangay_code');

    if (typeof profileQuery.eq === 'function') {
      profileQuery = profileQuery.eq('id', profileId);
    }

    const profileResult = typeof profileQuery.maybeSingle === 'function'
      ? await profileQuery.maybeSingle()
      : await profileQuery;

    const rawProfile = profileResult?.data;
    const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
    const profileError = profileResult?.error;

    if (profileError) {
      console.error('Database error querying profile for fallback:', profileError);
      return { match: null, error: 'database_error', details: profileError.message };
    }

    if (!profile) {
      return { match: null, error: 'profile_not_found', details: 'Returning profile does not exist.' };
    }

    if (!profile.first_name || !profile.last_name || !profile.contact_number_e164 || !profile.psgc_city_code) {
      return {
        match: null,
        error: 'no_historical_visitor_records',
        details: 'Returning profile lacks sufficient identity or locality data for fallback matching.',
      };
    }

    // Query historical visitors with the exact normalized contact number.
    // Query complete candidate set without arbitrary limit to ensure deterministic uniqueness across all records.
    let phoneQuery: any = admin
      .from('visitors')
      .select('id, full_name, contact_number, returning_profile_id, psgc_city_code, psgc_barangay_code, created_at');

    if (typeof phoneQuery.eq === 'function') {
      phoneQuery = phoneQuery.eq('contact_number', profile.contact_number_e164);
    }
    if (typeof phoneQuery.order === 'function') {
      phoneQuery = phoneQuery.order('created_at', { ascending: true });
    }

    const phoneResult = await phoneQuery;
    const phoneVisitors = phoneResult?.data;
    const phoneError = phoneResult?.error;

    if (phoneError) {
      console.error('Database error querying visitors by contact number:', phoneError);
      return { match: null, error: 'database_error', details: phoneError.message };
    }

    if (!phoneVisitors || phoneVisitors.length === 0) {
      return {
        match: null,
        error: 'no_historical_visitor_records',
        details: 'No historical registration records found with matching contact number.',
      };
    }

    // Filter candidates by strict identity, linkage, and locality criteria:
    // 1. Must NOT be linked to another profile (or any returning profile).
    // 2. Must have non-empty full_name that strictly matches the profile's names.
    // 3. Must have non-empty psgc_city_code that strictly matches the profile's psgc_city_code.
    // 4. If both records have psgc_barangay_code, they must match.
    const matchingCandidates = phoneVisitors.filter((v: any) => {
      // Never use a historical visitor already linked to another returning profile
      if (v.returning_profile_id) {
        return false;
      }

      // Do not treat missing identity fields as matches: full_name must be present and non-empty
      if (!v.full_name || typeof v.full_name !== 'string' || v.full_name.trim().length === 0) {
        return false;
      }

      // Strict name match
      if (!isNameMatching(v.full_name, profile.first_name, profile.middle_name, profile.last_name)) {
        return false;
      }

      // PSGC locality requirement: city must be present on visitor and must match profile city
      if (!v.psgc_city_code || typeof v.psgc_city_code !== 'string' || v.psgc_city_code !== profile.psgc_city_code) {
        return false;
      }

      // Barangay check if both populated
      if (profile.psgc_barangay_code && v.psgc_barangay_code && profile.psgc_barangay_code !== v.psgc_barangay_code) {
        return false;
      }

      return true;
    });

    if (matchingCandidates.length === 0) {
      return {
        match: null,
        error: 'no_historical_visitor_records',
        details: 'No historical registration records matched profile identity factors.',
      };
    }

    if (matchingCandidates.length > 1) {
      // Fail closed: multiple matching historical records cannot be disambiguated safely
      return {
        match: null,
        error: 'ambiguous_historical_records',
        details: 'Multiple historical visitor records matched profile factors. Ambiguity rejected.',
      };
    }

    // Exactly one matching candidate: unambiguous match
    const authoritativeVisitor = matchingCandidates[0];
    return {
      match: {
        visitor: authoritativeVisitor,
        visitorIds: [authoritativeVisitor.id],
        resolutionMethod: 'unambiguous_fallback',
      },
    };
  } catch (err) {
    console.error('Unexpected error in resolveAuthoritativeVisitorForProfile:', err);
    return {
      match: null,
      error: 'database_error',
      details: err instanceof Error ? err.message : 'Unknown resolution error',
    };
  }
}

/**
 * Resolves the eligible original registration portrait for one or more visitor IDs.
 * Strictly requires purged_at IS NULL and expires_at > now().
 * Returns the earliest created portrait (original registration).
 */
export async function resolveEligibleRegistrationPortrait(
  admin: SupabaseClient,
  visitorIds: string | string[]
): Promise<EligiblePortraitEvidence | null> {
  const ids = Array.isArray(visitorIds) ? visitorIds : [visitorIds];
  if (ids.length === 0) return null;

  try {
    const nowIso = new Date().toISOString();
    const evFrom = admin.from('visitor_evidence');
    if (!evFrom || typeof evFrom.select !== 'function') return null;

    let query: any = evFrom
      .select('id, visitor_id, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at, purged_at, created_at');

    if (typeof query.in === 'function') {
      query = query.in('visitor_id', ids);
    }
    if (typeof query.eq === 'function') {
      query = query.eq('kind', 'photo');
    }
    if (typeof query.is === 'function') {
      query = query.is('purged_at', null);
    }
    if (typeof query.gt === 'function') {
      query = query.gt('expires_at', nowIso);
    }
    if (typeof query.order === 'function') {
      query = query.order('created_at', { ascending: true });
    }
    if (typeof query.limit === 'function') {
      query = query.limit(1);
    }

    const result = typeof query.maybeSingle === 'function' ? await query.maybeSingle() : await query;
    const rawData = result?.data;
    const evidence = Array.isArray(rawData) ? rawData[0] : rawData;
    const error = result?.error;

    if (error) {
      console.error('Database error querying eligible registration portrait:', error);
      return null;
    }

    if (!evidence) return null;

    // Strict in-memory retention check to enforce retention boundaries across all environments and mocks
    if (evidence.purged_at) return null;
    if (evidence.expires_at && new Date(evidence.expires_at) <= new Date(nowIso)) return null;

    return (evidence as EligiblePortraitEvidence);
  } catch (err) {
    console.error('Unexpected error in resolveEligibleRegistrationPortrait:', err);
    return null;
  }
}
