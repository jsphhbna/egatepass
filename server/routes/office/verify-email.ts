import { randomInt, createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getServerSupabaseClients } from '../../supabase.js';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { sendResendEmail, EmailDeliveryError } from '../../email.js';
import { renderVerificationCodeEmail } from '../../templates/index.js';
import { getOfficeTokenSecret } from '../../lib/office.js';
import { getTrustedClientIp } from '../../lib/clientIp.js';

const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const requestCodeSchema = z.object({
  action: z.literal('request_code'),
  email: z.string().trim().regex(emailRegex, 'invalid_email_format').max(255),
  fullName: z.string().trim().max(150).optional(),
});

const verifyCodeSchema = z.object({
  action: z.literal('verify_code'),
  email: z.string().trim().regex(emailRegex, 'invalid_email_format').max(255),
  code: z.string().trim().length(6, 'invalid_code_length'),
});

const requestSchema = z.discriminatedUnion('action', [requestCodeSchema, verifyCodeSchema]);

function deriveIpRateLimitHmac(trustedIp: string | null): string | null {
  if (!trustedIp) return null;
  const secret = process.env.RATE_LIMIT_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new HttpError(503, 'abuse_control_unavailable');
  }
  return createHmac('sha256', secret).update(`office_ip:${trustedIp}`).digest('hex');
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) {
    return jsonResponse(401, { error: 'authentication_required' });
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  const { admin } = getServerSupabaseClients();
  const session = await getVerifiedSessionContext(admin, token);
  if (session.isRecoverySession) {
    throw new HttpError(403, 'recovery_session_forbidden');
  }
  if (!session.isAnonymous) {
    throw new HttpError(403, 'anonymous_visitor_session_required');
  }

  const secret = getOfficeTokenSecret();
  const normalizedEmail = parsed.data.email.toLowerCase().trim();

  if (parsed.data.action === 'request_code') {
    // Generate 6-digit code
    const rawCode = randomInt(100000, 1000000).toString();
    const codeHash = createHash('sha256').update(`${rawCode}:${secret}`).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const trustedIp = getTrustedClientIp(request);
    const ipHmac = deriveIpRateLimitHmac(trustedIp);

    // Atomic rate-limiting check and challenge allocation via database RPC
    const { data: slotRows, error: slotErr } = await admin.schema('api').rpc('request_office_email_verification_slot', {
      requested_actor_id: session.user.id,
      requested_email: normalizedEmail,
      requested_ip_hmac: ipHmac,
      requested_code_hash: codeHash,
      requested_expires_at: expiresAt,
    });

    if (slotErr) throw slotErr;
    const slot = Array.isArray(slotRows) ? slotRows[0] : slotRows;

    if (!slot?.allowed) {
      return jsonResponse(429, {
        error: slot?.error_code || 'too_many_requests',
        message: 'Too many verification code requests. Please wait a few minutes.',
      });
    }

    const emailHtml = await renderVerificationCodeEmail({
      fullName: parsed.data.fullName || 'EARIST Visitor',
      code: rawCode,
      expiresInMinutes: 15,
    });

    try {
      await sendResendEmail({
        to: normalizedEmail,
        subject: 'EARIST E-GatePass Verification Code',
        html: emailHtml,
      });
    } catch (sendErr) {
      console.error('Failed to dispatch verification email:', sendErr);
      const isConfigError =
        sendErr instanceof EmailDeliveryError &&
        (sendErr.code === 'email_service_unconfigured' ||
          sendErr.code === 'email_sender_unconfigured' ||
          sendErr.code === 'email_sender_invalid');
      if (isConfigError) {
        return jsonResponse(503, {
          error: 'email_service_unconfigured',
          message: 'Email service is currently unavailable. Please try again later or register as walk-in.',
        });
      }
      return jsonResponse(502, {
        error: 'email_delivery_failed',
        message: 'Could not deliver verification code to this email address. Please verify your email address.',
      });
    }

    return jsonResponse(200, {
      ok: true,
      message: 'Verification code sent to your email.',
    });
  }

  if (parsed.data.action === 'verify_code') {
    const candidateHash = createHash('sha256').update(`${parsed.data.code}:${secret}`).digest('hex');

    const { data: resultRows, error: rpcErr } = await admin.schema('api').rpc('verify_office_email_challenge', {
      requested_actor_id: session.user.id,
      requested_email: normalizedEmail,
      requested_code_hash: candidateHash,
    });

    if (rpcErr) throw rpcErr;

    const result = Array.isArray(resultRows) ? resultRows[0] : resultRows;
    if (!result || result.status === 'expired_or_not_found') {
      return jsonResponse(400, {
        error: 'invalid_or_expired_code',
        message: 'The verification code has expired or is invalid. Please request a new one.',
      });
    }

    if (result.status === 'too_many_attempts') {
      return jsonResponse(400, {
        error: 'too_many_failed_attempts',
        message: 'Too many incorrect attempts. Please request a new verification code.',
      });
    }

    if (result.status === 'invalid_code') {
      return jsonResponse(400, {
        error: 'invalid_code',
        message: `The verification code entered is incorrect. ${result.attempts_remaining} attempt(s) remaining.`,
        attemptsRemaining: result.attempts_remaining,
      });
    }

    // Generate 32-byte opaque proof token and store SHA-256 digest in office_visit_verification_proofs
    const proofToken = randomBytes(32).toString('hex');
    const proofDigest = createHash('sha256').update(proofToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour TTL

    // Store proof digest in office_visit_verification_proofs
    const { error: insertProofErr } = await admin
      .from('office_visit_verification_proofs')
      .insert({
        proof_digest: proofDigest,
        actor_id: session.user.id,
        email: normalizedEmail,
        expires_at: expiresAt,
      });

    if (insertProofErr) {
      console.error('Failed to persist office visit verification proof digest:', insertProofErr);
      return jsonResponse(500, {
        error: 'proof_storage_failed',
        message: 'Failed to record email verification proof. Please try again.',
      });
    }

    return jsonResponse(200, {
      ok: true,
      email: normalizedEmail,
      proofToken,
      emailVerificationToken: proofToken,
      message: 'Email verified successfully.',
    });
  }

  return jsonResponse(400, { error: 'invalid_action' });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
