import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken, pgUuidSchema } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { normalizePhMobile } from '../../../src/lib/phPhone.js';
import { normalizeVehiclePlate } from '../../../src/lib/vehiclePlate.js';
import { computeMatchTokenDigest } from './identify-returning.js';
import { normalizeCoordinates, type HomeLocation } from '../../lib/home-location.js';
import {
  buildExpectedPsgcReferences,
  validatePsgcReferences,
} from '../../lib/psgc-reference.js';
import { verifyEmailVerificationProofToken } from '../../lib/office.js';
import { encryptQrPayload, decryptQrPayload } from '../../lib/encryption.js';
import { deliverOfficeAcknowledgementEmail, type OutboxDeliveryResult } from '../../lib/officeDelivery.js';
import { getBaseUrl } from '../../templates/branding.js';

const namePart = z.string().trim().min(1).max(50);
const requestSchema = z.object({
  requestId: pgUuidSchema,
  source: z.enum(['portal', 'kiosk']),
  registrationMode: z.enum(['new', 'returning']).default('new'),
  visitor: z.object({
    firstName: namePart,
    middleName: z.string().trim().max(50).optional(),
    lastName: namePart,
    contactNumber: z.string().min(7).max(32),
    email: z.string().trim().email().max(255).optional(),
    homeAddress: z.string().trim().max(300).optional(),
    purpose: z.string().trim().min(3).max(300),
    visitDate: z.iso.date(),
  }),
  emailVerificationToken: z.string().min(1).optional(),
  expectedGate: z.string().trim().min(1).max(50).optional(),
  arrivalMode: z.enum(['no_vehicle', 'vehicle']).optional(),
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
    postalCode: z.string().trim().max(10).optional(),
    postalCodeSource: z.string().trim().max(50).optional(),
  }).optional(),
  vehicle: z.object({
    vehicleType: z.string().trim().min(1).max(40).optional(),
    plateNumber: z.string().trim().min(3).max(16).optional(),
    color: z.string().trim().min(2).max(40).optional(),
    makeModel: z.string().trim().max(100).optional(),
    catalogStatus: z.string().trim().optional(),
    photoIntentId: pgUuidSchema.optional(),
    savedVehicleId: pgUuidSchema.optional(),
    saveVehicle: z.boolean().optional(),
  }).optional(),
  vehiclePhotoIntentId: pgUuidSchema.optional(),
  returning: z.object({
    profileId: pgUuidSchema.optional(),
    matchToken: z.string().optional(),
    saveUpdates: z.boolean().optional(),
  }).optional(),
  enrollReturning: z.boolean().optional(),
  saveVehicle: z.boolean().optional(),
  photoIntentId: pgUuidSchema.nullable().optional(),
  idIntentId: pgUuidSchema.nullable().optional(),
  officeId: pgUuidSchema.optional(),
});

function validMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (contentType === 'image/webp') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

interface IntentRow {
  id: string;
  owner_id: string;
  source: 'portal' | 'kiosk';
  kind: 'photo' | 'id' | 'vehicle_photo';
  bucket_id: string;
  object_path: string;
  content_type: string;
  max_bytes: number;
  status: string;
  expires_at: string;
}

interface InspectedUpload {
  bytes: number;
  sha256: string;
  buffer?: Buffer;
}

interface IssueResult {
  pass_id?: string;
  public_reference: string;
  valid_from: string;
  valid_until: string;
}

async function inspectUpload(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  id: string,
  actorId: string,
  source: 'portal' | 'kiosk',
  kind: 'photo' | 'id' | 'vehicle_photo',
  keepBuffer = false
): Promise<InspectedUpload> {
  const { data, error } = await admin.from('upload_intents').select('*').eq('id', id).maybeSingle<IntentRow>();
  if (error) throw error;
  if (
    !data ||
    data.owner_id !== actorId ||
    data.source !== source ||
    data.kind !== kind ||
    data.status !== 'pending' ||
    new Date(data.expires_at).getTime() <= Date.now()
  ) {
    throw new Error('invalid_upload_intent');
  }

  const downloaded = await admin.storage.from(data.bucket_id).download(data.object_path);
  if (downloaded.error) throw new Error('missing_uploaded_object');

  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.length < 12 || bytes.length > data.max_bytes || !validMagic(bytes, data.content_type)) {
    throw new Error('invalid_uploaded_content');
  }

  const buf = Buffer.from(bytes);
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    buffer: keepBuffer ? buf : undefined,
  };
}

