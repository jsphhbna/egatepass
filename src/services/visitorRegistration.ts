import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePortalSupabase, requireSupabase } from '@/lib/supabase';

export type RegistrationSource = 'portal' | 'kiosk';

export interface VisitorRegistration {
  firstName: string;
  middleName?: string;
  lastName: string;
  contactNumber: string;
  purpose: string;
  visitDate: string;
}

export interface IssuedPass {
  passId: string;
  qrToken: string;
  validFrom: string;
  validUntil: string;
}

interface UploadIntent {
  intent_id: string;
  bucket_id: string;
  object_path: string;
  max_bytes: number;
}

export function evaluateTurnstilePolicy(
  source: RegistrationSource,
  isProd: boolean,
  siteKey?: string | null,
  captchaToken?: string | null,
): { allowed: boolean; error?: string } {
  if (source === 'kiosk') {
    return { allowed: true };
  }
  if (isProd) {
    if (!siteKey || siteKey.trim() === '') {
      return {
        allowed: false,
        error: 'Visitor registration is currently unavailable due to missing security configuration.',
      };
    }
    if (!captchaToken || captchaToken.trim() === '') {
      return {
        allowed: false,
        error: 'Verification challenge required to start registration.',
      };
    }
  }
  return { allowed: true };
}

async function authenticatedClient(
  source: RegistrationSource,
  captchaToken?: string,
): Promise<{ client: SupabaseClient; token: string }> {
  const client = source === 'portal' ? requirePortalSupabase() : requireSupabase();
  let { data: { session } } = await client.auth.getSession();
  if (source === 'portal' && session && !session.user.is_anonymous) {
    await client.auth.signOut();
    session = null;
  }
  if (source === 'portal' && !session) {
    const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
    const isProd = Boolean((import.meta as any).env?.PROD);

    const policy = evaluateTurnstilePolicy(source, isProd, siteKey, captchaToken);
    if (!policy.allowed) {
      throw new Error(policy.error);
    }

    const signInOptions = captchaToken ? { options: { captchaToken } } : undefined;
    const result = signInOptions
      ? await client.auth.signInAnonymously(signInOptions)
      : await client.auth.signInAnonymously();
    if (result.error) throw new Error('Visitor registration could not be started.');
    session = result.data.session;
  }
  if (!session) throw new Error(source === 'kiosk' ? 'Kiosk device not authenticated.' : 'Visitor session unavailable.');
  return { client, token: session.access_token };
}

async function uploadEvidence(
  client: SupabaseClient,
  source: RegistrationSource,
  kind: 'photo' | 'id',
  blob: Blob,
): Promise<string> {
  const contentType = blob.type || 'image/jpeg';
  const { data, error } = await client.schema('api').rpc('create_upload_intent', {
    requested_source: source,
    requested_kind: kind,
    requested_content_type: contentType,
  }).single<UploadIntent>();
  if (error || !data) throw new Error('Image upload could not be authorized.');
  if (blob.size < 1 || blob.size > data.max_bytes) throw new Error('Image exceeds the 5 MB upload limit.');

  const uploaded = await client.storage.from(data.bucket_id).upload(data.object_path, blob, {
    contentType,
    upsert: false,
  });
  if (uploaded.error) throw new Error('Image upload failed. Please try again.');
  return data.intent_id;
}

export async function issueVisitorPass(
  source: RegistrationSource,
  visitor: VisitorRegistration,
  photo: Blob,
  identification: Blob | null,
  requestId = crypto.randomUUID(),
  captchaToken?: string,
): Promise<IssuedPass> {
  const { client, token } = await authenticatedClient(source, captchaToken);
  const [photoIntentId, idIntentId] = await Promise.all([
    uploadEvidence(client, source, 'photo', photo),
    identification ? uploadEvidence(client, source, 'id', identification) : Promise.resolve(null),
  ]);

  const response = await fetch('/api/passes/issue', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      source,
      visitor,
      photoIntentId,
      idIntentId,
    }),
  });
  const body = await response.json().catch(() => null) as (IssuedPass & { error?: string }) | null;
  if (!response.ok || !body?.passId || !body.qrToken) {
    throw new Error(body?.error === 'service_unavailable'
      ? 'Pass service is temporarily unavailable.'
      : 'Failed to create visitor pass.');
  }
  return body;
}

export async function loadRegistrationSettings(source: RegistrationSource) {
  const client = source === 'portal' ? requirePortalSupabase() : requireSupabase();
  const { data, error } = await client
    .from('app_settings')
    .select('working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes')
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST205' || error.code === 'PGRST202') {
      console.warn(
        `[E-GatePass Diagnostic] Supabase schema migration required: table 'public.app_settings' was not found in schema cache (${error.code}). Default registration settings will be applied. Run migrations (starting with 20261020000100_core_schema.sql) on the Supabase project to persist custom settings.`
      );
    } else {
      console.warn('[E-GatePass Diagnostic] Could not load app_settings from Supabase:', error.message || error);
    }
    return null;
  }

  return data;
}
