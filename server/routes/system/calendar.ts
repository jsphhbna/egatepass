import { jsonResponse } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const { admin } = getServerSupabaseClients();
  const url = new URL(request.url);
  const fromDate = url.searchParams.get('from');
  const toDate = url.searchParams.get('to');

  let query = admin
    .from('campus_calendar_closures')
    .select('id, title, closure_type, start_date, end_date, description, active, published, archived_at')
    .eq('active', true)
    .eq('published', true)
    .is('archived_at', null)
    .order('start_date', { ascending: true });

  if (fromDate) {
    query = query.gte('end_date', fromDate);
  }
  if (toDate) {
    query = query.lte('start_date', toDate);
  }

  const { data, error } = await query;
  if (error) {
    return jsonResponse(500, { error: 'database_error', message: error.message });
  }

  const closures = (data || []).map((row) => ({
    id: row.id,
    title: row.title,
    closureType: row.closure_type,
    startDate: row.start_date,
    endDate: row.end_date,
    description: row.description,
    active: row.active,
    published: row.published,
  }));

  return jsonResponse(200, { closures });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