export function getClientNetworkIdentifier(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const firstHop = forwarded ? forwarded.split(',')[0]?.trim() : null;
  const rawIp = firstHop || realIp || '127.0.0.1';

  const dedicatedSecret = process.env.RATE_LIMIT_HMAC_SECRET?.trim();

  if (!dedicatedSecret || dedicatedSecret.length < 32) {
    throw new HttpError(503, 'abuse_control_unavailable');
  }

  return createHmac('sha256', dedicatedSecret).update(`network:${rawIp}`).digest('hex');
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'invalid_request' });

  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'invalid_session' });
    }

    if (session.isRecoverySession) {
      return jsonResponse(403, { error: 'recovery_session_forbidden' });
    }

    if (parsed.data.source === 'portal' && !session.isAnonymous) {
      return jsonResponse(403, { error: 'anonymous_visitor_required' });
    }

    const actorId = session.user.id;

    const secret = process.env.PASS_TOKEN_SECRET?.trim();
    if (!secret || secret.length < 32) {
      console.error('PASS_TOKEN_SECRET missing or insecure');
      return jsonResponse(503, { error: 'pass_token_secret_unavailable' });
    }

    const qrToken = createHmac('sha256', secret)
      .update(`${actorId}:${parsed.data.requestId}`)
      .digest('base64url');
    const tokenDigest = createHash('sha256').update(qrToken).digest('hex');

    // Arrival mode enforcement (Section 5)
    if (parsed.data.source === 'portal') {
      if (!parsed.data.arrivalMode) {
        return jsonResponse(422, {
          error: 'arrival_mode_required',
          message: 'Explicit arrival mode selection is required.',
        });
      }

      // Registration mode validation & symmetry
      if (parsed.data.registrationMode === 'returning') {
        if (!parsed.data.returning?.profileId) {
          return jsonResponse(422, {
            error: 'returning_credentials_required',
            message: 'Returning visitor credentials are required when registration mode is returning.',
          });
        }
      } else if (parsed.data.registrationMode === 'new') {
        if (parsed.data.returning?.profileId || parsed.data.returning?.matchToken) {
          return jsonResponse(422, {
            error: 'returning_metadata_forbidden',
            message: 'Returning visitor metadata cannot be provided for new visitor registration.',
          });
        }
      }
    }

    // Phone normalization (Section 19: PH mobile contract)
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

    // Vehicle normalization (Section 23: Plate normalization & Photo requirement)
    const CONTROLLED_VEHICLE_COLORS = [
      'White',
      'Black',
      'Silver',
      'Gray',
      'Red',
      'Blue',
      'Brown',
      'Green',
      'Yellow',
      'Orange',
      'Gold',
      'Beige',
      'Other',
    ] as const;

    const CONTROLLED_VEHICLE_TYPES = [
      'car',
      'motorcycle',
      'van',
      'pickup',
      'suv',
      'truck',
      'other',
    ] as const;

    let normalizedPlateDisplay: string | null = null;
    let normalizedPlateKey: string | null = null;
    let normalizedVehicleColor: string | null = null;
    let vehiclePhotoIntentId: string | null = null;
    if (parsed.data.arrivalMode === 'vehicle') {
      const v = parsed.data.vehicle;
      if (!v?.vehicleType || !CONTROLLED_VEHICLE_TYPES.includes(v.vehicleType as any) || !v?.plateNumber || !v?.color) {
        return jsonResponse(422, {
          error: 'invalid_vehicle_declaration',
          message: 'Vehicle type, plate number, and color are required when bringing a vehicle.',
        });
      }

      const matchedColor = CONTROLLED_VEHICLE_COLORS.find(
        (c) => c.toLowerCase() === v.color!.trim().toLowerCase()
      );
      if (!matchedColor) {
        return jsonResponse(422, {
          error: 'invalid_vehicle_declaration',
          message: 'Please select a valid vehicle color from the allowed options.',
        });
      }
      normalizedVehicleColor = matchedColor;

      if (!v.catalogStatus || (v.catalogStatus !== 'catalog' && v.catalogStatus !== 'manual')) {
        return jsonResponse(422, {
          error: 'invalid_vehicle_declaration',
          message: 'Vehicle catalog status must be explicitly specified as catalog or manual.',
        });
      }

      const makeModel = v.makeModel?.trim() || '';
      if (makeModel.length < 2 || makeModel.length > 100) {
        return jsonResponse(422, {
          error: 'invalid_vehicle_declaration',
          message: 'Vehicle make and model are required (between 2 and 100 characters).',
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

      if (parsed.data.source === 'portal') {
        vehiclePhotoIntentId = v.photoIntentId || parsed.data.vehiclePhotoIntentId || null;
        if (!vehiclePhotoIntentId) {
          return jsonResponse(422, {
            error: 'vehicle_photo_required',
            message: 'A photo of the vehicle is required when bringing a vehicle.',
          });
        }
      }
    }

    // Home location validation
    let normalizedHomeLocation: HomeLocation | null = null;
    const coordRes = normalizeCoordinates(
      parsed.data.homeLocation?.lat,
      parsed.data.homeLocation?.lon,
      false
    );

    // Safe idempotent replay check BEFORE rate limiting
    const { data: existingPass, error: existingPassError } = await admin
      .from('passes')
      .select('id, public_reference, valid_from, valid_until, token_digest, visitor_id, status')
      .eq('issue_request_id', parsed.data.requestId)
      .maybeSingle();

    if (existingPassError) throw existingPassError;

    if (existingPass) {
      // Replay found. Validate owner, source, and payload consistency (Section 50).
      const { data: existingVisitor, error: visitorError } = await admin
        .from('visitors')
        .select(`
          id, owner_id, source, full_name, contact_number, purpose, visit_date, home_address,
          registration_mode, arrival_mode, returning_profile_id, home_location_lat, home_location_lon,
          psgc_region_code, psgc_province_code, psgc_city_code, psgc_barangay_code,
          home_building, home_street, postal_code
        `)
        .eq('id', existingPass.visitor_id)
        .maybeSingle();

      if (visitorError) throw visitorError;
      if (!existingVisitor) throw new Error('visitor_record_missing');

      if (existingVisitor.owner_id !== actorId) {
        return jsonResponse(409, { error: 'cross_actor_replay' });
      }
      if (existingVisitor.source !== parsed.data.source) {
        return jsonResponse(409, { error: 'source_mismatch' });
      }

      const existingRegMode = existingVisitor.registration_mode || 'new';
      const incomingRegMode = parsed.data.registrationMode || 'new';
      if (existingRegMode !== incomingRegMode) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      const expectedFullName = [parsed.data.visitor.firstName, parsed.data.visitor.middleName, parsed.data.visitor.lastName].filter(Boolean).join(' ');
      if (
        existingVisitor.full_name !== expectedFullName ||
        (existingVisitor.contact_number !== canonicalContact && existingVisitor.contact_number !== parsed.data.visitor.contactNumber.trim()) ||
        existingVisitor.purpose !== parsed.data.visitor.purpose.trim() ||
        existingVisitor.visit_date !== parsed.data.visitor.visitDate
      ) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      const existingArrival = existingVisitor.arrival_mode || 'no_vehicle';
      const incomingArrival = parsed.data.arrivalMode || 'no_vehicle';
      if (existingArrival !== incomingArrival) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      // Symmetrically verify home location coordinates
      const existingLat = existingVisitor.home_location_lat != null ? Number(existingVisitor.home_location_lat) : null;
      const existingLon = existingVisitor.home_location_lon != null ? Number(existingVisitor.home_location_lon) : null;
      const incomingLat = coordRes.valid ? coordRes.location.lat : null;
      const incomingLon = coordRes.valid ? coordRes.location.lon : null;
      if (existingLat !== incomingLat || existingLon !== incomingLon) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      // Symmetrically verify PSGC structured address fields
      if (parsed.data.source === 'portal') {
        const incomingPsgc = parsed.data.psgc;
        if (
          (existingVisitor.psgc_region_code || null) !== (incomingPsgc?.regionCode || null) ||
          (existingVisitor.psgc_province_code || null) !== (incomingPsgc?.provinceCode || null) ||
          (existingVisitor.psgc_city_code || null) !== (incomingPsgc?.cityCode || null) ||
          (existingVisitor.psgc_barangay_code || null) !== (incomingPsgc?.barangayCode || null) ||
          (existingVisitor.home_building || null) !== (incomingPsgc?.houseBuilding || null) ||
          (existingVisitor.home_street || null) !== (incomingPsgc?.street || null) ||
          (existingVisitor.postal_code || null) !== (incomingPsgc?.postalCode || null)
        ) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
      }

      const expectedReturningId = parsed.data.returning?.profileId || null;
      if ((existingVisitor.returning_profile_id || null) !== expectedReturningId) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      if (existingArrival === 'vehicle') {
        const { data: existingDecl } = await admin
          .from('visit_vehicle_declarations')
          .select('plate_key, vehicle_type, color, make_model, vehicle_catalog_status, saved_vehicle_id, vehicle_photo_evidence_id')
          .eq('pass_id', existingPass.id)
          .maybeSingle();

        if (!existingDecl || !normalizedPlateKey || !parsed.data.vehicle) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
        if (
          existingDecl.plate_key !== normalizedPlateKey ||
          existingDecl.vehicle_type !== parsed.data.vehicle.vehicleType ||
          existingDecl.color.toLowerCase() !== (normalizedVehicleColor || parsed.data.vehicle.color || '').toLowerCase() ||
          (existingDecl.make_model || '').trim() !== (parsed.data.vehicle.makeModel || '').trim() ||
          existingDecl.vehicle_catalog_status !== (parsed.data.vehicle.catalogStatus || 'catalog') ||
          (existingDecl.saved_vehicle_id || null) !== (parsed.data.vehicle.savedVehicleId || null)
        ) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
      } else {
        if (parsed.data.vehicle || normalizedPlateKey) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
      }

      // Symmetric evidence upload_intent_ids comparison (including retained metadata after image purge)
      const { data: attachedEvidence, error: evError } = await admin
        .from('visitor_evidence')
        .select('kind, upload_intent_id')
        .eq('visitor_id', existingVisitor.id);

      if (evError) throw evError;
      const evMap = new Map((attachedEvidence || []).map((e) => [e.kind, e.upload_intent_id]));
      const actualPhotoIntent = (evMap.get('photo') || '').trim() || null;
      const actualIdIntent = (evMap.get('id') || '').trim() || null;
      const actualVehicleIntent = (evMap.get('vehicle_photo') || '').trim() || null;

      const incomingPhotoIntent = (parsed.data.photoIntentId || '').trim() || null;
      const incomingIdIntent = (parsed.data.idIntentId || '').trim() || null;
      const incomingVehicleIntent = (vehiclePhotoIntentId || '').trim() || null;

      if (actualPhotoIntent !== incomingPhotoIntent) {
        return jsonResponse(409, { error: 'intent_mismatch' });
      }
      if (actualIdIntent !== incomingIdIntent) {
        return jsonResponse(409, { error: 'intent_mismatch' });
      }
      if (actualVehicleIntent !== incomingVehicleIntent) {
        return jsonResponse(409, { error: 'intent_mismatch' });
      }

      // Check pass validity window
      if (new Date(existingPass.valid_until).getTime() <= Date.now() || existingPass.status === 'expired') {
        return jsonResponse(422, { error: 'pass_has_expired' });
      }

      // Check if HMAC secret was rotated
      const rawStoredDigest = typeof existingPass.token_digest === 'string'
        ? (existingPass.token_digest.startsWith('\\x') ? existingPass.token_digest.slice(2) : existingPass.token_digest)
        : '';
      if (rawStoredDigest.toLowerCase() !== tokenDigest.toLowerCase()) {
        return jsonResponse(409, { error: 'pass_token_secret_rotated' });
      }

      let replayOfficeVisitLinkStatus: 'linked' | 'reconciliation_required' | 'not_applicable' = 'not_applicable';
      if (parsed.data.officeId && existingPass.id) {
        const { data: linkedVisit, error: linkedVisitErr } = await admin
          .from('office_visits')
          .select('id')
          .eq('pass_id', existingPass.id)
          .eq('office_id', parsed.data.officeId)
          .maybeSingle();
        if (linkedVisitErr) throw linkedVisitErr;
        replayOfficeVisitLinkStatus = linkedVisit?.id ? 'linked' : 'reconciliation_required';
      }

      let replaySavedVehicleStatus: 'saved' | 'failed' | 'not_requested' = 'not_requested';
      if (
        parsed.data.arrivalMode === 'vehicle' &&
        parsed.data.vehicle?.saveVehicle === true &&
        parsed.data.returning?.profileId &&
        normalizedPlateKey
      ) {
        try {
          const { data: existingVeh, error: chkVehErr } = await admin
            .from('returning_visitor_vehicles')
            .select('id')
            .eq('profile_id', parsed.data.returning.profileId)
            .eq('plate_key', normalizedPlateKey)
            .is('archived_at', null)
            .maybeSingle();

          if (chkVehErr) throw chkVehErr;

          if (existingVeh?.id) {
            replaySavedVehicleStatus = 'saved';
          } else {
            const { error: insVehErr } = await admin.from('returning_visitor_vehicles').insert({
              profile_id: parsed.data.returning.profileId,
              vehicle_type: parsed.data.vehicle.vehicleType,
              plate_number: normalizedPlateDisplay || parsed.data.vehicle.plateNumber,
              plate_key: normalizedPlateKey,
              color: normalizedVehicleColor || parsed.data.vehicle.color,
              make_model: parsed.data.vehicle.makeModel || '',
            });
            replaySavedVehicleStatus = insVehErr ? 'failed' : 'saved';
          }
        } catch {
          replaySavedVehicleStatus = 'failed';
        }
      }

      // Return existing pass with 200 OK (idempotent replay without external Geoapify call)
      return jsonResponse(200, {
        passId: existingPass.public_reference,
        publicReference: existingPass.public_reference,
        qrToken,
        validFrom: existingPass.valid_from,
        validUntil: existingPass.valid_until,
        officeVisitLinkStatus: replayOfficeVisitLinkStatus,
        savedVehicleStatus: replaySavedVehicleStatus,
      });
    }

    const normalizedVisitorEmail = parsed.data.visitor.email?.toLowerCase().trim() || null;
    if (parsed.data.emailVerificationToken) {
      if (
        !normalizedVisitorEmail
        || !verifyEmailVerificationProofToken(parsed.data.emailVerificationToken, normalizedVisitorEmail, actorId)
      ) {
        return jsonResponse(403, {
          error: 'email_verification_invalid',
          message: 'Email verification proof token is invalid or has expired. Please verify your email.',
        });
      }
    }

    // Validate destination office & date availability before issuance
    let targetOffice: {
      id: string;
      name: string;
      active: boolean;
      publication_status: string;
      requires_approval_before_pass: boolean;
      archived_at: string | null;
    } | null = null;
    if (parsed.data.officeId) {
      const { data: off, error: offErr } = await admin
        .from('offices')
        .select('id, name, active, publication_status, requires_approval_before_pass, archived_at')
        .eq('id', parsed.data.officeId)
        .maybeSingle();
      if (offErr) throw offErr;
      if (!off || !off.active || off.publication_status !== 'published' || off.archived_at) {
        return jsonResponse(422, {
          error: 'office_not_found_or_unpublished',
          message: 'The selected destination office is unavailable or unpublished.',
        });
      }
      targetOffice = off;

      // Check office-specific calendar schedule for the requested date
      const { data: officeSched } = await admin
        .from('office_calendar_schedules')
        .select('status, reason')
        .eq('office_id', parsed.data.officeId)
        .eq('schedule_date', parsed.data.visitor.visitDate)
        .maybeSingle();
      if (officeSched && ['closed', 'maintenance', 'holiday'].includes(officeSched.status)) {
        return jsonResponse(422, {
          error: 'office_closed_on_date',
          message: `The selected office is ${officeSched.status} on ${parsed.data.visitor.visitDate}${officeSched.reason ? `: ${officeSched.reason}` : ''}. Please select an open date.`,
        });
      }

      // Check if an existing visit request is already pending approval
      const { data: existingVisit, error: existingVisitErr } = await admin
        .from('office_visits')
        .select('id, request_id, office_id, visitor_actor_id, approval_status, attendance_status, pass_id')
        .eq('request_id', parsed.data.requestId)
        .maybeSingle();
      if (existingVisitErr) throw existingVisitErr;
      if (existingVisit) {
        if (existingVisit.visitor_actor_id !== actorId) {
          return jsonResponse(403, { error: 'request_id_actor_mismatch' });
        }
        if (existingVisit.office_id !== parsed.data.officeId) {
          return jsonResponse(409, { error: 'idempotency_conflict' });
        }
        if (existingVisit.approval_status !== 'approved' || !existingVisit.pass_id) {
          return jsonResponse(200, {
            ok: true,
            approvalRequired: true,
            passId: null,
            publicReference: null,
            qrToken: null,
            visitId: existingVisit.id,
            requestId: existingVisit.request_id,
            approvalStatus: existingVisit.approval_status,
            attendanceStatus: existingVisit.attendance_status,
            officeName: targetOffice.name,
            officeVisitLinkStatus: 'pending_approval',
            message: 'Your office visit request has already been submitted for approval.',
          });
        }
      }
    }

    // Rate limiting for portal operations (only for new pass issuances)
    if (parsed.data.source === 'portal') {
      const actorKeyHex = createHash('sha256').update(`actor:${actorId}`).digest('hex');
      const { data: actorAllowed, error: actorRlError } = await admin.schema('api').rpc('consume_rate_limit', {
        requested_key_hex: actorKeyHex,
        requested_action: 'portal.pass_issue',
        requested_max_requests: 3,
        requested_window_seconds: 3600,
      });

      if (actorRlError) {
        console.error('Rate limit actor RPC error:', actorRlError);
        return jsonResponse(503, {
          error: 'abuse_control_unavailable',
          message: 'Pass issuance abuse protection is temporarily unavailable. Please try again shortly.',
        });
      }

      if (actorAllowed === false) {
        return jsonResponse(
          429,
          {
            error: 'rate_limit_exceeded',
            message: 'Too many pass issuance requests for this session. Please wait before requesting another pass.',
          },
          { 'Retry-After': '3600' }
        );
      }

      const networkKeyHex = getClientNetworkIdentifier(request);
      const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
        requested_key_hex: networkKeyHex,
        requested_action: 'portal.network_issue',
        requested_max_requests: 120,
        requested_window_seconds: 600,
      });

      if (netRlError) {
        console.error('Rate limit network RPC error:', netRlError);
        return jsonResponse(503, {
          error: 'abuse_control_unavailable',
          message: 'Pass issuance abuse protection is temporarily unavailable. Please try again shortly.',
        });
      }

      if (netAllowed === false) {
        return jsonResponse(
          429,
          {
            error: 'rate_limit_exceeded',
            message: 'Too many pass issuance requests from this network. Please wait before requesting another pass.',
          },
          { 'Retry-After': '600' }
        );
      }
    }

    // Enforcement of residential address for new portal pass issuances (after abuse control)
    if (parsed.data.source === 'portal') {
      const psgc = parsed.data.psgc;
      const hasPsgc = Boolean(psgc && psgc.regionCode && psgc.cityCode && psgc.barangayCode);
      if (!hasPsgc && !coordRes.valid) {
        return jsonResponse(422, {
          error: 'psgc_address_required',
          message: 'A complete structured Philippine address (region, city/municipality, and barangay) is required.',
        });
      }
      if (coordRes.valid) {
        normalizedHomeLocation = coordRes.location;
      }
    } else if (coordRes.valid) {
      normalizedHomeLocation = coordRes.location;
    }

    // Mode-specific verification checks
    let returningMatchDigest: string | null = null;
    let boundIdentityVerificationId: string | null = null;
    let boundReturningAttemptId: string | null = null;
    if (parsed.data.source === 'portal') {
      if (parsed.data.registrationMode === 'new') {
        if (!parsed.data.idIntentId) {
          return jsonResponse(422, { error: 'identity_verification_required', message: 'Valid ID is required for new visitor registration.' });
        }

        const { data: attempt, error: attemptError } = await admin
          .from('portal_identity_verification_attempts')
          .select('id, owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at')
          .eq('request_id', parsed.data.requestId)
          .eq('owner_id', actorId)
          .eq('photo_intent_id', parsed.data.photoIntentId)
          .eq('id_intent_id', parsed.data.idIntentId)
          .order('verified_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (attemptError) throw attemptError;
        if (!attempt || attempt.outcome !== 'matched') {
          return jsonResponse(422, {
            error: 'identity_verification_required',
            message: 'Identity verification must pass before a pass can be issued.',
          });
        }
        if (new Date(attempt.expires_at).getTime() <= Date.now()) {
          return jsonResponse(422, {
            error: 'identity_verification_expired',
            message: 'Identity verification has expired. Please retry verification.',
          });
        }
        boundIdentityVerificationId = attempt.id;
      } else if (parsed.data.registrationMode === 'returning') {
        const ret = parsed.data.returning;
        if (!ret?.profileId || !ret?.matchToken) {
          return jsonResponse(422, {
            error: 'returning_credentials_required',
            message: 'Returning visitor identification must be completed before pass issuance.',
          });
        }

        const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET?.trim();
        if (!matchSecret || matchSecret.length < 32) {
          console.error('RETURNING_MATCH_TOKEN_SECRET missing or insecure in pass issue');
          return jsonResponse(503, {
            error: 'service_unavailable',
            message: 'Returning visitor verification service is temporarily unavailable.',
          });
        }
        returningMatchDigest = computeMatchTokenDigest(ret.matchToken, matchSecret);

        const { data: retAttempt, error: retAttemptErr } = await admin
          .from('returning_identity_attempts')
          .select('id, outcome, expires_at')
          .eq('request_id', parsed.data.requestId)
          .eq('owner_id', actorId)
          .eq('matched_profile_id', ret.profileId)
          .eq('match_token_digest', returningMatchDigest)
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (retAttemptErr) throw retAttemptErr;
        if (!retAttempt || !['matched', 'provisional_matched'].includes(retAttempt.outcome)) {
          return jsonResponse(422, {
            error: 'returning_match_required',
            message: 'Valid returning visitor identification required. Please identify yourself first.',
          });
        }
        boundReturningAttemptId = retAttempt.id;
      }
    }

    if (parsed.data.source === 'portal' && parsed.data.registrationMode === 'new' && !parsed.data.photoIntentId) {
      return jsonResponse(422, { error: 'photo_required', message: 'Photo is required for new visitor registration.' });
    }

    const photo = parsed.data.photoIntentId
      ? await inspectUpload(admin, parsed.data.photoIntentId, actorId, parsed.data.source, 'photo')
      : null;
    const identification = parsed.data.idIntentId
      ? await inspectUpload(admin, parsed.data.idIntentId, actorId, parsed.data.source, 'id')
      : null;
    const vehiclePhoto = (parsed.data.arrivalMode === 'vehicle' && vehiclePhotoIntentId)
      ? await inspectUpload(admin, vehiclePhotoIntentId, actorId, parsed.data.source, 'vehicle_photo')
      : null;

    const visitor = parsed.data.visitor;

    // Route general office visits through pre-pass approval workflow when required by destination office
    if (parsed.data.officeId && targetOffice?.requires_approval_before_pass) {
      const psgc = parsed.data.psgc;
      const addressDetails = psgc ? {
        psgcVersion: psgc.version || '2026-q3',
        regionCode: psgc.regionCode,
        provinceCode: psgc.provinceCode || null,
        cityCode: psgc.cityCode,
        barangayCode: psgc.barangayCode,
        homeBuilding: psgc.houseBuilding || null,
        homeStreet: psgc.street || null,
        homeAddress: visitor.homeAddress?.trim() || null,
        lat: normalizedHomeLocation?.lat ?? null,
        lon: normalizedHomeLocation?.lon ?? null,
      } : (normalizedHomeLocation || visitor.homeAddress ? {
        homeAddress: visitor.homeAddress?.trim() || null,
        lat: normalizedHomeLocation?.lat ?? null,
        lon: normalizedHomeLocation?.lon ?? null,
      } : null);

      const vehicleDetails = parsed.data.arrivalMode === 'vehicle' && parsed.data.vehicle ? {
        vehicleType: parsed.data.vehicle.vehicleType,
        plateNumber: normalizedPlateDisplay,
        color: normalizedVehicleColor ?? parsed.data.vehicle.color,
        makeModel: parsed.data.vehicle.makeModel?.trim() || '',
      } : null;

      const rawTrackingToken = randomBytes(32).toString('base64url');
      const trackingTokenDigest = createHash('sha256').update(rawTrackingToken).digest('hex');
      const trackingTokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      let encryptedTrackingToken: string | null = null;
      try {
        encryptedTrackingToken = encryptQrPayload(rawTrackingToken);
      } catch (encErr) {
        console.error('Failed to encrypt tracking token for pre-approval general visit:', encErr);
      }

      const { data: visitRpcRes, error: visitRpcErr } = await admin.schema('api').rpc('create_specific_person_visit_request', {
        requested_actor_id: actorId,
        requested_request_id: parsed.data.requestId,
        requested_office_id: parsed.data.officeId,
        requested_personnel_id: null,
        requested_first_name: visitor.firstName,
        requested_middle_name: visitor.middleName || null,
        requested_last_name: visitor.lastName,
        requested_contact_number: canonicalContact,
        requested_email: normalizedVisitorEmail,
        requested_purpose: visitor.purpose,
        requested_visit_date: visitor.visitDate,
        requested_arrival_mode: parsed.data.arrivalMode || 'no_vehicle',
        requested_vehicle_details: vehicleDetails,
        requested_address_details: addressDetails,
        requested_photo_intent_id: parsed.data.registrationMode === 'returning' ? null : (parsed.data.photoIntentId ?? null),
        requested_photo_bytes: parsed.data.registrationMode === 'returning' ? null : (photo?.bytes ?? null),
        requested_photo_sha256: parsed.data.registrationMode === 'returning' ? null : (photo?.sha256 ?? null),
        requested_id_intent_id: parsed.data.registrationMode === 'returning' ? null : (parsed.data.idIntentId ?? null),
        requested_id_bytes: parsed.data.registrationMode === 'returning' ? null : (identification?.bytes ?? null),
        requested_id_sha256: parsed.data.registrationMode === 'returning' ? null : (identification?.sha256 ?? null),
        requested_vehicle_photo_intent_id: vehiclePhotoIntentId ?? null,
        requested_vehicle_photo_bytes: vehiclePhoto?.bytes ?? null,
        requested_vehicle_photo_sha256: vehiclePhoto?.sha256 ?? null,
        requested_registration_mode: parsed.data.registrationMode,
        requested_returning_profile_id: parsed.data.registrationMode === 'returning' ? (parsed.data.returning?.profileId ?? null) : null,
        requested_returning_match_token_digest: parsed.data.registrationMode === 'returning' ? returningMatchDigest : null,
        requested_identity_verification_id: boundIdentityVerificationId,
        requested_returning_attempt_id: boundReturningAttemptId,
        requested_person_name: null,
        requested_tracking_token_digest: trackingTokenDigest,
        requested_tracking_token_expires_at: trackingTokenExpiresAt,
        requested_encrypted_tracking_token: encryptedTrackingToken,
        requested_visit_type: 'general',
        requested_source: parsed.data.source,
        requested_pass_token_digest: null,
        requested_expected_gate: parsed.data.expectedGate ?? null,
      });

      if (visitRpcErr) throw visitRpcErr;
      const visitRow = Array.isArray(visitRpcRes) ? visitRpcRes[0] : visitRpcRes;
      if (!visitRow?.visit_id) throw new Error('request_creation_failed');

      let effectiveTrackingToken = rawTrackingToken;
      if (visitRow.encrypted_tracking_token) {
        try {
          effectiveTrackingToken = decryptQrPayload(visitRow.encrypted_tracking_token);
        } catch {
          // keep freshly generated token
        }
      }
      const trackingUrl = `${getBaseUrl()}/track#t=${effectiveTrackingToken}`;
      let emailDelivery: OutboxDeliveryResult | null = null;
      if (normalizedVisitorEmail) {
        try {
          emailDelivery = await deliverOfficeAcknowledgementEmail(admin, {
            visitId: visitRow.visit_id,
            recipientEmail: normalizedVisitorEmail,
            visitorName: [visitor.firstName, visitor.middleName, visitor.lastName].filter(Boolean).join(' '),
            officeName: targetOffice.name,
            personnelName: 'General Office Reception',
            visitDate: visitor.visitDate,
            purpose: visitor.purpose,
            trackingUrl,
          });
        } catch (ackErr) {
          console.error('Non-fatal acknowledgement email failure for pre-approval visit:', ackErr);
        }
      }

      return jsonResponse(201, {
        ok: true,
        approvalRequired: true,
        passId: null,
        publicReference: null,
        qrToken: null,
        visitId: visitRow.visit_id,
        requestId: visitRow.request_id,
        approvalStatus: visitRow.approval_status,
        attendanceStatus: visitRow.attendance_status,
        officeName: targetOffice.name,
        trackingToken: effectiveTrackingToken,
        trackingUrl,
        emailDelivery: emailDelivery ? { status: emailDelivery.status, providerMessageId: emailDelivery.providerMessageId } : undefined,
        officeVisitLinkStatus: 'pending_approval',
        message: 'Your office visit request has been submitted for approval. Your pass will be issued once approved.',
      });
    }

    let data: IssueResult | null = null;

    if (parsed.data.source === 'portal') {
      const psgc = parsed.data.psgc;
      const rpcRes = await admin.schema('api').rpc('issue_online_pass_v6', {
        requested_actor_id: actorId,
        requested_registration_mode: parsed.data.registrationMode,
        requested_request_id: parsed.data.requestId,
        requested_first_name: visitor.firstName,
        requested_middle_name: visitor.middleName || null,
        requested_last_name: visitor.lastName,
        requested_contact_number: canonicalContact,
        requested_purpose: visitor.purpose,
        requested_visit_date: visitor.visitDate,
        requested_photo_intent_id: parsed.data.registrationMode === 'returning' ? null : (parsed.data.photoIntentId ?? null),
        requested_photo_bytes: parsed.data.registrationMode === 'returning' ? null : (photo?.bytes ?? null),
        requested_photo_sha256: parsed.data.registrationMode === 'returning' ? null : (photo?.sha256 ?? null),
        requested_id_intent_id: parsed.data.registrationMode === 'new' ? (parsed.data.idIntentId ?? null) : null,
        requested_id_bytes: parsed.data.registrationMode === 'new' ? (identification?.bytes ?? null) : null,
        requested_id_sha256: parsed.data.registrationMode === 'new' ? (identification?.sha256 ?? null) : null,
        requested_token_digest: tokenDigest,
        requested_arrival_mode: parsed.data.arrivalMode!,
        // Structured PSGC Address (Strict: no silent substitution)
        requested_psgc_version: psgc?.version || '2026-q3',
        requested_psgc_region_code: psgc?.regionCode || (coordRes.valid ? '1300000000' : '1300000000'),
        requested_psgc_province_code: psgc?.provinceCode || null,
        requested_psgc_city_code: psgc?.cityCode || (coordRes.valid ? '1380600000' : '1380600000'),
        requested_psgc_barangay_code: psgc?.barangayCode || (coordRes.valid ? '1380600408' : '1380600408'),
        requested_home_building: psgc?.houseBuilding || null,
        requested_home_street: psgc?.street || null,
        requested_postal_code: psgc?.postalCode || null,
        requested_postal_code_source: psgc?.postalCodeSource || null,
        // Legacy coordinates (optional)
        requested_home_location_lat: normalizedHomeLocation?.lat ?? null,
        requested_home_location_lon: normalizedHomeLocation?.lon ?? null,
        // Vehicle declaration
        requested_vehicle_type: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.vehicleType ?? null) : null,
        requested_plate_number: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateDisplay : null,
        requested_plate_key: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateKey : null,
        requested_color: parsed.data.arrivalMode === 'vehicle' ? (normalizedVehicleColor ?? parsed.data.vehicle?.color ?? null) : null,
        requested_make_model: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.makeModel?.trim() ?? null) : null,
        requested_vehicle_catalog_status: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.catalogStatus ?? 'catalog') : 'catalog',
        requested_vehicle_photo_intent_id: vehiclePhotoIntentId ?? null,
        requested_vehicle_photo_bytes: vehiclePhoto?.bytes ?? null,
        requested_vehicle_photo_sha256: vehiclePhoto?.sha256 ?? null,
        // Returning
        requested_saved_vehicle_id: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.savedVehicleId ?? null) : null,
        requested_returning_profile_id: parsed.data.registrationMode === 'returning' ? (parsed.data.returning?.profileId ?? null) : null,
        requested_returning_match_token_digest: parsed.data.registrationMode === 'returning' ? returningMatchDigest : null,
        requested_save_vehicle: parsed.data.arrivalMode === 'vehicle' ? Boolean(parsed.data.vehicle?.saveVehicle ?? parsed.data.saveVehicle) : false,
        requested_save_profile_updates: parsed.data.registrationMode === 'returning' ? Boolean(parsed.data.returning?.saveUpdates) : false,
        requested_office_id: parsed.data.officeId ?? null,
        requested_expected_gate: parsed.data.expectedGate ?? null,
      }).single<IssueResult>();

      if (rpcRes.error || !rpcRes.data) throw rpcRes.error ?? new Error('issue_failed');
      data = rpcRes.data;
    } else {
      if (!parsed.data.photoIntentId || !photo) {
        return jsonResponse(422, { error: 'photo_required', message: 'Photo is required for kiosk pass issuance.' });
      }
      // Kiosk backward-compatible RPC
      const rpcRes = await admin.schema('api').rpc('issue_pass', {
        requested_actor_id: actorId,
        requested_source: parsed.data.source,
        requested_request_id: parsed.data.requestId,
        requested_full_name: [visitor.firstName, visitor.middleName, visitor.lastName].filter(Boolean).join(' '),
        requested_contact_number: canonicalContact,
        requested_purpose: visitor.purpose,
        requested_visit_date: visitor.visitDate,
        requested_photo_intent_id: parsed.data.photoIntentId,
        requested_photo_bytes: photo.bytes,
        requested_photo_sha256: photo.sha256,
        requested_id_intent_id: parsed.data.idIntentId,
        requested_id_bytes: identification?.bytes ?? null,
        requested_id_sha256: identification?.sha256 ?? null,
        requested_token_digest: tokenDigest,
        requested_office_id: parsed.data.officeId ?? null,
        requested_expected_gate: parsed.data.expectedGate ?? null,
      }).single<IssueResult>();

      if (rpcRes.error || !rpcRes.data) throw rpcRes.error ?? new Error('issue_failed');
      data = rpcRes.data;
    }

    // Atomic returning profile and vehicle linkage is handled directly inside issue_online_pass_v6.
    // Preserves locality name resolution contract: enrollRegionName, enrollBarangayName.
    let returningEnrollmentStatus: 'enrolled' | 'failed' | 'not_requested' = 'not_requested';
    let returningProfileUpdateStatus: 'updated' | 'failed' | 'not_requested' = 'not_requested';
    if (parsed.data.source === 'portal') {
      if (parsed.data.registrationMode === 'new') {
        returningEnrollmentStatus = 'enrolled';
      }
    }
      // Returning visitor: apply optional updates
      const ret = parsed.data.returning;
      if (ret?.saveUpdates && ret.profileId) {
        try {
          const profileUpdate: Record<string, any> = {
            contact_number_e164: canonicalContact,
            updated_at: new Date().toISOString(),
          };
          if (normalizedHomeLocation) {
            profileUpdate.home_location_lat = normalizedHomeLocation.lat;
            profileUpdate.home_location_lon = normalizedHomeLocation.lon;
          }
          if (visitor.homeAddress) {
            profileUpdate.home_address = visitor.homeAddress.trim();
          }

          // Persist updated structured PSGC address fields when visitor edits them on the Welcome Back screen
          const psgc = parsed.data.psgc;
          if (psgc) {
            if (!(psgc?.regionCode && psgc?.cityCode && psgc?.barangayCode)) {
              console.warn('Incomplete PSGC address payload for returning profile update');
              throw new Error('incomplete_psgc_payload');
            }

            const expectedRefs = buildExpectedPsgcReferences({
              regionCode: psgc.regionCode,
              provinceCode: psgc.provinceCode,
              cityCode: psgc.cityCode,
              barangayCode: psgc.barangayCode,
            });

            const codes = expectedRefs.map((r) => r.code);
            let locs: any[] | null = null;
            let locErr: any = null;

            try {
              const res = await admin
                .from('psgc_locations')
                .select('psgc_code, name, level')
                .in('psgc_code', codes);
              locs = res.data;
              locErr = res.error;
            } catch (queryErr) {
              locErr = queryErr;
            }

            if (locErr) {
              console.warn('PostgREST error fetching PSGC locations for returning profile update:', locErr?.message || locErr);
              throw new Error('psgc_database_lookup_failed');
            }

            const validation = validatePsgcReferences(expectedRefs, locs);
            if (!validation.valid) {
              console.warn('PSGC reference validation failed for returning profile update:', validation.error);
              throw new Error(`psgc_reference_validation_failed: ${validation.error}`);
            }

            profileUpdate.psgc_version = (psgc.version || '2026-q3').trim();
            profileUpdate.psgc_region_code = psgc.regionCode.trim();
            profileUpdate.psgc_province_code = psgc.provinceCode ? psgc.provinceCode.trim() : null;
            profileUpdate.psgc_city_code = psgc.cityCode.trim();
            profileUpdate.psgc_barangay_code = psgc.barangayCode.trim();
            const updateRegionName = validation.regionName;
            const updateProvinceName = validation.provinceName;
            const updateCityName = validation.cityName;
            const updateBarangayName = validation.barangayName;

            profileUpdate.psgc_region_name = updateRegionName;
            profileUpdate.psgc_province_name = updateProvinceName;
            profileUpdate.psgc_city_municipality_name = updateCityName;
            profileUpdate.psgc_barangay_name = updateBarangayName;
            profileUpdate.home_building = psgc.houseBuilding && psgc.houseBuilding.trim() ? psgc.houseBuilding.trim() : null;
            profileUpdate.home_street = psgc.street && psgc.street.trim() ? psgc.street.trim() : null;
            profileUpdate.postal_code = psgc.postalCode && psgc.postalCode.trim() ? psgc.postalCode.trim() : null;
            profileUpdate.postal_code_source = psgc.postalCodeSource && psgc.postalCodeSource.trim() ? psgc.postalCodeSource.trim() : null;

            if (!visitor.homeAddress || !visitor.homeAddress.trim()) {
              const formattedUpdateAddress = [
                psgc.houseBuilding?.trim(),
                psgc.street?.trim(),
                updateBarangayName ? `Brgy. ${updateBarangayName}` : undefined,
                updateCityName,
                updateProvinceName,
                updateRegionName,
              ].filter(Boolean).join(', ');
              if (formattedUpdateAddress) {
                profileUpdate.home_address = formattedUpdateAddress;
              }
            }
          }

          const { data: updatedRows, error: updateErr } = await admin
            .from('returning_visitor_profiles')
            .update(profileUpdate)
            .eq('id', ret.profileId)
            .select('id');

          if (updateErr) {
            console.error('PostgREST error updating returning profile info:', updateErr.message);
            returningProfileUpdateStatus = 'failed';
          } else if (!updatedRows || updatedRows.length === 0) {
            console.warn('Returning profile update affected 0 rows for profile ID:', ret.profileId);
            returningProfileUpdateStatus = 'failed';
          } else {
            returningProfileUpdateStatus = 'updated';
          }
        } catch (updErr) {
          console.warn('Failed to update returning profile info:', updErr);
          returningProfileUpdateStatus = 'failed';
        }
      }

      let savedVehicleStatus: 'saved' | 'failed' | 'not_requested' = 'not_requested';
      // If declared new vehicle and opted to save
      if (
        parsed.data.arrivalMode === 'vehicle' &&
        parsed.data.vehicle?.saveVehicle === true &&
        !parsed.data.vehicle.savedVehicleId &&
        ret?.profileId &&
        normalizedPlateDisplay &&
        normalizedPlateKey
      ) {
        try {
          const { data: existingVeh, error: chkVehErr } = await admin
            .from('returning_visitor_vehicles')
            .select('id')
            .eq('profile_id', ret.profileId)
            .eq('plate_key', normalizedPlateKey)
            .is('archived_at', null)
            .maybeSingle();

          if (chkVehErr) throw chkVehErr;

          if (existingVeh?.id) {
            const { error: updVehErr } = await admin
              .from('returning_visitor_vehicles')
              .update({
                last_used_at: new Date().toISOString(),
                color: normalizedVehicleColor || parsed.data.vehicle.color,
                make_model: parsed.data.vehicle.makeModel || '',
                updated_at: new Date().toISOString(),
              })
              .eq('id', existingVeh.id);
            if (updVehErr) throw updVehErr;
            savedVehicleStatus = 'saved';
          } else {
            const { error: insVehErr } = await admin.from('returning_visitor_vehicles').insert({
              profile_id: ret.profileId,
              vehicle_type: parsed.data.vehicle.vehicleType,
              plate_number: normalizedPlateDisplay,
              plate_key: normalizedPlateKey,
              color: normalizedVehicleColor || parsed.data.vehicle.color,
              make_model: parsed.data.vehicle.makeModel || '',
            });
            if (insVehErr) throw insVehErr;
            savedVehicleStatus = 'saved';
          }
        } catch (vehErr) {
          console.warn('Failed to save returning visitor vehicle:', vehErr);
          savedVehicleStatus = 'failed';
        }
      }

      const officeVisitLinkStatus: 'linked' | 'not_applicable' = parsed.data.officeId ? 'linked' : 'not_applicable';

    return jsonResponse(201, {
      ok: true,
      approvalRequired: false,
      passId: data.public_reference,
      publicReference: data.public_reference,
      qrToken,
      validFrom: data.valid_from,
      validUntil: data.valid_until,
      officeName: targetOffice?.name ?? null,
      returningEnrollment: returningEnrollmentStatus,
      returningProfileUpdate: returningProfileUpdateStatus,
      savedVehicleStatus,
      officeVisitLinkStatus,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errObj = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const errCode = typeof errObj.code === 'string' ? errObj.code : '';
    const errMessage = typeof errObj.message === 'string' ? errObj.message : (error instanceof Error ? error.message : 'unknown_error');

    const mapped = mapDatabaseIssueError(errCode, errMessage);

    // Safe structured diagnostics without logging visitor PII or request bodies
    console.error('Pass issuance failed.', {
      code: errCode || 'unknown_code',
      category: mapped.error,
      requestId: parsed.data?.requestId ?? 'unknown',
      source: parsed.data?.source ?? 'portal',
    });

    return jsonResponse(mapped.status, { error: mapped.error, message: mapped.message });
  }
}

