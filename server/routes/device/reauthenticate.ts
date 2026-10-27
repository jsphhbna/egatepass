import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const schema = z.object({
  password: z.string().min(1).max(256),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' });
  }

  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  try {
    const { admin, passwordVerifier } = getServerSupabaseClients();

    // 1. Cryptographically verify current bearer session
    const session = await getVerifiedSessionContext(admin, token);

    // 2. Confinement: Recovery sessions or anonymous sessions cannot reauthenticate device
    if (session.isRecoverySession || session.isAnonymous) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    if (!session.user.email) {
      return jsonResponse(401, { error: 'invalid_session' });
    }

    // 3. Verify caller maps to an active device of type 'kiosk'
    const { data: device, error: deviceError } = await admin
      .from('devices')
      .select('user_id, type, status, alias')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (deviceError) {
      console.error('Device lookup failed during reauthentication:', deviceError);
      return jsonResponse(500, { error: 'database_error' });
    }

    // If caller is staff or non-kiosk device, deny access
    if (!device || device.status !== 'active' || device.type !== 'kiosk') {
      return jsonResponse(403, { error: 'kiosk_device_required' });
    }

    // 4. Verify password against Supabase Auth using isolated passwordVerifier client
    const { data: verified, error: verificationError } = await passwordVerifier.auth.signInWithPassword({
      email: session.user.email,
      password: parsed.data.password,
    });

    if (verificationError || !verified.user || verified.user.id !== session.user.id) {
      return jsonResponse(401, { error: 'invalid_device_password' });
    }

    // Immediately sign out isolated client so no session remains (scope: 'local' preserves existing kiosk browser session)
    try {
      await passwordVerifier.auth.signOut({ scope: 'local' });
    } catch {
      // Ignore client signout error
    }

    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }

    console.error(
      'Device reauthentication error:',
      error instanceof Error ? error.message : 'unknown'
    );

    return jsonResponse(500, { error: 'internal_error' });
  }
}

export default { fetch: handleRequest };
