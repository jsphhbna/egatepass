import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';
import { HttpError, recordReconciliation } from '../../server/actors.js';
import { escapeHtml, generateQrPngBuffer, sendResendEmail } from '../../server/email.js';

// Accept public_reference (e.g. GP-20261020-0001) or internal UUID
const passIdSchema = z.string().trim().min(6).max(64);

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

interface VerificationRow {
  id: string;
  pass_id: string;
  recipient_email: string;
  code_hash: string;
  attempts: number;
  verified: boolean;
  expires_at: string;
  request_id?: string | null;
  send_request_id?: string | null;
  delivery_status?: string | null;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const rawBody = await request.json().catch(() => null);
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const { data: identity, error: authError } = await admin.auth.getUser(token);
    if (authError || !identity.user) {
      return jsonResponse(401, { error: 'invalid_session' });
    }
    const actorId = identity.user.id;

    // Look up the pass by public_reference (or fallback to id if UUID provided)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.data.passId);
    let passQuery = admin
      .from('passes')
      .select(`
        id,
        public_reference,
        status,
        valid_from,
        valid_until,
        token_digest,
        visitors (
          id,
          owner_id,
          source,
          full_name,
          visit_date,
          purpose
        )
      `);

    if (isUuid) {
      passQuery = passQuery.or(`public_reference.eq.${parsed.data.passId},id.eq.${parsed.data.passId}`);
    } else {
      passQuery = passQuery.eq('public_reference', parsed.data.passId);
    }

    const { data: passRow, error: passError } = await passQuery.maybeSingle<PassWithVisitor>();

    if (passError) throw passError;
    if (!passRow || !passRow.visitors) {
      return jsonResponse(404, { error: 'pass_not_found' });
    }

    // Verify caller is the owner of this pass (visitor session or kiosk device)
    if (passRow.visitors.owner_id !== actorId) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    // Verify pass is currently active and not expired
    if (passRow.status !== 'issued') {
      return jsonResponse(400, { error: 'pass_not_active', status: passRow.status });
    }
    if (new Date(passRow.valid_until).getTime() <= Date.now()) {
      return jsonResponse(400, { error: 'pass_expired' });
    }

    // Verify the caller possesses the exact bearer QR token matching the stored digest
    // Handle Postgres bytea representation (\x or plain hex) and use timing-safe comparison
    const rawStoredDigest = (passRow.token_digest || '').replace(/^[\\0]x/i, '');
    const storedDigestBuf = Buffer.from(rawStoredDigest, 'hex');
    const expectedDigestBuf = createHash('sha256').update(parsed.data.qrToken).digest();

    if (
      storedDigestBuf.length !== expectedDigestBuf.length ||
      !timingSafeEqual(storedDigestBuf, expectedDigestBuf)
    ) {
      return jsonResponse(403, { error: 'invalid_bearer_token' });
    }

    const recipient = parsed.data.recipientEmail.trim().toLowerCase();

