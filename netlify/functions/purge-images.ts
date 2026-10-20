import { Handler } from '@netlify/functions';
import { v2 as cloudinary } from 'cloudinary';
import { FieldPath, getFirestore, FieldValue, Timestamp, type Firestore, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { z } from 'zod';
import crypto from 'crypto';
import { handleAuthError, requireSuperAdmin } from './utils/auth';
import { writeAdministrativeAudit, type AuditActorRole } from './utils/audit';
import { recordReconciliationTask } from './utils/reconciliation';
import { classifyImageIdentifier, uploadSessionIdFromPublicId } from './utils/image-security';
import { imageDeliveryTypeForPublicId, normalizeImageDeliveryType, passProtectsImages } from './utils/image-lifecycle';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const purgeRequestSchema = z.object({
  dryRun: z.boolean().optional(),
}).strict();

const jsonHeaders = { 'Content-Type': 'application/json' };

function jsonResponse(statusCode: number, body: object) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  };
}

async function cleanupExpiredUploads(db: Firestore, actorUid: string) {
  const snapshot = await db.collection('imageUploads')
    .where('status', '==', 'pending')
    .where('expiresAt', '<=', Timestamp.now())
    .orderBy('expiresAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(25)
    .get();
  let deletedCount = 0;
  let failedCount = 0;
  let reconciliationCount = 0;

  for (const upload of snapshot.docs) {
    const data = upload.data();
    const publicId = data.publicId;
    try {
      if (
        classifyImageIdentifier(publicId) !== 'current' ||
        uploadSessionIdFromPublicId(publicId) !== upload.id ||
        typeof data.ownerUid !== 'string'
      ) throw new Error('Upload session image identifier is invalid');
      const reserved = await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(upload.ref);
        if (!latest.exists || latest.data()?.status !== 'pending') return false;
        transaction.update(upload.ref, { status: 'cleanup_pending', cleanupRequestedAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (!reserved) continue;
      const result = await cloudinary.uploader.destroy(publicId, {
        type: normalizeImageDeliveryType(data.deliveryType), resource_type: 'image', invalidate: true,
      });
      if (result.result !== 'ok' && result.result !== 'not found') {
        throw new Error(`Unexpected Cloudinary deletion result: ${result.result || 'unknown'}`);
      }
      await upload.ref.update({ status: 'deleted', deletedAt: FieldValue.serverTimestamp() });
      deletedCount++;
    } catch (error) {
      failedCount++;
      await upload.ref.update({ status: 'cleanup_failed', cleanupFailedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      const reference = db.collection('reconciliationTasks').doc().id;
      if (await recordReconciliationTask(db, {
        reference,
        operation: 'expired_upload_cleanup_failed',
        targetUid: upload.id,
        actorUid,
        reason: 'An expired unclaimed E-GatePass upload could not be safely deleted',
        requiredActions: ['Verify the upload session is unclaimed', 'Delete the matching Cloudinary asset and mark the session deleted'],
      })) reconciliationCount++;
      console.error('Expired upload cleanup failed', {
        uploadId: upload.id,
        reference,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  const remaining = await db.collection('imageUploads')
    .where('status', '==', 'pending')
    .where('expiresAt', '<=', Timestamp.now())
    .limit(1)
    .get();
  return { attempted: snapshot.size, deletedCount, failedCount, reconciliationCount, hasMore: !remaining.empty };
}

interface PurgeCursor {
  sortMillis: number;
  documentId: string;
}

function parsePurgeCursor(value: unknown): PurgeCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sortMillis === 'number' && typeof candidate.documentId === 'string'
    ? { sortMillis: candidate.sortMillis, documentId: candidate.documentId }
    : null;
}

function applyPurgeCursor(query: Query, cursor: PurgeCursor | null): Query {
  return cursor
    ? query.startAfter(Timestamp.fromMillis(cursor.sortMillis), cursor.documentId)
    : query;
}

async function updatePurgeCursor(
  db: Firestore,
  field: string,
  docs: QueryDocumentSnapshot[],
  limit: number,
  sortField: string,
): Promise<boolean> {
  const last = docs.at(-1);
  const sortValue = last?.data()?.[sortField];
  const sortMillis = typeof sortValue?.toMillis === 'function' ? sortValue.toMillis() : null;
  const hasMore = docs.length === limit;
  await db.collection('maintenanceState').doc('imagePurge').set({
    [field]: hasMore && last && sortMillis !== null
      ? { sortMillis, documentId: last.id }
      : null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return hasMore;
}

export const handler: Handler = async (event) => {
  const { httpMethod } = event;

  if (httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  if ((event.body?.length || 0) > 1024) {
    return jsonResponse(413, { error: 'Request body is too large' });
  }

  let requestBody: unknown = {};
  try {
    if (event.body) {
      requestBody = JSON.parse(event.body);
    }
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const parsedRequest = purgeRequestSchema.safeParse(requestBody);
  if (!parsedRequest.success) {
    return jsonResponse(400, { error: 'Invalid request body' });
  }
  const isDryRun = parsedRequest.data.dryRun === true;

  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = event.headers['x-cron-secret'] || event.headers['X-Cron-Secret'];
  
  let isCronAuthenticated = false;
  let auditActor: { uid: string; role: AuditActorRole } = { uid: 'system', role: 'system' };

  if (cronSecret && providedSecret) {
    const a = Buffer.from(cronSecret);
    const b = Buffer.from(providedSecret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      isCronAuthenticated = true;
    }
  }

  if (!isCronAuthenticated) {
    try {
      const actor = await requireSuperAdmin(event.headers.authorization || event.headers.Authorization);
      auditActor = { uid: actor.uid, role: actor.role };
    } catch (error) {
      return handleAuthError(error);
    }
  }

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('Image purge is missing required Cloudinary configuration');
    return jsonResponse(500, { error: 'Image deletion is not configured' });
  }

  const db = getFirestore();
  try {

    // 1. Fetch settings to get retentionDays
    const settingsDoc = await db.collection('settings').doc('app').get();
    const settings = settingsDoc.data();
    const legacyRetentionDays = typeof settings?.retentionDays === 'number' ? settings.retentionDays : 30;
    const retentionDays = typeof settings?.imageRetentionDays === 'number' ? settings.imageRetentionDays : 7;
    if (legacyRetentionDays < 1 || retentionDays < 1) {
      return jsonResponse(500, { error: 'Image retention settings are invalid' });
    }
    const legacyCutoff = new Date(Date.now() - legacyRetentionDays * 86_400_000);
    const legacyVisitors = db.collection('visitors')
      .where('imagesPurgedAt', '==', null)
      .where('createdAt', '<=', legacyCutoff)
      .orderBy('createdAt', 'asc')
      .orderBy(FieldPath.documentId(), 'asc');
    const scheduledVisitors = db.collection('visitors')
      .where('imagesPurgedAt', '==', null)
      .where('imagesExpireAt', '<=', Timestamp.now())
      .orderBy('imagesExpireAt', 'asc')
      .orderBy(FieldPath.documentId(), 'asc');

    if (isDryRun) {
      const [legacySnapshot, scheduledSnapshot, orphanCountSnapshot] = await Promise.all([
        legacyVisitors.limit(25).get(), scheduledVisitors.limit(25).get(),
        db.collection('imageUploads').where('status', '==', 'pending').where('expiresAt', '<=', Timestamp.now()).count().get(),
      ]);
      const visitorsAffected = new Set([...legacySnapshot.docs.filter((item) => item.data().imagesExpireAt == null).map((item) => item.id), ...scheduledSnapshot.docs.map((item) => item.id)]).size;

      return jsonResponse(200, {
        message: `Would delete images for up to ${visitorsAffected} visitors in the next bounded batch.`,
        visitorsAffected,
        orphanUploadsAffected: orphanCountSnapshot.data().count,
        retentionDays,
      });
    }

    // Maintain separate deterministic cursors for legacy and timestamped image
    // policies. A blocked oldest record is revisited on a later cursor cycle,
    // but cannot prevent later eligible records from being examined.
    const state = (await db.collection('maintenanceState').doc('imagePurge').get()).data() || {};
    const legacyLimit = 12;
    const scheduledLimit = 13;
    const [legacySnapshot, scheduledSnapshot] = await Promise.all([
      applyPurgeCursor(legacyVisitors, parsePurgeCursor(state.legacyCursor)).limit(legacyLimit).get(),
      applyPurgeCursor(scheduledVisitors, parsePurgeCursor(state.scheduledCursor)).limit(scheduledLimit).get(),
    ]);
    const snapshotDocs = [...new Map([
      ...legacySnapshot.docs.filter((item) => item.data().imagesExpireAt == null),
      ...scheduledSnapshot.docs,
    ].map((item) => [item.id, item])).values()];

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let reconciliationCount = 0;

    // 4. Process each visitor
    for (const doc of snapshotDocs) {
      const visitor = doc.data();
      const publicIdsToDestroy: Array<{ publicId: string; deliveryType: 'upload' | 'authenticated' }> = [];

      if (typeof visitor.photoPublicId === 'string') {
        publicIdsToDestroy.push({ publicId: visitor.photoPublicId, deliveryType: imageDeliveryTypeForPublicId(visitor, visitor.photoPublicId) });
      }
      if (typeof visitor.idImagePublicId === 'string') {
        publicIdsToDestroy.push({ publicId: visitor.idImagePublicId, deliveryType: imageDeliveryTypeForPublicId(visitor, visitor.idImagePublicId) });
      }

      let deletedImageCount = 0;
      try {
        const [passes, pendingReconciliation] = await Promise.all([
          db.collection('gatePasses').where('visitorId', '==', doc.id).limit(21).get(),
          db.collection('reconciliationTasks').where('status', '==', 'pending').where('targetUid', '==', doc.id).limit(1).get(),
        ]);
        if (passes.size > 20) throw new Error('Visitor pass count exceeds the bounded image-safety check');
        if (!pendingReconciliation.empty || passes.docs.some((pass) => passProtectsImages(pass.data().status, pass.data().validUntil))) {
          skippedCount++;
          continue;
        }

        if (publicIdsToDestroy.length > 0) {
          for (const image of publicIdsToDestroy) {
            if (classifyImageIdentifier(image.publicId) === 'malformed') {
              throw new Error('Stored image identifier is malformed');
            }
            const result = await cloudinary.uploader.destroy(image.publicId, {
              type: image.deliveryType,
              resource_type: 'image',
              invalidate: true,
            });

            if (result.result !== 'ok' && result.result !== 'not found') {
              throw new Error(`Cloudinary returned an unexpected deletion result: ${result.result || 'unknown'}`);
            }
            deletedImageCount++;
          }
        }

        // Only mark as purged after successful Cloudinary deletion
        await doc.ref.update({
          imagesPurgedAt: FieldValue.serverTimestamp(),
        });

        successCount++;
      } catch (error) {
        failedCount++;
        const reference = `visitor_image_purge_${doc.id}`;
        if (await recordReconciliationTask(db, {
          reference,
          operation: deletedImageCount > 0 ? 'visitor_image_purge_partial' : 'visitor_image_purge_failed',
          targetUid: doc.id,
          actorUid: auditActor.uid,
          reason: deletedImageCount > 0
            ? 'At least one visitor image was deleted before the retention purge could be finalized'
            : 'Visitor image retention cleanup could not safely complete',
          requiredActions: ['Verify both referenced Cloudinary images and delivery types', 'Complete deletion and set imagesPurgedAt only after all images are absent'],
        })) reconciliationCount++;
        console.error('Failed to delete visitor images', {
          visitorId: doc.id,
          reference,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const [legacyHasMore, scheduledHasMore] = await Promise.all([
      updatePurgeCursor(db, 'legacyCursor', legacySnapshot.docs, legacyLimit, 'createdAt'),
      updatePurgeCursor(db, 'scheduledCursor', scheduledSnapshot.docs, scheduledLimit, 'imagesExpireAt'),
    ]);
    const hasMoreVisitors = legacyHasMore || scheduledHasMore || skippedCount > 0 || failedCount > 0;

    const orphanCleanup = await cleanupExpiredUploads(db, auditActor.uid);

    try {
      if (snapshotDocs.length > 0) {
        await writeAdministrativeAudit(db, {
          action: 'visitor_images_purged',
          actorUid: auditActor.uid,
          actorRole: auditActor.role,
          targetType: 'visitor_images',
          targetId: 'retention_batch',
          result: failedCount > 0 ? 'partial' : 'success',
          metadata: { scannedCount: snapshotDocs.length, successCount, skippedCount, failedCount, reconciliationCount, retentionDays, hasMore: hasMoreVisitors },
        });
      }
      if (orphanCleanup.attempted > 0) {
        await writeAdministrativeAudit(db, {
          action: 'orphan_uploads_cleaned',
          actorUid: auditActor.uid,
          actorRole: auditActor.role,
          targetType: 'image_uploads',
          targetId: 'expired_batch',
          result: orphanCleanup.failedCount > 0 ? 'partial' : 'success',
          metadata: {
            deletedCount: orphanCleanup.deletedCount,
            failedCount: orphanCleanup.failedCount,
            reconciliationCount: orphanCleanup.reconciliationCount,
            hasMore: orphanCleanup.hasMore,
          },
        });
      }
    } catch (auditError) {
      const reference = db.collection('reconciliationTasks').doc().id;
      await recordReconciliationTask(db, {
        reference,
        operation: 'purge_images_audit_failure',
        targetUid: 'retention_batch',
        actorUid: auditActor.uid,
        reason: 'Visitor images were purged but the administrative audit event could not be finalized',
        requiredActions: ['Review image purge results and confirm the administrative audit trail'],
      });
      console.error('Image purge audit requires reconciliation', {
        reference,
        error: auditError instanceof Error ? auditError.message : 'Unknown error',
      });
      return jsonResponse(202, {
        message: `Deleted images for ${successCount} visitors, but audit reconciliation is required.`,
        successCount,
        skippedCount,
        failedCount,
        orphanDeletedCount: orphanCleanup.deletedCount,
        orphanFailedCount: orphanCleanup.failedCount,
        hasMore: hasMoreVisitors || orphanCleanup.hasMore,
        reconciliationRequired: true,
        reference,
      });
    }

    return jsonResponse(200, {
      message: `Deleted images for ${successCount} visitors.`,
      successCount,
      skippedCount,
      failedCount,
      orphanDeletedCount: orphanCleanup.deletedCount,
      orphanFailedCount: orphanCleanup.failedCount,
      hasMore: hasMoreVisitors || orphanCleanup.hasMore,
    });
  } catch (error) {
    console.error('Image purge failed', error);
    await writeAdministrativeAudit(db, {
      action: 'visitor_images_purge_failed',
      actorUid: auditActor.uid,
      actorRole: auditActor.role,
      targetType: 'visitor_images',
      targetId: 'retention_batch',
      result: 'failure',
      metadata: { safeSummary: 'Image purge did not complete' },
    }).catch((auditError) => {
      console.error('Failed to record image purge failure audit', auditError);
    });
    return jsonResponse(500, { error: 'Image deletion failed' });
  }
};
