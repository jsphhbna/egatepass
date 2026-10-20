import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';
import { HttpError, recordReconciliation } from '../../server/actors.js';
import {
  EmailDeliveryError,
  escapeHtml,
  generateQrPngBuffer,
  sendResendEmail,
} from '../../server/email.js';
import {
  renderVerificationCodeEmail,
  renderPassIssuedEmail,
} from '../../server/templates/index.js';

const passIdSchema = z.string().uuid();

const requestCodeSchema = z.object({
  action: z.literal('request_code'),
  passId: passIdSchema,
  qrToken: z.string().min(16).max(256),
  recipientEmail: z.string().email().max(320),
  consent: z.literal(true),
  requestId: z.string().uuid(),
});

const verifyAndSendSchema = z.object({
  action: z.literal('verify_and_send'),
  passId: passIdSchema,
  qrToken: z.string().min(16).max(256),
  recipientEmail: z.string().email().max(320),
  verificationId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/),
  requestId: z.string().uuid(),
});

const schema = z.discriminatedUnion('action', [requestCodeSchema, verifyAndSendSchema]);

interface PassWithVisitor {
  id: string;
  public_reference: string;
  status: string;
  valid_from: string;
  valid_until: string;
  token_digest: string;
  visitors: {
    id: string;
    owner_id: string;
    source: 'portal' | 'kiosk';
    full_name: string;
    visit_date: string;
    purpose: string;
  } | null;
}

type DispatchStatus = 'pending' | 'sending' | 'sent_to_provider' | 'delivery_failed' | 'outcome_unknown';
type CodeDeliveryStatus = 'code_sending' | 'sent_to_provider' | 'delivery_failed' | 'outcome_unknown';

interface RequestCodeRpcResult {
  verification_id: string;
  expires_at: string;
  idempotent_replay: boolean;
  dispatch_code: boolean;
  code_delivery_status: CodeDeliveryStatus;
}

interface ClaimRpcResult {
  success: boolean;
  error?: string;
  attempts_remaining?: number;
  idempotent_replay: boolean;
  dispatch_authorized: boolean;
  delivery_status: DispatchStatus;
  stale_claim_promoted?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeSha256Digest(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:\\x|0x)?([0-9a-fA-F]{64})$/.exec(value);
  if (!match) return null;
  const digest = Buffer.from(match[1], 'hex');
  return digest.length === 32 ? digest : null;
}

function rpcMessage(error: unknown): { code: string; message: string } {
  if (!isObject(error)) return { code: '', message: '' };
  return {
    code: typeof error.code === 'string' ? error.code : '',
    message: typeof error.message === 'string' ? error.message : '',
  };
}

