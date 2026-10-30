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
  email?: string;
  consent?: boolean;
}

export interface IssuedPass {
  passId: string;
  publicReference?: string;
  qrToken: string;
  validFrom: string;
  validUntil: string;
}

interface UploadIntent {
  intent_id: string;
  bucket_id: string;
  object_path: string;
  expires_at: string;
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

import { fetchWithTimeout, createBoundedAbortSignal, withTimeout } from '@/lib/fetchWithTimeout';

export type IssueTransactionPhase =
  | 'editable'
  | 'dispatched'
  | 'ambiguous'
  | 'committed'
  | 'existing_pass_conflict';

export type PortalIssueTransactionPhase = IssueTransactionPhase;

export function shouldReuseUploadedIntentForIssue(
  transaction: IssueTransaction | null | undefined,
  checkpoint: UploadCheckpoint | null | undefined,
  intentId: string | null | undefined
): boolean {
  if (!checkpoint || !intentId || !checkpoint.uploaded) {
    return false;
  }
  // Case A — Ambiguous transaction: reuse original intent for exact replay
  // even if local expiresAt has passed (server may already have committed the original pass).
  if (transaction?.phase === 'ambiguous') {
    return true;
  }
  // Case B — Normal/editable transaction: only reuse when checkpoint has a valid future expiresAt.
  if (
    checkpoint.expiresAt &&
    !Number.isNaN(new Date(checkpoint.expiresAt).getTime()) &&
    new Date(checkpoint.expiresAt).getTime() > Date.now()
  ) {
    return true;
  }
  return false;
}

export type SubmissionOutcomeType =
  | 'committed'
  | 'ambiguous'
  | 'rejected_correctable_field'
  | 'rejected_requires_new_transaction'
  | 'existing_pass_replay_conflict';

export function classifySubmissionOutcome(
  statusOrErr: number | { status?: number; message?: string; error?: string; code?: string } | any,
  errCode?: string
): SubmissionOutcomeType {
  let status = 0;
  let code = errCode;

  if (typeof statusOrErr === 'number') {
    status = statusOrErr;
  } else if (statusOrErr && typeof statusOrErr === 'object') {
    status = statusOrErr.status ?? 0;
    if (!code) {
      code = statusOrErr.code || statusOrErr.error || statusOrErr.message;
    }
  }

  // 1. Authoritative pre-commit rejections
  if (code === 'visit_date_out_of_range') {
    return 'rejected_correctable_field';
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    return 'rejected_correctable_field';
  }
  if (code === 'abuse_control_unavailable') {
    return 'rejected_correctable_field';
  }

  // 2. Existing pass replay conflicts (same-request-id replay payload or intent mismatch)
  if (code === 'payload_mismatch' || code === 'intent_mismatch') {
    return 'existing_pass_replay_conflict';
  }

  // 3. Authoritative replay consistency / session mismatches / expiration (Section 10)
  if (
    code === 'cross_actor_replay' ||
    code === 'source_mismatch' ||
    code === 'pass_has_expired' ||
    status === 409 ||
    status === 422
  ) {
    return 'rejected_requires_new_transaction';
  }

  // 3. Ambiguous outcomes: generic 5xx, service_unavailable, network timeout, unknown server failure
  if (status >= 500 || code === 'service_unavailable' || code === 'network_interruption') {
    return 'ambiguous';
  }
  return 'ambiguous';
}

export class PassIssuanceError extends Error {
  readonly code: string;
  readonly outcome: SubmissionOutcomeType;

