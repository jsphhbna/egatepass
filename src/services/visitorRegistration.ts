import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { requirePortalSupabase, requireSupabase } from '@/lib/supabase';
import type { HomeLocation } from '@/lib/homeLocation';
import type { PostalResolution } from '@/lib/psgc';

export type RegistrationSource = 'portal' | 'kiosk';

export interface ReturningSavedVehicle {
  id: string;
  vehicleType: string;
  plateNumber: string;
  plateKey?: string;
  color?: string | null;
  makeModel?: string | null;
}

export interface PsgcAddressPayload {
  version?: string;
  regionCode: string;
  provinceCode?: string | null;
  cityCode: string;
  barangayCode: string;
  houseBuilding?: string;
  street?: string;
  postalCode?: string;
  postalCodeSource?: string;
}

export interface ReturningIdentifyProfile {
  id: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  contactNumber: string;
  homeAddress?: string | null;
  homeLocation?: HomeLocation | null;
  psgc?: {
    version: string;
    region: { code: string; name: string };
    province: { code: string; name: string } | null;
    city: { code: string; name: string };
    barangay: { code: string; name: string };
    houseBuilding?: string;
    street?: string;
    postalCode?: string;
    postalCodeSource?: string;
    postalMappingType?: string;
    postalResolution?: PostalResolution;
  } | null;
}

export interface ReturningIdentifyResult {
  available?: boolean;
  matched: boolean;
  matchToken?: string;
  expiresAt?: string;
  profile?: ReturningIdentifyProfile;
  savedVehicles?: ReturningSavedVehicle[];
  originalPortraitUrl?: string;
  originalPortraitDate?: string;
  historicalIdUrl?: string;
  historicalIdDate?: string;
  similarity?: number;
  threshold?: number;
  reason?: string;
  message?: string;
  error?: string;
  reasonCode?: string;
  diagnostics?: Record<string, unknown>;
  thresholdMode?: string;
  verificationState?: 'calibrated' | 'provisional';
  guardVerificationRequired?: boolean;
}

export interface VisitorRegistration {
  firstName: string;
  middleName?: string;
  lastName: string;
  contactNumber: string;
  homeAddress?: string;
  purpose: string;
  visitDate: string;
  email?: string;
  consent?: boolean;
  homeLocation?: HomeLocation | null;
  psgc?: PsgcAddressPayload | null;
  registrationMode?: 'new' | 'returning';
  arrivalMode?: 'no_vehicle' | 'vehicle';
  saveVehicle?: boolean;
  vehicle?: {
    vehicleType?: 'car' | 'motorcycle' | 'van' | 'pickup' | 'suv' | 'truck' | 'bicycle' | 'other' | string;
    plateNumber?: string;
    color?: string;
    makeModel?: string | null;
    catalogStatus?: 'catalog' | 'manual';
    photoIntentId?: string;
    savedVehicleId?: string;
    saveVehicle?: boolean;
  } | null;
  returning?: {
    profileId?: string;
    matchToken?: string;
    saveUpdates?: boolean;
  };
  rememberVisitor?: boolean;
  enrollReturning?: boolean;
  enrollBiometric?: boolean;
  officeId?: string;
}

export interface IssuedPass {
  passId: string;
  publicReference?: string;
  qrToken: string;
  validFrom: string;
  validUntil: string;
  returningEnrollment?: 'enrolled' | 'failed' | 'not_requested';
  returningProfileUpdate?: 'updated' | 'failed' | 'not_requested';
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
  | 'existing_pass_conflict'
  | 'submission_uncertain_hold';

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
  | 'rejected_requires_reverification'
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

  // Group A: Authoritative pre-commit field / rate-limit rejections (user can correct fields in place)
  const CORRECTABLE_CODES = new Set([
    'visit_date_out_of_range',
    'invalid_vehicle_declaration',
    'invalid_vehicle_plate',
    'vehicle_photo_required',
    'invalid_home_location',
    'home_location_required_for_portal',
    'invalid_contact_number',
    'rate_limit_exceeded',
    'abuse_control_unavailable',
  ]);

  if (code && CORRECTABLE_CODES.has(code)) {
    return 'rejected_correctable_field';
  }
  if (status === 429) {
    return 'rejected_correctable_field';
  }

  // Group B: Identity re-verification required (biometric expired or missing)
  const REVERIFICATION_CODES = new Set([
    'identity_verification_required',
    'identity_verification_expired',
  ]);
  if (code && REVERIFICATION_CODES.has(code)) {
    return 'rejected_requires_reverification';
  }

  // Group D: Existing pass replay conflicts (same-request-id replay payload or intent mismatch)
  const REPLAY_CONFLICT_CODES = new Set([
    'payload_mismatch',
    'intent_mismatch',
    'pass_token_secret_rotated',
  ]);
  if (code && REPLAY_CONFLICT_CODES.has(code)) {
    return 'existing_pass_replay_conflict';
  }

  // Group C: Authoritative upload / session mismatches requiring brand-new transaction
  const NEW_TRANSACTION_CODES = new Set([
    'invalid_upload_intent',
    'missing_uploaded_object',
    'invalid_uploaded_content',
    'pass_has_expired',
    'expired_upload_intent',
    'cross_actor_replay',
    'source_mismatch',
  ]);
  if (code && NEW_TRANSACTION_CODES.has(code)) {
    return 'rejected_requires_new_transaction';
  }

