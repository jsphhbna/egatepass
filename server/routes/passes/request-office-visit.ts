import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken, pgUuidSchema } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { normalizePhMobile } from '../../../src/lib/phPhone.js';
import { normalizeVehiclePlate } from '../../../src/lib/vehiclePlate.js';
import { verifyEmailVerificationProofToken } from '../../lib/office.js';
import { inspectUploadIntent } from '../../upload-inspection.js';
import { computeMatchTokenDigest } from './identify-returning.js';
import { encryptQrPayload, decryptQrPayload } from '../../lib/encryption.js';
import { deliverOfficeAcknowledgementEmail, type OutboxDeliveryResult } from '../../lib/officeDelivery.js';
import { getBaseUrl } from '../../templates/branding.js';

const namePart = z.string().trim().min(1).max(50);

const requestSchema = z.object({
  requestId: pgUuidSchema,
  source: z.enum(['portal', 'kiosk']).default('portal'),
  registrationMode: z.enum(['new', 'returning']).default('new'),
  visitType: z.enum(['general', 'specific_person']).optional().default('specific_person'),
  visitor: z.object({
    firstName: namePart,
    middleName: z.string().trim().max(50).optional(),
    lastName: namePart,
    contactNumber: z.string().min(7).max(32),
    email: z.string().trim().email().max(255).optional(),
    purpose: z.string().trim().min(3).max(300),
    visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  officeId: pgUuidSchema,
  personnelId: pgUuidSchema.nullable().optional(),
  requestedPersonName: z.string().trim().min(2).max(150).nullable().optional(),
  specificPurpose: z.string().trim().min(3).max(300),
  emailVerificationToken: z.string().min(1).optional(),
  expectedGate: z.string().trim().min(1).max(50).optional(),
  arrivalMode: z.enum(['no_vehicle', 'vehicle']).optional().default('no_vehicle'),
  homeLocation: z.object({
    lat: z.number(),
    lon: z.number(),
  }).nullable().optional(),
  psgc: z.object({
    version: z.string().trim().default('2026-q3'),
    regionCode: z.string().regex(/^\d{10}$/),
    provinceCode: z.string().regex(/^\d{10}$/).nullable().optional(),
    cityCode: z.string().regex(/^\d{10}$/),
    barangayCode: z.string().regex(/^\d{10}$/),
    houseBuilding: z.string().trim().max(100).optional(),
    street: z.string().trim().max(150).optional(),
  }).optional(),
  vehicle: z.object({
    vehicleType: z.string().trim().min(1).max(40).optional(),
    plateNumber: z.string().trim().min(3).max(16).optional(),
    color: z.string().trim().min(2).max(40).optional(),
    makeModel: z.string().trim().max(100).optional(),
  }).optional(),
  photoIntentId: pgUuidSchema.nullable().optional(),
  idIntentId: pgUuidSchema.nullable().optional(),
  vehiclePhotoIntentId: pgUuidSchema.nullable().optional(),
  returning: z.object({
    profileId: pgUuidSchema.optional(),
    matchToken: z.string().optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  if (data.visitType === 'specific_person') {
    if (!data.visitor.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visitor', 'email'],
        message: 'Email is required for specific-person office visit requests.',
      });
    }
    if (!data.emailVerificationToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailVerificationToken'],
        message: 'Verified email token is required for specific-person office visit requests.',
      });
    }
    if (!data.requestedPersonName?.trim() && !data.personnelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedPersonName'],
        message: 'Either requestedPersonName or personnelId is required',
      });
    }
  }
});

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });
  }

  const { admin } = getServerSupabaseClients();
  const session = await getVerifiedSessionContext(admin, token);

  if (session.isRecoverySession) {
    throw new HttpError(403, 'recovery_session_forbidden');
  }

  // Cryptographically verify email verification proof token whenever email is supplied or required
  const normalizedVisitorEmail = parsed.data.visitor.email?.toLowerCase().trim() || null;
  if (normalizedVisitorEmail || parsed.data.visitType === 'specific_person') {
    if (!parsed.data.emailVerificationToken || !normalizedVisitorEmail) {
      return jsonResponse(403, {
        error: 'email_verification_invalid',
        message: 'Email verification is required for this office visit request.',
      });
    }
    const isEmailVerified = verifyEmailVerificationProofToken(
      parsed.data.emailVerificationToken,
      normalizedVisitorEmail,
      session.user.id
    );

    if (!isEmailVerified) {
      return jsonResponse(403, {
        error: 'email_verification_invalid',
        message: 'Email verification proof token is invalid or has expired. Please verify your email.',
      });
    }
  }

  // Normalize phone number
  let canonicalContact = parsed.data.visitor.contactNumber.trim();
  if (parsed.data.source === 'portal') {
    const canonical = normalizePhMobile(canonicalContact);
    if (!canonical) {
      return jsonResponse(422, {
        error: 'invalid_contact_number',
        message: 'Please provide a valid 11-digit Philippine mobile number starting with 09.',
      });
    }
    canonicalContact = canonical;
  }

  // Verify office is active & published, and validate optional personnel
  const { data: office, error: officeErr } = await admin
    .from('offices')
    .select('id, name, active, publication_status, requires_approval_before_pass, archived_at')
    .eq('id', parsed.data.officeId)
    .maybeSingle();

  if (officeErr || !office || !office.active || office.publication_status !== 'published' || office.archived_at) {
    return jsonResponse(404, {
      error: 'office_not_found',
      message: 'The requested office is not found, inactive, or not yet published.',
    });
  }

  let personnel: { id: string; name: string; office_id: string; active: boolean } | null = null;
  if (parsed.data.personnelId) {
    const { data: persRow, error: persErr } = await admin
      .from('office_personnel')
      .select('id, name, office_id, active')
      .eq('id', parsed.data.personnelId)
      .eq('office_id', parsed.data.officeId)
      .maybeSingle();

    if (persErr || !persRow || !persRow.active) {
      return jsonResponse(404, {
        error: 'personnel_not_found',
        message: 'The requested personnel is not found or is currently inactive in this office.',
      });
    }
    personnel = persRow;
  }

  let normalizedPlateDisplay: string | null = null;
  let normalizedPlateKey: string | null = null;
  let vehicleDetails: Record<string, unknown> | null = null;

  if (parsed.data.arrivalMode === 'vehicle') {
    const v = parsed.data.vehicle;
    if (!v?.vehicleType || !v?.plateNumber || !v?.color) {
      return jsonResponse(422, {
        error: 'invalid_vehicle_declaration',
        message: 'Vehicle type, plate number, and color are required when bringing a vehicle.',
      });
    }

    const plateResult = normalizeVehiclePlate(v.plateNumber);
    if (!plateResult.valid || !plateResult.plateKey) {
      return jsonResponse(422, {
        error: 'invalid_vehicle_plate',
        message: plateResult.error || 'Please enter a valid vehicle plate number.',
      });
    }
    normalizedPlateDisplay = plateResult.displayPlate;
    normalizedPlateKey = plateResult.plateKey;

    if (!parsed.data.vehiclePhotoIntentId) {
      return jsonResponse(422, {
        error: 'vehicle_photo_required',
        message: 'Vehicle photo is required when bringing a vehicle.',
      });
    }

    // Active plate collision check on campus
    const { data: activePlateDecl, error: plateCheckErr } = await admin
      .from('visit_vehicle_declarations')
      .select('id, pass_id, entry_recorded_at, exit_recorded_at, passes!inner(status)')
      .eq('plate_key', normalizedPlateKey)
      .is('exit_recorded_at', null)
      .not('entry_recorded_at', 'is', null)
      .in('passes.status', ['issued', 'pending', 'inside'])
      .limit(1)
      .maybeSingle();

    if (plateCheckErr) throw plateCheckErr;
    if (activePlateDecl) {
      return jsonResponse(409, {
        error: 'plate_already_active_on_campus',
        message: 'This vehicle is currently registered as on campus under an active pass.',
      });
    }

    vehicleDetails = {
      vehicleType: v.vehicleType,
      plateNumber: normalizedPlateDisplay,
      color: v.color,
      makeModel: v.makeModel || '',
    };
  } else {
    // arrivalMode === 'no_vehicle'
    if (parsed.data.vehicle || parsed.data.vehiclePhotoIntentId) {
      return jsonResponse(422, {
        error: 'unexpected_vehicle_details',
        message: 'Vehicle details and vehicle photo must not be provided when arrival mode is no_vehicle.',
      });
    }
  }

  const addressDetails = parsed.data.psgc ? {
    regionCode: parsed.data.psgc.regionCode,
    provinceCode: parsed.data.psgc.provinceCode,
    cityCode: parsed.data.psgc.cityCode,
    barangayCode: parsed.data.psgc.barangayCode,
    houseBuilding: parsed.data.psgc.houseBuilding,
    street: parsed.data.psgc.street,
  } : null;

  let photoInspected: { bytes: number; sha256: string } | null = null;
  if (parsed.data.photoIntentId) {
    try {
      photoInspected = await inspectUploadIntent(admin, parsed.data.photoIntentId, session.user.id, parsed.data.source, 'photo');
    } catch {
      return jsonResponse(400, { error: 'invalid_photo_upload', message: 'Uploaded visitor portrait is invalid, unverified, or expired.' });
    }
  }

  let idInspected: { bytes: number; sha256: string } | null = null;
  if (parsed.data.idIntentId) {
    try {
      idInspected = await inspectUploadIntent(admin, parsed.data.idIntentId, session.user.id, parsed.data.source, 'id');
    } catch {
      return jsonResponse(400, { error: 'invalid_id_upload', message: 'Uploaded identification document is invalid, unverified, or expired.' });
    }
  }

  let vehiclePhotoInspected: { bytes: number; sha256: string } | null = null;
  if (parsed.data.arrivalMode === 'vehicle' && parsed.data.vehiclePhotoIntentId) {
    try {
      vehiclePhotoInspected = await inspectUploadIntent(admin, parsed.data.vehiclePhotoIntentId, session.user.id, parsed.data.source, 'vehicle_photo');
    } catch {
      return jsonResponse(400, { error: 'invalid_vehicle_photo_upload', message: 'Uploaded vehicle photo is invalid, unverified, or expired.' });
    }
  }

  let boundIdentityVerificationId: string | null = null;
  let boundReturningAttemptId: string | null = null;
  let boundReturningProfileId: string | null = null;
  let returningMatchDigest: string | null = null;

  if (parsed.data.registrationMode === 'new') {
    if (!parsed.data.photoIntentId || !parsed.data.idIntentId) {
      return jsonResponse(422, {
        error: 'identity_proof_required',
        message: 'Both portrait photo and valid ID are required for new visitor registration.',
      });
    }

    if (parsed.data.returning?.profileId || parsed.data.returning?.matchToken) {
      return jsonResponse(422, {
        error: 'returning_metadata_forbidden',
        message: 'Returning visitor metadata cannot be provided for new visitor registration.',
      });
    }

    const { data: verAttempt, error: verErr } = await admin
      .from('portal_identity_verification_attempts')
      .select('id, outcome, expires_at')
      .eq('owner_id', session.user.id)
      .eq('request_id', parsed.data.requestId)
      .eq('photo_intent_id', parsed.data.photoIntentId)
      .eq('id_intent_id', parsed.data.idIntentId)
      .eq('outcome', 'matched')
      .gt('expires_at', new Date().toISOString())
      .order('verified_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (verErr || !verAttempt) {
      return jsonResponse(422, {
        error: 'identity_verification_required',
        message: 'Valid matched identity verification required. Please complete face and ID verification.',
      });
    }

    boundIdentityVerificationId = verAttempt.id;
  } else if (parsed.data.registrationMode === 'returning') {
    if (!parsed.data.returning?.profileId || !parsed.data.returning?.matchToken) {
      return jsonResponse(422, {
        error: 'returning_credentials_required',
        message: 'Returning visitor profile and verification token are required.',
      });
    }

    const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
    if (!matchSecret || matchSecret.length < 32) {
      return jsonResponse(503, {
        error: 'abuse_control_unavailable',
        message: 'Returning visitor verification service is temporarily unavailable.',
      });
    }

    returningMatchDigest = computeMatchTokenDigest(parsed.data.returning.matchToken, matchSecret);

    const { data: retAttempt, error: retErr } = await admin
      .from('returning_identity_attempts')
      .select('id, outcome, expires_at')
      .eq('owner_id', session.user.id)
      .eq('request_id', parsed.data.requestId)
      .eq('matched_profile_id', parsed.data.returning.profileId)
      .eq('match_token_digest', returningMatchDigest)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (retErr || !retAttempt || !['matched', 'provisional_matched'].includes(retAttempt.outcome)) {
      return jsonResponse(422, {
        error: 'returning_match_required',
        message: 'Valid returning visitor identification required. Please complete biometric verification.',
      });
    }

    boundReturningAttemptId = retAttempt.id;
    boundReturningProfileId = parsed.data.returning.profileId;
  }

  // Generate tracking token and encrypted delivery payload
  const rawTrackingToken = randomBytes(32).toString('base64url');
  const trackingTokenDigest = createHash('sha256').update(rawTrackingToken).digest('hex');
  const trackingTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  let encryptedTrackingToken: string | null = null;
  try {
    encryptedTrackingToken = encryptQrPayload(rawTrackingToken);
  } catch (encErr) {
    console.error('Failed to encrypt tracking token for delivery outbox:', encErr);
  }

  let passQrToken: string | null = null;
  let passTokenDigest: string | null = null;
  // Specific person visit requests unconditionally require office approval; no pass token is issued at request creation.

  // Call api.create_specific_person_visit_request RPC
  const { data: rpcResult, error: rpcError } = await admin.schema('api').rpc('create_specific_person_visit_request', {
    requested_actor_id: session.user.id,
    requested_request_id: parsed.data.requestId,
    requested_office_id: parsed.data.officeId,
    requested_personnel_id: parsed.data.personnelId || null,
    requested_first_name: parsed.data.visitor.firstName,
    requested_middle_name: parsed.data.visitor.middleName || null,
    requested_last_name: parsed.data.visitor.lastName,
    requested_contact_number: canonicalContact,
    requested_email: normalizedVisitorEmail,
    requested_purpose: parsed.data.specificPurpose,
    requested_visit_date: parsed.data.visitor.visitDate,
    requested_arrival_mode: parsed.data.arrivalMode,
    requested_vehicle_details: vehicleDetails,
    requested_address_details: addressDetails,
    requested_photo_intent_id: parsed.data.registrationMode === 'returning' ? null : (parsed.data.photoIntentId || null),
    requested_photo_bytes: parsed.data.registrationMode === 'returning' ? null : (photoInspected?.bytes || null),
    requested_photo_sha256: parsed.data.registrationMode === 'returning' ? null : (photoInspected?.sha256 || null),
    requested_id_intent_id: parsed.data.registrationMode === 'returning' ? null : (parsed.data.idIntentId || null),
    requested_id_bytes: parsed.data.registrationMode === 'returning' ? null : (idInspected?.bytes || null),
    requested_id_sha256: parsed.data.registrationMode === 'returning' ? null : (idInspected?.sha256 || null),
    requested_vehicle_photo_intent_id: parsed.data.vehiclePhotoIntentId || null,
    requested_vehicle_photo_bytes: vehiclePhotoInspected?.bytes || null,
    requested_vehicle_photo_sha256: vehiclePhotoInspected?.sha256 || null,
    requested_registration_mode: parsed.data.registrationMode,
    requested_returning_profile_id: boundReturningProfileId,
    requested_returning_match_token_digest: returningMatchDigest,
    requested_identity_verification_id: boundIdentityVerificationId,
    requested_returning_attempt_id: boundReturningAttemptId,
    requested_person_name: parsed.data.requestedPersonName?.trim() || null,
    requested_tracking_token_digest: trackingTokenDigest,
    requested_tracking_token_expires_at: trackingTokenExpiresAt,
    requested_encrypted_tracking_token: encryptedTrackingToken,
    requested_visit_type: parsed.data.visitType,
    requested_source: parsed.data.source,
    requested_pass_token_digest: passTokenDigest,
    requested_expected_gate: parsed.data.expectedGate ?? null,
  });

  if (rpcError) {
    if (rpcError.code === '42501' && rpcError.message?.includes('request_id_actor_mismatch')) {
      return jsonResponse(403, { error: 'request_id_actor_mismatch', message: 'This request ID was submitted by another account.' });
    }
    if (rpcError.message?.includes('visit_date_in_past')) {
      return jsonResponse(422, { error: 'visit_date_in_past', message: 'Requested visit date cannot be in the past.' });
    }
    if (rpcError.message?.includes('visit_date_beyond_horizon')) {
      return jsonResponse(422, { error: 'visit_date_beyond_horizon', message: 'Requested visit date exceeds maximum advance scheduling limit.' });
    }
    if (rpcError.message?.includes('visit_window_already_closed')) {
      return jsonResponse(422, { error: 'visit_window_already_closed', message: 'Visiting hours have already closed for the selected date.' });
    }
    if (rpcError.message?.includes('visit_date_closed')) {
      const match = rpcError.message.match(/visit_date_closed:\s*(.+)/);
      const title = match && match[1] ? match[1].trim() : 'Campus is closed on this date.';
      return jsonResponse(422, {
        error: 'visit_date_closed',
        message: `The campus is closed on the selected visit date (${title}). Please select another date.`,
      });
    }
    if (rpcError.message?.includes('office_not_found_or_unpublished')) {
      return jsonResponse(422, { error: 'office_not_found_or_unpublished', message: 'The selected office is unavailable or unpublished.' });
    }
    if (rpcError.message?.includes('office_not_found_or_inactive')) {
      return jsonResponse(422, { error: 'office_not_found_or_inactive', message: 'The selected office is inactive, unverified, or does not exist.' });
    }
    if (rpcError.message?.includes('plate_already_active_on_campus')) {
      return jsonResponse(409, { error: 'plate_already_active_on_campus', message: 'This vehicle is currently registered as on campus under an active pass.' });
    }
    if (rpcError.message?.includes('valid_matched_identity_verification_required')) {
      return jsonResponse(422, { error: 'identity_verification_required', message: 'Valid matched identity verification required.' });
    }
    if (rpcError.message?.includes('identity_verification_already_consumed')) {
      return jsonResponse(409, { error: 'identity_verification_already_consumed', message: 'This identity verification has already been used.' });
    }
    console.error('Failed to create specific-person visit request:', rpcError);
    return jsonResponse(500, {
      error: 'request_creation_failed',
      message: rpcError.message || 'Unable to record visit request.',
    });
  }

  const resultRow = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
  if (!resultRow?.visit_id) {
    return jsonResponse(500, {
      error: 'request_creation_failed',
      message: 'Failed to record visit request.',
    });
  }

  // Determine effective tracking token (reuse existing token on idempotent retry)
  let effectiveTrackingToken = rawTrackingToken;
  if (!resultRow.inserted && resultRow.encrypted_tracking_token) {
    try {
      effectiveTrackingToken = decryptQrPayload(resultRow.encrypted_tracking_token);
    } catch (decErr) {
      console.warn('Failed to decrypt existing tracking token on idempotent retry, reusing generated token:', decErr);
    }
  }

  const trackingUrl = `${getBaseUrl()}/track#t=${effectiveTrackingToken}`;
  const resolvedPersonnelName = personnel ? personnel.name : (parsed.data.requestedPersonName?.trim() || null);
  const visitorFullName = [
    parsed.data.visitor.firstName,
    parsed.data.visitor.middleName,
    parsed.data.visitor.lastName,
  ].filter(Boolean).join(' ');

  let emailDelivery: OutboxDeliveryResult | null = null;
  if (normalizedVisitorEmail) {
    try {
      emailDelivery = await deliverOfficeAcknowledgementEmail(admin, {
        visitId: resultRow.visit_id,
        recipientEmail: normalizedVisitorEmail,
        visitorName: visitorFullName,
        officeName: office.name,
        personnelName: resolvedPersonnelName || 'General Office Reception',
        visitDate: parsed.data.visitor.visitDate,
        purpose: parsed.data.specificPurpose,
        trackingUrl,
      });
    } catch (deliveryEx) {
      console.error('Non-fatal error delivering acknowledgement email:', deliveryEx);
      emailDelivery = {
        status: 'failed',
        providerMessageId: null,
        error: deliveryEx instanceof Error ? deliveryEx.message : 'acknowledgement_delivery_failed',
      };
    }
  }

  const isAutoApproved = false;
  return jsonResponse(201, {
    ok: true,
    approvalRequired: !isAutoApproved,
    visitId: resultRow.visit_id,
    requestId: resultRow.request_id,
    approvalStatus: resultRow.approval_status,
    attendanceStatus: resultRow.attendance_status,
    officeName: office.name,
    personnelName: resolvedPersonnelName,
    trackingToken: effectiveTrackingToken,
    trackingUrl,
    ...(isAutoApproved ? {
      passId: resultRow.public_reference,
      publicReference: resultRow.public_reference,
      qrToken: passQrToken,
      validFrom: resultRow.valid_from,
      validUntil: resultRow.valid_until,
      decisionSource: resultRow.decision_source ?? 'auto_office_policy',
    } : {}),
    emailDelivery: emailDelivery ? {
      status: emailDelivery.status,
      providerMessageId: emailDelivery.providerMessageId,
    } : undefined,
    message: isAutoApproved
      ? 'Your office visit pass has been issued and is ready for gate presentation.'
      : 'Your visit request has been submitted for office review. You will receive an email once approved or rejected.',
  });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
