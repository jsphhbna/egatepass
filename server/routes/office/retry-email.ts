import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { decryptQrPayload } from '../../lib/encryption.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';
import { sendResendEmail, generateQrPngBuffer, EmailDeliveryError } from '../../email.js';
import { renderOfficeVisitApprovedEmail, renderOfficeVisitRejectedEmail } from '../../templates/index.js';

const schema = z.object({
  visitId: z.string().uuid(),
}).strict();

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonResponse(400, { error: 'Invalid retry request', details: parsed.error.issues });
  }

  try {
    const { admin } = getServerSupabaseClients();

    // 1. Fetch visit record to check office binding and status
    const { data: visit, error: fetchErr } = await admin
      .from('office_visits')
      .select(`
        id,
        office_id,
        visitor_first_name,
        visitor_last_name,
        visitor_display_name,
        visitor_email,
        purpose,
        visit_date,
        approval_status,
        passes (
          id,
          public_reference
        ),
        offices ( name ),
        office_personnel ( name )
      `)
      .eq('id', parsed.data.visitId)
      .maybeSingle();

    if (fetchErr || !visit) {
      return jsonResponse(404, { error: 'visit_not_found' });
    }

    // 2. Authorize office staff for this specific office
    await requireOfficeStaffActor(admin, token, visit.office_id);

    if (visit.approval_status === 'pending' || visit.approval_status === 'not_required') {
      return jsonResponse(400, {
        error: 'visit_not_decided',
        message: 'Email retry is only available for approved or rejected visits.',
      });
    }

    const emailType = visit.approval_status === 'approved' ? 'approval' : 'rejection';

    // 3. Atomically claim outbox record for delivery
    const { data: claimRows, error: claimErr } = await admin.schema('api').rpc('claim_office_visit_email_for_delivery', {
      requested_visit_id: visit.id,
      requested_email_type: emailType,
    });

    if (claimErr) {
      if (claimErr.code === '40900' || claimErr.message?.includes('in_progress_or_sent')) {
        return jsonResponse(409, {
          error: 'email_already_sent_or_in_progress',
          message: 'An email is currently being processed or has already been delivered.',
        });
      }
      if (claimErr.message?.includes('outcome_unknown')) {
        return jsonResponse(409, {
          error: 'email_delivery_outcome_unknown',
          message: 'The outcome of the previous delivery attempt is uncertain. Automatic retry is suspended until verified via webhook or manual reconciliation.',
        });
      }
      throw claimErr;
    }

    const outboxRecord = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!outboxRecord?.outbox_id) {
      return jsonResponse(404, {
        error: 'outbox_record_not_found',
        message: 'No email delivery record exists for this visit.',
      });
    }

    const visitorName = visit.visitor_display_name || `${visit.visitor_first_name || ''} ${visit.visitor_last_name || ''}`.trim();
    const officeName = (visit.offices as any)?.name || 'EARIST Office';
    const personnelName = (visit.office_personnel as any)?.name || 'Faculty / Staff';

    // 4. Execute safe delivery based on decision type
    if (emailType === 'approval') {
      if (!outboxRecord.encrypted_token_payload) {
        throw new Error('missing_encrypted_token_payload');
      }

      // Decrypt the exact canonical QR token stored in outbox
      const rawQrToken = decryptQrPayload(outboxRecord.encrypted_token_payload);
      const publicRef = (visit.passes as any)?.public_reference || '';

      const qrBuffer = await generateQrPngBuffer(rawQrToken);
      const attachmentFilename = `egatepass-${publicRef ? publicRef.slice(0, 8) : 'visit'}.png`;

      const html = await renderOfficeVisitApprovedEmail({
        fullName: visitorName,
        officeName,
        personnelName,
        visitDate: visit.visit_date,
        purpose: visit.purpose,
        publicReference: publicRef,
        attachmentFilename,
      });

      try {
        const sendResult = await sendResendEmail({
          to: outboxRecord.recipient_email,
          subject: `Approved: EARIST E-GatePass for ${officeName}`,
          html,
          idempotencyKey: outboxRecord.idempotency_key || `office-approval-${visit.id}`,
          attachments: [
            {
              filename: attachmentFilename,
              content: qrBuffer.toString('base64'),
              content_type: 'image/png',
            },
          ],
        });

        await admin.schema('api').rpc('record_office_visit_email_result', {
          requested_outbox_id: outboxRecord.outbox_id,
          requested_claim_id: outboxRecord.claim_id,
          requested_status: 'sent',
          requested_provider_message_id: sendResult?.id || null,
          requested_error: null,
        });

        return jsonResponse(200, {
          ok: true,
          status: 'sent',
          message: 'Approval email with QR pass resent successfully.',
        });
      } catch (sendErr) {
        const outcome = (sendErr instanceof EmailDeliveryError && sendErr.outcome === 'unknown')
          ? 'unknown'
          : 'failed';
        const errMsg = sendErr instanceof Error ? sendErr.message : 'email_dispatch_failed';

        await admin.schema('api').rpc('record_office_visit_email_result', {
          requested_outbox_id: outboxRecord.outbox_id,
          requested_claim_id: outboxRecord.claim_id,
          requested_status: outcome,
          requested_provider_message_id: null,
          requested_error: errMsg,
        });

        return jsonResponse(502, {
          error: 'email_dispatch_failed',
          message: `Resend failed to deliver email: ${errMsg}`,
        });
      }
    } else {
      // Rejection email
      const html = await renderOfficeVisitRejectedEmail({
        fullName: visitorName,
        officeName,
        personnelName,
        visitDate: visit.visit_date,
        rejectionReason: outboxRecord.rejection_reason || 'Schedule conflict or personnel unavailable.',
      });

      try {
        const sendResult = await sendResendEmail({
          to: outboxRecord.recipient_email,
          subject: `Update on your visit request to ${officeName}`,
          html,
          idempotencyKey: outboxRecord.idempotency_key || `office-rejection-${visit.id}`,
        });

        await admin.schema('api').rpc('record_office_visit_email_result', {
          requested_outbox_id: outboxRecord.outbox_id,
          requested_claim_id: outboxRecord.claim_id,
          requested_status: 'sent',
          requested_provider_message_id: sendResult?.id || null,
          requested_error: null,
        });

        return jsonResponse(200, {
          ok: true,
          status: 'sent',
          message: 'Rejection notice email resent successfully.',
        });
      } catch (sendErr) {
        const outcome = (sendErr instanceof EmailDeliveryError && sendErr.outcome === 'unknown')
          ? 'unknown'
          : 'failed';
        const errMsg = sendErr instanceof Error ? sendErr.message : 'email_dispatch_failed';

        await admin.schema('api').rpc('record_office_visit_email_result', {
          requested_outbox_id: outboxRecord.outbox_id,
          requested_claim_id: outboxRecord.claim_id,
          requested_status: outcome,
          requested_provider_message_id: null,
          requested_error: errMsg,
        });

        return jsonResponse(502, {
          error: 'email_dispatch_failed',
          message: `Resend failed to deliver email: ${errMsg}`,
        });
      }
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Email retry error:', error);
    return jsonResponse(500, { error: 'retry_failed' });
  }
}

export default { fetch: handleRequest };