  // Generic 409: replay conflict
  if (status === 409) {
    return 'existing_pass_replay_conflict';
  }

  // Generic 422 / 400: field validation
  if (status === 422 || status === 400) {
    return 'rejected_correctable_field';
  }

  // Group E: Ambiguous outcomes: generic 5xx, service_unavailable, network timeout, unknown server failure
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
  vehiclePhotoIntentId?: string | null;
  photoCheckpoint?: UploadCheckpoint | null;
  idCheckpoint?: UploadCheckpoint | null;
  vehiclePhotoCheckpoint?: UploadCheckpoint | null;
  phase: IssueTransactionPhase;
  pendingAbandonments?: string[];
  submittedPayload?: {
    visitor: VisitorRegistration;
    source?: RegistrationSource;
    photoIntentId?: string | null;
    idIntentId?: string | null;
    vehiclePhotoIntentId?: string | null;
  } | null;
}

export function createIssueTransaction(_source: 'kiosk' | 'portal' = 'kiosk'): IssueTransaction {
  return {
    requestId: crypto.randomUUID(),
    photoIntentId: null,
    idIntentId: null,
    vehiclePhotoIntentId: null,
    photoCheckpoint: null,
    idCheckpoint: null,
    vehiclePhotoCheckpoint: null,
    phase: 'editable',
    pendingAbandonments: [],
  };
}

export type PortalIssueTransaction = IssueTransaction;

export class PortalSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PortalSessionError';
    this.code = code;
  }
}

export class UploadAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = 'UploadAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

export class UploadQuotaExceededError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = 'too_many_pending_intents', message = 'Too many upload attempts are in progress. Please wait a moment or retake your photo.') {
    super(message);
    this.name = 'UploadQuotaExceededError';
    this.code = code;
    this.status = 429;
  }
}

export class PendingAbandonmentError extends Error {
  readonly code: string;
  readonly pendingCount: number;
  constructor(code: string, message: string, pendingCount = 0) {
    super(message);
    this.name = 'PendingAbandonmentError';
    this.code = code;
    this.pendingCount = pendingCount;
  }
}

export class StorageUploadError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status?: number, retryable = true) {
    super(message);
    this.name = 'StorageUploadError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class PreflightQualityError extends Error {
  readonly code: string;
  readonly reasonCode: string;
  constructor(code: string, message: string, reasonCode?: string) {
    super(message);
    this.name = 'PreflightQualityError';
    this.code = code;
    this.reasonCode = reasonCode || code;
  }
}

export async function createPortalIssueTransaction(captchaToken?: string): Promise<PortalIssueTransaction> {
  const client = requirePortalSupabase();
  const envProcess = typeof process !== 'undefined' ? process.env : undefined;
  const siteKey = ((import.meta as any).env?.VITE_TURNSTILE_SITE_KEY || envProcess?.VITE_TURNSTILE_SITE_KEY)?.trim();
  const isProd = Boolean((import.meta as any).env?.PROD || envProcess?.PROD === 'true' || envProcess?.NODE_ENV === 'production');

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
  if (!session.user || session.user.is_anonymous !== true) {
    await client.auth.signOut();
    throw new PortalSessionError('portal_actor_not_anonymous', 'Visitor registration requires an anonymous visitor session.');
  }

  return {
    requestId: crypto.randomUUID(),
    actorId: session.user.id,
    token: session.access_token,
    photoIntentId: null,
    idIntentId: null,
    vehiclePhotoIntentId: null,
    photoCheckpoint: null,
    idCheckpoint: null,
    vehiclePhotoCheckpoint: null,
    phase: 'editable',
    pendingAbandonments: [],
    submittedPayload: null,
  };
}

export async function getVerifiedPortalSession(
  transaction: PortalIssueTransaction
): Promise<{
  client: SupabaseClient;
  session: Session;
  token: string;
}> {
  if (!transaction || !transaction.actorId) {
    throw new PortalSessionError('portal_session_missing', 'Visitor registration transaction is missing or invalid.');
  }
  const client = requirePortalSupabase();
  const { data: { session }, error } = await client.auth.getSession();
  if (error || !session || !session.user) {
    throw new PortalSessionError('portal_session_missing', 'Visitor registration session expired or unavailable.');
  }
  if (session.user.is_anonymous !== true) {
    throw new PortalSessionError('portal_actor_not_anonymous', 'Visitor registration requires an anonymous visitor session.');
  }
  if (session.user.id !== transaction.actorId) {
    throw new PortalSessionError('portal_session_mismatch', 'Visitor registration session mismatch.');
  }
  if (!session.access_token) {
    throw new PortalSessionError('portal_token_missing', 'Visitor registration session token missing.');
  }
  transaction.token = session.access_token;
  return { client, session, token: session.access_token };
}

export async function validatePortalSession(transaction: PortalIssueTransaction): Promise<boolean> {
  try {
    await getVerifiedPortalSession(transaction);
    return true;
  } catch {
    return false;
  }
}