  constructor(message: string, code: string, outcome: SubmissionOutcomeType) {
    super(message);
    this.name = 'PassIssuanceError';
    this.code = code;
    this.outcome = outcome;
  }
}

export interface UploadCheckpoint {
  intentId: string;
  bucketId: string;
  objectPath: string;
  contentType: string;
  maxBytes: number;
  expiresAt?: string;
  uploaded: boolean;
}

export interface IssueTransaction {
  requestId: string;
  actorId?: string;
  token?: string;
  photoIntentId: string | null;
  idIntentId: string | null;
  photoCheckpoint?: UploadCheckpoint | null;
  idCheckpoint?: UploadCheckpoint | null;
  phase: IssueTransactionPhase;
  submittedPayload?: {
    visitor: VisitorRegistration;
    source?: RegistrationSource;
    photoIntentId?: string | null;
    idIntentId?: string | null;
  } | null;
}

export function createIssueTransaction(_source: 'kiosk' | 'portal' = 'kiosk'): IssueTransaction {
  return {
    requestId: crypto.randomUUID(),
    photoIntentId: null,
    idIntentId: null,
    photoCheckpoint: null,
    idCheckpoint: null,
    phase: 'editable',
  };
}

export type PortalIssueTransaction = IssueTransaction;

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
    phase: 'editable',
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
      if (session && session.user?.id === existingTransaction.actorId) {
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
    if (!newTx.token) {
      throw new Error('Visitor registration session token missing.');
    }
    return { client, token: newTx.token };
  }

  const client = requireSupabase();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Kiosk device not authenticated.');
  return { client, token: session.access_token };
}

export async function uploadCheckpointedEvidence(
  client: SupabaseClient,
  source: RegistrationSource,
  kind: 'photo' | 'id',
  blob: Blob,
  transaction?: IssueTransaction | null,
): Promise<{ intentId: string; checkpoint: UploadCheckpoint }> {
  const existingCheckpoint =
    kind === 'photo' ? transaction?.photoCheckpoint : transaction?.idCheckpoint;

  let checkpoint: UploadCheckpoint;

  const isCheckpointValid = (cp?: UploadCheckpoint | null): boolean => {
    return Boolean(
      cp &&
      cp.expiresAt &&
      !Number.isNaN(new Date(cp.expiresAt).getTime()) &&
      new Date(cp.expiresAt).getTime() > Date.now()
    );
  };

  if (isCheckpointValid(existingCheckpoint)) {
    checkpoint = { ...existingCheckpoint! };
  } else {
    const contentType = blob.type || 'image/jpeg';
    const rpcCall = client
      .schema('api')
      .rpc('create_upload_intent', {
        requested_source: source,
        requested_kind: kind,
        requested_content_type: contentType,
      });
    const boundedRpc = typeof (rpcCall as any).abortSignal === 'function'
      ? (rpcCall as any).abortSignal(createBoundedAbortSignal(10000))
      : rpcCall;

    const { data, error } = (await boundedRpc.single()) as { data: UploadIntent | null; error: any };

    if (error || !data) {
      throw new Error('Image upload could not be authorized.');
    }
    if (blob.size < 1 || blob.size > data.max_bytes) {
      throw new Error('Image exceeds the 5 MB upload limit.');
    }

    checkpoint = {
      intentId: data.intent_id,
      bucketId: data.bucket_id,
      objectPath: data.object_path,
      contentType,
      maxBytes: data.max_bytes,
      expiresAt: data.expires_at,
      uploaded: false,
    };

    // Store intent descriptor in transaction immediately after authorization succeeds (Section 8)
    if (transaction) {
      if (kind === 'photo') {
        transaction.photoCheckpoint = checkpoint;
        transaction.photoIntentId = checkpoint.intentId;
      } else {
        transaction.idCheckpoint = checkpoint;
        transaction.idIntentId = checkpoint.intentId;
      }
    }
  }

  // Upload to Storage with 15s deadline if not already marked uploaded
  if (!checkpoint.uploaded) {
    try {
      const data = { bucket_id: checkpoint.bucketId, object_path: checkpoint.objectPath };
      const uploadRes = await withTimeout(
        client.storage.from(data.bucket_id).upload(data.object_path, blob, {
          contentType: checkpoint.contentType,
          upsert: false,
        }),
        15000,
        'Image upload timed out after 15s'
      );

      if (uploadRes.error) {
        const errMsg = uploadRes.error.message?.toLowerCase() || '';
        const statusCode = (uploadRes.error as any).statusCode || (uploadRes.error as any).status;
        if (
          statusCode === 409 ||
          errMsg.includes('already exists') ||
          errMsg.includes('duplicate') ||
          errMsg.includes('resourcealreadyexists')
        ) {
          checkpoint.uploaded = true;
        } else {
          throw new Error('Image upload failed. Please try again.');
        }
      } else {
        checkpoint.uploaded = true;
      }
    } catch (err: any) {
      const errMsg = err?.message?.toLowerCase() || '';
      if (
        errMsg.includes('already exists') ||
        errMsg.includes('resourcealreadyexists') ||
        errMsg.includes('409')
      ) {
        checkpoint.uploaded = true;
      } else {
        throw err;
      }
    }
  }

  // Ensure transaction reflects current checkpoint and intent ID
  if (transaction) {
    if (kind === 'photo') {
      transaction.photoCheckpoint = checkpoint;
      transaction.photoIntentId = checkpoint.intentId;
    } else {
      transaction.idCheckpoint = checkpoint;
      transaction.idIntentId = checkpoint.intentId;
    }
  }

  return { intentId: checkpoint.intentId, checkpoint };
}

