// Supabase Edge Function: send-sms
// Outbound SMS Gateway Hook for Supabase Auth ("Send SMS" Hook) and System Alerts
// Hardened: Fail-closed signature verification, constant-time comparison, replay defense, mandatory device ID targeting
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// In-memory cache for webhook replay protection (within 5-minute sliding window)
const seenWebhookIds = new Map<string, number>();

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

  const rawBody = await req.text();
  const hookSecret = Deno.env.get('SEND_SMS_HOOK_SECRET')?.trim();

  // FAIL CLOSED: If hook secret is not configured, reject all requests immediately
  if (!hookSecret) {
    console.error('[SEND-SMS] SEND_SMS_HOOK_SECRET is not configured. Rejecting request fail-closed.');
    return new Response(
      JSON.stringify({
        error: 'hook_secret_not_configured',
        message: 'Endpoint authentication is misconfigured.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Verify Standard Webhook headers
  const id = req.headers.get('webhook-id')?.trim();
  const timestampStr = req.headers.get('webhook-timestamp')?.trim();
  const signature = req.headers.get('webhook-signature')?.trim();

  if (!id || !timestampStr || !signature) {
    return new Response(JSON.stringify({ error: 'missing_webhook_headers' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check timestamp freshness (5 minutes = 300 seconds) & finite number check
  const timestamp = parseInt(timestampStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || Math.abs(now - timestamp) > 300) {
    return new Response(JSON.stringify({ error: 'timestamp_expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Replay Attack Protection: prune stale IDs older than 300s
  for (const [seenId, seenTs] of seenWebhookIds.entries()) {
    if (now - seenTs > 300) {
      seenWebhookIds.delete(seenId);
    }
  }
  if (seenWebhookIds.has(id)) {
    return new Response(JSON.stringify({ error: 'replayed_request' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  seenWebhookIds.set(id, timestamp);

  // Candidate key buffers: handle whsec_ (base64), raw hex string bytes, raw base64, and utf8 string
  function getCandidateKeyBytes(s: string): Uint8Array[] {
    const clean = s.trim();
    const candidates: Uint8Array[] = [];
    if (clean.startsWith('whsec_')) {
      try {
        candidates.push(Uint8Array.from(atob(clean.slice(6)), (c) => c.charCodeAt(0)));
      } catch {}
    }
    if (/^[0-9a-fA-F]{16,}$/.test(clean) && clean.length % 2 === 0) {
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
      }
      candidates.push(bytes);
    }
    try {
      const b64 = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
      if (b64.length > 0) candidates.push(b64);
    } catch {}
    candidates.push(new TextEncoder().encode(clean));
    return candidates;
  }

  // Verify HMAC using Web Crypto across candidate keys
  const candidateKeys = getCandidateKeyBytes(hookSecret);
  const encoder = new TextEncoder();
  const toSign = encoder.encode(`${id}.${timestampStr}.${rawBody}`);
  const sigItems = signature.split(/\s+/).flatMap((p) => p.split(','));
  let signatureMatched = false;

  for (const rawKeyBytes of candidateKeys) {
    if (!rawKeyBytes || rawKeyBytes.length === 0) continue;
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        rawKeyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, toSign);
      const expectedSigBytes = new Uint8Array(sigBuf);
      const expectedSigB64 = btoa(String.fromCharCode(...expectedSigBytes));
      const expectedSigHex = Array.from(expectedSigBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      for (const item of sigItems) {
        const cleanItem = item.startsWith('v1,') ? item.slice(3) : item;
        if (cleanItem === expectedSigB64) {
          try {
            const itemBytes = Uint8Array.from(atob(cleanItem), (c) => c.charCodeAt(0));
            if (timingSafeEqualBytes(itemBytes, expectedSigBytes)) {
              signatureMatched = true;
              break;
            }
          } catch {}
        }
        if (cleanItem.toLowerCase() === expectedSigHex.toLowerCase()) {
          const expectedHexBytes = encoder.encode(expectedSigHex.toLowerCase());
          const itemHexBytes = encoder.encode(cleanItem.toLowerCase());
          if (timingSafeEqualBytes(itemHexBytes, expectedHexBytes)) {
            signatureMatched = true;
            break;
          }
        }
      }

      if (signatureMatched) break;
    } catch {}
  }

  if (!signatureMatched) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), {
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

  const phoneNumber = body?.user?.phone || body?.phone || body?.phoneNumber;
  const otpCode = body?.sms?.otp;

  if (!phoneNumber) {
    return new Response(JSON.stringify({ error: 'phone_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let cleanPhone = String(phoneNumber).trim().replace(/[\s-]/g, '');
  if (cleanPhone.startsWith('09') && cleanPhone.length === 11) {
    cleanPhone = `+63${cleanPhone.slice(1)}`;
  }

  // Account Existence Check: Only text a code to a number that already has an account
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const localPhone = cleanPhone.startsWith('+63') ? `0${cleanPhone.slice(3)}` : cleanPhone;

    // Check visitors table
    const { data: hasVisitor } = await supabase
      .from('visitors')
      .select('id')
      .or(`contact_number.eq.${cleanPhone},contact_number.eq.${localPhone}`)
      .limit(1);

    let hasAccount = Boolean(hasVisitor && hasVisitor.length > 0);

    if (!hasAccount) {
      try {
        const { data: authUsers } = await supabase.auth.admin.listUsers();
        if (authUsers?.users?.some((u) => u.phone === cleanPhone || u.phone === localPhone)) {
          hasAccount = true;
        }
      } catch (authErr) {
        console.warn('[SEND-SMS] Auth admin listUsers fallback error:', authErr);
      }
    }

    if (!hasAccount) {
      return new Response(
        JSON.stringify({
          error: 'no account yet',
          message: 'Phone number is not associated with an existing account.',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Gateway credentials & device configuration
  const username = Deno.env.get('SMS_GATEWAY_USERNAME');
  const password = Deno.env.get('SMS_GATEWAY_PASSWORD');
  const deviceId = Deno.env.get('SMS_GATEWAY_DEVICE_ID')?.trim();
  let rawUrl = Deno.env.get('SMS_GATEWAY_URL') || 'https://api.sms-gate.app/3rdparty/v1/messages';

  if (!username || !password) {
    return new Response(
      JSON.stringify({
        error: 'sms_gateway_not_configured',
        message: 'SMS_GATEWAY_USERNAME or SMS_GATEWAY_PASSWORD is not configured.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // P1 FIX: Mandatory Device ID Targeting across all outbound paths
  if (!deviceId) {
    console.error('[SEND-SMS] SMS_GATEWAY_DEVICE_ID is not configured.');
    return new Response(
      JSON.stringify({
        error: 'sms_gateway_device_id_not_configured',
        message: 'SMS_GATEWAY_DEVICE_ID is not configured.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const messageText = otpCode
    ? `Your EARIST E-GatePass verification code is: ${otpCode}. Valid for 5 minutes. Do not share this code.`
    : body?.message || body?.text || 'EARIST E-GatePass Notification';

  // Normalize URL and enforce HTTPS
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `https://${rawUrl}`;
  }
  rawUrl = rawUrl.replace(':443', '');
  const parsed = new URL(rawUrl);

  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return new Response(
      JSON.stringify({
        error: 'sms_gateway_https_required',
        message: 'HTTPS is required for external SMS Gateway endpoint.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/3rdparty/v1/messages';
  } else if (!parsed.pathname.endsWith('/messages')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages`;
  }
  const endpoint = `${parsed.toString()}?skipPhoneValidation=true`;

  const basicAuth = btoa(`${username}:${password}`);

  try {
    const gatewayRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        textMessage: {
          text: messageText,
        },
        phoneNumbers: [cleanPhone],
        deviceId: deviceId, // STRICTLY REQUIRED: Device ID explicitly injected
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!gatewayRes.ok) {
      console.error('[SEND-SMS] Gateway dispatch returned status:', gatewayRes.status);
      return new Response(
        JSON.stringify({
          error: 'gateway_dispatch_failed',
          statusCode: gatewayRes.status,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: 'accepted_by_gateway',
        recipientMasked: maskPhone(cleanPhone),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 20;
    return new Response(
      JSON.stringify({
        error: isTimeout ? 'sms_gateway_request_timeout' : 'network_error',
        message: isTimeout ? 'Gateway request timed out after 15s' : 'Error communicating with SMS Gateway',
      }),
      { status: 504, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
