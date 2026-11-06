import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { encryptQrPayload } from '../../lib/encryption.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';
import { sendResendEmail, generateQrPngBuffer, EmailDeliveryError } from '../../email.js';
import { renderOfficeVisitApprovedEmail, renderOfficeVisitRejectedEmail } from '../../templates/index.js';

const schema = z.object({
  visitId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(500).optional(),
}).strict().superRefine((val, ctx) => {
  if (val.decision === 'rejected') {
    if (!val.rejectionReason || val.rejectionReason.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionReason'],
        message: 'A rejection reason is required.',
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
    return jsonResponse(400, { error: 'Invalid decision request', details: parsed.error.issues });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireOfficeStaffActor(admin, token);

    // Fetch the visit to check office assignment
    const { data: visit, error: fetchErr } = await admin
      .from('office_visits')
      .select(`
        id,
        office_id,
        visitor_first_name,
        visitor_last_name,
        visitor_email,
        purpose,
        visit_date,
        approval_status,
        offices ( name ),
        office_personnel ( name )
      `)
      .eq('id', parsed.data.visitId)
      .maybeSingle();

    if (fetchErr || !visit) {
      return jsonResponse(404, { error: 'visit_not_found' });
    }

    if (actor.role === 'office_staff' && !actor.assignedOfficeIds.includes(visit.office_id)) {
      return jsonResponse(403, { error: 'unauthorized_for_this_office' });
    }

    if (visit.approval_status !== 'pending') {
      return jsonResponse(409, { error: 'visit_already_decided' });
    }

    const visitorName = `${visit.visitor_first_name} ${visit.visitor_last_name}`.trim();
    const officeName = (visit.offices as any)?.name || 'EARIST Office';
    const personnelName = (visit.office_personnel as any)?.name || 'Faculty / Staff';

    if (parsed.data.decision === 'rejected') {
      const reason = parsed.data.rejectionReason || 'Schedule conflict or personnel unavailable.';
      const rejectionIdempotencyKey = `office-rejection-${visit.id}`;

      const { error: rpcErr } = await admin.schema('api').rpc('decide_office_visit', {
        requested_actor_id: actor.id,
        requested_visit_id: visit.id,
        requested_decision: 'rejected',
        requested_rejection_reason: reason,
        requested_token_digest: null,
        requested_encrypted_payload: null,
        requested_idempotency_key: rejectionIdempotencyKey,
      });

      if (rpcErr) {
        if (rpcErr.code === '40900' || rpcErr.message?.includes('already_decided')) {
          return jsonResponse(409, { error: 'visit_already_decided' });
        }
        throw rpcErr;
      }

      // Claim outbox record and dispatch rejection email
      if (visit.visitor_email) {
        try {
          const { data: claimRows } = await admin.schema('api').rpc('claim_office_visit_email_for_delivery', {
            requested_visit_id: visit.id,
            requested_email_type: 'rejection',
          });
          const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;

          if (claim?.outbox_id) {
            const html = await renderOfficeVisitRejectedEmail({
              fullName: visitorName,
              officeName,
              personnelName,
              visitDate: visit.visit_date,
              rejectionReason: reason,
            });

            const sendResult = await sendResendEmail({
              to: visit.visitor_email,
              subject: `Update on your visit request to ${officeName}`,
              html,
              idempotencyKey: claim.idempotency_key || rejectionIdempotencyKey,
            });

            await admin.schema('api').rpc('record_office_visit_email_result', {
              requested_outbox_id: claim.outbox_id,
              requested_claim_id: claim.claim_id,
              requested_status: 'sent',
              requested_provider_message_id: sendResult?.id || null,
              requested_error: null,
            });
          }
        } catch (emailErr) {
          console.error('Failed to send rejection email:', emailErr);
          const outcome = (emailErr instanceof EmailDeliveryError && emailErr.outcome === 'unknown')
            ? 'unknown'
            : 'failed';
          const errMsg = emailErr instanceof Error ? emailErr.message : 'email_dispatch_failed';

          // Look up outbox to record failure with proper error classification
          const { data: outboxRows } = await admin
            .from('office_visit_email_outbox')
            .select('id, claim_id')
            .eq('office_visit_id', visit.id)
            .eq('email_type', 'rejection')
            .maybeSingle();

          if (outboxRows?.id) {
            await admin.schema('api').rpc('record_office_visit_email_result', {
              requested_outbox_id: outboxRows.id,
              requested_claim_id: outboxRows.claim_id || null,
              requested_status: outcome,
              requested_provider_message_id: null,
              requested_error: errMsg,
            });
          }
        }
      }

      return jsonResponse(200, { ok: true, status: 'rejected' });
    }

    // APPROVAL
    // Generate secure QR pass token: p_<random32bytes>
    const randomSecretBytes = randomBytes(32).toString('hex');
    const qrPassToken = `p_${randomSecretBytes}`;
    const tokenDigest = createHash('sha256').update(qrPassToken).digest('hex');
    const encryptedPayload = encryptQrPayload(qrPassToken);
    const approvalIdempotencyKey = `office-approval-${visit.id}`;

    const { data: rpcRows, error: rpcErr } = await admin.schema('api').rpc('decide_office_visit', {
      requested_actor_id: actor.id,
      requested_visit_id: visit.id,
      requested_decision: 'approved',
      requested_rejection_reason: null,
      requested_token_digest: tokenDigest,
      requested_encrypted_payload: encryptedPayload,
      requested_idempotency_key: approvalIdempotencyKey,
    });

    if (rpcErr) {
      if (rpcErr.code === '40900' || rpcErr.message?.includes('already_decided')) {
        return jsonResponse(409, { error: 'visit_already_decided' });
      }
      throw rpcErr;
    }

    const decisionResult = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    const publicRef = decisionResult?.public_reference;
    const passId = decisionResult?.pass_id;

    // Claim outbox record and dispatch approval email with attached QR pass
    if (visit.visitor_email && publicRef) {
      try {
        const { data: claimRows } = await admin.schema('api').rpc('claim_office_visit_email_for_delivery', {
          requested_visit_id: visit.id,
          requested_email_type: 'approval',
        });
        const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;

        if (claim?.outbox_id) {
          const qrBuffer = await generateQrPngBuffer(qrPassToken);
          const attachmentFilename = `egatepass-${publicRef.slice(0, 8)}.png`;

          const html = await renderOfficeVisitApprovedEmail({
            fullName: visitorName,
            officeName,
            personnelName,
            visitDate: visit.visit_date,
            purpose: visit.purpose,
            publicReference: publicRef,
            attachmentFilename,
          });

          const sendResult = await sendResendEmail({
            to: visit.visitor_email,
            subject: `Approved: EARIST E-GatePass for ${officeName}`,
            html,
            idempotencyKey: claim.idempotency_key || approvalIdempotencyKey,
            attachments: [
              {
                filename: attachmentFilename,
                content: qrBuffer.toString('base64'),
                content_type: 'image/png',
              },
            ],
          });

          await admin.schema('api').rpc('record_office_visit_email_result', {
            requested_outbox_id: claim.outbox_id,
            requested_claim_id: claim.claim_id,
            requested_status: 'sent',
            requested_provider_message_id: sendResult?.id || null,
            requested_error: null,
          });
        }
      } catch (emailErr) {
        console.error('Failed to send approval email:', emailErr);
        const outcome = (emailErr instanceof EmailDeliveryError && emailErr.outcome === 'unknown')
          ? 'unknown'
          : 'failed';
        const errMsg = emailErr instanceof Error ? emailErr.message : 'email_dispatch_failed';

        const { data: outboxRows } = await admin
          .from('office_visit_email_outbox')
          .select('id, claim_id')
          .eq('office_visit_id', visit.id)
          .eq('email_type', 'approval')
          .maybeSingle();

        if (outboxRows?.id) {
          await admin.schema('api').rpc('record_office_visit_email_result', {
            requested_outbox_id: outboxRows.id,
            requested_claim_id: outboxRows.claim_id || null,
            requested_status: outcome,
            requested_provider_message_id: null,
            requested_error: errMsg,
          });
        }
      }
    }

    return jsonResponse(200, {
      ok: true,
      status: 'approved',
      passId,
      publicReference: publicRef,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Decision execution failed:', error);
    return jsonResponse(500, { error: 'decision_failed' });
  }
}

export default { fetch: handleRequest };
