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
    .select('id, title, closure_type, start_date, end_date, description, active, published')
    .eq('active', true)
    .eq('published', true)
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

  return jsonResponse(200, { closures: data || [] });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