export interface VerifyIdentityResponse {
  outcome: 'matched' | 'mismatched' | 'face_not_detected' | 'quality_rejected';
  matched: boolean;
  verificationId?: string;
  expiresAt?: string;
  message?: string;
  reasonCode?: string;
  error?: string;
}

export async function verifyPortalIdentity(
  client: SupabaseClient,
  requestId: string,
  photoIntentId: string,
  idIntentId: string
): Promise<VerifyIdentityResponse> {
  const { data: { session } } = await client.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Authentication session required for identity verification.');

  const res = await fetch('/api/passes/verify-identity', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requestId,
      photoIntentId,
      idIntentId,
    }),
  });

  const body = (await res.json().catch(() => null)) as (VerifyIdentityResponse & { error?: string }) | null;
  if (!res.ok || !body) {
    throw new Error(body?.message || body?.error || 'Identity verification failed');
  }

  return body;
}

export async function issueVisitorPass(
  source: RegistrationSource,
  visitor: VisitorRegistration,
  photo: Blob,
  identification?: Blob | null,
  requestId: string = crypto.randomUUID(),
  captchaToken?: string,
  transaction?: IssueTransaction | null,
): Promise<IssuedPass> {
  const { client, token } = await authenticatedClient(source, captchaToken, transaction);

  const effectiveRequestId = transaction?.requestId ? transaction.requestId : requestId;

  // Upload photo intent with retry-safe checkpointing (Section 8)
  let photoIntentId: string;
  if (shouldReuseUploadedIntentForIssue(transaction, transaction?.photoCheckpoint, transaction?.photoIntentId)) {
    photoIntentId = transaction!.photoIntentId!;
  } else {
    const photoRes = await uploadCheckpointedEvidence(client, source, 'photo', photo, transaction);
    photoIntentId = photoRes.intentId;
  }

  // Upload id intent with retry-safe checkpointing if provided (Section 8)
  let idIntentId: string | null = null;
  if (identification) {
    if (shouldReuseUploadedIntentForIssue(transaction, transaction?.idCheckpoint, transaction?.idIntentId)) {
      idIntentId = transaction!.idIntentId!;
    } else {
      const idRes = await uploadCheckpointedEvidence(client, source, 'id', identification, transaction);
      idIntentId = idRes.intentId;
    }
  }

  // If transaction had previously submitted a payload in an ambiguous attempt, preserve the exact payload for replay safety
  const effectiveVisitor = (transaction?.phase === 'ambiguous' && transaction?.submittedPayload?.visitor)
    ? transaction.submittedPayload.visitor
    : visitor;

  // Record submitted payload and transition to 'dispatched' immediately before network dispatch
  if (transaction) {
    transaction.submittedPayload = { visitor: { ...effectiveVisitor } };
    transaction.phase = 'dispatched';
  }

  let response: Response;
  try {
    response = await fetchWithTimeout('/api/passes/issue', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: effectiveRequestId,
        source,
        visitor: effectiveVisitor,
        photoIntentId,
        idIntentId,
      }),
    }, 15000);
  } catch (networkErr) {
    if (transaction) {
      transaction.phase = 'ambiguous';
    }
    throw new PassIssuanceError(
      'Generation result could not be confirmed due to a network interruption. Please retry your submission.',
      'network_interruption',
      'ambiguous'
    );
  }

  const body = await response.json().catch(() => null) as (IssuedPass & { error?: string }) | null;
  if (!response.ok || !body?.passId || !body.qrToken) {
    const errCode = body?.error || 'issue_failed';
    const outcome = classifySubmissionOutcome(response.status, errCode);

    if (outcome === 'rejected_correctable_field') {
      if (transaction) {
        transaction.phase = 'editable';
        transaction.submittedPayload = null; // Unfreeze so visitor can edit and re-submit
      }
      let message = 'Failed to create visitor pass.';
      if (errCode === 'visit_date_out_of_range') {
        message = 'Visit date is outside the allowed scheduling window.';
      } else if (response.status === 429 || errCode === 'rate_limit_exceeded') {
        message = 'Too many pass requests from this visitor session. Please wait before requesting another pass.';
      } else if (errCode === 'abuse_control_unavailable') {
        message = 'Pass service is temporarily unavailable.';
      }
      throw new PassIssuanceError(message, errCode, outcome);
    }

    if (outcome === 'existing_pass_replay_conflict') {
      // Do NOT rotate requestId, do NOT clear existing request, do NOT issue a second pass.
      // Preserve transaction state for operator/recovery handling.
      if (transaction) {
        transaction.phase = 'existing_pass_conflict';
      }
      throw new PassIssuanceError(
        'An existing pass was already created for this request, but this retry does not match the recorded details. Please consult the guard station.',
        errCode,
        outcome
      );
    }

    if (outcome === 'rejected_requires_new_transaction') {
      if (transaction) {
        transaction.requestId = crypto.randomUUID();
        transaction.photoIntentId = null;
        transaction.idIntentId = null;
        transaction.photoCheckpoint = null;
        transaction.idCheckpoint = null;
        transaction.phase = 'editable';
        transaction.submittedPayload = null;
      }
      throw new PassIssuanceError(
        'Pass request session conflict. Please start a new pass registration.',
        errCode,
        outcome
      );
    }

    // Ambiguous outcomes (generic 500/503, service_unavailable, etc.):
    // Preserve actor, requestId, submittedPayload, photoIntentId, idIntentId for exact replay
    if (transaction) {
      transaction.phase = 'ambiguous';
    }
    const message = 'Generation result could not be confirmed. Please retry your submission.';

    throw new PassIssuanceError(message, errCode, 'ambiguous');
  }

  if (transaction) {
    transaction.phase = 'committed';
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
  visitor_instructions?: string[] | null;
  image_retention_days?: number | null;
  photo_retention_days?: number | null;
  id_retention_days?: number | null;
  visitor_retention_days?: number | null;
}

