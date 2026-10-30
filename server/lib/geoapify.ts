/**
 * server/lib/geoapify.ts
 *
 * Server-only Geoapify integration for address autocomplete and Place Details verification.
 * Strictly Philippines-only (countrycode: ph).
 *
 * SECURITY:
 * - process.env.GEOAPIFY_API_KEY is used exclusively on the server.
 * - Never returns or leaks API key in errors, headers, or DTO payloads.
 * - Enforces fail-closed validation on place specificity and coordinates.
 */

export interface AddressSuggestionDto {
  placeId: string;
  formatted: string;
  addressLine1?: string;
  addressLine2?: string;
  houseNumber?: string;
  street?: string;
  suburb?: string;
  district?: string;
  city?: string;
  state?: string;
  postcode?: string;
  countryCode: 'ph';
  lat: number;
  lon: number;
  resultType: string;
  confidence?: number;
  matchType?: string;
}

export interface VerifiedAddressDetails {
  placeId: string;
  formatted: string;
  resultType: string;
  confidence: number | null;
  lat: number;
  lon: number;
  city: string | null;
  state: string | null;
  postcode: string | null;
  countryCode: 'ph';
  addressDetail?: string;
}

const PH_LAT_MIN = 4.0;
const PH_LAT_MAX = 22.0;
const PH_LON_MIN = 116.0;
const PH_LON_MAX = 127.0;

function getApiKey(): string {
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('address_verification_unavailable');
  }
  return key.trim();
}

/**
 * Searches Geoapify address autocomplete for Philippines locations.
 */
export async function searchAddressAutocomplete(query: string): Promise<AddressSuggestionDto[]> {
  const trimmed = query.trim();
  if (trimmed.length < 4) {
    return [];
  }

  const apiKey = getApiKey();
  const endpoint = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  endpoint.searchParams.set('text', trimmed);
  endpoint.searchParams.set('filter', 'countrycode:ph');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('limit', '5');
  endpoint.searchParams.set('lang', 'en');
  endpoint.searchParams.set('apiKey', apiKey);

  let res: Response;
  try {
    res = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('Geoapify autocomplete network error:', err instanceof Error ? err.message : 'network_error');
    throw new Error('address_verification_unavailable');
  }

  if (res.status === 429) {
    throw new Error('address_rate_limited');
  }
  if (!res.ok) {
    console.error('Geoapify autocomplete response status:', res.status);
    throw new Error('address_verification_unavailable');
  }

  const data = await res.json().catch(() => null);
  if (!data) return [];

  // Support both format=json (`results`) and GeoJSON (`features`)
  const rawItems: any[] = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.features)
    ? data.features.map((f: any) => f.properties || f)
    : [];

  const suggestions: AddressSuggestionDto[] = [];

  for (const item of rawItems) {
    const placeId = item.place_id || item.properties?.place_id || item.id;
    const formatted = item.formatted || item.properties?.formatted;
    const lat = Number(item.lat ?? item.properties?.lat);
    const lon = Number(item.lon ?? item.properties?.lon);
    const countryCode = (item.country_code || item.properties?.country_code || '').toLowerCase();

    if (!placeId || !formatted || countryCode !== 'ph' || isNaN(lat) || isNaN(lon)) {
      continue;
    }

    const rank = item.rank || item.properties?.rank || {};

    suggestions.push({
      placeId: String(placeId),
      formatted: String(formatted),
      addressLine1: item.address_line1 || item.properties?.address_line1,
      addressLine2: item.address_line2 || item.properties?.address_line2,
      houseNumber: item.housenumber || item.properties?.housenumber,
      street: item.street || item.properties?.street,
      suburb: item.suburb || item.properties?.suburb,
      district: item.district || item.properties?.district,
      city: item.city || item.properties?.city,
      state: item.state || item.properties?.state,
      postcode: item.postcode || item.properties?.postcode,
      countryCode: 'ph',
      lat,
      lon,
      resultType: String(item.result_type || item.properties?.result_type || 'unknown'),
      confidence: typeof rank.confidence === 'number' ? rank.confidence : undefined,
      matchType: typeof rank.match_type === 'string' ? rank.match_type : undefined,
    });
  }

  return suggestions.slice(0, 5);
}

/**
 * Revalidates a selected Geoapify place ID server-side via Place Details.
 * Enforces Philippines country code, geographic bounding box, and location specificity.
 */
export async function verifyPlaceDetails(
  placeId: string,
  addressDetail?: string
): Promise<VerifiedAddressDetails> {
  const trimmedId = placeId.trim();
  if (!trimmedId) {
    throw new Error('invalid_place_id');
  }

  const apiKey = getApiKey();
  const endpoint = new URL('https://api.geoapify.com/v2/place-details');
  endpoint.searchParams.set('id', trimmedId);
  endpoint.searchParams.set('apiKey', apiKey);

  let res: Response;
  try {
    res = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch (err) {
    console.error('Geoapify Place Details network error:', err instanceof Error ? err.message : 'network_error');
    throw new Error('address_verification_unavailable');
  }

  if (res.status === 429) {
    throw new Error('address_rate_limited');
  }
  if (res.status === 404) {
    throw new Error('invalid_address_place');
  }
  if (!res.ok) {
    console.error('Geoapify Place Details error status:', res.status);
    throw new Error('address_verification_unavailable');
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    throw new Error('invalid_address_place');
  }

  // Geoapify returns a GeoJSON FeatureCollection
  const feature = Array.isArray(data.features) && data.features.length > 0 ? data.features[0] : null;
  const props = feature?.properties || (data.properties ? data.properties : null);

  if (!props) {
    throw new Error('invalid_address_place');
  }

  const countryCode = String(props.country_code || '').toLowerCase();
  if (countryCode !== 'ph') {
    throw new Error('address_must_be_philippines');
  }

  const lat = Number(props.lat);
  const lon = Number(props.lon);
  if (isNaN(lat) || isNaN(lon) || lat < PH_LAT_MIN || lat > PH_LAT_MAX || lon < PH_LON_MIN || lon > PH_LON_MAX) {
    throw new Error('address_coordinates_out_of_bounds');
  }

  const formatted = String(props.formatted || '').trim();
  if (!formatted) {
    throw new Error('invalid_address_place');
  }

  // Specificity check: reject excessively broad results such as country or state level only
  const resultType = String(props.result_type || '').toLowerCase();
  const broadTypes = ['country', 'state'];
  if (broadTypes.includes(resultType)) {
    throw new Error('address_too_broad');
  }

  // Check if formatted text is only country/island/state without local context
  const broadNames = ['philippines', 'pilipinas', 'metro manila', 'national capital region', 'luzon', 'visayas', 'mindanao'];
  if (broadNames.includes(formatted.toLowerCase())) {
    throw new Error('address_too_broad');
  }

  const rank = props.rank || {};
  const confidence = typeof rank.confidence === 'number' ? rank.confidence : null;

  return {
    placeId: trimmedId,
    formatted,
    resultType,
    confidence,
    lat,
    lon,
    city: props.city ? String(props.city) : null,
    state: props.state ? String(props.state) : null,
    postcode: props.postcode ? String(props.postcode) : null,
    countryCode: 'ph',
    addressDetail: addressDetail?.trim() || undefined,
  };
}
