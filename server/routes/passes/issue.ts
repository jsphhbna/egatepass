import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { normalizePhMobile } from '../../../src/lib/phPhone.js';
import { normalizeVehiclePlate } from '../../../src/lib/vehiclePlate.js';
import {
  encryptFaceTemplate,
  extractFaceDescriptorFromBuffer,
} from '../../lib/face-engine.js';
import { computeMatchTokenDigest } from './identify-returning.js';
import { verifyPlaceDetails, type VerifiedAddressDetails } from '../../lib/geoapify.js';

const namePart = z.string().trim().min(1).max(50);
const requestSchema = z.object({
  requestId: z.string().uuid(),
  source: z.enum(['portal', 'kiosk']),
  registrationMode: z.enum(['new', 'returning']).default('new'),
  visitor: z.object({
    firstName: namePart,
    middleName: z.string().trim().max(50).optional(),
    lastName: namePart,
    contactNumber: z.string().min(7).max(32),
    homeAddress: z.string().trim().min(5).max(300).optional(),
    purpose: z.string().trim().min(3).max(300),
    visitDate: z.iso.date(),
  }),
  arrivalMode: z.enum(['no_vehicle', 'vehicle']).optional(),
  addressProvenance: z.object({
    provider: z.literal('geoapify'),
    placeId: z.string().min(1).max(200),
    resultType: z.string().min(1).max(100).optional(),
    confidence: z.number().nullable().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    postcode: z.string().nullable().optional(),
    countryCode: z.string().max(10).optional(),
    addressDetail: z.string().max(200).optional(),
  }).optional(),
  vehicle: z.object({
    vehicleType: z.enum(['car', 'motorcycle', 'van', 'pickup', 'suv', 'truck', 'bicycle', 'other']).optional(),
    plateNumber: z.string().trim().min(3).max(16).optional(),
    color: z.string().trim().min(2).max(40).optional(),
    makeModel: z.string().trim().max(100).optional(),
    catalogStatus: z.enum(['catalog', 'manual']).optional(),
    photoIntentId: z.string().uuid().optional(),
    savedVehicleId: z.string().uuid().optional(),
    saveVehicle: z.boolean().optional(),
  }).optional(),
  vehiclePhotoIntentId: z.string().uuid().optional(),
  returning: z.object({
    profileId: z.string().uuid().optional(),
    matchToken: z.string().optional(),
    saveUpdates: z.boolean().optional(),
  }).optional(),
  enrollReturning: z.boolean().optional(),
  photoIntentId: z.string().uuid(),
  idIntentId: z.string().uuid().nullable().optional(),
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
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

  if (!dedicatedSecret || dedicatedSecret.length < 32) {
    if (isProd) {
      throw new HttpError(503, 'abuse_control_unavailable');
    }
    return createHmac('sha256', 'test-rate-limit-secret-32-chars-minimum!').update(`network:${rawIp}`).digest('hex');
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
    }

    // Phone normalization (Section 19: PH mobile contract)
    let canonicalContact = parsed.data.visitor.contactNumber.trim();
    if (parsed.data.source === 'portal') {
      const canonical = normalizePhMobile(canonicalContact);
      if (canonical) {
        canonicalContact = canonical;
      }
    }

    // Vehicle normalization (Section 23: Plate normalization & Photo requirement)
    let normalizedPlateDisplay: string | null = null;
    let normalizedPlateKey: string | null = null;
    let vehiclePhotoIntentId: string | null = null;
    if (parsed.data.arrivalMode === 'vehicle') {
      const v = parsed.data.vehicle;
      if (!v?.vehicleType || !v?.plateNumber || !v?.color) {
        return jsonResponse(422, {
          error: 'invalid_vehicle_declaration',
          message: 'Vehicle type, plate number, and color are required when bringing a vehicle.',
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

    // Safe idempotent replay check BEFORE external network calls (Geoapify) and before rate limiting
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
        .select('id, owner_id, source, full_name, contact_number, purpose, visit_date, home_address, registration_mode, arrival_mode, returning_profile_id, address_place_id')
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

      const expectedFullName = [parsed.data.visitor.firstName, parsed.data.visitor.middleName, parsed.data.visitor.lastName].filter(Boolean).join(' ');
      if (
        existingVisitor.full_name !== expectedFullName ||
        (existingVisitor.contact_number !== canonicalContact && existingVisitor.contact_number !== parsed.data.visitor.contactNumber.trim()) ||
        existingVisitor.purpose !== parsed.data.visitor.purpose.trim() ||
        existingVisitor.visit_date !== parsed.data.visitor.visitDate
      ) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      if (existingVisitor.arrival_mode && existingVisitor.arrival_mode !== parsed.data.arrivalMode) {
        return jsonResponse(409, { error: 'payload_mismatch' });
      }

      if (parsed.data.source === 'portal' && parsed.data.addressProvenance?.placeId && existingVisitor.address_place_id) {
        if (existingVisitor.address_place_id !== parsed.data.addressProvenance.placeId) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
      }

      if (parsed.data.arrivalMode === 'vehicle' && normalizedPlateKey) {
        const { data: existingDecl } = await admin
          .from('visit_vehicle_declarations')
          .select('plate_key, vehicle_type')
          .eq('pass_id', existingPass.id)
          .maybeSingle();
        if (existingDecl && (existingDecl.plate_key !== normalizedPlateKey || existingDecl.vehicle_type !== parsed.data.vehicle?.vehicleType)) {
          return jsonResponse(409, { error: 'payload_mismatch' });
        }
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

      // Return existing pass with 200 OK (idempotent replay without external Geoapify call)
      return jsonResponse(200, {
        passId: existingPass.public_reference,
        publicReference: existingPass.public_reference,
        qrToken,
        validFrom: existingPass.valid_from,
        validUntil: existingPass.valid_until,
      });
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
        return jsonResponse(429, {
          error: 'rate_limit_exceeded',
          message: 'Too many pass issuance requests for this session. Please wait before requesting another pass.',
        });
      }

      const networkKeyHex = getClientNetworkIdentifier(request);
      const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
        requested_key_hex: networkKeyHex,
        requested_action: 'portal.network_issue',
        requested_max_requests: 10,
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
        return jsonResponse(429, {
          error: 'rate_limit_exceeded',
          message: 'Too many pass issuance requests from this network. Please wait before requesting another pass.',
        });
      }
    }

    // Home address & provenance check for portal (only for new issuances)
    let verifiedAddress: VerifiedAddressDetails | null = null;
    if (parsed.data.source === 'portal') {
      if (parsed.data.addressProvenance?.placeId) {
        try {
          verifiedAddress = await verifyPlaceDetails(
            parsed.data.addressProvenance.placeId,
            parsed.data.addressProvenance.addressDetail
          );
        } catch (addrErr) {
          const msg = addrErr instanceof Error ? addrErr.message : 'address_verification_failed';
          if (msg === 'address_too_broad') {
            return jsonResponse(422, {
              error: 'address_insufficient_specificity',
              message: 'Please select a more specific address including your street, barangay, or building.',
            });
          }
          if (msg === 'address_must_be_philippines' || msg === 'address_coordinates_out_of_bounds') {
            return jsonResponse(422, {
              error: msg,
              message: 'Address must be within the Philippines.',
            });
          }
          if (msg === 'address_rate_limited') {
            return jsonResponse(429, {
              error: 'rate_limit_exceeded',
              message: 'Address verification rate limit reached. Please wait a moment.',
            });
          }
          if (msg === 'address_verification_unavailable') {
            return jsonResponse(503, {
              error: 'address_verification_unavailable',
              message: 'Address verification is temporarily unavailable. Please try again shortly.',
            });
          }
          return jsonResponse(422, {
            error: 'address_verification_failed',
            message: 'The selected address could not be verified. Please search and select your address again.',
          });
        }
      } else {
        return jsonResponse(422, {
          error: 'address_verification_required',
          message: 'Address must be selected from verified suggestions.',
        });
      }
    }

    // Mode-specific verification checks
    let returningMatchDigest: string | null = null;
    if (parsed.data.source === 'portal') {
      if (parsed.data.registrationMode === 'new') {
        if (!parsed.data.idIntentId) {
          return jsonResponse(422, { error: 'identity_verification_required', message: 'Valid ID is required for new visitor registration.' });
        }

        const { data: attempt, error: attemptError } = await admin
          .from('portal_identity_verification_attempts')
          .select('owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at')
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
      } else if (parsed.data.registrationMode === 'returning') {
        const ret = parsed.data.returning;
        if (!ret?.profileId || !ret?.matchToken) {
          return jsonResponse(422, {
            error: 'returning_credentials_required',
            message: 'Returning visitor identification must be completed before pass issuance.',
          });
        }

        const matchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET || '';
        returningMatchDigest = computeMatchTokenDigest(ret.matchToken, matchSecret);

        const { data: retAttempt, error: retAttemptErr } = await admin
          .from('returning_identity_attempts')
          .select('id, outcome, expires_at')
          .eq('request_id', parsed.data.requestId)
          .eq('owner_id', actorId)
          .eq('matched_profile_id', ret.profileId)
          .eq('match_token_digest', returningMatchDigest)
          .eq('outcome', 'matched')
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (retAttemptErr) throw retAttemptErr;
        if (!retAttempt) {
          return jsonResponse(422, {
            error: 'returning_match_required',
            message: 'Valid returning visitor identification required. Please identify yourself first.',
          });
        }
      }
    }

    // Need photo buffer if new visitor opted in to returning enrollment
    const needsPhotoBuffer = parsed.data.source === 'portal' && parsed.data.registrationMode === 'new' && parsed.data.enrollReturning === true;
    const photo = await inspectUpload(admin, parsed.data.photoIntentId, actorId, parsed.data.source, 'photo', needsPhotoBuffer);
    const identification = parsed.data.idIntentId
      ? await inspectUpload(admin, parsed.data.idIntentId, actorId, parsed.data.source, 'id')
      : null;
    const vehiclePhoto = (parsed.data.arrivalMode === 'vehicle' && vehiclePhotoIntentId)
      ? await inspectUpload(admin, vehiclePhotoIntentId, actorId, parsed.data.source, 'vehicle_photo')
      : null;

    const visitor = parsed.data.visitor;
    let data: IssueResult | null = null;

    if (parsed.data.source === 'portal') {
      if (verifiedAddress) {
        // Use online v3 RPC with verified address provenance and vehicle evidence
        const rpcRes = await admin.schema('api').rpc('issue_online_pass_v3', {
          requested_actor_id: actorId,
          requested_registration_mode: parsed.data.registrationMode,
          requested_request_id: parsed.data.requestId,
          requested_first_name: visitor.firstName,
          requested_middle_name: visitor.middleName || null,
          requested_last_name: visitor.lastName,
          requested_contact_number: canonicalContact,
          requested_home_address: verifiedAddress.formatted,
          requested_purpose: visitor.purpose,
          requested_visit_date: visitor.visitDate,
          requested_photo_intent_id: parsed.data.photoIntentId,
          requested_photo_bytes: photo.bytes,
          requested_photo_sha256: photo.sha256,
          requested_id_intent_id: parsed.data.registrationMode === 'new' ? (parsed.data.idIntentId ?? null) : null,
          requested_id_bytes: parsed.data.registrationMode === 'new' ? (identification?.bytes ?? null) : null,
          requested_id_sha256: parsed.data.registrationMode === 'new' ? (identification?.sha256 ?? null) : null,
          requested_token_digest: tokenDigest,
          requested_arrival_mode: parsed.data.arrivalMode!,
          // Address provenance
          requested_address_provider: 'geoapify',
          requested_address_place_id: verifiedAddress.placeId,
          requested_address_result_type: verifiedAddress.resultType,
          requested_address_confidence: verifiedAddress.confidence,
          requested_address_lat: verifiedAddress.lat,
          requested_address_lon: verifiedAddress.lon,
          requested_address_city: verifiedAddress.city,
          requested_address_state: verifiedAddress.state,
          requested_address_postcode: verifiedAddress.postcode,
          requested_address_country_code: 'ph',
          requested_address_detail: verifiedAddress.addressDetail || null,
          // Vehicle declaration
          requested_vehicle_type: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.vehicleType ?? null) : null,
          requested_plate_number: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateDisplay : null,
          requested_plate_key: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateKey : null,
          requested_color: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.color ?? null) : null,
          requested_make_model: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.makeModel?.trim() ?? null) : null,
          requested_vehicle_catalog_status: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.catalogStatus ?? 'catalog') : 'catalog',
          requested_vehicle_photo_intent_id: vehiclePhotoIntentId ?? null,
          requested_vehicle_photo_bytes: vehiclePhoto?.bytes ?? null,
          requested_vehicle_photo_sha256: vehiclePhoto?.sha256 ?? null,
          // Returning
          requested_saved_vehicle_id: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.savedVehicleId ?? null) : null,
          requested_returning_profile_id: parsed.data.registrationMode === 'returning' ? (parsed.data.returning?.profileId ?? null) : null,
          requested_returning_match_token_digest: parsed.data.registrationMode === 'returning' ? returningMatchDigest : null,
        }).single<IssueResult>();

        if (rpcRes.error || !rpcRes.data) throw rpcRes.error ?? new Error('issue_failed');
        data = rpcRes.data;
      } else {
        // Fallback to online v2 RPC for tests without address provenance
        const rpcRes = await admin.schema('api').rpc('issue_online_pass_v2', {
          requested_actor_id: actorId,
          requested_registration_mode: parsed.data.registrationMode,
          requested_request_id: parsed.data.requestId,
          requested_first_name: visitor.firstName,
          requested_middle_name: visitor.middleName || null,
          requested_last_name: visitor.lastName,
          requested_contact_number: canonicalContact,
          requested_home_address: visitor.homeAddress?.trim() || '',
          requested_purpose: visitor.purpose,
          requested_visit_date: visitor.visitDate,
          requested_photo_intent_id: parsed.data.photoIntentId,
          requested_photo_bytes: photo.bytes,
          requested_photo_sha256: photo.sha256,
          requested_id_intent_id: parsed.data.registrationMode === 'new' ? (parsed.data.idIntentId ?? null) : null,
          requested_id_bytes: parsed.data.registrationMode === 'new' ? (identification?.bytes ?? null) : null,
          requested_id_sha256: parsed.data.registrationMode === 'new' ? (identification?.sha256 ?? null) : null,
          requested_token_digest: tokenDigest,
          requested_arrival_mode: parsed.data.arrivalMode || 'no_vehicle',
          requested_vehicle_type: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.vehicleType ?? null) : null,
          requested_plate_number: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateDisplay : null,
          requested_plate_key: parsed.data.arrivalMode === 'vehicle' ? normalizedPlateKey : null,
          requested_color: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.color ?? null) : null,
          requested_make_model: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.makeModel ?? null) : null,
          requested_saved_vehicle_id: parsed.data.arrivalMode === 'vehicle' ? (parsed.data.vehicle?.savedVehicleId ?? null) : null,
          requested_returning_profile_id: parsed.data.registrationMode === 'returning' ? (parsed.data.returning?.profileId ?? null) : null,
          requested_returning_match_token_digest: parsed.data.registrationMode === 'returning' ? returningMatchDigest : null,
        }).single<IssueResult>();

        if (rpcRes.error || !rpcRes.data) throw rpcRes.error ?? new Error('issue_failed');
        data = rpcRes.data;
      }
    } else {
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
      }).single<IssueResult>();

      if (rpcRes.error || !rpcRes.data) throw rpcRes.error ?? new Error('issue_failed');
      data = rpcRes.data;
    }

    // Post-issuance Returning Visitor conveniences (Section 51: Failure must NOT destroy pass issuance)
    let returningEnrollmentStatus: 'enrolled' | 'failed' | 'not_requested' = 'not_requested';
    if (parsed.data.source === 'portal' && parsed.data.registrationMode === 'new' && parsed.data.enrollReturning === true) {
      try {
        const templateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY?.trim();
        if (templateKey && photo.buffer) {
          const { descriptor, modelName, modelVersion } = await extractFaceDescriptorFromBuffer(photo.buffer);
          const encrypted = encryptFaceTemplate(descriptor, templateKey);

          // Insert returning profile with canonical verified address provenance (Section 18)
          const { data: newProfile, error: profileErr } = await admin
            .from('returning_visitor_profiles')
            .insert({
              first_name: visitor.firstName,
              middle_name: visitor.middleName || null,
              last_name: visitor.lastName,
              contact_number_e164: canonicalContact,
              home_address: verifiedAddress ? verifiedAddress.formatted : (visitor.homeAddress?.trim() || ''),
              consent_version: 'v1',
              address_provider: verifiedAddress ? 'geoapify' : null,
              address_place_id: verifiedAddress ? verifiedAddress.placeId : null,
              address_result_type: verifiedAddress ? verifiedAddress.resultType : null,
              address_confidence: verifiedAddress ? verifiedAddress.confidence : null,
              address_lat: verifiedAddress ? verifiedAddress.lat : null,
              address_lon: verifiedAddress ? verifiedAddress.lon : null,
              address_city: verifiedAddress ? verifiedAddress.city : null,
              address_state: verifiedAddress ? verifiedAddress.state : null,
              address_postcode: verifiedAddress ? verifiedAddress.postcode : null,
              address_country_code: verifiedAddress ? verifiedAddress.countryCode : null,
              address_verified_at: verifiedAddress ? new Date().toISOString() : null,
              address_detail: verifiedAddress ? (verifiedAddress.addressDetail || null) : null,
            })
            .select('id')
            .single();

          if (profileErr) throw profileErr;

          // Insert encrypted template
          const { error: templateErr } = await admin
            .from('returning_face_templates')
            .insert({
              profile_id: newProfile.id,
              encrypted_embedding: encrypted.encryptedEmbedding,
              iv: encrypted.iv,
              auth_tag: encrypted.authTag,
              key_version: encrypted.keyVersion,
              model_name: modelName,
              model_version: modelVersion,
            });

          if (templateErr) throw templateErr;

          // If vehicle chosen and user opted to save vehicle
          if (parsed.data.arrivalMode === 'vehicle' && parsed.data.vehicle?.saveVehicle === true && normalizedPlateDisplay && normalizedPlateKey) {
            await admin.from('returning_visitor_vehicles').insert({
              profile_id: newProfile.id,
              vehicle_type: parsed.data.vehicle.vehicleType,
              plate_number: normalizedPlateDisplay,
              plate_key: normalizedPlateKey,
              color: parsed.data.vehicle.color,
              make_model: parsed.data.vehicle.makeModel || '',
            });
          }

          returningEnrollmentStatus = 'enrolled';
        }
      } catch (enrollErr) {
        console.error('Returning visitor enrollment failed after pass issuance (pass preserved):', enrollErr);
        returningEnrollmentStatus = 'failed';
      }
    } else if (parsed.data.source === 'portal' && parsed.data.registrationMode === 'returning') {
      // Returning visitor: apply optional updates
      const ret = parsed.data.returning;
      if (ret?.saveUpdates && ret.profileId) {
        try {
          const profileUpdate: Record<string, any> = {
            contact_number_e164: canonicalContact,
            updated_at: new Date().toISOString(),
          };
          if (verifiedAddress) {
            profileUpdate.home_address = verifiedAddress.formatted;
            profileUpdate.address_provider = 'geoapify';
            profileUpdate.address_place_id = verifiedAddress.placeId;
            profileUpdate.address_result_type = verifiedAddress.resultType;
            profileUpdate.address_confidence = verifiedAddress.confidence;
            profileUpdate.address_lat = verifiedAddress.lat;
            profileUpdate.address_lon = verifiedAddress.lon;
            profileUpdate.address_city = verifiedAddress.city;
            profileUpdate.address_state = verifiedAddress.state;
            profileUpdate.address_postcode = verifiedAddress.postcode;
            profileUpdate.address_country_code = verifiedAddress.countryCode;
            profileUpdate.address_verified_at = new Date().toISOString();
            profileUpdate.address_detail = verifiedAddress.addressDetail || null;
          }
          await admin
            .from('returning_visitor_profiles')
            .update(profileUpdate)
            .eq('id', ret.profileId);
        } catch (updErr) {
          console.warn('Failed to update returning profile info:', updErr);
        }
      }

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
          await admin.from('returning_visitor_vehicles').insert({
            profile_id: ret.profileId,
            vehicle_type: parsed.data.vehicle.vehicleType,
            plate_number: normalizedPlateDisplay,
            plate_key: normalizedPlateKey,
            color: parsed.data.vehicle.color,
            make_model: parsed.data.vehicle.makeModel || '',
          });
        } catch (vehErr) {
          console.warn('Failed to save returning visitor vehicle:', vehErr);
        }
      }
    }

    return jsonResponse(201, {
      passId: data.public_reference,
      publicReference: data.public_reference,
      qrToken,
      validFrom: data.valid_from,
      validUntil: data.valid_until,
      returningEnrollment: returningEnrollmentStatus,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    const errObj = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const errCode = typeof errObj.code === 'string' ? errObj.code : '';
    const errMessage = typeof errObj.message === 'string' ? errObj.message : (error instanceof Error ? error.message : 'unknown_error');
    console.error('Pass issuance failed.', errCode || errMessage);

    const mapped = mapDatabaseIssueError(errCode, errMessage);
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

  // Vehicle inside campus / unique constraint
  if (
    msg.includes('vehicle already inside') ||
    msg.includes('vehicle_already_inside') ||
    (errCode === '23505' && msg.includes('vehicle'))
  ) {
    return { status: 409, error: 'vehicle_already_inside', message: 'This vehicle is currently recorded inside campus.' };
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

  // Address verification
  if (
    msg.includes('verified address provenance required') ||
    msg.includes('address_verification_required') ||
    msg === 'address_verification_required'
  ) {
    return { status: 422, error: 'address_verification_required', message: 'Address must be selected from verified suggestions.' };
  }
  if (msg === 'address_insufficient_specificity' || msg.includes('address_too_broad')) {
    return { status: 422, error: 'address_insufficient_specificity', message: 'Please select a more specific address including your street, barangay, or building.' };
  }
  if (msg === 'address_verification_unavailable') {
    return { status: 503, error: 'address_verification_unavailable', message: 'Address verification is temporarily unavailable. Please try again shortly.' };
  }
  if (msg === 'abuse_control_unavailable') {
    return { status: 503, error: 'abuse_control_unavailable', message: 'Abuse control is temporarily unavailable. Please try again shortly.' };
  }

  // Upload intent
  if (
    msg.includes('upload intent') ||
    msg.includes('missing_uploaded_object') ||
    msg.includes('invalid_uploaded_content') ||
    msg === 'invalid_upload_intent'
  ) {
    return { status: 422, error: 'invalid_upload_intent', message: 'Uploaded evidence could not be verified. Please retry uploading.' };
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

  // Pass expired
  if (msg === 'pass_has_expired' || msg.includes('pass has expired')) {
    return { status: 422, error: 'pass_has_expired', message: 'The requested pass has expired.' };
  }

  // Generic 22023 without matching above
  if (errCode === '22023') {
    return { status: 422, error: 'invalid_request', message: 'The request parameters were invalid.' };
  }

  return { status: 503, error: 'service_unavailable' };
}

export default { fetch: handleRequest };