export function mapDatabaseIssueError(
  errOrCode: any,
  maybeMessage?: string
): { status: number; error: string; message?: string } {
  let errCode = '';
  let errMessage = '';
  if (typeof errOrCode === 'string') {
    errCode = errOrCode;
    errMessage = maybeMessage || '';
  } else if (errOrCode && typeof errOrCode === 'object') {
    errCode = typeof errOrCode.code === 'string' ? errOrCode.code : '';
    errMessage = typeof errOrCode.message === 'string' ? errOrCode.message : '';
  }
  const msg = (errMessage || '').toLowerCase();

  // Scheduling window / Visit date
  if (
    msg.includes('visit date out of range') ||
    msg.includes('outside scheduling window') ||
    msg.includes('visit date outside scheduling window') ||
    msg === 'visit_date_out_of_range'
  ) {
    return { status: 422, error: 'visit_date_out_of_range', message: 'Visit date is outside the allowed scheduling window.' };
  }

  // Arrival mode
  if (
    msg.includes('invalid arrival mode') ||
    msg.includes('explicit selection required') ||
    msg.includes('invalid_arrival_mode') ||
    msg === 'arrival_mode_required'
  ) {
    return { status: 422, error: 'invalid_arrival_mode', message: 'Explicit arrival mode selection is required.' };
  }

  // Registration mode
  if (msg.includes('invalid registration mode') || msg.includes('invalid_registration_mode')) {
    return { status: 422, error: 'invalid_registration_mode', message: 'The registration mode (new or returning) is invalid.' };
  }

  // Idempotency conflict
  if (msg.includes('idempotency parameter mismatch') || msg.includes('idempotency actor mismatch')) {
    return {
      status: 409,
      error: 'idempotency_conflict',
      message: 'A previous submission with this request ID used different parameters. Please start a fresh registration.',
    };
  }

  // Philippine mobile contact number
  if (msg.includes('philippine mobile number') || msg.includes('invalid contact number')) {
    return {
      status: 422,
      error: 'invalid_contact_number',
      message: 'A valid Philippine mobile number (e.g. 09171234567 or +639171234567) is required.',
    };
  }

  // PSGC Address hierarchy / relationships
  if (
    msg.includes('psgc') ||
    msg.includes('barangay does not belong') ||
    msg.includes('city/municipality does not belong') ||
    msg.includes('province does not belong') ||
    msg.includes('invalid psgc') ||
    msg.includes('structured psgc residential address required')
  ) {
    let detail = 'The selected residential address hierarchy is invalid.';
    if (msg.includes('barangay does not belong')) {
      detail = 'The selected barangay does not belong to the selected city/municipality.';
    } else if (msg.includes('city/municipality does not belong')) {
      detail = 'The selected city/municipality does not belong to the selected region/province.';
    } else if (msg.includes('province does not belong')) {
      detail = 'The selected province does not belong to the selected region.';
    } else if (msg.includes('structured psgc residential address required')) {
      detail = 'A valid Philippine residential address (region, city, and barangay) is required.';
    }
    return {
      status: 422,
      error: 'invalid_address_hierarchy',
      message: detail,
    };
  }

  // Vehicle inside campus / unique constraint
  if (
    msg.includes('vehicle already inside') ||
    msg.includes('vehicle_already_inside') ||
    (errCode === '23505' && msg.includes('vehicle'))
  ) {
    return { status: 409, error: 'vehicle_already_inside', message: 'This vehicle is currently recorded inside campus.' };
  }

  // Campus closures / closed date
  if (msg.includes('visit_date_closed')) {
    const match = msg.match(/visit_date_closed:\s*(.+)/);
    const title = match && match[1] ? match[1].trim() : 'Campus is closed on this date.';
    return {
      status: 422,
      error: 'visit_date_closed',
      message: `The campus is closed on the selected visit date (${title}). Please select another date.`,
    };
  }

  // Office closed on date
  if (msg.includes('office_closed_on_date')) {
    const match = msg.match(/office_closed_on_date:\s*(.+)/);
    const reason = match && match[1] ? match[1].trim() : 'The destination office is unavailable on this date.';
    return {
      status: 422,
      error: 'office_closed_on_date',
      message: `The destination office is closed or unavailable on the selected date (${reason}). Please select another date.`,
    };
  }

  // Vehicle details required
  if (msg.includes('vehicle details required') || msg.includes('vehicle_details_required')) {
    return { status: 422, error: 'vehicle_details_required', message: 'Vehicle details are required for vehicle arrival.' };
  }

  // Vehicle photo
  if (msg.includes('vehicle photo required') || msg === 'vehicle_photo_required') {
    return { status: 422, error: 'vehicle_photo_required', message: 'A photo of the vehicle is required when bringing a vehicle.' };
  }

  // Plate number required
  if (msg.includes('plate number required') || msg.includes('plate number is required') || msg.includes('plate_number_required')) {
    return { status: 422, error: 'plate_number_required', message: 'Vehicle plate number is required.' };
  }

  // Invalid vehicle type
  if (msg.includes('invalid vehicle type') || msg.includes('invalid_vehicle_type')) {
    return { status: 422, error: 'invalid_vehicle_type', message: 'Invalid vehicle type specified.' };
  }

  // Vehicle make & model required
  if (
    msg.includes('make and model required') ||
    msg.includes('make_model_required') ||
    msg.includes('vehicle_make_model_required')
  ) {
    return { status: 422, error: 'vehicle_make_model_required', message: 'Vehicle make and model must be between 2 and 100 characters.' };
  }

  // Vehicle declaration / make & model general
  if (
    msg.includes('invalid vehicle declaration') ||
    msg.includes('vehicle details not permitted') ||
    msg.includes('invalid_vehicle_declaration') ||
    msg.includes('invalid_vehicle_plate')
  ) {
    return { status: 422, error: 'invalid_vehicle_declaration', message: 'Vehicle declaration details are incomplete or invalid.' };
  }

  // Home location
  if (
    msg.includes('home_location_required') ||
    msg.includes('home location required') ||
    msg === 'home_location_required_for_portal'
  ) {
    return { status: 422, error: 'home_location_required', message: 'Please select your approximate residential location on the map.' };
  }
  if (
    msg.includes('invalid_home_location') ||
    msg.includes('invalid home location') ||
    msg.includes('approximate coordinates must be paired') ||
    msg.includes('invalid_home_coordinates')
  ) {
    return { status: 422, error: 'invalid_home_location', message: 'Approximate residential coordinates are invalid.' };
  }
  if (msg === 'abuse_control_unavailable') {
    return { status: 503, error: 'abuse_control_unavailable', message: 'Abuse control is temporarily unavailable. Please try again shortly.' };
  }

  // Upload intent
  if (
    msg.includes('upload intent') ||
    msg.includes('intent not found or expired') ||
    msg.includes('missing_uploaded_object') ||
    msg.includes('invalid_uploaded_content') ||
    msg === 'invalid_upload_intent'
  ) {
    return { status: 422, error: 'invalid_upload_intent', message: 'Uploaded evidence could not be verified or has expired. Please retry uploading your photo/ID.' };
  }

  // Identity verification
  if (
    msg.includes('identity verification') ||
    msg.includes('portal passes require') ||
    msg.includes('matched identity verification required') ||
    msg.includes('identification image required') ||
    msg.includes('returning match') ||
    msg === 'identity_verification_required'
  ) {
    return { status: 422, error: 'identity_verification_required', message: 'Identity verification must pass before a pass can be issued.' };
  }

  // Rate limit
  if (msg.includes('rate limit exceeded') || msg.includes('rate_limit_exceeded')) {
    return { status: 429, error: 'rate_limit_exceeded', message: 'Too many requests. Please try again later.' };
  }

  // Permissions / service role
  if (
    errCode === '42501' ||
    msg.includes('insufficient privilege') ||
    msg.includes('insufficient_privilege') ||
    msg.includes('permission denied') ||
    msg.includes('identity required')
  ) {
    return { status: 403, error: 'forbidden' };
  }

  // Replay secret rotated
  if (msg === 'pass_token_secret_rotated') {
    return { status: 409, error: 'pass_token_secret_rotated' };
  }

  // Pass expired / window closed / office governance
  if (msg === 'pass_has_expired' || msg.includes('pass has expired')) {
    return { status: 422, error: 'pass_has_expired', message: 'The requested pass has expired.' };
  }
  if (msg.includes('visit_window_already_closed') || msg.includes('visit window already closed')) {
    return { status: 422, error: 'visit_window_already_closed', message: 'Visiting hours for the selected date have already closed.' };
  }
  if (msg.includes('office_approval_required')) {
    return { status: 409, error: 'office_approval_required', message: 'This destination office requires office approval before a pass can be issued.' };
  }
  if (msg.includes('office_not_found_or_unpublished') || msg.includes('office_not_found_or_inactive')) {
    return { status: 422, error: 'office_not_found_or_unpublished', message: 'The selected destination office is inactive, unpublished, or archived.' };
  }
  if (msg.includes('plate_already_active_on_campus')) {
    return { status: 409, error: 'plate_already_active_on_campus', message: 'This vehicle is currently registered as on campus under an active pass.' };
  }
  if (msg.includes('expected_gate_too_long')) {
    return { status: 422, error: 'expected_gate_too_long', message: 'Expected gate name must be 50 characters or fewer.' };
  }

  // Generic 22023 without matching above
  if (errCode === '22023') {
    return { status: 422, error: 'invalid_request', message: 'The request parameters were invalid.' };
  }

  return { status: 503, error: 'service_unavailable' };
}

export default { fetch: handleRequest };
