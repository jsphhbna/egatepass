import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({ passId: z.string().min(20).max(200), mode: z.enum(['entry', 'exit']) }).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'Authentication required' });
  if (!parsed.success) return jsonResponse(400, { error: 'Invalid scan request', code: 'invalid_request' });
  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }
    if (session.isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_forbidden' });
    }
    const digest = createHash('sha256').update(parsed.data.passId).digest('hex');
    const { data, error } = await admin.schema('api').rpc('scan_pass', {
      requested_actor_id: session.user.id,
      requested_token_digest: digest,
      requested_mode: parsed.data.mode,
      requested_request_id: randomUUID(),
    }).single<{ ok: boolean; result_status: string | null; code: string | null; message: string }>();
    if (error || !data) throw error ?? new Error('scan_failed');
    if (!data.ok) return jsonResponse(data.code === 'not_found' ? 404 : 409, { error: data.message, code: data.code });
    return jsonResponse(200, { status: data.result_status, message: data.message });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
    if (code === '42501') return jsonResponse(403, { error: `An active ${parsed.data.mode} scanner is required`, code: 'device_not_authorized' });
    console.error('Scanner transaction failed.', error instanceof Error ? error.message : code ?? 'unknown_error');
    return jsonResponse(503, { error: 'Scan could not be processed', code: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
