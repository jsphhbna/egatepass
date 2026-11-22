import { requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { sendGatewaySms, maskPhoneNumber, normalizePhilippinePhone } from '../../sms.js';

export default async function handleSmsRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const { admin } = getServerSupabaseClients();
  const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/admin\/sms\/?/, '');

  if (request.method === 'GET') {
    // ------------------------------------------------------------------------
    // 1. Recipient Query: Emergency inside-campus or Overdue visitors
    // ------------------------------------------------------------------------
    if (path === 'recipients') {
      const type = url.searchParams.get('type') || 'emergency';

      if (type === 'overdue') {
        const { data, error } = await admin.schema('api').rpc('get_overdue_campus_visitors', {
          requested_actor_id: actor.id,
        });

        if (error) {
          console.error('[SMS-API] get_overdue_campus_visitors error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_overdue_recipients', details: error.message });
        }

        const recipients = (data || []).map((r: any) => ({
          passId: r.pass_id,
          visitorName: r.visitor_name,
          maskedContact: maskPhoneNumber(r.contact_number),
          validUntil: r.valid_until,
          timeIn: r.time_in,
          gate: r.gate,
        }));

        // Unique deduplicated phone count
        const uniquePhones = new Set(
          (data || [])
            .map((r: any) => normalizePhilippinePhone(r.contact_number))
            .filter(Boolean)
        );

        return jsonResponse(200, {
          type: 'overdue',
          count: recipients.length,
          uniqueRecipientCount: uniquePhones.size,
          recipients,
        });
      } else {
        const { data, error } = await admin.schema('api').rpc('get_emergency_sms_recipients', {
          requested_actor_id: actor.id,
        });

        if (error) {
          console.error('[SMS-API] get_emergency_sms_recipients error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_emergency_recipients', details: error.message });
        }

        const recipients = (data || []).map((r: any) => ({
          passId: r.pass_id,
          visitorName: r.visitor_name,
          maskedContact: maskPhoneNumber(r.contact_number),
          timeIn: r.time_in,
          gate: r.gate,
        }));

        const uniquePhones = new Set(
          (data || [])
            .map((r: any) => normalizePhilippinePhone(r.contact_number))
            .filter(Boolean)
        );

        return jsonResponse(200, {
          type: 'emergency',
          count: recipients.length,
          uniqueRecipientCount: uniquePhones.size,
          recipients,
        });
      }
    }

    // ------------------------------------------------------------------------
    // 2. Daily Quota & Health Query
    // ------------------------------------------------------------------------
    if (path === 'quota') {
      const { data, error } = await admin.schema('api').rpc('check_and_reserve_sms_quota', {
        requested_actor_id: actor.id,
        requested_count: 0,
      });

      if (error) {
        console.error('[SMS-API] check_and_reserve_sms_quota error:', error);
        return jsonResponse(500, { error: 'failed_to_fetch_quota', details: error.message });
      }

      return jsonResponse(200, { quota: data });
    }

    // ------------------------------------------------------------------------
    // 3. SMS Activity Logs
    // ------------------------------------------------------------------------
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

      // ======================================================================
      // A. Test SMS (Single number)
      // ======================================================================
      if (body.type === 'test') {
        if (!body.testNumber || body.testNumber.trim() === '') {
          return jsonResponse(400, { error: 'test_number_required' });
        }

        const normalized = normalizePhilippinePhone(body.testNumber);
        if (!normalized) {
          return jsonResponse(400, {
            error: 'invalid_philippine_phone_number',
            message: 'Phone number must be a valid 11-digit Philippine mobile number (e.g. 09171234567 or +639171234567).',
          });
        }

        const campaignId = `camp_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Atomic daily SMS cap reservation (1 recipient)
        const { data: quota, error: quotaErr } = await admin.schema('api').rpc('check_and_reserve_sms_quota', {
          requested_actor_id: actor.id,
          requested_count: 1,
          campaign_id: campaignId,
        });

        if (quotaErr) {
          console.error('[SMS-API] Quota reservation error:', quotaErr);
          return jsonResponse(500, { error: 'quota_check_failed' });
        }

        if (quota && quota.allowed === false) {
          return jsonResponse(429, {
            error: 'daily_sms_cap_exceeded',
            message: `Daily SMS cap of ${quota.daily_cap} reached (${quota.current_count} messages sent/reserved today).`,
            quota,
          });
        }

        const result = await sendGatewaySms({
          phoneNumbers: [normalized],
          message,
          purpose: 'manual_test',
          actorId: actor.id,
          campaignId,
        });

        // Finalize quota state: release only if pre-send or gateway failed without timeout
        const outcome = result.success ? 'consumed' : (result.status === 'unknown' ? 'timeout' : 'released');
        try {
          await admin.schema('api').rpc('finalize_sms_quota', {
            campaign_id: campaignId,
            outcome,
            requested_actor_id: actor.id,
          });
        } catch (err: any) {
          console.error('[SMS-API] Quota finalization error:', err);
        }

        if (!result.success) {
          return jsonResponse(502, {
            error: result.error || 'sms_gateway_error',
            status: result.status || 'failed',
            transactionId: result.transactionId,
          });
        }

        return jsonResponse(200, {
          success: true,
          count: 1,
          status: 'accepted_by_gateway',
          message: 'Test SMS accepted by gateway and queued for Android device dispatch.',
          messageId: result.messageId,
          transactionId: result.transactionId,
          campaignId,
        });
      }

      // ======================================================================
      // B. Emergency Mass SMS (Active Visitors inside campus)
      // ======================================================================
      if (body.type === 'emergency') {
        const { data: recipients, error } = await admin.schema('api').rpc('get_emergency_sms_recipients', {
          requested_actor_id: actor.id,
        });
        if (error) {
          console.error('[SMS-API] Emergency recipient query error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_emergency_recipients', details: error.message });
        }

        // Deduplicate and normalize recipient phone numbers (exclude invalid before reservation)
        const phoneSet = new Set<string>();
        for (const r of (recipients || [])) {
          const norm = normalizePhilippinePhone(r.contact_number);
          if (norm) phoneSet.add(norm);
        }
        const phoneNumbers = Array.from(phoneSet);

        if (phoneNumbers.length === 0) {
          return jsonResponse(200, {
            success: true,
            count: 0,
            message: 'no_active_visitors_with_contact_number',
          });
        }

        const campaignId = `camp_em_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Atomic reservation for the full recipient count
        const { data: quota, error: quotaErr } = await admin.schema('api').rpc('check_and_reserve_sms_quota', {
          requested_actor_id: actor.id,
          requested_count: phoneNumbers.length,
          campaign_id: campaignId,
        });

        if (quotaErr) {
          console.error('[SMS-API] Quota reservation error:', quotaErr);
          return jsonResponse(500, { error: 'quota_check_failed' });
        }

        if (quota && quota.allowed === false) {
          return jsonResponse(429, {
            error: 'daily_sms_cap_exceeded',
            message: `Emergency broadcast of ${phoneNumbers.length} messages exceeds remaining daily safety cap of ${quota.remaining} (${quota.current_count}/${quota.daily_cap} used today).`,
            quota,
          });
        }

        // Chunk into safe batches of 50
        const BATCH_SIZE = 50;
        let acceptedCount = 0;
        let failCount = 0;
        let unknownCount = 0;

        for (let i = 0; i < phoneNumbers.length; i += BATCH_SIZE) {
          const batch = phoneNumbers.slice(i, i + BATCH_SIZE);
          const result = await sendGatewaySms({
            phoneNumbers: batch,
            message,
            purpose: 'emergency_roll_call',
            actorId: actor.id,
            campaignId,
            batchId: `${campaignId}_batch_${Math.floor(i / BATCH_SIZE) + 1}`,
          });

          if (result.success) {
            acceptedCount += batch.length;
          } else if (result.status === 'unknown') {
            unknownCount += batch.length;
          } else {
            failCount += batch.length;
          }
        }

        // Finalize quota: if any were accepted or ambiguous timeout, consume; release only if zero accepted & zero unknown
        const outcome = (acceptedCount > 0 || unknownCount > 0) ? 'consumed' : 'released';
        try {
          await admin.schema('api').rpc('finalize_sms_quota', {
            campaign_id: campaignId,
            outcome,
            requested_actor_id: actor.id,
          });
        } catch (err: any) {
          console.error('[SMS-API] Quota finalization error:', err);
        }

        return jsonResponse(200, {
          success: acceptedCount > 0,
          acceptedCount,
          failedCount: failCount,
          unknownCount,
          total: phoneNumbers.length,
          status: 'accepted_by_gateway',
          campaignId,
          message: `Emergency SMS broadcast: ${acceptedCount} accepted by gateway for SIM dispatch, ${failCount} failed${unknownCount > 0 ? `, ${unknownCount} timed out` : ''}.`,
        });
      }

      // ======================================================================
      // C. Overdue Campus Visitor Warning SMS
      // ======================================================================
      if (body.type === 'overdue') {
        const { data: overdueVisitors, error } = await admin.schema('api').rpc('get_overdue_campus_visitors', {
          requested_actor_id: actor.id,
        });
        if (error) {
          console.error('[SMS-API] Overdue visitor query error:', error);
          return jsonResponse(500, { error: 'failed_to_fetch_overdue_recipients', details: error.message });
        }

        const phoneSet = new Set<string>();
        for (const r of (overdueVisitors || [])) {
          const norm = normalizePhilippinePhone(r.contact_number);
          if (norm) phoneSet.add(norm);
        }
        const phoneNumbers = Array.from(phoneSet);

        if (phoneNumbers.length === 0) {
          return jsonResponse(200, {
            success: true,
            count: 0,
            message: 'no_overdue_visitors',
          });
        }

        const campaignId = `camp_od_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Atomic reservation for full overdue count
        const { data: quota, error: quotaErr } = await admin.schema('api').rpc('check_and_reserve_sms_quota', {
          requested_actor_id: actor.id,
          requested_count: phoneNumbers.length,
          campaign_id: campaignId,
        });

        if (quotaErr) {
          console.error('[SMS-API] Quota reservation error:', quotaErr);
          return jsonResponse(500, { error: 'quota_check_failed' });
        }

        if (quota && quota.allowed === false) {
          return jsonResponse(429, {
            error: 'daily_sms_cap_exceeded',
            message: `Overdue warning batch of ${phoneNumbers.length} messages exceeds remaining daily safety cap of ${quota.remaining} (${quota.current_count}/${quota.daily_cap} used today).`,
            quota,
          });
        }

        const BATCH_SIZE = 50;
        let acceptedCount = 0;
        let failCount = 0;
        let unknownCount = 0;

        for (let i = 0; i < phoneNumbers.length; i += BATCH_SIZE) {
          const batch = phoneNumbers.slice(i, i + BATCH_SIZE);
          const result = await sendGatewaySms({
            phoneNumbers: batch,
            message,
            purpose: 'overdue_exit_warning',
            actorId: actor.id,
            campaignId,
            batchId: `${campaignId}_batch_${Math.floor(i / BATCH_SIZE) + 1}`,
          });

          if (result.success) {
            acceptedCount += batch.length;
          } else if (result.status === 'unknown') {
            unknownCount += batch.length;
          } else {
            failCount += batch.length;
          }
        }

        const outcome = (acceptedCount > 0 || unknownCount > 0) ? 'consumed' : 'released';
        try {
          await admin.schema('api').rpc('finalize_sms_quota', {
            campaign_id: campaignId,
            outcome,
            requested_actor_id: actor.id,
          });
        } catch (err: any) {
          console.error('[SMS-API] Quota finalization error:', err);
        }

        return jsonResponse(200, {
          success: acceptedCount > 0,
          acceptedCount,
          failedCount: failCount,
          unknownCount,
          total: phoneNumbers.length,
          status: 'accepted_by_gateway',
          campaignId,
          message: `Overdue visitor notices: ${acceptedCount} accepted by gateway for SIM dispatch, ${failCount} failed${unknownCount > 0 ? `, ${unknownCount} timed out` : ''}.`,
        });
      }

      return jsonResponse(400, { error: 'invalid_sms_type' });
    }

    return jsonResponse(404, { error: 'not_found' });
  }

  return jsonResponse(405, { error: 'method_not_allowed' });
}
