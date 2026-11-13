import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';

export async function handleRequest(request: Request): Promise<Response> {
  const method = request.method;
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET, POST, DELETE' });
  }

  const { admin } = getServerSupabaseClients();
  const url = new URL(request.url);

  // --------------------------------------------------------------------------
  // GET: Fetch office calendar schedules (public for visitor booking & staff)
  // --------------------------------------------------------------------------
  if (method === 'GET') {
    const officeId = url.searchParams.get('officeId');
    if (!officeId) {
      return jsonResponse(400, { error: 'officeId query parameter is required' });
    }

    const { data: schedules, error } = await admin
      .from('office_calendar_schedules')
      .select('id, office_id, schedule_date, status, reason, created_at, updated_at')
      .eq('office_id', officeId)
      .order('schedule_date', { ascending: true });

    if (error) {
      console.error('Failed to fetch office calendar schedules:', error);
      return jsonResponse(500, { error: 'Failed to fetch office calendar schedules' });
    }

    return jsonResponse(200, { schedules: schedules || [] });
  }

  // --------------------------------------------------------------------------
  // POST & DELETE: Requires authenticated office staff or administrator
  // --------------------------------------------------------------------------
  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'Authentication required' });
  }

  if (method === 'POST') {
    let officeId: string | undefined;
    try {
      const body = await request.json();
      const parsed = body || {};
      officeId = parsed.officeId;
      const { scheduleDate, status, reason } = parsed;

      if (!officeId || typeof officeId !== 'string') {
        return jsonResponse(400, { error: 'officeId is required' });
      }
      if (!scheduleDate || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate)) {
        return jsonResponse(400, { error: 'Valid scheduleDate (YYYY-MM-DD) is required' });
      }
      if (!status || !['open', 'closed', 'maintenance', 'holiday'].includes(status)) {
        return jsonResponse(400, { error: 'status must be open, closed, maintenance, or holiday' });
      }

      const actor = await requireOfficeStaffActor(admin, token, officeId);

      const trimmedReason = typeof reason === 'string' ? reason.trim().slice(0, 250) : null;

      const { data: schedule, error } = await admin
        .from('office_calendar_schedules')
        .upsert(
          {
            office_id: officeId,
            schedule_date: scheduleDate,
            status,
            reason: trimmedReason,
            created_by: actor.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'office_id,schedule_date' }
        )
        .select()
        .single();

      if (error) {
        console.error('Failed to set office calendar schedule:', error);
        return jsonResponse(500, { error: 'Failed to set office calendar schedule' });
      }

      return jsonResponse(200, { success: true, schedule });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.message });
      }
      console.error('Error updating office calendar:', {
        officeId,
        error: err?.message || 'unknown_error',
      });
      return jsonResponse(500, { error: err?.message || 'Internal server error' });
    }
  }

  if (method === 'DELETE') {
    let officeId = url.searchParams.get('officeId');
    let scheduleDate = url.searchParams.get('scheduleDate');
    try {
      if (!officeId || !scheduleDate) {
        try {
          const body = await request.json();
          officeId = officeId || body?.officeId;
          scheduleDate = scheduleDate || body?.scheduleDate;
        } catch {
          // No body
        }
      }

      if (!officeId || !scheduleDate) {
        return jsonResponse(400, { error: 'officeId and scheduleDate are required' });
      }

      await requireOfficeStaffActor(admin, token, officeId);

      const { error } = await admin
        .from('office_calendar_schedules')
        .delete()
        .eq('office_id', officeId)
        .eq('schedule_date', scheduleDate);

      if (error) {
        console.error('Failed to delete office calendar schedule:', {
          officeId,
          scheduleDate,
          error: error.message,
        });
        return jsonResponse(500, { error: 'Failed to delete office calendar schedule' });
      }

      return jsonResponse(200, { success: true });
    } catch (err: any) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.message });
      }
      console.error('Error deleting office calendar schedule:', {
        officeId,
        scheduleDate,
        error: err?.message || 'unknown_error',
      });
      return jsonResponse(500, { error: err?.message || 'Internal server error' });
    }
  }

  return jsonResponse(405, { error: 'Method not allowed' });
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
export default { fetch: handleRequest };
