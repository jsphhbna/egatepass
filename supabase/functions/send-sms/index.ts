// Supabase Edge Function: send-sms
// Outbound SMS Gateway Hook for Supabase Auth and System Alerts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

function maskPhone(phone: string): string {
  const clean = phone.trim().replace(/[\s-]/g, '');
  if (clean.length < 8) return '••••••';
  const prefixLen = clean.startsWith('+63') ? 5 : 4;
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

  const username = Deno.env.get('SMS_GATEWAY_USERNAME');
  const password = Deno.env.get('SMS_GATEWAY_PASSWORD');
  let rawUrl = Deno.env.get('SMS_GATEWAY_URL') || 'https://api.sms-gate.app/3rdparty/v1/messages';

  if (!username || !password) {
    return new Response(
      JSON.stringify({
        error: 'sms_gateway_not_configured',
        message: 'SMS_GATEWAY_USERNAME or SMS_GATEWAY_PASSWORD secret is missing.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle Supabase Auth Send SMS Hook format or direct call
  const phoneNumber = body?.user?.phone || body?.phone || body?.phoneNumber;
  const messageText = body?.sms?.otp
    ? `Your EARIST E-GatePass security code is: ${body.sms.otp}. Valid for 5 minutes.`
    : body?.message || body?.text;

  if (!phoneNumber || !messageText) {
    return new Response(JSON.stringify({ error: 'phone_and_message_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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

  // Format clean E.164 phone
  let cleanPhone = String(phoneNumber).trim().replace(/[\s-]/g, '');
  if (cleanPhone.startsWith('09') && cleanPhone.length === 11) {
    cleanPhone = `+63${cleanPhone.slice(1)}`;
  }

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
        result,
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
