import { getVerifiedSessionContext } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { validateThermalTemplateLayout } from '../../../src/types/thermalTemplate.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  try {
    const { admin } = getServerSupabaseClients();

    // 1. Cryptographically verify current bearer session
    const session = await getVerifiedSessionContext(admin, token);

    // 2. Confinement: Recovery sessions or anonymous sessions cannot fetch template
    if (session.isRecoverySession || session.isAnonymous) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    // 3. Verify caller maps to an active device of type 'kiosk'
    const { data: device, error: deviceError } = await admin
      .from('devices')
      .select('user_id, type, status, alias')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (deviceError) {
      console.error('Device lookup failed during thermal template fetch:', deviceError);
      return jsonResponse(500, { error: 'database_error' });
    }

    // If caller is staff or non-kiosk device, deny access
    if (!device || device.status !== 'active' || device.type !== 'kiosk') {
      return jsonResponse(403, { error: 'kiosk_device_required' });
    }

    // 4. Retrieve current published template via trusted RPC in api schema
    const { data, error } = await admin
      .schema('api')
      .rpc('get_published_thermal_template');
    if (error) {
      console.error('Failed to retrieve published thermal template:', error);
      return jsonResponse(500, { error: 'database_error' });
    }

    if (!data || !data.layout) {
      return jsonResponse(404, { error: 'template_not_found' });
    }

    // 5. Server-side validation before returning to kiosk (defense in depth)
    const validation = validateThermalTemplateLayout(data.layout);
    if (!validation.success) {
      console.error('Published template in database failed schema validation:', validation.error.issues);
      return jsonResponse(502, { error: 'invalid_published_template', details: validation.error.issues });
    }

    return jsonResponse(200, {
      version: data.version,
      name: data.name,
      layout: validation.data,
    });
  } catch (error) {
    console.error('Thermal template fetch error:', error instanceof Error ? error.message : 'unknown');
    return jsonResponse(500, { error: 'internal_error' });
  }
}

export default { fetch: handleRequest };
