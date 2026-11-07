import type { SupabaseClient } from '@supabase/supabase-js';
import { sendResendEmail, EmailDeliveryError } from '../email.js';

export interface OutboxDeliveryResult {
  status: 'sent' | 'failed' | 'unknown' | 'none' | 'pending' | 'reconciliation_required';
  providerMessageId: string | null;
  error: string | null;
  reconciliationRequired?: boolean;
}

export function isPositiveRpcSuccess(recData: any, recErr: any): boolean {
  if (recErr) return false;
  if (!recData || typeof recData !== 'object') return false;
  return recData.ok === true;
}

export async function deliverOfficeEmail(
  admin: SupabaseClient,
  params: {
    visitId: string;
    visitorEmail?: string | null;
    emailType: 'approval' | 'rejection';
    defaultIdempotencyKey: string;
    prepareContent: (claim: {
      outbox_id: string;
      office_visit_id: string;
      email_type: string;
      recipient_email: string;
      encrypted_token_payload?: string | null;
      rejection_reason?: string | null;
      attempt_count: number;
      claim_id: string;
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
      const isReconciliation =
        claimErr.message?.includes('outcome_unknown') ||
        claimErr.message?.includes('reconciliation_required');
      return {
        status: isReconciliation ? 'reconciliation_required' : 'failed',
        providerMessageId: null,
        error: claimErr.message,
        reconciliationRequired: isReconciliation,
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

  // If lease was expired, claim_id is returned as null and state is transitioned to reconciliation_required
  if (!claim.claim_id) {
    return {
      status: 'reconciliation_required',
      providerMessageId: null,
      error: 'email_delivery_outcome_unknown_reconciliation_required',
      reconciliationRequired: true,
    };
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
    const { data: prepRecData, error: prepRecErr } = await admin.schema('api').rpc('record_office_visit_email_result', {
      requested_outbox_id: claim.outbox_id,
      requested_claim_id: claim.claim_id,
      requested_status: 'failed',
      requested_provider_message_id: null,
      requested_error: errMsg,
    });
    if (!isPositiveRpcSuccess(prepRecData, prepRecErr)) {
      console.error(JSON.stringify({
        event: 'office_email_record_prep_failure_rpc_failed',
        visitId: params.visitId,
        error: prepRecErr?.message || (prepRecData && typeof prepRecData === 'object' ? prepRecData.error : 'persistence_not_confirmed'),
      }));
    }
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

      if (isPositiveRpcSuccess(recData, recErr)) {
        primarySuccess = true;
      } else {
        console.warn(JSON.stringify({
          event: 'office_email_primary_record_rpc_failed',
          visitId: params.visitId,
          outboxId: claim.outbox_id,
          error: recErr?.message || (recData && typeof recData === 'object' ? recData.error : 'persistence_not_confirmed'),
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

      if (isPositiveRpcSuccess(fbData, fbErr)) {
        fallbackSuccess = true;
      } else {
        console.error(JSON.stringify({
          event: 'office_email_fallback_record_rpc_failed',
          visitId: params.visitId,
          outboxId: claim.outbox_id,
          error: fbErr?.message || (fbData && typeof fbData === 'object' ? fbData.error : 'fallback_persistence_not_confirmed'),
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
    let writeSuccess = false;
    try {
      const { data: recordData, error: recordErr } = await admin.schema('api').rpc('record_office_visit_email_result', {
        requested_outbox_id: outboxRows.id,
        requested_claim_id: outboxRows.claim_id || claim.claim_id || null,
        requested_status: outcome,
        requested_provider_message_id: null,
        requested_error: errMsg,
      });
      if (isPositiveRpcSuccess(recordData, recordErr)) {
        writeSuccess = true;
      } else {
        console.error(JSON.stringify({
          event: 'office_email_record_failure_rpc_failed',
          visitId: params.visitId,
          error: recordErr?.message || (recordData && typeof recordData === 'object' ? recordData.error : 'persistence_not_confirmed'),
        }));
      }
    } catch (writeEx: any) {
      console.error(JSON.stringify({
        event: 'office_email_record_failure_rpc_exception',
        visitId: params.visitId,
        error: writeEx?.message || 'write_exception',
      }));
    }

    if (!writeSuccess && outcome === 'unknown') {
      try {
        const { data: fbData, error: fbErr } = await admin.schema('api').rpc('record_office_visit_email_result', {
          requested_outbox_id: outboxRows.id,
          requested_claim_id: outboxRows.claim_id || claim.claim_id || null,
          requested_status: 'reconciliation_required',
          requested_provider_message_id: null,
          requested_error: `unknown_outcome_write_fallback: ${errMsg}`,
        });
        if (!isPositiveRpcSuccess(fbData, fbErr)) {
          console.error(JSON.stringify({
            event: 'office_email_unknown_fallback_rpc_failed',
            visitId: params.visitId,
            error: fbErr?.message || (fbData && typeof fbData === 'object' ? fbData.error : 'persistence_not_confirmed'),
          }));
        }
      } catch (fbEx: any) {
        console.error(JSON.stringify({
          event: 'office_email_unknown_fallback_rpc_exception',
          visitId: params.visitId,
          error: fbEx?.message || 'fallback_exception',
        }));
      }
    }
  }

  return {
    status: outcome,
    providerMessageId: null,
    error: errMsg,
    reconciliationRequired: outcome === 'unknown',
  };
}
