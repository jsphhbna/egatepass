// Supabase Edge Function: sms-intake
// Webhook receiver for incoming SMS from Android Gateway (sms:received event)
// Hardened: Fail-closed signature verification, strict timestamp validation, durable replay defense, device targeting, quota-controlled automated replies
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SMS_PREFIX = 'EG1';
const MAX_PAYLOAD_BYTES = 65_536; // 64 KB

function maskPhone(phone: string): string {
  const clean = phone.trim().replace(/[\s-]/g, '');
  if (clean.length < 8) return '••••••';
  const prefixLen = clean.startsWith('+63') ? 6 : 4;
  const suffixLen = 4;
  if (clean.length <= prefixLen + suffixLen) return `${clean.slice(0, 3)} ••• ${clean.slice(-2)}`;
  return `${clean.slice(0, prefixLen)} ••• ${clean.slice(-suffixLen)}`;
}

// Constant-time byte comparison to eliminate timing side-channel attacks
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    c |= a[i] ^ b[i];
  }
  return c === 0;
}

function decodeSmsMessage(raw: string) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.trim().split('|');
  if (parts.length < 6 || parts[0] !== SMS_PREFIX) return null;
  const msgId = parts[1].trim();
  const type = parts[2].trim().toUpperCase();
  const lat = parts[3].trim() ? parseFloat(parts[3].trim()) : null;
  const lon = parts[4].trim() ? parseFloat(parts[4].trim()) : null;
  const ts = parseInt(parts[5].trim(), 10);
  if (!msgId || !type || Number.isNaN(ts)) return null;
  return {
    version: SMS_PREFIX,
    msgId,
    type,
    latitude: lat !== null && !Number.isNaN(lat) ? lat : null,
    longitude: lon !== null && !Number.isNaN(lon) ? lon : null,
    timestamp: ts,
  };
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate Content-Type
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return new Response(JSON.stringify({ error: 'invalid_content_type', message: 'application/json required' }), {
      status: 415,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // FAIL CLOSED: Require SMS_INTAKE_SIGNING_KEY
  const signingKey = Deno.env.get('SMS_INTAKE_SIGNING_KEY')?.trim();
  if (!signingKey) {
    console.error('[SMS-INTAKE] SMS_INTAKE_SIGNING_KEY is not configured. Rejecting fail-closed.');
    return new Response(
      JSON.stringify({
        error: 'signing_key_not_configured',
        message: 'Endpoint authentication is misconfigured.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Check headers: X-Signature and X-Timestamp
  const signature = req.headers.get('x-signature') || req.headers.get('X-Signature');
  const timestampStr = req.headers.get('x-timestamp') || req.headers.get('X-Timestamp');

  if (!signature) {
    return new Response(JSON.stringify({ error: 'missing_x_signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!timestampStr) {
    return new Response(JSON.stringify({ error: 'missing_x_timestamp' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Strict timestamp validation: finite, positive, within 300s
  const ts = parseInt(timestampStr.trim(), 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || ts <= 0 || Math.abs(now - ts) > 300) {
    return new Response(JSON.stringify({ error: 'timestamp_outside_tolerance' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Constant-time HMAC validation
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Candidate 1: HMAC of rawBody
  const sigBuf1 = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(rawBody));
  const hex1 = Array.from(new Uint8Array(sigBuf1))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Candidate 2: HMAC of `${timestampStr}.${rawBody}`
  const sigBuf2 = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(`${timestampStr}.${rawBody}`));
  const hex2 = Array.from(new Uint8Array(sigBuf2))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const cleanPassed = signature.trim().toLowerCase();
  const passedBytes = encoder.encode(cleanPassed);

  let signatureValid = false;
  for (const expectedHex of [hex1, hex2]) {
    const expectedBytes = encoder.encode(expectedHex.toLowerCase());
    if (timingSafeEqualBytes(passedBytes, expectedBytes)) {
      signatureValid = true;
      break;
    }
  }

  // Candidate 3: Raw token match if gateway configured with bearer token
  if (!signatureValid) {
    const rawPassedBytes = encoder.encode(signature.trim());
    const rawSecretBytes = encoder.encode(signingKey.trim());
    if (timingSafeEqualBytes(rawPassedBytes, rawSecretBytes)) {
      signatureValid = true;
    }
  }

  if (!signatureValid) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Durable Replay Protection across multiple Edge Function instances via Supabase DB
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'database_configuration_missing' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Compute a unique request identifier (HMAC or SHA256 of signature + timestamp + body)
  const idHashBuf = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${cleanPassed}.${timestampStr}.${rawBody}`)
  );
  const replayIdentifier = Array.from(new Uint8Array(idHashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const { data: replayCheck, error: replayErr } = await supabase.schema('api').rpc('verify_and_record_inbound_replay', {
    p_identifier: replayIdentifier,
  });

  if (replayErr || replayCheck?.allowed === false) {
    return new Response(JSON.stringify({ error: 'replayed_request', message: 'Webhook request has already been processed.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const messageData = body?.data || body?.message || body;
  const senderNumber = String(messageData?.phoneNumber || messageData?.from || body?.phoneNumber || '').trim();
  const rawText = String(messageData?.message || messageData?.text || messageData?.body || '').trim();

  if (!senderNumber || !rawText) {
    return new Response(JSON.stringify({ error: 'sender_and_message_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse structured or fallback payload
  const parsedStructured = decodeSmsMessage(rawText);
  const msgId = parsedStructured?.msgId || `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reportType = parsedStructured?.type || 'SMS_INBOUND';
  const lat = parsedStructured?.latitude || null;
  const lon = parsedStructured?.longitude || null;
  const reportedAt = parsedStructured?.timestamp
    ? new Date(parsedStructured.timestamp * 1000).toISOString()
    : new Date().toISOString();

  // Call database function (service role only) to record inbound report
  const { data: dbResult, error: dbErr } = await supabase.schema('api').rpc('record_inbound_sms', {
    requested_msg_id: msgId,
    requested_sender_phone: senderNumber,
    requested_report_type: reportType,
    requested_lat: lat,
    requested_lon: lon,
    requested_reported_at: reportedAt,
    requested_raw_message: rawText,
  });

  if (dbErr) {
    console.error('[SMS-INTAKE] record_inbound_sms error:', dbErr);
  }

  // ============================================================================
  // Automated Outbound Confirmation Reply Path
  // Enforces:
  //   1. Do NOT reply if inbound event was duplicate (prevents reply storms)
  //   2. Require SMS_GATEWAY_DEVICE_ID
  //   3. HTTPS and canonical SMS Gateway endpoint
  //   4. Finite 15s timeout
  //   5. Quota reservation and finalization
  //   6. Sanitized errors & truthful acceptance reporting
  // ============================================================================
  let replyDispatched = false;
  let replyStatus = 'skipped';
  const isDuplicate = Boolean(dbResult?.duplicate);

  if (!isDuplicate && senderNumber) {
    const username = Deno.env.get('SMS_GATEWAY_USERNAME');
    const password = Deno.env.get('SMS_GATEWAY_PASSWORD');
    const deviceId = Deno.env.get('SMS_GATEWAY_DEVICE_ID')?.trim();
    let rawUrl = Deno.env.get('SMS_GATEWAY_URL') || 'https://api.sms-gate.app/3rdparty/v1/messages';

    if (!username || !password) {
      console.warn('[SMS-INTAKE] Reply skipped: SMS Gateway username or password missing.');
      replyStatus = 'credentials_missing';
    } else if (!deviceId) {
      console.warn('[SMS-INTAKE] Reply skipped: SMS_GATEWAY_DEVICE_ID missing.');
      replyStatus = 'device_id_missing';
    } else {
      // 1. Quota reservation for automated reply
      const replyCampaignId = `reply_${msgId}`;
      const { data: quota, error: quotaErr } = await supabase.schema('api').rpc('check_and_reserve_sms_quota', {
        requested_count: 1,
        campaign_id: replyCampaignId,
      });

      if (quotaErr || quota?.allowed !== true) {
        console.warn('[SMS-INTAKE] Reply skipped: Daily quota exceeded or reservation rejected.');
        replyStatus = 'quota_exceeded';
      } else {
        // Normalize URL and enforce HTTPS
        if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) rawUrl = `https://${rawUrl}`;
        rawUrl = rawUrl.replace(':443', '');
        const parsed = new URL(rawUrl);
        if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/3rdparty/v1/messages';
        else if (!parsed.pathname.endsWith('/messages')) parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages`;

        const confirmationText = 'EARIST Alert: Received your emergency report. Security dispatch has been notified.';
        let outcome = 'released';

        try {
          const gatewayRes = await fetch(`${parsed.toString()}?skipPhoneValidation=true`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${btoa(`${username}:${password}`)}`,
            },
            body: JSON.stringify({
              textMessage: { text: confirmationText },
              phoneNumbers: [senderNumber],
              deviceId: deviceId, // STRICT: Explicit Android device targeting
            }),
            signal: AbortSignal.timeout(15_000),
          });

          if (gatewayRes.ok) {
            replyDispatched = true;
            replyStatus = 'accepted_by_gateway';
            outcome = 'consumed';
          } else {
            console.error('[SMS-INTAKE] Gateway reply rejected with status:', gatewayRes.status);
            replyStatus = 'gateway_rejected';
            outcome = 'released';
          }
        } catch (fetchErr: any) {
          const isTimeout = fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError' || fetchErr?.code === 20;
          console.error('[SMS-INTAKE] Gateway dispatch error:', isTimeout ? 'timeout' : 'network_error');
          replyStatus = isTimeout ? 'gateway_timeout' : 'network_error';
          outcome = isTimeout ? 'timeout' : 'released';
        }

        // Finalize reply quota
        try {
          await supabase.schema('api').rpc('finalize_sms_quota', {
            p_campaign_id: replyCampaignId,
            p_outcome: outcome,
          });
        } catch (finErr) {
          console.error('[SMS-INTAKE] Failed to finalize reply quota:', finErr);
        }
      }
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      msgId,
      senderMasked: maskPhone(senderNumber),
      duplicate: isDuplicate,
      replyStatus,
      replyAcceptedByGateway: replyDispatched,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
