import { HttpError, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

interface RawReconciliationTask {
  id: string;
  operation: string;
  status: string;
  reference_type: string;
  reference_id: string | null;
  last_error_code: string | null;
  safe_context: Record<string, unknown> | null;
  created_at: string;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['superadmin']);

    const { data: rows, error } = await admin
      .from('reconciliation_tasks')
      .select('id, operation, status, reference_type, reference_id, last_error_code, safe_context, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const items = ((rows ?? []) as unknown as RawReconciliationTask[]).map((row) => ({
      id: row.id,
      type: row.operation,
      status: 'unresolved',
      targetType: row.reference_type,
      targetId: row.reference_id ?? 'unknown',
      createdAt: row.created_at,
      summary: row.last_error_code ? `Error: ${row.last_error_code}` : 'Manual investigation is required',
      requiredActions: ['Inspect linked identity or storage asset', 'Verify consistency and resolve task'],
    }));

    return jsonResponse(200, {
      items,
      count: items.length,
      limit: 50,
      readOnly: true,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Reconciliation items load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
