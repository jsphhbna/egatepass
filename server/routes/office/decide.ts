import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { encryptQrPayload, decryptQrPayload } from '../../lib/encryption.js';
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

interface OutboxDeliveryResult {
  status: 'sent' | 'failed' | 'unknown' | 'none' | 'pending' | 'reconciliation_required';
  providerMessageId: string | null;
  error: string | null;
  reconciliationRequired?: boolean;
}

async function deliverOfficeEmail(
  admin: any,
  params: {
    visitId: string;
    visitorEmail: string | null;
    emailType: 'approval' | 'rejection';
    defaultIdempotencyKey: string;
    prepareContent: (claim: {
      outbox_id: string;
      claim_id: string;
      encrypted_token_payload?: string | null;
      idempotency_key?: string | null;
    }) => Promise<{
      subject: string;
      html: string;
      attachments?: Array<{ filename: string; content: string; content_type: string }>;
    }>;
  }
): Promise<OutboxDeliveryResult> {
  if (!params.visitorEmail) {
    return { status: 'none', providerMessageId: null, error: null };
  }

  // 1. Claim outbox row for delivery
  let claim: any = null;
  try {
    const { data: claimRows, error: claimErr } = await admin
      .schema('api')
      .rpc('claim_office_visit_email_for_delivery', {
        requested_visit_id: params.visitId,
        requested_email_type: params.emailType,
      });

    if (claimErr) {
      console.error(JSON.stringify({
        event: 'office_email_claim_error',
        visitId: params.visitId,
        emailType: params.emailType,
        error: claimErr.message,
        code: claimErr.code,
      }));
      return {
        status: 'failed',
        providerMessageId: null,
        error: claimErr.message,
      };
    }

    claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'office_email_claim_exception',
      visitId: params.visitId,
      emailType: params.emailType,
      error: err?.message || 'claim_exception',
    }));
    return {
      status: 'failed',
      providerMessageId: null,
      error: err?.message || 'claim_exception',
    };
  }

  if (!claim?.outbox_id) {
    return { status: 'pending', providerMessageId: null, error: null };
  }

  // 2. Prepare content
  let content: {
    subject: string;
    html: string;
    attachments?: Array<{ filename: string; content: string; content_type: string }>;
  };
  try {
    content = await params.prepareContent(claim);
  } catch (prepErr: any) {
    const errMsg = prepErr?.message || 'failed_to_prepare_email_content';
    console.error(JSON.stringify({
      event: 'office_email_prepare_content_failed',
      visitId: params.visitId,
      emailType: params.emailType,
      error: errMsg,
    }));
    await admin.schema('api').rpc('record_office_visit_email_result', {
      requested_outbox_id: claim.outbox_id,
      requested_claim_id: claim.claim_id,
      requested_status: 'failed',
      requested_provider_message_id: null,
      requested_error: errMsg,
    });
    return {
      status: 'failed',
      providerMessageId: null,
      error: errMsg,
    };
  }

  // 3. Dispatch via Resend
  let sendResult: { id?: string } | null = null;
  let providerAccepted = false;
  let dispatchErr: any = null;

  try {
    sendResult = await sendResendEmail({
      to: params.visitorEmail,
      subject: content.subject,
      html: content.html,
      idempotencyKey: claim.idempotency_key || params.defaultIdempotencyKey,
      correlationId: claim.outbox_id,
      attachments: content.attachments,
    });
    if (sendResult?.id) {
      providerAccepted = true;
    }
  } catch (err: any) {
    dispatchErr = err;
  }

  // 4. Provider accepted: persist outcome with primary write and bounded fallback
  if (providerAccepted) {
    const providerMessageId = sendResult?.id || null;
    let primarySuccess = false;

    try {
      const { data: recData, error: recErr } = await admin
        .schema('api')
        .rpc('record_office_visit_email_result', {
          requested_outbox_id: claim.outbox_id,
          requested_claim_id: claim.claim_id,
          requested_status: 'sent',
          requested_provider_message_id: providerMessageId,
          requested_error: null,
        });

      if (!recErr && recData?.ok !== false) {
        primarySuccess = true;
      } else {
        console.warn(JSON.stringify({
          event: 'office_email_primary_record_rpc_failed',
          visitId: params.visitId,
          outboxId: claim.outbox_id,
          error: recErr?.message || recData?.error,
        }));
      }
    } catch (rpcEx: any) {
      console.warn(JSON.stringify({
        event: 'office_email_primary_record_rpc_exception',
        visitId: params.visitId,
        outboxId: claim.outbox_id,
        error: rpcEx?.message || 'rpc_exception',
      }));
    }

    if (primarySuccess) {
      return {
        status: 'sent',
        providerMessageId,
        error: null,
      };
    }

    // Primary record failed after Resend accepted: perform bounded fallback write
    let fallbackSuccess = false;
    try {
      const { data: fbData, error: fbErr } = await admin
        .schema('api')
        .rpc('record_office_visit_email_result', {
          requested_outbox_id: claim.outbox_id,
          requested_claim_id: claim.claim_id,
          requested_status: 'reconciliation_required',
          requested_provider_message_id: providerMessageId,
          requested_error: 'reconciliation_required: primary_record_failed',
        });

      if (!fbErr && fbData?.ok !== false) {
        fallbackSuccess = true;
      } else {
        console.error(JSON.stringify({
          event: 'office_email_fallback_record_rpc_failed',
          visitId: params.visitId,
          outboxId: claim.outbox_id,
          error: fbErr?.message || fbData?.error,
        }));
      }
    } catch (fbEx: any) {
      console.error(JSON.stringify({
        event: 'office_email_fallback_record_rpc_exception',
        visitId: params.visitId,
        outboxId: claim.outbox_id,
        error: fbEx?.message || 'fallback_exception',
      }));
    }

    // Structured non-PII diagnostic log
    console.error(JSON.stringify({
      event: 'resend_email_accepted_db_persistence_failed',
      visitId: params.visitId,
      outboxId: claim.outbox_id,
      emailType: params.emailType,
      providerMessageId,
      fallbackPersisted: fallbackSuccess,
    }));

    // Preserve provider-accepted outcome in response
    return {
      status: 'sent',
      providerMessageId,
      error: fallbackSuccess
        ? 'persistence_degraded_reconciliation_required'
        : 'persistence_failed_awaiting_webhook_reconciliation',
      reconciliationRequired: true,
    };
  }

  // 5. Send threw error: record failure/unknown without overwriting any successful send
  const outcome = (dispatchErr instanceof EmailDeliveryError && dispatchErr.outcome === 'unknown')
    ? 'unknown'
    : 'failed';
  const errMsg = dispatchErr instanceof Error ? dispatchErr.message : 'email_dispatch_failed';

  console.error(JSON.stringify({
    event: 'office_email_dispatch_failed',
    visitId: params.visitId,
    emailType: params.emailType,
    outcome,
    error: errMsg,
  }));

  const { data: outboxRows, error: outboxReadErr } = await admin
    .from('office_visit_email_outbox')
    .select('id, claim_id')
    .eq('office_visit_id', params.visitId)
    .eq('email_type', params.emailType)
    .maybeSingle();

  if (outboxReadErr) {
    console.error(JSON.stringify({
      event: 'office_email_outbox_lookup_failed_on_error',
      visitId: params.visitId,
      error: outboxReadErr.message,
    }));
  } else if (outboxRows?.id) {
    const { error: recordErr } = await admin.schema('api').rpc('record_office_visit_email_result', {
      requested_outbox_id: outboxRows.id,
      requested_claim_id: outboxRows.claim_id || claim.claim_id || null,
      requested_status: outcome,
      requested_provider_message_id: null,
      requested_error: errMsg,
    });
    if (recordErr) {
      console.error(JSON.stringify({
        event: 'office_email_record_failure_rpc_failed',
        visitId: params.visitId,
        error: recordErr.message,
      }));
    }
  }

  return {
    status: outcome,
    providerMessageId: null,
    error: errMsg,
  };
}

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
    const formattedVisitDate = visit.visit_date instanceof Date
      ? visit.visit_date.toISOString().slice(0, 10)
      : String(visit.visit_date || '');
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

      const emailDelivery = await deliverOfficeEmail(admin, {
        visitId: visit.id,
        visitorEmail: visit.visitor_email,
        emailType: 'rejection',
        defaultIdempotencyKey: rejectionIdempotencyKey,
        prepareContent: async () => {
          const html = await renderOfficeVisitRejectedEmail({
            fullName: visitorName,
            officeName,
            personnelName,
            visitDate: formattedVisitDate,
            rejectionReason: reason,
          });
          return {
            subject: `Update on your visit request to ${officeName}`,
            html,
          };
        },
      });

      return jsonResponse(200, {
        ok: true,
        status: 'rejected',
        decision: 'rejected',
        emailDelivery,
      });
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
    if (decisionResult && decisionResult.ok === false) {
      return jsonResponse(422, {
        error: decisionResult.message || 'decision_rejected',
        decision: decisionResult.decision,
      });
    }

    const publicRef = decisionResult?.public_reference;
    const passId = decisionResult?.pass_id;

    let emailDelivery: OutboxDeliveryResult = { status: 'none', providerMessageId: null, error: null };
    if (visit.visitor_email && publicRef) {
      emailDelivery = await deliverOfficeEmail(admin, {
        visitId: visit.id,
        visitorEmail: visit.visitor_email,
        emailType: 'approval',
        defaultIdempotencyKey: approvalIdempotencyKey,
        prepareContent: async (claim) => {
          if (!claim.encrypted_token_payload) {
            throw new Error('missing_encrypted_token_payload');
          }

          // Decrypt authoritative QR token directly from canonical outbox claim
          const canonicalQrToken = decryptQrPayload(claim.encrypted_token_payload);
          const canonicalDigest = createHash('sha256').update(canonicalQrToken).digest('hex');

          if (canonicalDigest !== tokenDigest) {
            console.warn('Authoritative outbox token differs from local proposal; generating QR from canonical outbox token');
          }

          const qrBuffer = await generateQrPngBuffer(canonicalQrToken);
          const attachmentFilename = `egatepass-${publicRef.slice(0, 8)}.png`;

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
        },
      });
    }

    return jsonResponse(200, {
      ok: true,
      status: 'approved',
      decision: 'approved',
      passId,
      publicReference: publicRef,
      emailDelivery,
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
