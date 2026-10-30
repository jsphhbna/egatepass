import { jsonResponse } from '../../http.js';
import { getVehicleModels } from '../../lib/vpic.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const url = new URL(request.url);
  const make = url.searchParams.get('make');
  const type = url.searchParams.get('type');

  if (!make || make.trim() === '') {
    return jsonResponse(200, { models: [] });
  }

  try {
    const models = await getVehicleModels(make, type);
    return jsonResponse(
      200,
      { models },
      {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400',
      }
    );
  } catch (err) {
    console.error('Error fetching vehicle models:', err);
    return jsonResponse(500, { error: 'vehicle_catalog_error' });
  }
}

export { handleRequest as handleVehicleModels };
export default { fetch: handleRequest };
