import type { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { adminAuth } from './firebase-admin';
import { recordReconciliationTask } from './utils/reconciliation';
import { parseVisitWindow } from './utils/working-hours';
import { uploadSessionIdFromPublicId } from './utils/image-security';
import {
  calculateImageExpiry,
  isVisitDateWithinPolicy,
  normalizeImageDeliveryType,
} from './utils/image-lifecycle';
import { clientAddressFromHeaders, enforceRateLimit, RateLimitError } from './utils/rate-limit';

const namePattern = /^[\p{L}\s\-'.]+$/u;
const documentId = z.string().min(1).max(128).refine((value) => !value.includes('/'));
const publicId = (folder: 'photos' | 'ids') => z.string()
  .min(1)
  .max(300)
  .regex(new RegExp(`^e-gatepass/${folder}/[A-Za-z0-9_-]{16,128}$`));

const createPassSchema = z.object({
  visitorId: documentId,
  passId: documentId,
  firstName: z.string().trim().min(2).max(50).regex(namePattern),
  middleName: z.string().trim().max(50).regex(namePattern).or(z.literal('')),
  lastName: z.string().trim().min(2).max(50).regex(namePattern),
  contactNumber: z.string().min(7).max(15).regex(/^[0-9+\-() ]+$/),
  purpose: z.string().trim().min(3).max(300),
  visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  photoPublicId: publicId('photos'),
  idImagePublicId: publicId('ids').nullable(),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function authErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 8192) return jsonResponse(413, { error: 'Request body is too large' });

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader?.startsWith('Bearer ')) return jsonResponse(401, { error: 'Missing or invalid token' });

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }
  const parsed = createPassSchema.safeParse(rawBody);
  if (!parsed.success) return jsonResponse(400, { error: 'Invalid request body' });
  const request = parsed.data;
  const db = getFirestore();
  let actorUid = '';

  try {
    const decoded = await adminAuth.verifyIdToken(authHeader.slice('Bearer '.length));
    actorUid = decoded.uid;
    const isAnonymous = decoded.firebase?.sign_in_provider === 'anonymous';
    const actorDeviceRef = db.collection('devices').doc(decoded.uid);
    const actorUserRef = db.collection('users').doc(decoded.uid);
    const visitorRef = db.collection('visitors').doc(request.visitorId);
    const passRef = db.collection('gatePasses').doc(request.passId);
    const settingsRef = db.collection('settings').doc('app');
    const requestedPublicIds = [request.photoPublicId, request.idImagePublicId].filter((value): value is string => Boolean(value));
    const uploadSessionRefs = requestedPublicIds.map((value) => {
      const uploadId = uploadSessionIdFromPublicId(value);
      if (!uploadId) throw new RequestError(400, 'Invalid image identifier');
      return { publicId: value, reference: db.collection('imageUploads').doc(uploadId) };
    });
    let source: 'portal' | 'kiosk' = 'portal';

    const [preflightDevice, preflightUser] = await Promise.all([actorDeviceRef.get(), actorUserRef.get()]);
    if (isAnonymous) {
      if (preflightDevice.exists || preflightUser.exists) {
        throw new RequestError(403, 'This account cannot create a public visitor pass');
      }
      source = 'portal';
    } else {
      const device = preflightDevice.data();
      if (
        decoded.email_verified !== true ||
        preflightUser.exists ||
        !preflightDevice.exists ||
        device?.status !== 'active' ||
        device?.type !== 'kiosk'
      ) throw new RequestError(403, 'An active Kiosk device is required');
      source = 'kiosk';
    }

    await enforceRateLimit(db, {
      operation: 'create_pass',
      actorType: source === 'portal' ? 'visitor' : 'kiosk',
      uid: decoded.uid,
      clientAddress: clientAddressFromHeaders(event.headers),
    });

    const result = await db.runTransaction(async (transaction) => {
      const [deviceSnapshot, userSnapshot, visitorSnapshot, passSnapshot, settingsSnapshot, ...uploadSnapshots] = await Promise.all([
        transaction.get(actorDeviceRef),
        transaction.get(actorUserRef),
        transaction.get(visitorRef),
        transaction.get(passRef),
        transaction.get(settingsRef),
        ...uploadSessionRefs.map((item) => transaction.get(item.reference)),
      ]);

      const device = deviceSnapshot.data();
      if (isAnonymous) {
        if (deviceSnapshot.exists || userSnapshot.exists) {
          throw new RequestError(403, 'This account cannot create a public visitor pass');
        }
        source = 'portal';
      } else {
        if (
          decoded.email_verified !== true ||
          !deviceSnapshot.exists ||
          device?.status !== 'active' ||
          device?.type !== 'kiosk'
        ) {
          throw new RequestError(403, 'An active Kiosk device is required');
        }
        source = 'kiosk';
      }

      if (visitorSnapshot.exists || passSnapshot.exists) {
        const visitor = visitorSnapshot.data();
        const pass = passSnapshot.data();
        if (
          visitorSnapshot.exists &&
          passSnapshot.exists &&
          visitor?.createdByUid === decoded.uid &&
          pass?.createdByUid === decoded.uid &&
          pass?.visitorId === request.visitorId &&
          pass?.source === source
        ) {
          return {
            kind: 'existing' as const,
            validFrom: pass.validFrom?.toDate?.().toISOString() || null,
            validUntil: pass.validUntil?.toDate?.().toISOString() || null,
          };
        }
        throw new RequestError(409, 'Pass identifiers are already in use');
      }

      const uploadDeliveryTypes = new Map<string, 'upload' | 'authenticated'>();
      uploadSnapshots.forEach((snapshot, index) => {
        const expected = uploadSessionRefs[index];
        const session = snapshot.data();
        if (
          !expected ||
          !snapshot.exists ||
          session?.ownerUid !== decoded.uid ||
          session?.publicId !== expected.publicId ||
          session?.status !== 'pending'
        ) throw new RequestError(403, 'Uploaded image ownership could not be verified');
        uploadDeliveryTypes.set(expected.publicId, normalizeImageDeliveryType(session.deliveryType));
      });

      if (settingsSnapshot.data()?.peakMode !== true && request.idImagePublicId === null) {
        throw new RequestError(400, 'ID upload is required');
      }

      let visitWindow;
      try {
        visitWindow = parseVisitWindow(request.visitDate, settingsSnapshot.data()?.workingHours);
      } catch {
        throw new RequestError(400, 'Invalid visit date');
      }
      if (!isVisitDateWithinPolicy(request.visitDate)) {
        throw new RequestError(400, 'Visit date must be within the next 30 days');
      }

      const fullName = [request.firstName, request.middleName, request.lastName]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ');
      const configuredImageRetentionDays = settingsSnapshot.data()?.imageRetentionDays;
      const imageRetentionDays = typeof configuredImageRetentionDays === 'number' && configuredImageRetentionDays >= 1
        ? configuredImageRetentionDays : 7;
      const imageExpiry = calculateImageExpiry(Date.now(), imageRetentionDays, visitWindow.validUntil.toMillis());
      const photoDeliveryType = uploadDeliveryTypes.get(request.photoPublicId) || 'upload';
      const idImageDeliveryType = request.idImagePublicId
        ? uploadDeliveryTypes.get(request.idImagePublicId) || 'upload'
        : null;

      transaction.create(visitorRef, {
        firstName: request.firstName,
        middleName: request.middleName,
        lastName: request.lastName,
        fullName,
        contactNumber: request.contactNumber,
        purpose: request.purpose,
        visitDate: request.visitDate,
        idImagePublicId: request.idImagePublicId,
        photoPublicId: request.photoPublicId,
        idImageDeliveryType,
        photoDeliveryType,
        consentAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        createdByUid: decoded.uid,
        imagesPurgedAt: null,
        imageRetentionDaysApplied: imageRetentionDays,
        baseImagesExpireAt: imageExpiry.baseImagesExpireAt,
        imagesExpireAt: imageExpiry.imagesExpireAt,
      });
      transaction.create(passRef, {
        visitorId: request.visitorId,
        visitorName: fullName,
        purpose: request.purpose,
        photoPublicId: request.photoPublicId,
        idImagePublicId: request.idImagePublicId,
        photoDeliveryType,
        idImageDeliveryType,
        source,
        status: 'issued',
        validFrom: visitWindow.validFrom,
        validUntil: visitWindow.validUntil,
        issuedAt: FieldValue.serverTimestamp(),
        scannedAt: null,
        timeIn: null,
        timeOut: null,
        entryDeviceId: null,
        exitDeviceId: null,
        decidedByUid: null,
        rejectionReason: null,
        gate: null,
        createdByUid: decoded.uid,
      });
      uploadSessionRefs.forEach((item) => transaction.update(item.reference, {
        status: 'claimed',
        visitorId: request.visitorId,
        passId: request.passId,
        claimedAt: FieldValue.serverTimestamp(),
      }));
      return {
        kind: 'created' as const,
        validFrom: visitWindow.validFrom.toDate().toISOString(),
        validUntil: visitWindow.validUntil.toDate().toISOString(),
      };
    });

    return jsonResponse(result.kind === 'created' ? 201 : 200, {
      passId: request.passId,
      visitorId: request.visitorId,
      source,
      idempotent: result.kind === 'existing',
      validFrom: result.validFrom,
      validUntil: result.validUntil,
    });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    if (error instanceof RateLimitError) {
      return {
        ...jsonResponse(429, { error: error.message, retryAfterSeconds: error.retryAfterSeconds }),
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(error.retryAfterSeconds) },
      };
    }
    const code = authErrorCode(error);
    if (code?.startsWith('auth/')) return jsonResponse(401, { error: 'Invalid or expired token' });

    const reference = db.collection('reconciliationTasks').doc().id;
    await recordReconciliationTask(db, {
      reference,
      operation: 'create_pass_database_failure',
      targetUid: request.passId,
      actorUid,
      reason: 'Uploaded visitor images may be orphaned because atomic visitor/pass creation failed',
      requiredActions: [
        `Verify visitors/${request.visitorId} and gatePasses/${request.passId} were not created`,
        `If unreferenced, delete Cloudinary asset ${request.photoPublicId}`,
        ...(request.idImagePublicId ? [`If unreferenced, delete Cloudinary asset ${request.idImagePublicId}`] : []),
      ],
    });
    console.error('Atomic pass creation failed', {
      reference,
      actorUid,
      passId: request.passId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return jsonResponse(500, {
      error: 'Pass creation failed. Uploaded images require server-side reconciliation.',
      reconciliationRequired: true,
      reference,
    });
  }
};
