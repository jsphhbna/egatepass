import { getFirestore, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { adminAuth } from '../firebase-admin';
import type { AuthContext } from './auth';
import { imageDeliveryTypeForPublicId, type ImageDeliveryType } from './image-lifecycle';

export type ImageIdentifierClass = 'current' | 'legacy_candidate' | 'malformed';
export type UploadActor = { uid: string; type: 'visitor' | 'kiosk' };

const currentImagePattern = /^e-gatepass\/(photos|ids)\/([A-Za-z0-9_-]{16,128})$/;
const safeLegacyPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]{1,300}$/;

export class ImageAccessError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404, message: string) {
    super(message);
  }
}

export function classifyImageIdentifier(publicId: unknown): ImageIdentifierClass {
  if (typeof publicId !== 'string' || !safeLegacyPattern.test(publicId)) return 'malformed';
  return currentImagePattern.test(publicId) ? 'current' : 'legacy_candidate';
}

export function uploadSessionIdFromPublicId(publicId: string): string | null {
  return currentImagePattern.exec(publicId)?.[2] || null;
}

export async function requireImageUploadActor(authHeader: string | undefined): Promise<UploadActor> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Unauthorized: Missing or invalid authorization header');
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(authHeader.slice('Bearer '.length));
  } catch {
    throw new Error('Unauthorized: Invalid or expired token');
  }
  const db = getFirestore();
  const [userSnapshot, deviceSnapshot] = await Promise.all([
    db.collection('users').doc(decoded.uid).get(),
    db.collection('devices').doc(decoded.uid).get(),
  ]);

  if (decoded.firebase?.sign_in_provider === 'anonymous' && !userSnapshot.exists && !deviceSnapshot.exists) {
    return { uid: decoded.uid, type: 'visitor' };
  }
  const device = deviceSnapshot.data();
  if (
    decoded.email_verified === true &&
    !userSnapshot.exists &&
    deviceSnapshot.exists &&
    device?.type === 'kiosk' &&
    device?.status === 'active'
  ) return { uid: decoded.uid, type: 'kiosk' };

  throw new Error('Forbidden: Image uploads require a visitor or active Kiosk session');
}

interface ImageReferenceResult {
  classification: Exclude<ImageIdentifierClass, 'malformed'>;
  deliveryType: ImageDeliveryType;
  visitorReferences: QueryDocumentSnapshot[];
  passReferences: QueryDocumentSnapshot[];
}

export async function authorizeReferencedImage(
  db: Firestore,
  actor: AuthContext,
  publicId: unknown,
): Promise<ImageReferenceResult> {
  const classification = classifyImageIdentifier(publicId);
  if (classification === 'malformed') throw new ImageAccessError(400, 'Invalid image identifier');
  const safePublicId = publicId as string;

  const [visitorPhotos, visitorIds, passPhotos, passIds] = await Promise.all([
    db.collection('visitors').where('photoPublicId', '==', publicId).limit(5).get(),
    db.collection('visitors').where('idImagePublicId', '==', publicId).limit(5).get(),
    db.collection('gatePasses').where('photoPublicId', '==', publicId).limit(5).get(),
    db.collection('gatePasses').where('idImagePublicId', '==', publicId).limit(5).get(),
  ]);
  const visitorReferences = [...visitorPhotos.docs, ...visitorIds.docs];
  const passReferences = [...passPhotos.docs, ...passIds.docs];
  if (visitorReferences.length === 0 && passReferences.length === 0) {
    throw new ImageAccessError(404, 'Image not found');
  }

  if (actor.role === 'guard') {
    const permitted = passReferences.some((reference) => reference.data().status === 'pending');
    if (!permitted) throw new ImageAccessError(404, 'Image not found');
  }

  const referencedTypes = [...visitorReferences, ...passReferences]
    .map((reference) => imageDeliveryTypeForPublicId(reference.data(), safePublicId));
  const deliveryType = referencedTypes.includes('authenticated') ? 'authenticated' : 'upload';

  return { classification, deliveryType, visitorReferences, passReferences };
}