    // =========================================================================
    // ACTION 1: REQUEST VERIFICATION CODE
    // =========================================================================
    if (parsed.data.action === 'request_code') {
      const verificationId = randomUUID();
      // Generate cryptographically secure 6-digit verification code
      const codeNum = randomInt(100000, 1000000);
      const code = String(codeNum);
      const codeHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      let activeVerificationId = verificationId;
      let activeExpiresAt = expiresAt;

      // Call atomic RPC with rate-limiting and idempotency
      const rpcResult = await admin.schema('api').rpc('request_email_verification_code', {
        requested_pass_id: passRow.id,
        requested_actor_id: actorId,
        requested_recipient_email: recipient,
        requested_code_hash: codeHash,
        requested_request_id: parsed.data.requestId,
        requested_verification_id: verificationId,
        requested_expires_at: expiresAt,
      });

      if (rpcResult.error) {
        const errCode = rpcResult.error.code;
        const errMsg = rpcResult.error.message || '';
        if (errCode === '42501' || errMsg.includes('access_denied')) {
          return jsonResponse(403, { error: 'access_denied' });
        }
        if (errCode === 'P0002' || errMsg.includes('pass_not_found')) {
          return jsonResponse(404, { error: 'pass_not_found' });
        }
        if (errCode === 'P0003' || errMsg.includes('too_many_requests')) {
          return jsonResponse(429, {
            error: 'too_many_requests',
            message: 'Too many email requests for this pass. Please wait 15 minutes before trying again.',
          });
        }
        if (errCode === 'P0001' || errMsg.includes('pass_expired') || errMsg.includes('pass_not_active')) {
          return jsonResponse(400, { error: errMsg || 'pass_not_active' });
        }

        // Direct database fallback if RPC not installed in current environment
        const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const { count, error: countError } = await admin
          .from('pass_email_verifications')
          .select('id', { count: 'exact', head: true })
          .eq('pass_id', passRow.id)
          .gte('created_at', windowStart);

        if (countError) throw countError;
        if (typeof count === 'number' && count >= 3) {
          return jsonResponse(429, {
            error: 'too_many_requests',
            message: 'Too many email requests for this pass. Please wait 15 minutes before trying again.',
          });
        }

        const { error: insertError } = await admin
          .from('pass_email_verifications')
          .insert({
            id: verificationId,
            pass_id: passRow.id,
            recipient_email: recipient,
            code_hash: codeHash,
            attempts: 0,
            verified: false,
            expires_at: expiresAt,
            request_id: parsed.data.requestId,
            delivery_status: 'pending',
          });

      } else if (rpcResult.data) {
        const rpcData = rpcResult.data as any;
        if (rpcData.idempotent_replay) {
          return jsonResponse(200, {
            success: true,
            verificationId: rpcData.verification_id,
            expiresAt: rpcData.expires_at,
            status: 'code_sent',
            idempotentReplay: true,
          });
        }
        activeVerificationId = rpcData.verification_id || verificationId;
        activeExpiresAt = rpcData.expires_at || expiresAt;
      }

      // Send verification code email via Resend
      const escapedVisitorName = escapeHtml(passRow.visitors.full_name);
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #800000; margin-top: 0;">EARIST E-GatePass</h2>
          <p>Hello <strong>${escapedVisitorName}</strong>,</p>
          <p>You requested email delivery of your digital EARIST Gate Pass. Please enter this verification code to confirm ownership of your email address:</p>
          <div style="text-align: center; margin: 28px 0;">
            <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #800000; padding: 12px 24px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 6px;">
              ${code}
            </span>
          </div>
          <p style="font-size: 13px; color: #6b7280;">This code will expire in 10 minutes. If you did not request this, you can safely ignore this email.</p>
        </div>
      `;

      try {
        await sendResendEmail({
          to: recipient,
          subject: 'EARIST Gate Pass — Verification Code',
          html: emailHtml,
        });
      } catch (sendErr) {
        console.error('Failed to send verification code email:', sendErr);
        const code = (sendErr as { code?: string })?.code;
        if (code === 'email_service_unconfigured') {
          return jsonResponse(503, { error: 'email_service_unconfigured', message: 'Email delivery is currently unconfigured.' });
        }
        return jsonResponse(502, { error: 'verification_email_failed', message: 'Could not send verification email.' });
      }

      return jsonResponse(200, {
        success: true,
        verificationId: activeVerificationId,
        expiresAt: activeExpiresAt,
        status: 'code_sent',
      });
    }

    // =========================================================================
    // ACTION 2: VERIFY AND SEND PASS QR
    // =========================================================================
    if (parsed.data.action === 'verify_and_send') {
      const { verificationId, code, requestId } = parsed.data;
      const expectedHash = createHash('sha256').update(`${verificationId}:${code}`).digest('hex');

      // Attempt atomic claim via protected RPC
      const claimRpc = await admin.schema('api').rpc('verify_and_claim_email_dispatch', {
        requested_verification_id: verificationId,
        requested_pass_id: passRow.id,
        requested_actor_id: actorId,
        requested_recipient_email: recipient,
        requested_expected_hash: expectedHash,
        requested_send_request_id: requestId,
      });

      if (claimRpc.error) {
        const errCode = claimRpc.error.code;
        const errMsg = claimRpc.error.message || '';

        if (errCode === 'P0002' || errMsg.includes('verification_not_found')) {
          return jsonResponse(404, { error: 'verification_not_found' });
        }
        if (errCode === '42501' || errMsg.includes('access_denied')) {
          return jsonResponse(403, { error: 'access_denied' });
        }
        if (errCode === 'P0004' || errMsg.includes('code_already_used')) {
          return jsonResponse(409, { error: 'code_already_used' });
        }
        if (errCode === 'P0005' || errMsg.includes('dispatch_in_progress')) {
          return jsonResponse(409, { error: 'dispatch_in_progress', message: 'Delivery dispatch already in progress.' });
        }
        if (errCode === 'P0006' || errMsg.includes('code_expired')) {
          return jsonResponse(410, { error: 'code_expired' });
        }
        if (errCode === 'P0007' || errMsg.includes('max_attempts_exceeded')) {
          return jsonResponse(429, { error: 'max_attempts_exceeded', message: 'Too many incorrect attempts. Please request a new code.' });
        }
        if (errCode === 'P0008' || errMsg.includes('recipient_mismatch')) {
          return jsonResponse(400, { error: 'recipient_mismatch' });
        }

        // Direct table fallback if RPC not installed
        const { data: verif, error: verifError } = await admin
          .from('pass_email_verifications')
          .select('*')
          .eq('id', verificationId)
          .eq('pass_id', passRow.id)
          .maybeSingle<VerificationRow>();

        if (verifError) throw verifError;
        if (!verif) return jsonResponse(404, { error: 'verification_not_found' });
        if (verif.verified && verif.delivery_status === 'sent_to_provider') return jsonResponse(409, { error: 'code_already_used' });
        if (new Date(verif.expires_at).getTime() <= Date.now()) return jsonResponse(410, { error: 'code_expired' });
        if (verif.attempts >= 3) return jsonResponse(429, { error: 'max_attempts_exceeded' });
        if (verif.recipient_email !== recipient) return jsonResponse(400, { error: 'recipient_mismatch' });

        if (expectedHash !== verif.code_hash) {
          await admin
            .from('pass_email_verifications')
            .update({ attempts: verif.attempts + 1 })
            .eq('id', verif.id);

          return jsonResponse(400, {
            error: 'invalid_code',
            attemptsRemaining: Math.max(0, 2 - verif.attempts),
          });
        }

        // Lock for sending
        await admin
          .from('pass_email_verifications')
          .update({ verified: true, delivery_status: 'sending', send_request_id: requestId })
          .eq('id', verif.id);
      } else if (claimRpc.data) {
        const claimData = claimRpc.data as any;
        if (claimData.success === false) {
          return jsonResponse(400, {
            error: 'invalid_code',
            attemptsRemaining: claimData.attempts_remaining ?? 0,
          });
        }
      }

      // Generate PNG QR code attachment
      const qrPngBuffer = await generateQrPngBuffer(parsed.data.qrToken);
      const qrBase64 = qrPngBuffer.toString('base64');

      const visitorName = escapeHtml(passRow.visitors.full_name);
      const visitDate = escapeHtml(passRow.visitors.visit_date);
      const purpose = escapeHtml(passRow.visitors.purpose);
      const validFromTime = new Date(passRow.valid_from).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
      const validUntilTime = new Date(passRow.valid_until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #800000; margin-top: 0;">EARIST Digital Gate Pass</h2>
          <p>Dear <strong>${visitorName}</strong>,</p>
          <p>Your official visitor pass for <strong>${visitDate}</strong> has been issued.</p>
          <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 20px 0;">
            <p style="margin: 4px 0;"><strong>Visitor:</strong> ${visitorName}</p>
            <p style="margin: 4px 0;"><strong>Pass ID:</strong> ${escapeHtml(passRow.public_reference)}</p>
            <p style="margin: 4px 0;"><strong>Date:</strong> ${visitDate}</p>
            <p style="margin: 4px 0;"><strong>Valid Hours:</strong> ${validFromTime} – ${validUntilTime} (Asia/Manila)</p>
            <p style="margin: 4px 0;"><strong>Purpose:</strong> ${purpose}</p>
          </div>
          <p style="font-weight: bold; color: #111827;">Attached is your scannable QR code.</p>
          <p style="font-size: 14px; color: #4b5563;">Present this QR code on your phone or printed to the scanner tablet at the campus gate upon arrival.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="font-size: 12px; color: #6b7280; line-height: 1.5;">
            Campus Security Notice: This gate pass is a non-transferable bearer credential issued for authorized campus entry. Do not share or forward this code. Campus guards verify identity against campus policies.
          </p>
        </div>
      `;

      try {
        const sendResult = await sendResendEmail({
          to: recipient,
          subject: 'Your EARIST Digital Gate Pass QR Code',
          html: emailHtml,
          attachments: [
            {
              filename: 'earist-gate-pass-qr.png',
              content: qrBase64,
            },
          ],
        });

        // Finalize state: submitted/sent to provider
        const finalizeSuccess = await admin.schema('api').rpc('finalize_email_dispatch', {
          requested_verification_id: verificationId,
          requested_send_request_id: requestId,
          requested_delivery_status: 'sent_to_provider',
          requested_provider_delivery_id: sendResult.id,
        });

        if (finalizeSuccess.error) {
          // Direct fallback
          await admin
            .from('pass_email_verifications')
            .update({
              delivery_status: 'sent_to_provider',
              provider_delivery_id: sendResult.id,
              sent_at: new Date().toISOString(),
            })
            .eq('id', verificationId);
        }

        return jsonResponse(200, {
          success: true,
          status: 'sent_to_provider',
          deliveryId: sendResult.id,
          recipientEmail: recipient,
        });
      } catch (deliveryErr) {
        console.error('QR pass email delivery failed:', deliveryErr);

        // Finalize state: failed delivery (unlocking for retry)
        const finalizeFailure = await admin.schema('api').rpc('finalize_email_dispatch', {
          requested_verification_id: verificationId,
          requested_send_request_id: requestId,
          requested_delivery_status: 'delivery_failed',
          requested_provider_delivery_id: null,
        });

        if (finalizeFailure.error) {
          await admin
            .from('pass_email_verifications')
            .update({ delivery_status: 'delivery_failed' })
            .eq('id', verificationId);
        }

        await recordReconciliation(
          admin,
          'pass.email_delivery_failed',
          'pass',
          passRow.id,
          (deliveryErr as { code?: string })?.code ?? 'delivery_failed',
          { recipient }
        );

        return jsonResponse(502, {
          error: 'email_delivery_failed',
          message: 'The email delivery provider rejected the message. You can still download your pass QR directly.',
        });
      }
    }

    return jsonResponse(400, { error: 'invalid_action' });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Pass email endpoint error:', error);
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
