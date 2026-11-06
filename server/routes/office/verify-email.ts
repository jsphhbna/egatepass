import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
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
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    // Rate-limiting check: max 5 requests per 15 minutes per email or actor
    const { count: emailCount, error: countErr } = await admin
      .from('office_visit_email_verifications')
      .select('id', { count: 'exact', head: true })
      .eq('email', normalizedEmail)
      .gt('created_at', fifteenMinutesAgo);

    if (countErr) throw countErr;
    if ((emailCount || 0) >= 5) {
      return jsonResponse(429, {
        error: 'too_many_requests',
        message: 'Too many verification code requests for this email. Please wait a few minutes.',
      });
    }

    // Generate 6-digit code
    const rawCode = randomInt(100000, 1000000).toString();
    const codeHash = createHash('sha256').update(`${rawCode}:${secret}`).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { error: insertErr } = await admin.from('office_visit_email_verifications').insert({
      email: normalizedEmail,
      code_hash: codeHash,
      actor_id: session.user.id,
      expires_at: expiresAt,
      verified: false,
      attempts: 0,
    });

    if (insertErr) throw insertErr;

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
    const nowIso = new Date().toISOString();

    const { data: records, error: fetchErr } = await admin
      .from('office_visit_email_verifications')
      .select('id, code_hash, attempts, expires_at')
      .eq('email', normalizedEmail)
      .eq('verified', false)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (fetchErr) throw fetchErr;

    const record = records?.[0];
    if (!record) {
      return jsonResponse(400, {
        error: 'invalid_or_expired_code',
        message: 'The verification code has expired or is invalid. Please request a new one.',
      });
    }

    if (record.attempts >= 5) {
      return jsonResponse(400, {
        error: 'too_many_failed_attempts',
        message: 'Too many incorrect attempts. Please request a new verification code.',
      });
    }

    // Increment attempts
    await admin
      .from('office_visit_email_verifications')
      .update({ attempts: record.attempts + 1 })
      .eq('id', record.id);

    const candidateHash = createHash('sha256').update(`${parsed.data.code}:${secret}`).digest('hex');
    const isMatch = timingSafeEqual(Buffer.from(candidateHash), Buffer.from(record.code_hash));

    if (!isMatch) {
      return jsonResponse(400, {
        error: 'invalid_code',
        message: 'The verification code you entered is incorrect.',
      });
    }

    // Mark verified
    await admin
      .from('office_visit_email_verifications')
      .update({ verified: true })
      .eq('id', record.id);

    const emailVerificationToken = createEmailVerificationProofToken(normalizedEmail, session.user.id);

    return jsonResponse(200, {
      ok: true,
      emailVerificationToken,
      message: 'Email verified successfully.',
    });
  }

  return jsonResponse(400, { error: 'invalid_action' });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