async function authenticatedClient(
  source: RegistrationSource,
  captchaToken?: string,
  existingTransaction?: PortalIssueTransaction | null,
): Promise<{ client: SupabaseClient; token: string }> {
  if (source === 'portal') {
    if (existingTransaction && existingTransaction.actorId) {
      const verified = await getVerifiedPortalSession(existingTransaction);
      return { client: verified.client, token: verified.token };
    }

    const newTx = await createPortalIssueTransaction(captchaToken);
    if (existingTransaction) {
      existingTransaction.requestId = newTx.requestId;
      existingTransaction.actorId = newTx.actorId;
      existingTransaction.token = newTx.token;
      existingTransaction.photoIntentId = newTx.photoIntentId;
      existingTransaction.idIntentId = newTx.idIntentId;
      existingTransaction.vehiclePhotoIntentId = newTx.vehiclePhotoIntentId;
      existingTransaction.photoCheckpoint = null;
      existingTransaction.idCheckpoint = null;
      existingTransaction.vehiclePhotoCheckpoint = null;
    }
    if (!newTx.token) {
      throw new PortalSessionError('portal_token_missing', 'Visitor registration session token missing.');
    }
    return { client: requirePortalSupabase(), token: newTx.token };
  }

  const client = requireSupabase();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Kiosk device not authenticated.');
  return { client, token: session.access_token };
}

export async function uploadPortalEvidence(
  transaction: PortalIssueTransaction,
  kind: 'photo' | 'id' | 'vehicle_photo',
  blob: Blob,
): Promise<{ intentId: string; checkpoint: UploadCheckpoint }> {
  const { client } = await getVerifiedPortalSession(transaction);

  // Await deterministic bounded draining before creating new intent to protect quota
  const drain = await drainPendingAbandonments(transaction, client);
  if (!drain.safeToContinue) {
    throw new PendingAbandonmentError(
      'pending_abandonment_unconfirmed',
      drain.message || 'Previous upload cleanup could not be confirmed. Please check your connection and retry.',
      drain.pendingCount,
    );
  }

  return uploadCheckpointedEvidence(client, 'portal', kind, blob, transaction);
}

export async function uploadCheckpointedEvidence(
  client: SupabaseClient,
  source: RegistrationSource,
  kind: 'photo' | 'id' | 'vehicle_photo',
  blob: Blob,
  transaction?: IssueTransaction | null,
): Promise<{ intentId: string; checkpoint: UploadCheckpoint }> {
  const existingCheckpoint =
    kind === 'photo'
      ? transaction?.photoCheckpoint
      : kind === 'id'
      ? transaction?.idCheckpoint
      : transaction?.vehiclePhotoCheckpoint;

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
      const detail = error?.message ? ` ${error.message}` : '';
      const errMsg = (error?.message || '').toLowerCase();
      const errCode = (error?.code || '').toUpperCase();

      if (
        errMsg.includes('too many pending') ||
        errMsg.includes('too_many_pending_intents') ||
        errCode === 'P0003'
      ) {
        throw new UploadQuotaExceededError(
          'too_many_pending_intents',
          'Too many upload attempts are currently pending. Retaking or waiting a moment will reset your upload session.'
        );
      }
      if (
        errMsg.includes('session required') ||
        errMsg.includes('not authenticated') ||
        errCode === 'P0001'
      ) {
        throw new PortalSessionError(
          'portal_session_expired',
          `Visitor registration session expired or unavailable.${detail}`
        );
      }
      throw new UploadAuthorizationError(
        'upload_intent_unauthorized',
        `Image upload could not be authorized.${detail}`,
        error?.status || 403
      );
    }
    if (blob.size < 1 || blob.size > data.max_bytes) {
      throw new StorageUploadError('file_size_exceeded', 'Image exceeds the 5 MB upload limit.', 413, false);
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
      } else if (kind === 'id') {
        transaction.idCheckpoint = checkpoint;
        transaction.idIntentId = checkpoint.intentId;
      } else if (kind === 'vehicle_photo') {
        transaction.vehiclePhotoCheckpoint = checkpoint;
        transaction.vehiclePhotoIntentId = checkpoint.intentId;
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
        const numStatus = Number(statusCode);
        if (
          numStatus === 409 ||
          statusCode === '409' ||
          errMsg.includes('already exists') ||
          errMsg.includes('duplicate') ||
          errMsg.includes('resourcealreadyexists') ||
          (uploadRes.error as any)?.error === 'Duplicate'
        ) {
          checkpoint.uploaded = true;
        } else {
          throw new StorageUploadError(
            'storage_upload_failed',
            'Image upload failed. Please try again.',
            numStatus || undefined,
            true
          );
        }
      } else {
        checkpoint.uploaded = true;
      }
    } catch (err: any) {
      const errMsg = err?.message?.toLowerCase() || '';
      const numStatus = Number(err?.status || err?.statusCode);
      if (
        numStatus === 409 ||
        errMsg.includes('already exists') ||
        errMsg.includes('resourcealreadyexists') ||
        errMsg.includes('409')
      ) {
        checkpoint.uploaded = true;
      } else if (
        err instanceof StorageUploadError ||
        err instanceof UploadAuthorizationError ||
        err instanceof PortalSessionError
      ) {
        throw err;
      } else if (errMsg.includes('timed out') || errMsg.includes('timeout')) {
        throw new StorageUploadError(
          'storage_timeout',
          'Image upload timed out after 15s. Please check your connection and try again.',
          408,
          true
        );
      } else {
        throw new StorageUploadError(
          'storage_upload_failed',
          err?.message || 'Image upload failed. Please try again.',
          numStatus || undefined,
          true
        );
      }
    }
  }

  // Ensure transaction reflects current checkpoint and intent ID
  if (transaction) {
    if (kind === 'photo') {
      transaction.photoCheckpoint = checkpoint;
      transaction.photoIntentId = checkpoint.intentId;
    } else if (kind === 'id') {
      transaction.idCheckpoint = checkpoint;
      transaction.idIntentId = checkpoint.intentId;
    } else if (kind === 'vehicle_photo') {
      transaction.vehiclePhotoCheckpoint = checkpoint;
      transaction.vehiclePhotoIntentId = checkpoint.intentId;
    }
  }

  return { intentId: checkpoint.intentId, checkpoint };
}

