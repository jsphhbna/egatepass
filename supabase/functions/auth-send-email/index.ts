// Supabase Edge Function: auth-send-email
// Serves as the documented Supabase Auth Send Email Hook (Standard Webhooks + Resend)
// Reference: https://supabase.com/docs/guides/functions/examples/auth-send-email-hook-react-email-resend

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

const resendApiKey = Deno.env.get('RESEND_API_KEY');
const hookSecret = Deno.env.get('SEND_EMAIL_HOOK_SECRET');
const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'EARIST E-GatePass <noreply@egatepass.earist.edu.ph>';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());

  if (!hookSecret) {
    return new Response(JSON.stringify({ error: 'SEND_EMAIL_HOOK_SECRET unconfigured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Verify Standard Webhooks signature
  try {
    const wh = new Webhook(hookSecret);
    wh.verify(rawBody, headers);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Parse payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { user, email_data } = payload;
  const actionType = email_data?.email_action_type;
  const recipient = user?.email;

  if (!recipient || !actionType) {
    return new Response(JSON.stringify({ error: 'Missing required payload fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Format link based on action type
  const siteUrl = (email_data.site_url || 'https://egatepass.earist.edu.ph').replace(/\/+$/, '');
  const redirectTo = email_data.redirect_to ? `&redirect_to=${encodeURIComponent(email_data.redirect_to)}` : '';
  
  // Under secure change: token_hash_new is for current email, token_hash is for new email
  let tokenHash = email_data.token_hash;
  if (actionType === 'email_change_current' && email_data.token_hash_new) {
    tokenHash = email_data.token_hash_new;
  }
  const actionUrl = `${siteUrl}/auth/v1/verify?token=${tokenHash}&type=${actionType === 'email_change_current' || actionType === 'email_change_new' ? 'email_change' : actionType}${redirectTo}`;

  // 4. Generate subject and HTML body
  let subject = 'EARIST E-GatePass Notification';
  if (actionType === 'signup') subject = 'Confirm your EARIST E-GatePass staff account';
  else if (actionType === 'recovery') subject = 'Reset your EARIST E-GatePass account password';
  else if (actionType === 'invite') subject = 'Invitation to join EARIST E-GatePass as staff';
  else if (actionType === 'email_change_current') subject = 'Authorize email address change for EARIST E-GatePass';
  else if (actionType === 'email_change_new') subject = 'Verify new email address for EARIST E-GatePass';

  const html = `
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8" /></head>
      <body style="font-family: -apple-system, sans-serif; background-color: #f4f4f5; padding: 24px 0; margin: 0;">
        <div style="background-color: #ffffff; max-width: 560px; margin: 0 auto; padding: 32px 28px; border-radius: 8px; border: 1px solid #e4e4e7;">
          <div style="border-bottom: 2px solid #800000; padding-bottom: 16px; margin-bottom: 24px;">
            <h1 style="color: #800000; font-size: 24px; margin: 0;">EARIST E-GatePass</h1>
            <p style="color: #71717a; font-size: 13px; margin: 4px 0 0 0;">Eulogio "Amang" Rodriguez Institute of Science and Technology</p>
          </div>
          <p style="font-size: 16px; color: #18181b;">Hello,</p>
          <p style="font-size: 14px; color: #3f3f46; line-height: 22px;">${subject}. Click the button below to proceed:</p>
          <div style="text-align: center; margin: 28px 0;">
            <a href="${actionUrl}" style="background-color: #800000; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">Proceed</a>
          </div>
          <p style="font-size: 12px; color: #71717a; word-break: break-all;">If the button does not work, copy and paste this link: ${actionUrl}</p>
          <hr style="border-color: #e4e4e7; margin: 28px 0 20px 0;" />
          <p style="font-size: 12px; color: #a1a1aa; text-align: center; margin: 0;">E-GatePass Campus Access Management System • Nagtahan, Sampaloc, Manila</p>
        </div>
      </body>
    </html>
  `;

  // 5. Send via Resend if key is available, else mock
  if (resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipient],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: 'Resend dispatch failed', details: err }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
