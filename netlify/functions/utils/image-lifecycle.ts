import { Timestamp } from 'firebase-admin/firestore';

export const SECURE_IMAGE_DELIVERY_TYPE = 'authenticated' as const;
export type ImageDeliveryType = 'upload' | typeof SECURE_IMAGE_DELIVERY_TYPE;

export const IMAGE_PASS_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;
export const MAX_VISIT_ADVANCE_DAYS = 30;

export function normalizeImageDeliveryType(value: unknown): ImageDeliveryType {
  return value === SECURE_IMAGE_DELIVERY_TYPE ? SECURE_IMAGE_DELIVERY_TYPE : 'upload';
}

export function imageDeliveryTypeForPublicId(
  record: Record<string, unknown>,
  publicId: string,
): ImageDeliveryType {
  if (record.photoPublicId === publicId) return normalizeImageDeliveryType(record.photoDeliveryType);
  if (record.idImagePublicId === publicId) return normalizeImageDeliveryType(record.idImageDeliveryType);
  return 'upload';
}

export function calculateImageExpiry(
  nowMillis: number,
  imageRetentionDays: number,
  passValidUntilMillis: number,
): { baseImagesExpireAt: Timestamp; imagesExpireAt: Timestamp } {
  const baseMillis = nowMillis + imageRetentionDays * 86_400_000;
  return {
    baseImagesExpireAt: Timestamp.fromMillis(baseMillis),
    imagesExpireAt: Timestamp.fromMillis(Math.max(baseMillis, passValidUntilMillis + IMAGE_PASS_SAFETY_MARGIN_MS)),
  };
}

export function isVisitDateWithinPolicy(visitDate: string, nowMillis = Date.now()): boolean {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(nowMillis));
  const latest = new Date(`${today}T00:00:00+08:00`);
  latest.setUTCDate(latest.getUTCDate() + MAX_VISIT_ADVANCE_DAYS);
  const latestDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(latest);
  return visitDate >= today && visitDate <= latestDate;
}

export function passProtectsImages(
  status: unknown,
  validUntil: unknown,
  nowMillis = Date.now(),
): boolean {
  if (status === 'pending' || status === 'inside') return true;
  if (status !== 'issued') return false;
  const validUntilMillis = typeof (validUntil as { toMillis?: unknown } | null)?.toMillis === 'function'
    ? (validUntil as { toMillis: () => number }).toMillis()
    : null;
  return validUntilMillis === null || validUntilMillis > nowMillis;
}

export function closedPassImageExpiryUpdate(
  visitor: Record<string, unknown> | undefined,
): { imagesExpireAt: Timestamp } | null {
  const base = visitor?.baseImagesExpireAt;
  const current = visitor?.imagesExpireAt;
  if (
    typeof (base as { toMillis?: unknown } | null)?.toMillis !== 'function' ||
    typeof (current as { toMillis?: unknown } | null)?.toMillis !== 'function'
  ) return null;
  const baseTimestamp = base as Timestamp;
  return baseTimestamp.toMillis() < (current as Timestamp).toMillis()
    ? { imagesExpireAt: baseTimestamp }
    : null;
}