export type CanonicalVerificationOutcome =
  | 'matched'
  | 'mismatch'
  | 'no_face_in_id'
  | 'no_face_in_selfie'
  | 'multiple_selfie_faces'
  | 'ambiguous_id_faces'
  | 'low_quality_id'
  | 'low_quality_selfie'
  | 'engine_error';

export interface VerifyIdentityResponse {
  outcome: CanonicalVerificationOutcome;
  matched: boolean;
  verificationId?: string;
  expiresAt?: string;
  message?: string;
  reasonCode?: string;
  error?: string;
}

/**
 * Invalidate checkpoint and intent ID on the transaction when evidence is retaken or replaced.
 * Ensures fresh blobs generate fresh intents and require new authoritative verification.
 */
export function invalidatePortalEvidenceCheckpoint(
  transaction: IssueTransaction | null | undefined,
  kind: 'photo' | 'id' | 'vehicle_photo' | 'vehicle'
): void {
  if (!transaction) return;
  if (kind === 'photo') {
    transaction.photoCheckpoint = null;
    transaction.photoIntentId = null;
    (transaction as any).verifiedPhotoIntentId = null;
  } else if (kind === 'id') {
    transaction.idCheckpoint = null;
    transaction.idIntentId = null;
    (transaction as any).verifiedIdIntentId = null;
  } else if (kind === 'vehicle_photo' || kind === 'vehicle') {
    transaction.vehiclePhotoCheckpoint = null;
    transaction.vehiclePhotoIntentId = null;
  }
}

export type AbandonEvidenceStatus =
  | 'abandoned'
  | 'already_expired'
  | 'not_found'
  | 'no_intent'
  | 'claimed'
  | 'forbidden'
  | 'unauthorized'
  | 'network_error'
  | 'error';

export interface AbandonEvidenceResult {
  success: boolean;
  status: AbandonEvidenceStatus;
  intentId: string | null;
  databaseExpired: boolean;
  storageCleaned: boolean;
  message?: string;
}

export interface DrainPendingAbandonmentsResult {
  safeToContinue: boolean;
  pendingCount: number;
  confirmedExpired: string[];
  failed: string[];
  message?: string;
}

const inFlightAbandonments = new WeakMap<IssueTransaction, Map<string, Promise<AbandonEvidenceResult>>>();
const inFlightDrains = new WeakMap<IssueTransaction, Promise<DrainPendingAbandonmentsResult>>();

/**
 * Informs the backend to abandon a pending or rejected upload intent,
 * releasing the visitor's quota immediately and cleaning up orphaned storage objects.
 * Also invalidates the in-memory checkpoint.
 */
export async function abandonPortalEvidence(
  transaction: IssueTransaction | null | undefined,
  kind: 'photo' | 'id' | 'vehicle_photo' | 'vehicle',
  client?: SupabaseClient
): Promise<AbandonEvidenceResult> {
  if (!transaction) {
    return {
      success: true,
      status: 'no_intent',
      intentId: null,
      databaseExpired: false,
      storageCleaned: false,
      message: 'No active transaction',
    };
  }

  let intentId: string | null = null;
  if (kind === 'photo') {
    intentId = transaction.photoIntentId || transaction.photoCheckpoint?.intentId || null;
  } else if (kind === 'id') {
    intentId = transaction.idIntentId || transaction.idCheckpoint?.intentId || null;
  } else if (kind === 'vehicle_photo' || kind === 'vehicle') {
    intentId = transaction.vehiclePhotoIntentId || transaction.vehiclePhotoCheckpoint?.intentId || null;
  }

  // Clear in-memory references immediately so subsequent attempts are clean
  invalidatePortalEvidenceCheckpoint(transaction, kind);

  if (!intentId) {
    return {
      success: true,
      status: 'no_intent',
      intentId: null,
      databaseExpired: false,
      storageCleaned: false,
      message: 'No intent registered for kind',
    };
  }

  // Synchronously enqueue into pendingAbandonments BEFORE the async request begins
  transaction.pendingAbandonments ??= [];
  if (!transaction.pendingAbandonments.includes(intentId)) {
    transaction.pendingAbandonments.push(intentId);
  }

  // Deduplicate concurrent abandonment calls for the same transaction & intentId
  let txInFlight = inFlightAbandonments.get(transaction);
  if (!txInFlight) {
    txInFlight = new Map();
    inFlightAbandonments.set(transaction, txInFlight);
  }
  const existingPromise = txInFlight.get(intentId);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = (async (): Promise<AbandonEvidenceResult> => {
    try {
      const sb = client || requirePortalSupabase();
      const token = transaction.token || (await sb.auth.getSession()).data.session?.access_token;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch('/api/passes/abandon-intent', {
        method: 'POST',
        headers,
        body: JSON.stringify({ intentId }),
      });

      const json = await res.json().catch(() => null);

      if (res.ok && (json?.ok || json?.success)) {
        if (transaction.pendingAbandonments) {
          transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
        }
        return {
          success: true,
          status:
            json.code === 'already_expired'
              ? 'already_expired'
              : json.code === 'not_found'
              ? 'not_found'
              : 'abandoned',
          intentId,
          databaseExpired: json.databaseExpired ?? true,
          storageCleaned: json.storageCleaned ?? true,
          message: json.warning || json.message,
        };
      }

      if (res.status === 409 || json?.error === 'intent_claimed') {
        if (transaction.pendingAbandonments) {
          transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
        }
        return {
          success: false,
          status: 'claimed',
          intentId,
          databaseExpired: false,
          storageCleaned: false,
          message: json?.message || 'Intent is already claimed by an issued pass',
        };
      }

      if (res.status === 403) {
        if (transaction.pendingAbandonments) {
          transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
        }
        return {
          success: false,
          status: 'forbidden',
          intentId,
          databaseExpired: false,
          storageCleaned: false,
          message: json?.message || 'Not authorized to abandon this intent',
        };
      }

      if (res.status === 401) {
        return {
          success: false,
          status: 'unauthorized',
          intentId,
          databaseExpired: false,
          storageCleaned: false,
          message: json?.message || 'Authentication required',
        };
      }

      return {
        success: false,
        status: 'error',
        intentId,
        databaseExpired: false,
        storageCleaned: false,
        message: json?.message || `Abandonment failed with status ${res.status}`,
      };
    } catch (netErr) {
      return {
        success: false,
        status: 'network_error',
        intentId,
        databaseExpired: false,
        storageCleaned: false,
        message: netErr instanceof Error ? netErr.message : 'Network error during abandonment',
      };
    } finally {
      txInFlight?.delete(intentId);
    }
  })();

  txInFlight.set(intentId, promise);
  return promise;
}

