import { jsonResponse } from '../../http.js';
import { sendResendEmail, EmailDeliveryError } from '../../email.js';
import {
  verifyStandardWebhookSignature,
  prepareAuthEmails,
  type SupabaseAuthEmailPayload,
} from '../../auth-email-hook.js';

type HookStage =
  | 'request_received'
  | 'signature_verified'
  | 'payload_parsed'
  | 'template_prepare_start'
  | 'template_prepare_complete'
  | 'provider_send_start'
  | 'provider_send_complete';

function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HASH]')
    .replace(/\b(re_[a-zA-Z0-9_]{10,})\b/g, '[REDACTED_KEY]')
    .replace(/\b(whsec_[a-zA-Z0-9_+=/]{10,})\b/g, '[REDACTED_SECRET]')
    .slice(0, 200);
}

async function handleRequest(request: Request): Promise<Response> {
  let stage: HookStage = 'request_received';
  let actionType = 'unknown';

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

  stage = 'signature_verified';

  let payload: SupabaseAuthEmailPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: 'invalid_json_payload' });
  }

  if (!payload?.user?.email || !payload?.email_data?.email_action_type) {
    return jsonResponse(400, { error: 'missing_required_hook_fields' });
  }

  stage = 'payload_parsed';
  actionType = String(payload.email_data.email_action_type);

  try {
    stage = 'template_prepare_start';
    const preparedList = await prepareAuthEmails(payload);
    stage = 'template_prepare_complete';

    // Production hook: missing provider configuration -> non-2xx failure (REPAIR 6C & REPAIR GROUP E)
    if (!process.env.RESEND_API_KEY?.trim()) {
      if (process.env.NODE_ENV !== 'production' && (process.env.NODE_ENV === 'test' || process.env.AUTH_HOOK_DRY_RUN === 'true')) {
        console.log(`[AUTH-EMAIL-HOOK] Test dry-run: rendered ${actionType} email for user ${payload.user.id.slice(0, 8)}...`);
        return jsonResponse(200, {});
      }
      console.error('[AUTH-EMAIL-HOOK] RESEND_API_KEY is not configured in environment.');
      return jsonResponse(503, { error: 'provider_unconfigured' });
    }

    stage = 'provider_send_start';
    for (const prepared of preparedList) {
      await sendResendEmail({
        to: prepared.to,
        subject: prepared.subject,
        html: prepared.html,
      });
    }
    stage = 'provider_send_complete';
    console.log(`[AUTH-EMAIL-HOOK] Dispatched ${preparedList.length} ${actionType} email(s) for user ${payload.user.id.slice(0, 8)}...`);
    return jsonResponse(200, {});
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      // Safe logging: no recipient email address, no API keys, no verification tokens
      console.error(
        `[AUTH-EMAIL-HOOK] Delivery failed for action "${actionType}": code=${error.code}, outcome=${error.outcome}`
      );
      if (error.code === 'email_sender_invalid') {
        return jsonResponse(422, { error: 'email_sender_invalid' });
      }
      if (error.code === 'email_sender_unconfigured' || error.code === 'email_service_unconfigured') {
        return jsonResponse(503, { error: error.code });
      }
      if (error.code === 'resend_rejected') {
        return jsonResponse(502, { error: 'provider_rejected' });
      }
      if (error.code === 'resend_rate_limited') {
        return jsonResponse(429, { error: 'provider_rate_limited' });
      }
      if (error.code === 'resend_server_error') {
        return jsonResponse(502, { error: 'provider_server_error' });
      }
      return jsonResponse(502, { error: 'provider_delivery_failed', code: error.code });
    }

    const errName = error instanceof Error ? error.name : 'UnknownError';
    const sanitizedMsg = error instanceof Error ? sanitizeErrorMessage(error.message) : 'unknown';
    console.error(
      `[AUTH-EMAIL-HOOK] Unexpected failure: action="${actionType}" stage="${stage}" error="${errName}: ${sanitizedMsg}"`
    );
    return jsonResponse(500, { error: 'auth_email_processing_failed' });
  }
}

export default { fetch: handleRequest };
