/**
 * server/routes/address/psgc.ts
 *
 * REST endpoint serving canonical PSGC data for the compact administrative location selector.
 */

import { jsonResponse } from '../../http.js';
import {
  getPsgcRegions,
  getPsgcProvinces,
  getPsgcCities,
  getPsgcBarangays,
  validatePsgcHierarchy,
} from '../../lib/psgc.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const level = url.searchParams.get('level') || 'regions';

  try {
    if (level === 'regions') {
      const regions = getPsgcRegions();
      return jsonResponse(200, { data: regions, regions }, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (level === 'provinces') {
      const regionCode = url.searchParams.get('regionCode') || undefined;
      const provinces = getPsgcProvinces(regionCode);
      return jsonResponse(200, { data: provinces, provinces }, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (level === 'cities') {
      const regionCode = url.searchParams.get('regionCode') || undefined;
      const rawProvince = url.searchParams.get('provinceCode');
      const provinceCode = rawProvince === 'null' || rawProvince === '' ? null : rawProvince || undefined;
      const cities = getPsgcCities(regionCode, provinceCode);
      return jsonResponse(200, { data: cities, cities }, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (level === 'barangays') {
      const cityCode = url.searchParams.get('cityCode');
      if (!cityCode) {
        return jsonResponse(400, { error: 'city_code_required' });
      }
      const barangays = getPsgcBarangays(cityCode);
      return jsonResponse(200, { data: barangays, barangays }, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (level === 'validate') {
      const regionCode = url.searchParams.get('regionCode') || '';
      const provinceCode = url.searchParams.get('provinceCode');
      const cityCode = url.searchParams.get('cityCode') || '';
      const barangayCode = url.searchParams.get('barangayCode') || '';
      const result = validatePsgcHierarchy(regionCode, provinceCode, cityCode, barangayCode);
      return jsonResponse(200, result as unknown as Record<string, unknown>);
    }

    return jsonResponse(400, { error: 'invalid_level' });
  } catch (error) {
    console.error('PSGC route error:', error);
    return jsonResponse(500, { error: 'psgc_service_unavailable' });
  }
}

export default { fetch: handleRequest };