export async function drainPendingAbandonments(
  transaction: IssueTransaction | null | undefined,
  client?: SupabaseClient
): Promise<DrainPendingAbandonmentsResult> {
  if (!transaction || !transaction.pendingAbandonments || transaction.pendingAbandonments.length === 0) {
    return {
      safeToContinue: true,
      pendingCount: 0,
      confirmedExpired: [],
      failed: [],
    };
  }

  // Deduplicate concurrent drain calls for the same transaction
  const existingDrain = inFlightDrains.get(transaction);
  if (existingDrain) {
    return existingDrain;
  }

  const drainPromise = (async (): Promise<DrainPendingAbandonmentsResult> => {
    try {
      // 1. Await any in-flight individual abandonment promises for this transaction
      const txInFlight = inFlightAbandonments.get(transaction);
      if (txInFlight && txInFlight.size > 0) {
        await Promise.allSettled(Array.from(txInFlight.values()));
      }

      if (!transaction.pendingAbandonments || transaction.pendingAbandonments.length === 0) {
        return {
          safeToContinue: true,
          pendingCount: 0,
          confirmedExpired: [],
          failed: [],
        };
      }

      const confirmedExpired: string[] = [];
      const failed: string[] = [];

      // 2. Perform bounded retry loop for remaining pending items (up to 2 passes with 150ms backoff)
      const MAX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const remaining: string[] = [...(transaction.pendingAbandonments || [])];
        if (remaining.length === 0) break;

        const sb = client || requirePortalSupabase();
        const token = transaction.token || (await sb.auth.getSession()).data.session?.access_token;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        for (const intentId of remaining) {
          try {
            const res = await fetch('/api/passes/abandon-intent', {
              method: 'POST',
              headers,
              body: JSON.stringify({ intentId }),
            });
            const json = await res.json().catch(() => null);

            if (res.ok && (json?.ok || json?.success)) {
              if (!confirmedExpired.includes(intentId)) {
                confirmedExpired.push(intentId);
              }
              transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
            } else if (res.status === 409 || json?.error === 'intent_claimed') {
              transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
            } else if (res.status === 403) {
              transaction.pendingAbandonments = transaction.pendingAbandonments.filter((id) => id !== intentId);
            } else {
              if (attempt === MAX_ATTEMPTS && !failed.includes(intentId)) {
                failed.push(intentId);
              }
            }
          } catch {
            if (attempt === MAX_ATTEMPTS && !failed.includes(intentId)) {
              failed.push(intentId);
            }
          }
        }

        if (transaction.pendingAbandonments.length > 0 && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      const pendingCount = transaction.pendingAbandonments?.length || 0;
      const safeToContinue = pendingCount === 0;

      return {
        safeToContinue,
        pendingCount,
        confirmedExpired,
        failed,
        message: safeToContinue
          ? undefined
          : `Unable to confirm release of ${pendingCount} previous upload attempt(s). Please retry.`,
      };
    } finally {
      inFlightDrains.delete(transaction);
    }
  })();

  inFlightDrains.set(transaction, drainPromise);
  return drainPromise;
}

export type PortalPreflightCategory =
  | 'quality'
  | 'session'
  | 'security'
  | 'upload'
  | 'rate_limit'
  | 'service'
  | 'network';

export interface PreflightResponse {
  ok: boolean;
  category?: PortalPreflightCategory;
  message?: string;
  reasonCode?: string;
  error?: string;
  statusCode?: number;
}

export async function preflightPortalLiveFace(
  transaction: PortalIssueTransaction,
  photoIntentId: string
): Promise<PreflightResponse> {
  const { token } = await getVerifiedPortalSession(transaction);

  let res: Response;
  try {
    res = await withTimeout(
      fetch('/api/passes/verify-identity', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: transaction.requestId,
          photoIntentId,
          mode: 'preflight_face',
        }),
      }),
      15000,
      'Preflight request timed out after 15s'
    );
  } catch (err: any) {
    return {
      ok: false,
      category: 'network',
      message: 'Network connection interrupted. Please check your internet connection.',
      error: 'network_timeout',
    };
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    message?: string;
    reasonCode?: string;
    preflightPassed?: boolean;
  } | null;

  // 1. Authoritative success
  if (res.ok && (body?.ok || body?.preflightPassed)) {
    return { ok: true, message: body?.message || 'Face presence and quality verified.' };
  }

  // 2. Authentication / Session failure (401)
  if (res.status === 401 || body?.error === 'invalid_session' || body?.error === 'authentication_required') {
    throw new PortalSessionError('portal_session_expired', 'Visitor registration session expired or unavailable.');
  }

  // 3. Authorization / Recovery session forbidden (403)
  if (res.status === 403 || body?.error === 'recovery_session_forbidden') {
    return {
      ok: false,
      category: 'security',
      statusCode: res.status,
      error: body?.error || 'recovery_session_forbidden',
      message: 'Visitor registration session is unauthorized.',
    };
  }

  // 4. Authoritative quality rejection (422 with error=quality_rejected)
  if (res.status === 422 && body?.error === 'quality_rejected') {
    return {
      ok: false,
      category: 'quality',
      statusCode: 422,
      reasonCode: body.reasonCode || 'quality_rejected',
      message: body.message || 'Face quality verification failed. Please ensure your face is clearly visible.',
    };
  }

  // 5. Upload-related errors (422 with upload intent / content errors)
  if (
    res.status === 422 &&
    (body?.error?.startsWith('invalid_upload_intent') ||
      body?.error?.startsWith('missing_uploaded_object') ||
      body?.error?.startsWith('invalid_uploaded_content'))
  ) {
    return {
      ok: false,
      category: 'upload',
      statusCode: 422,
      error: body.error,
      message: 'Photo upload verification failed. Please retake and re-upload your photo.',
    };
  }

  // 6. Rate limiting (429)
  if (res.status === 429 || body?.error === 'rate_limit_exceeded') {
    return {
      ok: false,
      category: 'rate_limit',
      statusCode: 429,
      error: 'rate_limit_exceeded',
      message: body?.message || 'Too many verification attempts. Please wait a moment before trying again.',
    };
  }

  // 7. Abuse control unavailable (503) or server failures (5xx)
  if (res.status >= 500 || body?.error === 'abuse_control_unavailable') {
    return {
      ok: false,
      category: 'service',
      statusCode: res.status,
      error: body?.error || 'service_unavailable',
      message: body?.message || 'Verification service temporarily unavailable. Please try again shortly.',
    };
  }

  // Fallback
  return {
    ok: false,
    category: 'service',
    statusCode: res.status,
    error: body?.error || 'verification_failed',
    message: body?.message || 'Verification could not be completed. Please try again.',
  };
}

