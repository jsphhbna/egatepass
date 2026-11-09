import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { requireOfficeStaffActor } from '../../lib/office.js';
import { encryptQrPayload, decryptQrPayload } from '../../lib/encryption.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';
import { generateQrPngBuffer } from '../../email.js';
import { renderOfficeVisitApprovedEmail, renderOfficeVisitRejectedEmail } from '../../templates/index.js';
import { deliverOfficeEmail, type OutboxDeliveryResult } from '../../lib/officeDelivery.js';

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
        requested_person_name,
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
    const personnelName = (visit as any).requested_person_name || (visit.office_personnel as any)?.name || 'Faculty / Staff';

    if (parsed.data.decision === 'rejected') {
      const reason = parsed.data.rejectionReason || 'Schedule conflict or personnel unavailable.';
      const rejectionIdempotencyKey = `office-rejection-${visit.id}`;

      const { data: rejRpcRows, error: rpcErr } = await admin.schema('api').rpc('decide_office_visit', {
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

      const rejDecisionResult = Array.isArray(rejRpcRows) ? rejRpcRows[0] : rejRpcRows;
      if (!rejDecisionResult || typeof rejDecisionResult !== 'object' || rejDecisionResult.ok !== true) {
        return jsonResponse(422, {
          error: rejDecisionResult?.message || 'decision_rejected',
          decision: rejDecisionResult?.decision || 'rejected',
        });
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
    if (!decisionResult || typeof decisionResult !== 'object' || decisionResult.ok !== true) {
      return jsonResponse(422, {
        error: decisionResult?.message || 'decision_rejected',
        decision: decisionResult?.decision || 'rejected',
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
