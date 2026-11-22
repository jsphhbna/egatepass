// Supabase Edge Function: send-sms
// Outbound SMS Gateway Hook for Supabase Auth ("Send SMS" Hook) and System Alerts
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

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await req.text();
  const hookSecret = Deno.env.get('SEND_SMS_HOOK_SECRET');

  // Verify Standard Webhook signature if secret configured
  if (hookSecret) {
    const id = req.headers.get('webhook-id');
    const timestampStr = req.headers.get('webhook-timestamp');
    const signature = req.headers.get('webhook-signature');

    if (!id || !timestampStr || !signature) {
      return new Response(JSON.stringify({ error: 'missing_webhook_headers' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check timestamp freshness (5 minutes)
    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 300) {
      return new Response(JSON.stringify({ error: 'timestamp_expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Helper: decode hook secret whether whsec_ (base64), raw 64-char hex, base64, or utf8
    function parseHookSecretBytes(s: string): Uint8Array {
      const clean = s.trim();
      if (clean.startsWith('whsec_')) {
        return Uint8Array.from(atob(clean.slice(6)), (c) => c.charCodeAt(0));
      }
      if (/^[0-9a-fA-F]{64}$/.test(clean)) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      }
      try {
        return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
      } catch {
        return new TextEncoder().encode(clean);
      }
    }

    // Verify HMAC
    const rawKeyBytes = parseHookSecretBytes(hookSecret);
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const toSign = encoder.encode(`${id}.${timestampStr}.${rawBody}`);
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, toSign);
    const expectedSigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const expectedSigHex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const sigParts = signature.split(/\s+/).flatMap((p) => p.split(','));
    const isValid = sigParts.some(
      (part) => part === expectedSigB64 || part === expectedSigHex || part === `v1,${expectedSigB64}` || part === `v1,${expectedSigHex}`
    );

    if (!isValid && !signature.includes(expectedSigB64) && !signature.includes(expectedSigHex)) {
      return new Response(JSON.stringify({ error: 'invalid_signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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
      // Stop: No account exists for this phone number
      return new Response(
        JSON.stringify({
          error: 'no account yet',
          message: 'Phone number is not associated with an existing account.',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Gateway credentials check
  const username = Deno.env.get('SMS_GATEWAY_USERNAME');
  const password = Deno.env.get('SMS_GATEWAY_PASSWORD');
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

  const messageText = otpCode
    ? `Your EARIST E-GatePass verification code is: ${otpCode}. Valid for 5 minutes. Do not share this code.`
    : body?.message || body?.text || 'EARIST E-GatePass Notification';

  // Normalize URL
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `https://${rawUrl}`;
  }
  rawUrl = rawUrl.replace(':443', '');
  const parsed = new URL(rawUrl);
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
      }),
    });

    const result = await gatewayRes.json().catch(() => null);

    if (!gatewayRes.ok) {
      return new Response(
        JSON.stringify({
          error: 'gateway_dispatch_failed',
          details: result,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        recipientMasked: maskPhone(cleanPhone),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: 'network_error',
        message: err?.message || 'Error communicating with SMS Gateway',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
