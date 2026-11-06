import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { normalizePhMobile } from '../../../src/lib/phPhone.js';
import { verifyEmailVerificationProofToken } from '../../lib/office.js';
import { inspectUploadIntent } from '../../upload-inspection.js';

const namePart = z.string().trim().min(1).max(50);

const requestSchema = z.object({
  requestId: z.string().uuid(),
  source: z.enum(['portal', 'kiosk']).default('portal'),
  registrationMode: z.enum(['new', 'returning']).default('new'),
  visitor: z.object({
    firstName: namePart,
    middleName: z.string().trim().max(50).optional(),
    lastName: namePart,
    contactNumber: z.string().min(7).max(32),
    email: z.string().trim().email().max(255),
    purpose: z.string().trim().min(3).max(300),
    visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  officeId: z.string().uuid(),
  personnelId: z.string().uuid(),
  specificPurpose: z.string().trim().min(3).max(300),
  emailVerificationToken: z.string().min(1),
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
  photoIntentId: z.string().uuid().nullable().optional(),
  idIntentId: z.string().uuid().nullable().optional(),
  vehiclePhotoIntentId: z.string().uuid().nullable().optional(),
  returning: z.object({
    profileId: z.string().uuid().optional(),
    matchToken: z.string().optional(),
  }).optional(),
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

  // Cryptographically verify email verification proof token
  const isEmailVerified = verifyEmailVerificationProofToken(
    parsed.data.emailVerificationToken,
    parsed.data.visitor.email,
    session.user.id
  );

  if (!isEmailVerified) {
    return jsonResponse(403, {
      error: 'email_verification_invalid',
      message: 'Email verification proof token is invalid or has expired. Please verify your email.',
    });
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

  // Verify office and personnel exist and are active
  const { data: office, error: officeErr } = await admin
    .from('offices')
    .select('id, name, active')
    .eq('id', parsed.data.officeId)
    .maybeSingle();

  if (officeErr || !office || !office.active) {
    return jsonResponse(404, {
      error: 'office_not_found',
      message: 'The requested office is not found or is currently inactive.',
    });
  }

  const { data: personnel, error: persErr } = await admin
    .from('office_personnel')
    .select('id, name, office_id, active')
    .eq('id', parsed.data.personnelId)
    .eq('office_id', parsed.data.officeId)
    .maybeSingle();

  if (persErr || !personnel || !personnel.active) {
    return jsonResponse(404, {
      error: 'personnel_not_found',
      message: 'The requested personnel is not found or is currently inactive in this office.',
    });
  }

  const vehicleDetails = parsed.data.vehicle ? {
    vehicleType: parsed.data.vehicle.vehicleType,
    plateNumber: parsed.data.vehicle.plateNumber,
    color: parsed.data.vehicle.color,
    makeModel: parsed.data.vehicle.makeModel,
  } : null;

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

  // Call api.create_specific_person_visit_request RPC
  const { data: rpcResult, error: rpcError } = await admin.rpc('create_specific_person_visit_request', {
    requested_actor_id: session.user.id,
    requested_request_id: parsed.data.requestId,
    requested_office_id: parsed.data.officeId,
    requested_personnel_id: parsed.data.personnelId,
    requested_first_name: parsed.data.visitor.firstName,
    requested_middle_name: parsed.data.visitor.middleName || null,
    requested_last_name: parsed.data.visitor.lastName,
    requested_contact_number: canonicalContact,
    requested_email: parsed.data.visitor.email.toLowerCase().trim(),
    requested_purpose: parsed.data.specificPurpose,
    requested_visit_date: parsed.data.visitor.visitDate,
    requested_arrival_mode: parsed.data.arrivalMode,
    requested_vehicle_details: vehicleDetails,
    requested_address_details: addressDetails,
    requested_photo_intent_id: parsed.data.photoIntentId || null,
    requested_photo_bytes: photoInspected?.bytes || null,
    requested_photo_sha256: photoInspected?.sha256 || null,
    requested_id_intent_id: parsed.data.idIntentId || null,
    requested_id_bytes: idInspected?.bytes || null,
    requested_id_sha256: idInspected?.sha256 || null,
    requested_vehicle_photo_intent_id: parsed.data.vehiclePhotoIntentId || null,
    requested_vehicle_photo_bytes: vehiclePhotoInspected?.bytes || null,
    requested_vehicle_photo_sha256: vehiclePhotoInspected?.sha256 || null,
  });

  if (rpcError) {
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

  return jsonResponse(201, {
    ok: true,
    visitId: resultRow.visit_id,
    requestId: resultRow.request_id,
    approvalStatus: resultRow.approval_status,
    attendanceStatus: resultRow.attendance_status,
    officeName: office.name,
    personnelName: personnel.name,
    message: 'Your visit request has been submitted for office review. You will receive an email once approved or rejected.',
  });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