export async function verifyPortalIdentity(
  transactionOrClient: PortalIssueTransaction | SupabaseClient,
  requestIdOrPhotoIntentId: string,
  photoIntentIdOrIdIntentId: string,
  maybeIdIntentId?: string
): Promise<VerifyIdentityResponse> {
  let token: string;
  let requestId: string;
  let photoIntentId: string;
  let idIntentId: string;

  if (maybeIdIntentId !== undefined) {
    // Legacy client signature: (client, requestId, photoIntentId, idIntentId)
    const client = transactionOrClient as SupabaseClient;
    requestId = requestIdOrPhotoIntentId;
    photoIntentId = photoIntentIdOrIdIntentId;
    idIntentId = maybeIdIntentId;
    const { data: { session } } = await client.auth.getSession();
    token = session?.access_token || '';
  } else {
    // Portal transaction signature: (transaction, photoIntentId, idIntentId)
    const transaction = transactionOrClient as PortalIssueTransaction;
    requestId = transaction.requestId;
    photoIntentId = requestIdOrPhotoIntentId;
    idIntentId = photoIntentIdOrIdIntentId;
    const verified = await getVerifiedPortalSession(transaction);
    token = verified.token;
  }

  if (!token) throw new PortalSessionError('portal_session_missing', 'Authentication session required for identity verification.');

  let res: Response;
  try {
    res = await withTimeout(
      fetch('/api/passes/verify-identity', {
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
      }),
      30000,
      'Identity verification timed out after 30s'
    );
  } catch (err: any) {
    throw new Error('Network connection interrupted during identity verification. Please try again.');
  }

  const body = (await res.json().catch(() => null)) as (VerifyIdentityResponse & { error?: string }) | null;

  if (res.status === 401 || body?.error === 'invalid_session' || body?.error === 'authentication_required') {
    throw new PortalSessionError('portal_session_expired', 'Visitor registration session expired or unavailable.');
  }

  if (res.status === 429 || body?.error === 'rate_limit_exceeded') {
    throw new Error(body?.message || 'Too many verification attempts. Please wait before retrying.');
  }

  if (res.status >= 500 || body?.error === 'abuse_control_unavailable') {
    throw new Error(body?.message || 'Identity verification service temporarily unavailable. Please try again shortly.');
  }

  if (!res.ok || !body) {
    throw new Error(body?.message || body?.error || 'Identity verification failed');
  }

  return body;
}

