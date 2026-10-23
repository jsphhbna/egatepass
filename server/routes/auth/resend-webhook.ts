import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { jsonResponse } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') return '[Unknown]';
  const parts = email.split('@');
  if (parts.length !== 2) return '[Invalid Email]';
  const local = parts[0];
  const domain = parts[1];
  if (!local || !domain) return '[Invalid Email]';
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`;
  return `${local[0] ?? ''}***${local[local.length - 1] ?? ''}@${domain}`;
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();

  if (!secret) {
    return jsonResponse(503, {
      error: 'webhook_secret_unconfigured',
      message: 'Resend webhook secret is not configured in this environment.',
    });
  }

  // Extract raw text body for cryptographic signature verification
  const rawBody = await request.text().catch(() => '');
  if (!rawBody) {
    return jsonResponse(400, { error: 'empty_payload' });
  }

  // Standard Webhooks / Svix header extraction
  const msgId = request.headers.get('svix-id') || request.headers.get('webhook-id');
  const msgTimestamp = request.headers.get('svix-timestamp') || request.headers.get('webhook-timestamp');
  const msgSignature = request.headers.get('svix-signature') || request.headers.get('webhook-signature');

  if (!msgId || !msgTimestamp || !msgSignature) {
    return jsonResponse(400, {
      error: 'invalid_signature',
      message: 'Missing required webhook signature headers.',
    });
  }

  const webhookHeaders = {
    'webhook-id': msgId,
    'webhook-timestamp': msgTimestamp,
    'webhook-signature': msgSignature,
  };

  let verifiedPayload: any;

  try {
    const wh = new Webhook(secret);
    verifiedPayload = wh.verify(rawBody, webhookHeaders);
  } catch (err: unknown) {
    if (err instanceof WebhookVerificationError) {
      return jsonResponse(400, {
        error: 'invalid_signature',
        message: 'Webhook signature verification failed.',
      });
    }
    return jsonResponse(400, {
      error: 'verification_error',
      message: err instanceof Error ? err.message : 'Unknown verification error',
    });
  }

  if (!verifiedPayload || typeof verifiedPayload !== 'object') {
    return jsonResponse(400, { error: 'invalid_payload' });
  }

  const eventType = String(verifiedPayload.type || '');
  const data = verifiedPayload.data || {};
  const emailId = String(data.email_id || data.id || msgId);

  // Supported Resend delivery event types
  const SUPPORTED_EVENTS = new Set([
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.complained',
    'email.bounced',
    'email.failed',
  ]);

  if (!SUPPORTED_EVENTS.has(eventType)) {
    // Acknowledge unsupported/informational event types gracefully without failure
    return jsonResponse(200, {
      ok: true,
      status: 'ignored_unsupported_event',
      eventType,
    });
  }

  const { admin } = getServerSupabaseClients();

  // Canonical idempotency: atomically claim the signed provider event ID in database
  const { error: claimError } = await admin
    .from('resend_webhook_events')
    .insert({
      provider_event_id: msgId,
      event_type: eventType,
      email_id: emailId,
    });

  if (claimError) {
    const isDuplicate =
      claimError.code === '23505' ||
      claimError.message?.includes('duplicate key') ||
      claimError.message?.includes('unique') ||
      claimError.message?.includes('resend_webhook_events_provider_id_unique');

    if (isDuplicate) {
      return jsonResponse(200, {
        ok: true,
        status: 'already_processed',
        duplicate: true,
        providerEventId: msgId,
        emailId,
        eventType,
      });
    }

    console.error('Failed to claim webhook provider event ID:', claimError);
    return jsonResponse(500, {
      error: 'idempotency_claim_failed',
      message: claimError.message,
    });
  }

  const recipient = Array.isArray(data.to) ? data.to[0] : (typeof data.to === 'string' ? data.to : null);
  const outcome = (eventType === 'email.delivered' || eventType === 'email.sent') ? 'success' : 'failure';

  const { error: insertError } = await admin.from('audit_events').insert({
    action: 'resend.delivery_event',
    actor_kind: 'system',
    actor_role: 'webhook',
    target_type: 'email',
    target_id: emailId,
    outcome,
    after_state: {
      eventType,
      emailId,
      recipientMasked: recipient ? maskEmail(recipient) : null,
      subjectSanitized: data.subject ? String(data.subject).slice(0, 100) : null,
      timestamp: new Date().toISOString(),
    },
  });

  if (insertError) {
    console.error('Failed to log Resend webhook delivery audit:', insertError);
    return jsonResponse(500, {
      error: 'audit_logging_failed',
      message: insertError.message,
    });
  }

  return jsonResponse(200, {
    ok: true,
    status: 'processed',
    emailId,
    eventType,
    outcome,
  });
}

export const POST = handleRequest;
export default { fetch: handleRequest, POST: handleRequest };
