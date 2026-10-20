import { jsonResponse } from '../../server/http.js';
import { sendResendEmail } from '../../server/email.js';
import {
  verifyStandardWebhookSignature,
  prepareAuthEmails,
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
    const preparedList = await prepareAuthEmails(payload);

    // Production hook: missing provider configuration -> non-2xx failure (REPAIR 6C & REPAIR GROUP E)
    if (!process.env.RESEND_API_KEY?.trim()) {
      if (process.env.NODE_ENV !== 'production' && (process.env.NODE_ENV === 'test' || process.env.AUTH_HOOK_DRY_RUN === 'true')) {
        console.log(`[AUTH-EMAIL-HOOK] Test dry-run: rendered ${payload.email_data.email_action_type} email for user ${payload.user.id.slice(0, 8)}...`);
        return jsonResponse(200, {});
      }
      console.error('[AUTH-EMAIL-HOOK] RESEND_API_KEY is not configured in environment.');
      return jsonResponse(503, { error: 'provider_unconfigured' });
    }

    for (const prepared of preparedList) {
      await sendResendEmail({
        to: prepared.to,
        subject: prepared.subject,
        html: prepared.html,
      });
    }
    console.log(`[AUTH-EMAIL-HOOK] Dispatched ${preparedList.length} ${payload.email_data.email_action_type} email(s) for user ${payload.user.id.slice(0, 8)}...`);
    return jsonResponse(200, {});
  } catch (error) {
    console.error('Failed to process auth email hook:', error instanceof Error ? error.message : 'unknown');
    return jsonResponse(500, { error: 'auth_email_processing_failed' });
  }
}

export default { fetch: handleRequest };
