import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { decryptQrPayload } from '../../lib/encryption.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';
import { generateQrPngBuffer } from '../../email.js';
import { renderOfficeVisitApprovedEmail, renderOfficeVisitRejectedEmail } from '../../templates/index.js';
import { deliverOfficeEmail, isPositiveRpcSuccess } from '../../lib/officeDelivery.js';

const schema = z.object({
  visitId: z.string().uuid(),
  action: z.enum(['retry', 'mark_delivered', 'permit_retry']).optional().default('retry'),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.action === 'mark_delivered' || data.action === 'permit_retry') {
    if (!data.note || data.note.trim().length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: `${data.action} requires an audit note of at least 3 characters.`,
      });
    }
  }
});

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
    const actor = await requireOfficeStaffActor(admin, token, visit.office_id);

    if (visit.approval_status === 'pending' || visit.approval_status === 'not_required') {
      return jsonResponse(400, {
        error: 'visit_not_decided',
        message: 'Email retry is only available for approved or rejected visits.',
      });
    }

    if (parsed.data.action === 'mark_delivered' || parsed.data.action === 'permit_retry') {
      const { data: recRows, error: recErr } = await admin.schema('api').rpc('reconcile_office_visit_email', {
        requested_actor_id: actor.id,
        requested_visit_id: visit.id,
        requested_action: parsed.data.action,
        requested_note: parsed.data.note || null,
      });

      if (recErr) {
        if (recErr.message?.includes('already_delivered')) {
          return jsonResponse(409, { error: 'email_already_delivered', message: 'Email is already delivered.' });
        }
        if (recErr.message?.includes('only_for_unknown_or_failed')) {
          return jsonResponse(400, { error: 'invalid_reconciliation_state', message: recErr.message });
        }
        if (recErr.message?.includes('reconciliation_note_required')) {
          return jsonResponse(400, { error: 'invalid_reconciliation_note', message: recErr.message });
        }
        if (recErr.code === '40900') {
          return jsonResponse(409, { error: 'conflict', message: recErr.message });
        }
        throw recErr;
      }

      const recResult = Array.isArray(recRows) ? recRows[0] : recRows;
      if (!isPositiveRpcSuccess(recResult, recErr)) {
        return jsonResponse(500, {
          error: 'reconciliation_persistence_unconfirmed',
          message: 'The database did not positively confirm reconciliation persistence.',
        });
      }

      return jsonResponse(200, {
        ok: true,
        action: parsed.data.action,
        status: recResult?.new_status || 'reconciled',
        message: parsed.data.action === 'mark_delivered'
          ? 'Email delivery manually confirmed as delivered.'
          : 'Email delivery reset to failed and retry permitted.',
      });
    }

    if (!visit.visitor_email) {
      return jsonResponse(400, {
        error: 'missing_visitor_email',
        message: 'No email address on file for this visitor.',
      });
    }

    const emailType = visit.approval_status === 'approved' ? 'approval' : 'rejection';
    const visitorName = visit.visitor_display_name || `${visit.visitor_first_name || ''} ${visit.visitor_last_name || ''}`.trim();
    const officeName = (visit.offices as any)?.name || 'EARIST Office';
    const personnelName = (visit.office_personnel as any)?.name || 'Faculty / Staff';
    const formattedVisitDate = visit.visit_date instanceof Date
      ? visit.visit_date.toISOString().slice(0, 10)
      : String(visit.visit_date || '');

    const defaultIdempotencyKey = `office-${emailType}-${visit.id}`;

    // 3. Atomically deliver via shared deliverOfficeEmail helper
    const deliveryResult = await deliverOfficeEmail(admin, {
      visitId: visit.id,
      visitorEmail: visit.visitor_email,
      emailType,
      defaultIdempotencyKey,
      prepareContent: async (claim) => {
        if (emailType === 'approval') {
          if (!claim.encrypted_token_payload) {
            throw new Error('missing_encrypted_token_payload');
          }

          // Decrypt the exact canonical QR token stored in outbox
          const rawQrToken = decryptQrPayload(claim.encrypted_token_payload);
          const publicRef = (visit.passes as any)?.public_reference || '';

          const qrBuffer = await generateQrPngBuffer(rawQrToken);
          const attachmentFilename = `egatepass-${publicRef ? publicRef.slice(0, 8) : 'visit'}.png`;

          const html = await renderOfficeVisitApprovedEmail({
            fullName: visitorName,
            officeName,
            personnelName,
            visitDate: formattedVisitDate,
            purpose: visit.purpose,
            publicReference: publicRef,
            attachmentFilename,
          });

          return {
            subject: `Approved: EARIST E-GatePass for ${officeName}`,
            html,
            attachments: [
              {
                filename: attachmentFilename,
                content: qrBuffer.toString('base64'),
                content_type: 'image/png',
              },
            ],
          };
        } else {
          // Rejection notice email
          const html = await renderOfficeVisitRejectedEmail({
            fullName: visitorName,
            officeName,
            personnelName,
            visitDate: formattedVisitDate,
            rejectionReason: claim.rejection_reason || 'Schedule conflict or personnel unavailable.',
          });

          return {
            subject: `Update on your visit request to ${officeName}`,
            html,
          };
        }
      },
    });

    if (deliveryResult.status === 'none' || deliveryResult.status === 'pending') {
      return jsonResponse(404, {
        error: 'outbox_record_not_found',
        message: 'No email delivery record exists for this visit.',
      });
    }

    if (
      deliveryResult.error?.includes('email_lease_active_in_progress') ||
      deliveryResult.error?.includes('email_already_sent_or_delivered') ||
      deliveryResult.error?.includes('in_progress_or_sent')
    ) {
      return jsonResponse(409, {
        error: 'email_already_sent_or_in_progress',
        message: 'An email is currently being processed or has already been delivered.',
      });
    }

    if (deliveryResult.reconciliationRequired) {
      if (deliveryResult.status === 'sent') {
        // Provider accepted the email, but database persistence degraded/fell back
        return jsonResponse(200, {
          ok: true,
          status: 'sent',
          providerMessageId: deliveryResult.providerMessageId,
          message: emailType === 'approval'
            ? 'Approval email with QR pass resent successfully (persistence degraded; awaiting webhook reconciliation).'
            : 'Rejection notice email resent successfully (persistence degraded; awaiting webhook reconciliation).',
          reconciliationRequired: true,
        });
      }
      return jsonResponse(409, {
        error: 'email_delivery_outcome_unknown',
        message: 'The outcome of the previous delivery attempt is uncertain. Automatic retry is suspended until verified via webhook or manual reconciliation.',
        reconciliationRequired: true,
      });
    }

    if (deliveryResult.status === 'sent') {
      return jsonResponse(200, {
        ok: true,
        status: 'sent',
        providerMessageId: deliveryResult.providerMessageId,
        message: emailType === 'approval'
          ? 'Approval email with QR pass resent successfully.'
          : 'Rejection notice email resent successfully.',
      });
    }

    return jsonResponse(502, {
      error: 'email_dispatch_failed',
      message: `Resend failed to deliver email: ${deliveryResult.error || 'email_dispatch_failed'}`,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Email retry error:', error);
    return jsonResponse(500, { error: 'retry_failed' });
  }
}

export default { fetch: handleRequest };
