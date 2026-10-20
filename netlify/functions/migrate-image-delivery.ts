import type { Handler } from '@netlify/functions';
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { handleAuthError, requireSuperAdmin } from './utils/auth';
import { writeAdministrativeAudit } from './utils/audit';
import { classifyImageIdentifier } from './utils/image-security';
import { normalizeImageDeliveryType, SECURE_IMAGE_DELIVERY_TYPE } from './utils/image-lifecycle';
import { recordReconciliationTask } from './utils/reconciliation';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const requestSchema = z.object({
  dryRun: z.boolean(),
  confirmation: z.literal('MIGRATE LEGACY VISITOR IMAGES').optional(),
  cursor: z.object({
    createdAtMillis: z.number().int().nonnegative(),
    visitorId: z.string().min(1).max(128).refine((value) => !value.includes('/')),
  }).strict().optional(),
}).strict();

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 2048) return jsonResponse(413, { error: 'Request body is too large' });

  try {
    const actor = await requireSuperAdmin(event.headers.authorization || event.headers.Authorization);
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) return jsonResponse(400, { error: 'Invalid request body' });
    if (!parsed.data.dryRun && parsed.data.confirmation !== 'MIGRATE LEGACY VISITOR IMAGES') {
      return jsonResponse(400, { error: 'Exact migration confirmation is required' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return jsonResponse(500, { error: 'Image migration is not configured' });
    }

    const db = getFirestore();
    let query = db.collection('visitors')
      .where('imagesPurgedAt', '==', null)
      .orderBy('createdAt', 'asc')
      .orderBy(FieldPath.documentId(), 'asc');
    if (parsed.data.cursor) {
      query = query.startAfter(
        Timestamp.fromMillis(parsed.data.cursor.createdAtMillis),
        parsed.data.cursor.visitorId,
      );
    }
    const snapshot = await query.limit(5).get();
    let legacyImagesFound = 0;
    let migratedImages = 0;
    let skippedVisitors = 0;
    let failedImages = 0;
    let reconciliationCount = 0;

    for (const visitorSnapshot of snapshot.docs) {
      const visitor = visitorSnapshot.data();
      const images = [
        { publicId: visitor.photoPublicId, field: 'photoDeliveryType' as const },
        { publicId: visitor.idImagePublicId, field: 'idImageDeliveryType' as const },
      ].filter((image): image is { publicId: string; field: 'photoDeliveryType' | 'idImageDeliveryType' } =>
        typeof image.publicId === 'string' && normalizeImageDeliveryType(visitor[image.field]) === 'upload');
      legacyImagesFound += images.length;
      if (images.length === 0) {
        skippedVisitors++;
        continue;
      }

      const passes = await db.collection('gatePasses').where('visitorId', '==', visitorSnapshot.id).limit(21).get();
      if (passes.size > 20) {
        failedImages += images.length;
        const reference = `image_delivery_migration_${visitorSnapshot.id}`;
        if (await recordReconciliationTask(db, {
          reference,
          operation: 'image_delivery_migration_blocked',
          targetUid: visitorSnapshot.id,
          actorUid: actor.uid,
          reason: 'The visitor has more pass references than the bounded migration can safely update',
          requiredActions: ['Review all pass references', 'Migrate delivery metadata only after every reference can be updated'],
        })) reconciliationCount++;
        continue;
      }
      if (parsed.data.dryRun) continue;

      for (const image of images) {
        try {
          if (classifyImageIdentifier(image.publicId) === 'malformed') throw new Error('Stored image identifier is malformed');
          await cloudinary.uploader.rename(image.publicId, image.publicId, {
            type: 'upload',
            to_type: SECURE_IMAGE_DELIVERY_TYPE,
            resource_type: 'image',
            overwrite: false,
            invalidate: true,
          });

          const batch = db.batch();
          batch.update(visitorSnapshot.ref, {
            [image.field]: SECURE_IMAGE_DELIVERY_TYPE,
            imageDeliveryMigratedAt: FieldValue.serverTimestamp(),
          });
          passes.docs.forEach((pass) => {
            const passData = pass.data();
            const passField = passData.photoPublicId === image.publicId
              ? 'photoDeliveryType'
              : passData.idImagePublicId === image.publicId ? 'idImageDeliveryType' : null;
            if (passField) batch.update(pass.ref, { [passField]: SECURE_IMAGE_DELIVERY_TYPE });
          });
          await batch.commit();
          migratedImages++;
        } catch (error) {
          failedImages++;
          const reference = `image_delivery_migration_${visitorSnapshot.id}_${image.field}`;
          if (await recordReconciliationTask(db, {
            reference,
            operation: 'image_delivery_migration_failed',
            targetUid: visitorSnapshot.id,
            actorUid: actor.uid,
            reason: 'A legacy image could not be converted and synchronized with its Firestore references',
            requiredActions: [
              `Verify ${image.publicId} in both upload and authenticated delivery namespaces`,
              `Set ${image.field} only after the authenticated asset is confirmed`,
            ],
          })) reconciliationCount++;
          console.error('Legacy image delivery migration requires reconciliation', {
            visitorId: visitorSnapshot.id,
            reference,
            field: image.field,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    const last = snapshot.docs.at(-1);
    const lastCreatedAt = last?.data().createdAt;
    const nextCursor = snapshot.size === 5 && typeof lastCreatedAt?.toMillis === 'function'
      ? { createdAtMillis: lastCreatedAt.toMillis(), visitorId: last!.id }
      : null;

    if (!parsed.data.dryRun) {
      await writeAdministrativeAudit(db, {
        action: 'image_delivery_migration',
        actorUid: actor.uid,
        actorRole: actor.role,
        targetType: 'visitor_images',
        targetId: 'bounded_batch',
        result: failedImages > 0 ? 'partial' : 'success',
        metadata: {
          scannedVisitors: snapshot.size,
          legacyImagesFound,
          migratedImages,
          skippedVisitors,
          failedImages,
          reconciliationCount,
          hasMore: nextCursor !== null,
        },
      });
    }

    return jsonResponse(failedImages > 0 ? 202 : 200, {
      dryRun: parsed.data.dryRun,
      scannedVisitors: snapshot.size,
      legacyImagesFound,
      migratedImages,
      skippedVisitors,
      failedImages,
      reconciliationCount,
      nextCursor,
    });
  } catch (error) {
    console.error('Image delivery migration failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return handleAuthError(error);
  }
};
