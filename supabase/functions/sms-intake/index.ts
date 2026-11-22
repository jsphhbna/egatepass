// Supabase Edge Function: sms-intake
// Webhook receiver for incoming SMS from Android Gateway (sms:received event)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SMS_PREFIX = 'EG1';

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

  const rawBody = await req.text();
  const signingKey = Deno.env.get('SMS_INTAKE_SIGNING_KEY');
  const signature = req.headers.get('x-signature') || req.headers.get('X-Signature');
  const timestampStr = req.headers.get('x-timestamp') || req.headers.get('X-Timestamp');

  // Verify X-Signature and X-Timestamp
  if (signingKey) {
    if (!signature) {
      return new Response(JSON.stringify({ error: 'missing_x_signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (timestampStr) {
      const ts = parseInt(timestampStr, 10);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > 300) {
        return new Response(JSON.stringify({ error: 'timestamp_outside_tolerance' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Compute expected HMAC
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(rawBody));
    const hex = Array.from(new Uint8Array(sigBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (signature.toLowerCase() !== hex && signature !== signingKey) {
      return new Response(JSON.stringify({ error: 'signature_mismatch' }), {
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

  // Call database function (service role only)
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  let dbResult: any = null;
  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('record_inbound_sms', {
      requested_msg_id: msgId,
      requested_sender_phone: senderNumber,
      requested_report_type: reportType,
      requested_lat: lat,
      requested_lon: lon,
      requested_reported_at: reportedAt,
      requested_raw_message: rawText,
    });
    if (error) {
      console.error('[SMS-INTAKE] record_inbound_sms error:', error);
    } else {
      dbResult = data;
    }
  }

  // Reply confirmation under 160 characters from Gateway SIM
  const confirmationText = 'EARIST Alert: Received your emergency report. Security dispatch has been notified.';
  const username = Deno.env.get('SMS_GATEWAY_USERNAME');
  const password = Deno.env.get('SMS_GATEWAY_PASSWORD');
  let rawUrl = Deno.env.get('SMS_GATEWAY_URL') || 'https://api.sms-gate.app/3rdparty/v1/messages';

  if (username && password && senderNumber) {
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) rawUrl = `https://${rawUrl}`;
    rawUrl = rawUrl.replace(':443', '');
    const parsed = new URL(rawUrl);
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/3rdparty/v1/messages';
    else if (!parsed.pathname.endsWith('/messages')) parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/messages`;

    try {
      await fetch(`${parsed.toString()}?skipPhoneValidation=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        },
        body: JSON.stringify({
          textMessage: { text: confirmationText },
          phoneNumbers: [senderNumber],
        }),
      });
    } catch (replyErr) {
      console.warn('[SMS-INTAKE] Failed to dispatch reply confirmation:', replyErr);
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      msgId,
      dbResult,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
