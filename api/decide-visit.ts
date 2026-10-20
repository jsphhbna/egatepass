import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const schema = z.object({
  passId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(500).nullable(),
}).strict().superRefine((value, context) => {
  if (value.decision === 'approved' && value.reason !== null) context.addIssue({ code: 'custom', message: 'approval cannot include a reason' });
  if (value.decision === 'rejected' && value.reason === null) context.addIssue({ code: 'custom', message: 'rejection requires a reason' });
});

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!token) return jsonResponse(401, { error: 'Authentication required' });
  if (!parsed.success) return jsonResponse(400, { error: 'Invalid decision request' });
  try {
    const { admin } = getServerSupabaseClients();
    const { data: identity, error: authError } = await admin.auth.getUser(token);
    if (authError || !identity.user) return jsonResponse(401, { error: 'Invalid or expired session' });
    const { data, error } = await admin.schema('api').rpc('decide_visit', {
      requested_actor_id: identity.user.id,
      requested_pass_id: parsed.data.passId,
      requested_decision: parsed.data.decision,
      requested_reason: parsed.data.reason,
      requested_request_id: randomUUID(),
    });
    if (error) {
      if (error.code === '40001') return jsonResponse(409, { error: 'This pass is no longer waiting for a decision' });
      if (error.code === 'P0002') return jsonResponse(404, { error: 'Pass not found' });
      if (error.code === '22023' || error.message?.includes('pass_has_expired')) {
        return jsonResponse(422, { error: 'Pass has expired and cannot be approved' });
      }
      throw error;
    }
    return jsonResponse(200, { status: data });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
    if (code === '42501') return jsonResponse(403, { error: 'Guard access required' });
    console.error('Visitor decision failed.', error instanceof Error ? error.message : code ?? 'unknown_error');
    return jsonResponse(503, { error: 'Decision could not be recorded' });
  }
}

export default { fetch: handleRequest };
