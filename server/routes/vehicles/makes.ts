import { jsonResponse } from '../../http.js';
import { getVehicleMakes } from '../../lib/vpic.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  try {
    const makes = await getVehicleMakes(type);
    return jsonResponse(
      200,
      { makes },
      {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400',
      }
    );
  } catch (err) {
    console.error('Error fetching vehicle makes:', err);
    return jsonResponse(500, { error: 'vehicle_catalog_error' });
  }
}

export { handleRequest as handleVehicleMakes };
export default { fetch: handleRequest };
