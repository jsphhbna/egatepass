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

export interface PortalIssueTransaction {
  requestId: string;
  actorId: string;
  token: string;
  photoIntentId: string | null;
  idIntentId: string | null;
  submittedPayload?: {
    visitor: VisitorRegistration;
  } | null;
}

export async function createPortalIssueTransaction(captchaToken?: string): Promise<PortalIssueTransaction> {
  const client = requirePortalSupabase();
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
  const isProd = Boolean((import.meta as any).env?.PROD);

  const policy = evaluateTurnstilePolicy('portal', isProd, siteKey, captchaToken);
  if (!policy.allowed) {
    throw new Error(policy.error);
  }

  // Rotate/sign out any stale portal anonymous session once when establishing a NEW transaction
  const { data: { session: existingSession } } = await client.auth.getSession();
  if (existingSession) {
    await client.auth.signOut();
  }

  const signInOptions = captchaToken ? { options: { captchaToken } } : undefined;
  const result = signInOptions
    ? await client.auth.signInAnonymously(signInOptions)
    : await client.auth.signInAnonymously();

  if (result.error || !result.data.session) {
    throw new Error('Visitor registration could not be started.');
  }

  const session = result.data.session;
  return {
    requestId: crypto.randomUUID(),
    actorId: session.user.id,
    token: session.access_token,
    photoIntentId: null,
    idIntentId: null,
    submittedPayload: null,
  };
}

async function authenticatedClient(
  source: RegistrationSource,
  captchaToken?: string,
  existingTransaction?: PortalIssueTransaction | null,
): Promise<{ client: SupabaseClient; token: string }> {
  if (source === 'portal') {
    const client = requirePortalSupabase();
    if (existingTransaction?.token && existingTransaction?.actorId) {
      // Reuse existing transaction session
      const { data: { session } } = await client.auth.getSession();
      if (session && session.user.id === existingTransaction.actorId) {
        return { client, token: session.access_token };
      }
      return { client, token: existingTransaction.token };
    }

    const newTx = await createPortalIssueTransaction(captchaToken);
    if (existingTransaction) {
      existingTransaction.requestId = newTx.requestId;
      existingTransaction.actorId = newTx.actorId;
      existingTransaction.token = newTx.token;
      existingTransaction.photoIntentId = newTx.photoIntentId;
      existingTransaction.idIntentId = newTx.idIntentId;
    }
    return { client, token: newTx.token };
  }

  const client = requireSupabase();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Kiosk device not authenticated.');
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
  requestId: string = crypto.randomUUID(),
  captchaToken?: string,
  transaction?: PortalIssueTransaction | null,
): Promise<IssuedPass> {
  const { client, token } = await authenticatedClient(source, captchaToken, transaction);

  const effectiveRequestId = (source === 'portal' && transaction?.requestId) ? transaction.requestId : requestId;

  // Upload photo intent if not already created
  let photoIntentId: string;
  if (transaction?.photoIntentId) {
    photoIntentId = transaction.photoIntentId;
  } else {
    photoIntentId = await uploadEvidence(client, source, 'photo', photo);
    if (transaction) {
      transaction.photoIntentId = photoIntentId;
    }
  }

  // Upload id intent if not already created
  let idIntentId: string | null = null;
  if (identification) {
    if (transaction?.idIntentId) {
      idIntentId = transaction.idIntentId;
    } else {
      idIntentId = await uploadEvidence(client, source, 'id', identification);
      if (transaction) {
        transaction.idIntentId = idIntentId;
      }
    }
  }

  // If transaction had previously submitted a payload, preserve the exact payload for replay safety
  const effectiveVisitor = (transaction?.submittedPayload?.visitor) ? transaction.submittedPayload.visitor : visitor;

  // Record submitted payload on transaction before network dispatch
  if (transaction && !transaction.submittedPayload) {
    transaction.submittedPayload = { visitor: { ...effectiveVisitor } };
  }

  const response = await fetch('/api/passes/issue', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: effectiveRequestId,
      source,
      visitor: effectiveVisitor,
      photoIntentId,
      idIntentId,
    }),
  });
  const body = await response.json().catch(() => null) as (IssuedPass & { error?: string }) | null;
  if (!response.ok || !body?.passId || !body.qrToken) {
    if (response.status === 429 || body?.error === 'rate_limit_exceeded') {
      throw new Error('Too many pass requests from this visitor session. Please wait before requesting another pass.');
    }
    if (body?.error === 'visit_date_out_of_range') {
      throw new Error('Visit date is outside the allowed scheduling window.');
    }
    if (body?.error === 'service_unavailable') {
      throw new Error('Pass service is temporarily unavailable.');
    }
    if (body?.error === 'cross_actor_replay') {
      throw new Error('Pass request session conflict. Please start a new pass registration.');
    }
    if (body?.error === 'intent_mismatch') {
      throw new Error('Pass evidence verification conflict. Please retry your request.');
    }
    throw new Error('Failed to create visitor pass.');
  }
  return body;
}

export interface RegistrationSettingsData {
  working_hours_start: string | null;
  working_hours_end: string | null;
  timezone: string | null;
  scheduling_days_ahead: number | null;
  peak_mode: string | null;
  visit_purposes: unknown;
}

export async function loadRegistrationSettings(source: RegistrationSource): Promise<RegistrationSettingsData> {
  const client = source === 'portal' ? requirePortalSupabase() : requireSupabase();
  const { data, error } = await client
    .from('app_settings')
    .select('working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes')
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST205' || error.code === 'PGRST202') {
      console.warn(
        `[E-GatePass Diagnostic] Supabase schema migration required: table 'public.app_settings' was not found in schema cache (${error.code}). Run migrations on the Supabase project to persist custom settings.`
      );
    } else {
      console.warn('[E-GatePass Diagnostic] Could not load app_settings from Supabase:', error.message || error);
    }
    throw new Error(error.message || 'Failed to load registration settings');
  }

  if (!data) {
    throw new Error('No registration settings found in database');
  }

  return data;
}
