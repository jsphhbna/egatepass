import { jsonResponse } from '../../server/http.js';
import { sendResendEmail } from '../../server/email.js';
import {
  verifyStandardWebhookSignature,
  prepareAuthEmail,
  type SupabaseAuthEmailPayload,
} from '../../server/auth-email-hook.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const rawBody = await request.text();
  const hookSecret = process.env.SEND_EMAIL_HOOK_SECRET?.trim();

  // Signature verification
  if (!hookSecret) {
    console.warn('SEND_EMAIL_HOOK_SECRET is not configured. Rejecting request.');
    return jsonResponse(503, { error: 'auth_hook_unconfigured' });
  }

  const isValid = verifyStandardWebhookSignature(rawBody, request.headers, hookSecret);
  if (!isValid) {
    console.error('Invalid auth email hook signature.');
    return jsonResponse(401, { error: 'invalid_webhook_signature' });
  }

  let payload: SupabaseAuthEmailPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: 'invalid_json_payload' });
  }

  if (!payload?.user?.email || !payload?.email_data?.email_action_type) {
    return jsonResponse(400, { error: 'missing_required_hook_fields' });
  }

  try {
    const prepared = await prepareAuthEmail(payload);

    // Only attempt real sending if RESEND_API_KEY is configured
    if (process.env.RESEND_API_KEY?.trim()) {
      await sendResendEmail({
        to: prepared.to,
        subject: prepared.subject,
        html: prepared.html,
      });
      console.log(`[AUTH-EMAIL-HOOK] Dispatched ${payload.email_data.email_action_type} email for user ${payload.user.id.slice(0, 8)}...`);
    } else {
      console.log(`[AUTH-EMAIL-HOOK] Dry-run: rendered ${payload.email_data.email_action_type} email for user ${payload.user.id.slice(0, 8)}... (RESEND_API_KEY absent)`);
    }

    // GoTrue expects a 200 OK with empty JSON object {}
    return jsonResponse(200, {});
  } catch (error) {
    console.error('Failed to process auth email hook:', error instanceof Error ? error.message : 'unknown');
    return jsonResponse(500, { error: 'auth_email_processing_failed' });
  }
}

export default { fetch: handleRequest };
