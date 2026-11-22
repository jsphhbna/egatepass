// Supabase Edge Function: sms-intake
// Webhook receiver for incoming SMS from Android Gateway (sms:received event)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

  const signingKey = Deno.env.get('SMS_INTAKE_SIGNING_KEY');
  const signature = req.headers.get('x-signature') || req.headers.get('x-gateway-signature');

  // Verify signature if signing key is configured
  if (signingKey && signature) {
    // Optional HMAC check or token comparison
    if (signature !== signingKey && !signature.includes(signingKey)) {
      console.warn('[SMS-INTAKE] Unauthorized signature mismatch');
      return new Response(JSON.stringify({ error: 'invalid_signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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

  // Parse incoming payload structure from SMS Gateway for Android
  // Payload usually contains event: 'sms:received', data: { phoneNumber, message, receivedAt }
  const messageData = body?.data || body?.message || body;
  const senderNumber = messageData?.phoneNumber || messageData?.from || body?.phoneNumber || 'Unknown';
  const messageText = messageData?.message || messageData?.text || messageData?.body || '';

  // Write to public.sms_logs table via Supabase client
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (supabaseUrl && serviceRoleKey) {
    try {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      await supabase.from('sms_logs').insert({
        direction: 'inbound',
        recipient_masked: 'EARIST Gateway',
        sender_masked: maskPhone(senderNumber),
        message_body: messageText,
        purpose: 'inbound_message',
        status: 'received',
      });
    } catch (dbErr) {
      console.error('[SMS-INTAKE] Failed to record incoming SMS to database:', dbErr);
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: 'SMS received and logged successfully',
      senderMasked: maskPhone(senderNumber),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
