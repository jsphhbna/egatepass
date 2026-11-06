import { randomInt, createHash } from 'node:crypto';
import { z } from 'zod';
import { getServerSupabaseClients } from '../../supabase.js';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { sendResendEmail } from '../../email.js';
import { renderVerificationCodeEmail } from '../../templates/index.js';
import { createEmailVerificationProofToken, getOfficeTokenSecret } from '../../lib/office.js';

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

function extractClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const firstHop = forwarded ? forwarded.split(',')[0]?.trim() : null;
  return cfIp?.trim() || firstHop || realIp || '127.0.0.1';
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

  const secret = getOfficeTokenSecret();
  const normalizedEmail = parsed.data.email.toLowerCase().trim();

  if (parsed.data.action === 'request_code') {
    // Generate 6-digit code
    const rawCode = randomInt(100000, 1000000).toString();
    const codeHash = createHash('sha256').update(`${rawCode}:${secret}`).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const clientIp = extractClientIp(request);

    // Atomic rate-limiting check and challenge allocation via database RPC
    const { data: slotRows, error: slotErr } = await admin.schema('api').rpc('request_office_email_verification_slot', {
      requested_actor_id: session.user.id,
      requested_email: normalizedEmail,
      requested_client_ip: clientIp,
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

    await sendResendEmail({
      to: normalizedEmail,
      subject: 'EARIST E-GatePass Verification Code',
      html: emailHtml,
    });

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

    // Mint actor-bound proof token signed strictly with OFFICE_VISIT_HMAC_SECRET
    const proofToken = createEmailVerificationProofToken(normalizedEmail, session.user.id);

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