function failClosedRpcResponse(error: unknown): Response {
  const { code, message } = rpcMessage(error);
  if (message.includes('kiosk_device_revoked')) {
    return jsonResponse(403, { error: 'kiosk_device_revoked', message: 'Kiosk device is not active or has been revoked.' });
  }
  if (message.includes('access_denied')) return jsonResponse(403, { error: 'access_denied' });
  if (code === 'P0002' || message.includes('pass_not_found') || message.includes('verification_not_found')) {
    return jsonResponse(404, { error: message.includes('verification') ? 'verification_not_found' : 'pass_not_found' });
  }
  if (message.includes('too_many_requests_recipient') || message.includes('recipient_challenge_limit_exceeded')) {
    return jsonResponse(429, {
      error: message.includes('recipient_challenge_limit_exceeded') ? 'recipient_challenge_limit_exceeded' : 'too_many_requests_recipient',
      message: 'Too many verification code requests for this email address. Please try again later.',
    });
  }
  if (message.includes('too_many_requests_actor') || message.includes('actor_challenge_limit_exceeded')) {
    return jsonResponse(429, {
      error: message.includes('actor_challenge_limit_exceeded') ? 'actor_challenge_limit_exceeded' : 'too_many_requests_actor',
      message: 'Too many verification requests from this device or session. Please wait before retrying.',
    });
  }
  if (code === 'P0003' || message.includes('too_many_requests')) {
    return jsonResponse(429, { error: 'too_many_requests', message: 'Too many email requests for this pass. Please wait before trying again.' });
  }
  if (code === 'P0004' || message.includes('code_already_used')) return jsonResponse(409, { error: 'code_already_used' });
  if (code === 'P0005' || message.includes('dispatch_in_progress')) {
    return jsonResponse(409, { error: 'dispatch_in_progress', message: 'An email submission is already in progress.' });
  }
  if (code === 'P0006' || message.includes('code_expired')) return jsonResponse(410, { error: 'code_expired' });
  if (code === 'P0007' || message.includes('max_attempts_exceeded')) {
    return jsonResponse(429, { error: 'max_attempts_exceeded', message: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (code === 'P0008' || message.includes('recipient_mismatch') || message.includes('idempotency_key_mismatch')) {
    return jsonResponse(400, { error: message.includes('idempotency') ? 'idempotency_key_mismatch' : 'recipient_mismatch' });
  }
  if (code === 'P0001' || message.includes('pass_expired') || message.includes('pass_not_active')) {
    return jsonResponse(400, { error: message.includes('expired') ? 'pass_expired' : 'pass_not_active' });
  }
  return jsonResponse(503, { error: 'email_state_unavailable', message: 'Email delivery state is temporarily unavailable. Your issued pass remains valid.' });
}

function parseRequestCodeResult(value: unknown): RequestCodeRpcResult | null {
  if (!isObject(value)) return null;
  const status = value.code_delivery_status;
  if (
    typeof value.verification_id !== 'string'
    || typeof value.expires_at !== 'string'
    || typeof value.idempotent_replay !== 'boolean'
    || typeof value.dispatch_code !== 'boolean'
    || !['code_sending', 'sent_to_provider', 'delivery_failed', 'outcome_unknown'].includes(String(status))
  ) return null;
  return value as unknown as RequestCodeRpcResult;
}

function parseClaimResult(value: unknown): ClaimRpcResult | null {
  if (!isObject(value)) return null;
  if (
    typeof value.success !== 'boolean'
    || typeof value.idempotent_replay !== 'boolean'
    || typeof value.dispatch_authorized !== 'boolean'
    || !['pending', 'sending', 'sent_to_provider', 'delivery_failed', 'outcome_unknown'].includes(String(value.delivery_status))
  ) return null;
  return value as unknown as ClaimRpcResult;
}

function respondToCodeReplay(result: RequestCodeRpcResult): Response {
  if (result.code_delivery_status === 'sent_to_provider') {
    return jsonResponse(200, {
      success: true,
      verificationId: result.verification_id,
      expiresAt: result.expires_at,
      status: 'code_sent_to_provider',
      idempotentReplay: true,
    });
  }
  if (result.code_delivery_status === 'delivery_failed') {
    return jsonResponse(409, {
      error: 'verification_delivery_failed',
      status: 'delivery_failed',
      retryAllowed: true,
      message: 'The provider definitively rejected the verification email. Start a new code request to retry.',
    });
  }
  return jsonResponse(202, {
    error: 'verification_delivery_unknown',
    status: 'outcome_unknown',
    retryAllowed: false,
    message: 'The verification email outcome is still unknown. Do not retry automatically.',
  });
}

async function respondToDispatchReplay(
  result: ClaimRpcResult,
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  passId: string,
): Promise<Response> {
  if (result.delivery_status === 'sent_to_provider') {
    return jsonResponse(200, { success: true, status: 'sent_to_provider', idempotentReplay: true });
  }
  if (result.delivery_status === 'delivery_failed') {
    return jsonResponse(409, {
      error: 'email_delivery_failed',
      status: 'delivery_failed',
      retryAllowed: true,
      message: 'The provider definitively rejected the email. You may deliberately try again.',
    });
  }
  const recorded = result.stale_claim_promoted
    ? await recordUnknownOutcome(admin, 'pass.email_delivery_unknown', passId, 'stale_dispatch_claim', 'qr_dispatch')
    : undefined;
  return jsonResponse(202, {
    error: 'email_outcome_unknown',
    status: result.delivery_status,
    retryAllowed: false,
    message: 'The email submission is still pending or its outcome is unknown. Do not retry automatically.',
    ...(result.stale_claim_promoted ? { reconciliationRequired: true, reconciliationRecorded: recorded } : {}),
  });
}

interface FinalizeOutcome {
  success: boolean;
  matchStatus: 'matched' | 'already_finalized_same_status' | 'terminal_conflict' | 'error';
  persistedStatus: string | null;
}

async function finalizeCodeDelivery(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  verificationId: string,
  requestId: string,
  status: Exclude<CodeDeliveryStatus, 'code_sending'>,
  providerId: string | null,
): Promise<FinalizeOutcome> {
  const { data, error } = await admin.schema('api').rpc('finalize_email_verification_code', {
    requested_verification_id: verificationId,
    requested_request_id: requestId,
    requested_delivery_status: status,
    requested_provider_delivery_id: providerId,
  });
  if (error || !isObject(data)) {
    return { success: false, matchStatus: 'error', persistedStatus: null };
  }
  const matchStatus = typeof data.match_status === 'string' ? (data.match_status as any) : 'error';
  const persistedStatus = typeof data.code_delivery_status === 'string' ? data.code_delivery_status : null;
  const success = data.success === true && matchStatus !== 'terminal_conflict' && (persistedStatus === status || matchStatus === 'already_finalized_same_status');
  return { success, matchStatus, persistedStatus };
}

async function finalizeDispatch(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  verificationId: string,
  requestId: string,
  status: Exclude<DispatchStatus, 'pending' | 'sending'>,
  providerId: string | null,
): Promise<FinalizeOutcome> {
  const { data, error } = await admin.schema('api').rpc('finalize_email_dispatch', {
    requested_verification_id: verificationId,
    requested_send_request_id: requestId,
    requested_delivery_status: status,
    requested_provider_delivery_id: providerId,
  });
  if (error || !isObject(data)) {
    return { success: false, matchStatus: 'error', persistedStatus: null };
  }
  const matchStatus = typeof data.match_status === 'string' ? (data.match_status as any) : 'error';
  const persistedStatus = typeof data.delivery_status === 'string' ? data.delivery_status : null;
  const success = data.success === true && matchStatus !== 'terminal_conflict' && (persistedStatus === status || matchStatus === 'already_finalized_same_status');
  return { success, matchStatus, persistedStatus };
}

async function recordUnknownOutcome(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  operation: string,
  passId: string,
  errorCode: string,
  phase: 'verification_code' | 'qr_dispatch',
): Promise<boolean> {
  return recordReconciliation(admin, operation, 'pass', passId, errorCode, { phase, outcome: 'unknown' });
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

  try {
    const { admin } = getServerSupabaseClients();
    const { data: identity, error: authError } = await admin.auth.getUser(token);
    if (authError || !identity.user) return jsonResponse(401, { error: 'invalid_session' });
    const actorId = identity.user.id;

    const { data: passRow, error: passError } = await admin
      .from('passes')
      .select(`id, public_reference, status, valid_from, valid_until, token_digest,
        visitors (id, owner_id, source, full_name, visit_date, purpose)`)
      .eq('public_reference', parsed.data.passId)
      .maybeSingle<PassWithVisitor>();
    if (passError) return jsonResponse(503, { error: 'email_state_unavailable' });
    if (!passRow?.visitors) return jsonResponse(404, { error: 'pass_not_found' });
    if (passRow.visitors.owner_id !== actorId) return jsonResponse(403, { error: 'access_denied' });

    if (passRow.visitors.source === 'kiosk') {
      const { data: device, error: deviceError } = await admin
        .from('devices')
        .select('user_id, type, status, deleted_at')
        .eq('user_id', actorId)
        .maybeSingle();
      if (deviceError || !device || device.type !== 'kiosk' || device.status !== 'active' || device.deleted_at !== null) {
        return jsonResponse(403, { error: 'kiosk_device_revoked', message: 'Kiosk device is not active or has been revoked.' });
      }
    }

    if (passRow.status !== 'issued') return jsonResponse(400, { error: 'pass_not_active', status: passRow.status });
    if (new Date(passRow.valid_until).getTime() <= Date.now()) return jsonResponse(400, { error: 'pass_expired' });

    const storedDigest = normalizeSha256Digest(passRow.token_digest);
    const expectedDigest = createHash('sha256').update(parsed.data.qrToken).digest();
    if (!storedDigest || !timingSafeEqual(storedDigest, expectedDigest)) {
      return jsonResponse(403, { error: 'invalid_bearer_token' });
    }

    const recipient = parsed.data.recipientEmail.trim().toLowerCase();

    if (parsed.data.action === 'request_code') {
      const verificationId = randomUUID();
      const code = String(randomInt(100000, 1000000));
      const codeHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const rpc = await admin.schema('api').rpc('request_email_verification_code', {
        requested_pass_id: passRow.id,
        requested_actor_id: actorId,
        requested_recipient_email: recipient,
        requested_code_hash: codeHash,
        requested_request_id: parsed.data.requestId,
        requested_verification_id: verificationId,
        requested_expires_at: expiresAt,
      });
      if (rpc.error) return failClosedRpcResponse(rpc.error);
      const state = parseRequestCodeResult(rpc.data);
      if (!state) return jsonResponse(503, { error: 'email_state_unavailable' });
      if (state.idempotent_replay || !state.dispatch_code) return respondToCodeReplay(state);

      const html = await renderVerificationCodeEmail({
        fullName: passRow.visitors.full_name,
        code,
        expiresInMinutes: 10,
      });

      try {
        const sent = await sendResendEmail({ to: recipient, subject: 'EARIST Gate Pass — Verification Code', html });
        const finalResult = await finalizeCodeDelivery(admin, state.verification_id, parsed.data.requestId, 'sent_to_provider', sent.id);
        if (!finalResult.success) {
          const conflict = finalResult.matchStatus === 'terminal_conflict';
          const recorded = await recordUnknownOutcome(
            admin,
            'pass.verification_delivery_unknown',
            passRow.id,
            conflict ? 'terminal_conflict' : 'finalize_failed',
            'verification_code'
          );
          return jsonResponse(202, {
            error: conflict ? 'verification_finalization_conflict' : 'verification_delivery_unknown',
            status: 'outcome_unknown',
            retryAllowed: false,
            reconciliationRequired: true,
            reconciliationRecorded: recorded,
          });
        }
        return jsonResponse(200, {
          success: true,
          verificationId: state.verification_id,
          expiresAt: state.expires_at,
          status: 'code_sent_to_provider',
        });
      } catch (error) {
        const deliveryError = error instanceof EmailDeliveryError ? error : new EmailDeliveryError('email_transport_unknown', 'unknown');
        const finalStatus = deliveryError.outcome === 'definitive_rejection' ? 'delivery_failed' : 'outcome_unknown';
        const finalResult = await finalizeCodeDelivery(admin, state.verification_id, parsed.data.requestId, finalStatus, null);
        if (deliveryError.outcome === 'unknown' || !finalResult.success || finalResult.matchStatus === 'terminal_conflict') {
          const conflict = finalResult.matchStatus === 'terminal_conflict';
          const recorded = await recordUnknownOutcome(
            admin,
            'pass.verification_delivery_unknown',
            passRow.id,
            conflict ? 'terminal_conflict' : deliveryError.code,
            'verification_code'
          );
          return jsonResponse(202, {
            error: conflict ? 'verification_finalization_conflict' : 'verification_delivery_unknown',
            status: 'outcome_unknown',
            retryAllowed: false,
            reconciliationRequired: true,
            reconciliationRecorded: recorded,
          });
        }
        if (deliveryError.code === 'email_service_unconfigured') {
          return jsonResponse(503, { error: 'email_service_unconfigured', status: 'delivery_failed', retryAllowed: true });
        }
        return jsonResponse(502, { error: 'verification_delivery_failed', status: 'delivery_failed', retryAllowed: true });
      }
    }

    const { verificationId, code, requestId } = parsed.data;
    const expectedHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');
    const claimRpc = await admin.schema('api').rpc('verify_and_claim_email_dispatch', {
      requested_verification_id: verificationId,
      requested_pass_id: passRow.id,
      requested_actor_id: actorId,
      requested_recipient_email: recipient,
      requested_expected_hash: expectedHash,
      requested_send_request_id: requestId,
    });
    if (claimRpc.error) return failClosedRpcResponse(claimRpc.error);
    const claim = parseClaimResult(claimRpc.data);
    if (!claim) return jsonResponse(503, { error: 'email_state_unavailable' });
    if (!claim.success) {
      return jsonResponse(400, { error: claim.error ?? 'invalid_code', attemptsRemaining: claim.attempts_remaining ?? 0 });
    }
    if (claim.idempotent_replay || !claim.dispatch_authorized) return respondToDispatchReplay(claim, admin, passRow.id);

    let providerAttempted = false;
    try {
      const qrBase64 = (await generateQrPngBuffer(parsed.data.qrToken)).toString('base64');
      const validFrom = new Date(passRow.valid_from).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
      const validUntil = new Date(passRow.valid_until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
      const html = await renderPassIssuedEmail({
        fullName: passRow.visitors.full_name,
        visitDate: passRow.visitors.visit_date,
        publicReference: passRow.public_reference,
        validFrom,
        validUntil,
        purpose: passRow.visitors.purpose,
      });
      providerAttempted = true;
      const sent = await sendResendEmail({
        to: recipient,
        subject: 'Your EARIST Digital Gate Pass QR Code',
        html,
        attachments: [{ filename: 'earist-gate-pass-qr.png', content: qrBase64 }],
      });
      const finalResult = await finalizeDispatch(admin, verificationId, requestId, 'sent_to_provider', sent.id);
      if (!finalResult.success) {
        const conflict = finalResult.matchStatus === 'terminal_conflict';
        const recorded = await recordUnknownOutcome(
          admin,
          'pass.email_delivery_unknown',
          passRow.id,
          conflict ? 'terminal_conflict' : 'finalize_failed',
          'qr_dispatch'
        );
        return jsonResponse(202, {
          error: conflict ? 'email_finalization_conflict' : 'email_outcome_unknown',
          status: 'outcome_unknown',
          retryAllowed: false,
          reconciliationRequired: true,
          reconciliationRecorded: recorded,
        });
      }
      return jsonResponse(200, { success: true, status: 'sent_to_provider' });
    } catch (error) {
      const deliveryError = error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError(providerAttempted ? 'email_transport_unknown' : 'qr_generation_failed', providerAttempted ? 'unknown' : 'definitive_rejection');
      const finalStatus = deliveryError.outcome === 'definitive_rejection' ? 'delivery_failed' : 'outcome_unknown';
      const finalResult = await finalizeDispatch(admin, verificationId, requestId, finalStatus, null);
      if (deliveryError.outcome === 'unknown' || !finalResult.success || finalResult.matchStatus === 'terminal_conflict') {
        const conflict = finalResult.matchStatus === 'terminal_conflict';
        const recorded = await recordUnknownOutcome(
          admin,
          'pass.email_delivery_unknown',
          passRow.id,
          conflict ? 'terminal_conflict' : deliveryError.code,
          'qr_dispatch'
        );
        return jsonResponse(202, {
          error: conflict ? 'email_finalization_conflict' : 'email_outcome_unknown',
          status: 'outcome_unknown',
          retryAllowed: false,
          reconciliationRequired: true,
          reconciliationRecorded: recorded,
        });
      }
      return jsonResponse(502, {
        error: 'email_delivery_failed', status: 'delivery_failed', retryAllowed: true,
        message: 'The provider definitively rejected the email. Your issued pass remains available for download.',
      });
    }
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Pass email endpoint failed without exposing request data.');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