export async function loadRegistrationSettings(source: RegistrationSource): Promise<RegistrationSettingsData> {
  const client = source === 'portal' ? requirePortalSupabase() : requireSupabase();
  const selectCols =
    'working_hours_start, working_hours_end, timezone, scheduling_days_ahead, peak_mode, visit_purposes, visitor_instructions, image_retention_days, photo_retention_days, id_retention_days, visitor_retention_days';

  const { data, error } = await client
    .from('app_settings')
    .select(selectCols)
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

  const raw = data as unknown as Record<string, unknown>;
  return {
    working_hours_start: (raw.working_hours_start as string) ?? null,
    working_hours_end: (raw.working_hours_end as string) ?? null,
    timezone: (raw.timezone as string) ?? null,
    scheduling_days_ahead: typeof raw.scheduling_days_ahead === 'number' ? raw.scheduling_days_ahead : null,
    peak_mode: (raw.peak_mode as string) ?? null,
    visit_purposes: raw.visit_purposes,
    visitor_instructions: Array.isArray(raw.visitor_instructions) ? (raw.visitor_instructions as string[]) : null,
    image_retention_days: typeof raw.image_retention_days === 'number' ? raw.image_retention_days : null,
    photo_retention_days: typeof raw.photo_retention_days === 'number' ? raw.photo_retention_days : null,
    id_retention_days: typeof raw.id_retention_days === 'number' ? raw.id_retention_days : null,
    visitor_retention_days: typeof raw.visitor_retention_days === 'number' ? raw.visitor_retention_days : null,
  };
}