export async function preflightLiveFace(
  transactionOrClient: PortalIssueTransaction | SupabaseClient,
  requestIdOrPhotoIntentId: string,
  maybePhotoIntentId?: string
): Promise<{ ok: boolean; message?: string; reasonCode?: string }> {
  let token: string;
  let requestId: string;
  let photoIntentId: string;

  if (maybePhotoIntentId !== undefined) {
    // Legacy client signature: (client, requestId, photoIntentId)
    const client = transactionOrClient as SupabaseClient;
    requestId = requestIdOrPhotoIntentId;
    photoIntentId = maybePhotoIntentId;
    const { data: { session } } = await client.auth.getSession();
    token = session?.access_token || '';
  } else {
    // Portal transaction signature: (transaction, photoIntentId)
    const transaction = transactionOrClient as PortalIssueTransaction;
    requestId = transaction.requestId;
    photoIntentId = requestIdOrPhotoIntentId;
    const verified = await getVerifiedPortalSession(transaction);
    token = verified.token;
  }

  if (!token) throw new PortalSessionError('portal_session_missing', 'Authentication session required for face quality check.');

  const res = await fetch('/api/passes/verify-identity', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requestId,
      photoIntentId,
      mode: 'preflight_face',
    }),
  });

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    message?: string;
    reasonCode?: string;
    preflightPassed?: boolean;
  } | null;

  if (!res.ok || !body?.ok) {
    return {
      ok: false,
      message: body?.message || body?.error || 'Face quality verification failed.',
      reasonCode: body?.reasonCode,
    };
  }

  return { ok: true, message: body.message };
}

export interface ReturningLookupCandidate {
  profileId: string;
  maskedName: string;
  maskedContact: string;
  partialLocality: string;
  registeredAt?: string;
  previewUrl?: string;
}

export interface ReturningLookupResult {
  found: boolean;
  count: number;
  candidates: ReturningLookupCandidate[];
  error?: string;
  message?: string;
}

export async function lookupReturningVisitor(
  transaction: PortalIssueTransaction,
  payload: {
    firstName: string;
    lastName: string;
    middleName?: string;
    contactNumber?: string;
    psgcCityCode?: string;
    psgcBarangayCode?: string;
    mode?: 'auto' | 'manual';
  }
): Promise<ReturningLookupResult> {
  const { token } = await getVerifiedPortalSession(transaction);

  let res: Response;
  try {
    res = await withTimeout(
      fetch('/api/passes/lookup-returning', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
      15000,
      'Returning visitor lookup timed out after 15s'
    );
  } catch (err: any) {
    throw new Error('Network connection interrupted during visitor search. Please try again.');
  }

  const body = (await res.json().catch(() => null)) as ReturningLookupResult | null;

  if (res.status === 401) {
    throw new PortalSessionError('portal_session_expired', 'Visitor registration session expired or unavailable.');
  }

  if (res.status === 429) {
    throw new Error(body?.message || 'Too many search attempts. Please wait before retrying.');
  }

  if (!res.ok || !body) {
    return {
      found: false,
      count: 0,
      candidates: [],
      error: body?.error || 'lookup_failed',
      message: body?.message || 'Could not find returning visitor profile.',
    };
  }

  return body;
}

export async function identifyReturningVisitor(
  transaction: PortalIssueTransaction,
  photoBlobOrIntentId: Blob | string,
  profileId: string
): Promise<ReturningIdentifyResult> {
  const { token } = await getVerifiedPortalSession(transaction);

  let res: Response;
  try {
    if (typeof photoBlobOrIntentId === 'string') {
      res = await withTimeout(
        fetch('/api/passes/identify-returning', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId: transaction.requestId,
            profileId,
            photoIntentId: photoBlobOrIntentId,
          }),
        }),
        30000,
        'Returning visitor identification timed out after 30s'
      );
    } else {
      const formData = new FormData();
      formData.append('photo', photoBlobOrIntentId, 'selfie.jpg');
      formData.append('profileId', profileId);
      formData.append('requestId', transaction.requestId);

      res = await withTimeout(
        fetch('/api/passes/identify-returning', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        }),
        30000,
        'Returning visitor identification timed out after 30s'
      );
    }
  } catch (err: any) {
    throw new Error('Network connection interrupted during visitor identification. Please try again.');
  }

  const body = (await res.json().catch(() => null)) as ReturningIdentifyResult | null;

  if (res.status === 401) {
    throw new PortalSessionError('portal_session_expired', 'Visitor registration session expired or unavailable.');
  }

  if (res.status === 429) {
    throw new Error(body?.message || 'Too many identification attempts. Please wait before retrying.');
  }

  if (!res.ok || !body) {
    return {
      matched: false,
      error: body?.error || 'identify_failed',
      message: body?.message || 'Could not verify returning visitor.',
      reasonCode: (body as any)?.reasonCode,
      diagnostics: (body as any)?.diagnostics,
    };
  }

  return body;
}

