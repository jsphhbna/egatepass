import { requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { sendGatewaySms, maskPhoneNumber } from '../../sms.js';

export default async function handleSmsRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const { admin } = getServerSupabaseClients();
  const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin\/sms\/?/, '');

  if (request.method === 'GET') {
    if (path === 'recipients') {
      const type = url.searchParams.get('type') || 'emergency';
      if (type === 'overdue') {
        const { data, error } = await admin.schema('api').rpc('get_overdue_campus_visitors');
        if (error) {
          console.error('[SMS-API] get_overdue_campus_visitors error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_overdue_recipients' });
        }
        const recipients = (data || []).map((r: any) => ({
          passId: r.pass_id,
          visitorName: r.visitor_name,
          maskedContact: maskPhoneNumber(r.contact_number),
          validUntil: r.valid_until,
          timeIn: r.time_in,
          gate: r.gate,
        }));
        return jsonResponse(200, {
          type: 'overdue',
          count: recipients.length,
          recipients,
        });
      } else {
        const { data, error } = await admin.schema('api').rpc('get_emergency_sms_recipients');
        if (error) {
          console.error('[SMS-API] get_emergency_sms_recipients error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_emergency_recipients' });
        }
        const recipients = (data || []).map((r: any) => ({
          passId: r.pass_id,
          visitorName: r.visitor_name,
          maskedContact: maskPhoneNumber(r.contact_number),
          timeIn: r.time_in,
          gate: r.gate,
        }));
        return jsonResponse(200, {
          type: 'emergency',
          count: recipients.length,
          recipients,
        });
      }
    }

    if (path === 'logs') {
      const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 100);
      const { data, error } = await admin
        .from('sms_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('[SMS-API] sms_logs error:', error);
        return jsonResponse(500, { error: 'failed_to_fetch_sms_logs' });
      }

      return jsonResponse(200, { logs: data || [] });
    }

    return jsonResponse(404, { error: 'not_found' });
  }

  if (request.method === 'POST') {
    if (path === 'send') {
      const body = await request.json().catch(() => null) as {
        type: 'emergency' | 'overdue' | 'test';
        message: string;
        testNumber?: string;
      } | null;

      if (!body || !body.message || body.message.trim() === '') {
        return jsonResponse(400, { error: 'message_required' });
      }

      const message = body.message.trim();

      // Test send to a single number
      if (body.type === 'test') {
        if (!body.testNumber || body.testNumber.trim() === '') {
          return jsonResponse(400, { error: 'test_number_required' });
        }
        const result = await sendGatewaySms({
          phoneNumbers: [body.testNumber.trim()],
          message,
          purpose: 'manual_test',
          actorId: actor.id,
        });
        if (!result.success) {
          return jsonResponse(502, { error: result.error || 'sms_gateway_error' });
        }
        return jsonResponse(200, { success: true, count: 1 });
      }

      // Emergency Mass SMS
      if (body.type === 'emergency') {
        const { data: recipients, error } = await admin.schema('api').rpc('get_emergency_sms_recipients');
        if (error) throw error;

        const phoneNumbers = Array.from(
          new Set((recipients || []).map((r: any) => r.contact_number).filter(Boolean))
        ) as string[];

        if (phoneNumbers.length === 0) {
          return jsonResponse(200, { success: true, count: 0, message: 'no_active_visitors_inside' });
        }

        // Split into batches of 50
        const BATCH_SIZE = 50;
        let sentCount = 0;
        let failCount = 0;

        for (let i = 0; i < phoneNumbers.length; i += BATCH_SIZE) {
          const batch = phoneNumbers.slice(i, i + BATCH_SIZE);
          const result = await sendGatewaySms({
            phoneNumbers: batch,
            message,
            purpose: 'emergency_roll_call',
            actorId: actor.id,
          });
          if (result.success) {
            sentCount += batch.length;
          } else {
            failCount += batch.length;
          }
        }

        return jsonResponse(200, {
          success: sentCount > 0,
          count: sentCount,
          failedCount: failCount,
          total: phoneNumbers.length,
        });
      }

      // Overdue Visitor Warning SMS
      if (body.type === 'overdue') {
        const { data: overdueVisitors, error } = await admin.schema('api').rpc('get_overdue_campus_visitors');
        if (error) throw error;

        const phoneNumbers = Array.from(
          new Set((overdueVisitors || []).map((r: any) => r.contact_number).filter(Boolean))
        ) as string[];

        if (phoneNumbers.length === 0) {
          return jsonResponse(200, { success: true, count: 0, message: 'no_overdue_visitors' });
        }

        const BATCH_SIZE = 50;
        let sentCount = 0;
        let failCount = 0;

        for (let i = 0; i < phoneNumbers.length; i += BATCH_SIZE) {
          const batch = phoneNumbers.slice(i, i + BATCH_SIZE);
          const result = await sendGatewaySms({
            phoneNumbers: batch,
            message,
            purpose: 'overdue_exit_warning',
            actorId: actor.id,
          });
          if (result.success) {
            sentCount += batch.length;
          } else {
            failCount += batch.length;
          }
        }

        return jsonResponse(200, {
          success: sentCount > 0,
          count: sentCount,
          failedCount: failCount,
          total: phoneNumbers.length,
        });
      }

      return jsonResponse(400, { error: 'invalid_sms_type' });
    }

    return jsonResponse(404, { error: 'not_found' });
  }

  return jsonResponse(405, { error: 'method_not_allowed' });
}
