import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError, recordReconciliation } from '../../actors.js';
import { sendGatewaySms } from '../../sms.js';

export async function handleRequest(request: Request): Promise<Response> {
  const method = request.method;
  if (!['GET', 'POST'].includes(method)) {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  }

  const { admin } = getServerSupabaseClients();
  const url = new URL(request.url);

  // --------------------------------------------------------------------------
  // GET: Fetch office closure status & explanation
  // --------------------------------------------------------------------------
  if (method === 'GET') {
    const officeId = url.searchParams.get('officeId');
    if (!officeId) {
      return jsonResponse(400, { error: 'officeId query parameter is required' });
    }

    const { data: office, error } = await admin
      .from('offices')
      .select('id, name, closure_status, closure_reason, closed_at')
      .eq('id', officeId)
      .maybeSingle();

    if (error || !office) {
      return jsonResponse(404, { error: 'Office not found' });
    }

    return jsonResponse(200, { office });
  }

  // --------------------------------------------------------------------------
  // POST: Toggle office emergency closure & alert registered visitors
  // --------------------------------------------------------------------------
  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'Authentication required' });
  }

  let officeId: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    officeId = body?.officeId;
    const status = body?.status;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const notifyVisitors = Boolean(body?.notifyVisitors);

    if (!officeId || typeof officeId !== 'string') {
      return jsonResponse(400, { error: 'officeId is required' });
    }
    if (!status || !['open', 'closed'].includes(status)) {
      return jsonResponse(400, { error: 'status must be open or closed' });
    }
    if (status === 'closed' && !reason) {
      return jsonResponse(400, { error: 'A closure reason is required when closing an office' });
    }

    const actor = await requireOfficeStaffActor(admin, token, officeId);

    // Call service-role RPC to update closure status
    const { error: closureError } = await admin.rpc('set_office_emergency_closure', {
      requested_office_id: officeId,
      requested_status: status,
      requested_reason: status === 'closed' ? reason : null,
    });

    if (closureError) {
      console.error('Failed to set office emergency closure:', closureError);
      await recordReconciliation(
        admin,
        'office.emergency_closure_failed',
        'offices',
        officeId,
        closureError.message || 'closure_failed',
        { status, reason: reason ?? null }
      );
      return jsonResponse(500, { error: closureError.message || 'Failed to update office closure' });
    }

    let notifiedCount = 0;
    let smsDispatched = 0;

    // If closed and notification requested, alert affected visitors via SMS & Email
    if (status === 'closed' && notifyVisitors) {
      try {
        const { data: visitors, error: vErr } = await admin.rpc('get_office_closure_affected_visitors', {
          requested_office_id: officeId,
        });

        if (!vErr && Array.isArray(visitors) && visitors.length > 0) {
          notifiedCount = visitors.length;

          // Target phone numbers with valid length
          const validPhoneNumbers = visitors
            .map((v: any) => v.contact_number)
            .filter((p: string | null) => p && String(p).trim().replace(/[\s-]/g, '').length >= 7);

          if (validPhoneNumbers.length > 0) {
            const officeName = visitors[0]?.office_name || 'EARIST Office';
            const smsMessage = `EARIST Notice: ${officeName} is temporarily closed due to: ${reason}. Please contact the office or reschedule your visit.`;

            const smsRes = await sendGatewaySms({
              phoneNumbers: validPhoneNumbers,
              message: smsMessage,
              purpose: 'status_update',
              actorId: actor.id,
            });

            if (smsRes.success) {
              smsDispatched = smsRes.recipientCount;
            }
          }
        }
      } catch (notifyErr) {
        console.warn('[OFFICE-CLOSURE] Warning dispatching visitor alerts:', notifyErr);
      }
    }

    return jsonResponse(200, {
      success: true,
      closureStatus: status,
      closureReason: status === 'closed' ? reason : null,
      notifiedVisitorsCount: notifiedCount,
      smsDispatchedCount: smsDispatched,
      message: status === 'closed'
        ? `Office closed. ${smsDispatched > 0 ? `Sent SMS alert to ${smsDispatched} visitors.` : ''}`
        : 'Office marked open.',
    });
  } catch (err: any) {
    if (err instanceof HttpError) {
      return jsonResponse(err.status, { error: err.message });
    }
    console.error('Error toggling office closure:', err);
    return jsonResponse(500, { error: err?.message || 'Internal server error' });
  }
}

export default handleRequest;