export async function issueVisitorPass(
  source: RegistrationSource,
  visitor: VisitorRegistration,
  photo?: Blob | null,
  identification?: Blob | null,
  requestId: string = crypto.randomUUID(),
  captchaToken?: string,
  transaction?: IssueTransaction | null,
  vehiclePhoto?: Blob | null,
): Promise<IssuedPass> {
  const { client, token } = await authenticatedClient(source, captchaToken, transaction);

  const effectiveRequestId = transaction?.requestId ? transaction.requestId : requestId;

  // Upload photo intent with retry-safe checkpointing for new visitor
  let photoIntentId: string | null = null;
  let idIntentId: string | null = null;

  if (visitor.registrationMode === 'returning') {
    // Ephemeral returning visitor verification: no photo or ID upload intent created or reused
    photoIntentId = null;
    idIntentId = null;
  } else {
    if (shouldReuseUploadedIntentForIssue(transaction, transaction?.photoCheckpoint, transaction?.photoIntentId)) {
      photoIntentId = transaction!.photoIntentId!;
    } else if (photo) {
      const photoRes = await uploadCheckpointedEvidence(client, source, 'photo', photo, transaction);
      photoIntentId = photoRes.intentId;
    }

    // Upload id intent with retry-safe checkpointing if provided (Section 8)
    if (identification) {
      if (shouldReuseUploadedIntentForIssue(transaction, transaction?.idCheckpoint, transaction?.idIntentId)) {
        idIntentId = transaction!.idIntentId!;
      } else {
        const idRes = await uploadCheckpointedEvidence(client, source, 'id', identification, transaction);
        idIntentId = idRes.intentId;
      }
    }
  }

  // If vehicle arrival declared, upload vehicle photo with retry-safe checkpointing
  let vehiclePhotoIntentId: string | null = null;
  if (visitor.arrivalMode === 'vehicle') {
    if (shouldReuseUploadedIntentForIssue(transaction, transaction?.vehiclePhotoCheckpoint, transaction?.vehiclePhotoIntentId)) {
      vehiclePhotoIntentId = transaction!.vehiclePhotoIntentId!;
    } else if (vehiclePhoto) {
      const vehRes = await uploadCheckpointedEvidence(client, source, 'vehicle_photo', vehiclePhoto, transaction);
      vehiclePhotoIntentId = vehRes.intentId;
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
        registrationMode: effectiveVisitor.registrationMode || (effectiveVisitor.returning?.profileId ? 'returning' : 'new'),
        visitor: {
          firstName: effectiveVisitor.firstName,
          middleName: effectiveVisitor.middleName,
          lastName: effectiveVisitor.lastName,
          contactNumber: effectiveVisitor.contactNumber,
          purpose: effectiveVisitor.purpose,
          visitDate: effectiveVisitor.visitDate,
          homeAddress: effectiveVisitor.homeAddress?.trim() || undefined,
        },
        arrivalMode: effectiveVisitor.arrivalMode,
        homeLocation: effectiveVisitor.homeLocation || undefined,
        psgc: effectiveVisitor.psgc || undefined,
        vehicle: effectiveVisitor.vehicle
          ? {
              ...effectiveVisitor.vehicle,
              photoIntentId: vehiclePhotoIntentId || effectiveVisitor.vehicle.photoIntentId,
            }
          : undefined,
        vehiclePhotoIntentId: vehiclePhotoIntentId || undefined,
        returning: effectiveVisitor.returning || undefined,
        saveVehicle: Boolean(effectiveVisitor.saveVehicle || effectiveVisitor.vehicle?.saveVehicle),
        photoIntentId: effectiveVisitor.registrationMode === 'returning' ? undefined : (photoIntentId || undefined),
        idIntentId: effectiveVisitor.registrationMode === 'returning' ? undefined : (idIntentId || undefined),
        officeId: effectiveVisitor.officeId || undefined,
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
      } else if (errCode === 'invalid_contact_number') {
        message = 'Please provide a valid Philippine mobile number (e.g., 0917 123 4567).';
      } else if (errCode === 'home_location_required_for_portal' || errCode === 'home_location_required') {
        message = 'Please select your approximate residential location on the map.';
      } else if (errCode === 'invalid_home_location') {
        message = 'Approximate residential coordinates are invalid.';
      } else if (errCode?.includes('vehicle')) {
        message = 'Please check your vehicle declaration details.';
      } else if (body && (body as any).message) {
        message = (body as any).message;
      }
      throw new PassIssuanceError(message, errCode, outcome);
    }

    if (outcome === 'rejected_requires_reverification') {
      if (transaction) {
        transaction.phase = 'editable';
        transaction.submittedPayload = null;
      }
      throw new PassIssuanceError(
        'Identity verification has expired or is required. Please verify your identity again.',
        errCode,
        outcome
      );
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
        transaction.vehiclePhotoIntentId = null;
        transaction.photoCheckpoint = null;
        transaction.idCheckpoint = null;
        transaction.vehiclePhotoCheckpoint = null;
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

/**
 * Securely fetch previously submitted ID preview for a matched returning visitor.
 * Authenticated via visitor bearer token, bound to profileId, requestId, and matchToken.
 * Returns an object URL for the image blob, or null if unavailable/expired.
 */
export async function fetchHistoricalIdPreview(
  transaction: PortalIssueTransaction,
  profileId: string,
  matchToken: string
): Promise<string | null> {
  const { token } = await getVerifiedPortalSession(transaction);
  const params = new URLSearchParams({
    profileId,
    requestId: transaction.requestId,
    matchToken,
  });

  try {
    const res = await withTimeout(
      fetch(`/api/passes/returning-id-preview?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      15000,
      'Historical ID preview request timed out'
    );

    if (!res.ok) {
      return null;
    }

    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      return null;
    }
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn('Historical ID preview fetch error:', err);
    return null;
  }
}

