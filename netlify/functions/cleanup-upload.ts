import type { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { handleAuthError } from './utils/auth';
import { requireImageUploadActor, uploadSessionIdFromPublicId } from './utils/image-security';
import { recordReconciliationTask } from './utils/reconciliation';
import { normalizeImageDeliveryType } from './utils/image-lifecycle';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const cleanupSchema = z.object({
  publicIds: z.array(z.string().min(1).max(300)).min(1).max(2),
}).strict();

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 1024) return jsonResponse(413, { error: 'Request body is too large' });

  try {
    const actor = await requireImageUploadActor(event.headers.authorization || event.headers.Authorization);
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }
    const parsed = cleanupSchema.safeParse(rawBody);
    if (!parsed.success || new Set(parsed.data.publicIds).size !== parsed.data.publicIds.length) {
      return jsonResponse(400, { error: 'Invalid request body' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('Upload cleanup is missing required Cloudinary configuration');
      return jsonResponse(500, { error: 'Image cleanup is not configured' });
    }

    const db = getFirestore();
    let deletedCount = 0;
    let failedCount = 0;
    const reconciliationReferences: string[] = [];

    for (const publicId of parsed.data.publicIds) {
      const uploadId = uploadSessionIdFromPublicId(publicId);
      if (!uploadId) return jsonResponse(400, { error: 'Invalid image identifier' });
      const sessionRef = db.collection('imageUploads').doc(uploadId);
      const reservation = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        const session = snapshot.data();
        if (!snapshot.exists || session?.ownerUid !== actor.uid || session?.publicId !== publicId) return { state: 'not_found' as const };
        if (session.status === 'claimed') return { state: 'claimed' as const };
        if (session.status === 'deleted') return { state: 'deleted' as const };
        if (session.status !== 'pending' && session.status !== 'cleanup_failed') return { state: 'busy' as const };
        transaction.update(sessionRef, { status: 'cleanup_pending', cleanupRequestedAt: FieldValue.serverTimestamp() });
        return { state: 'reserved' as const, deliveryType: normalizeImageDeliveryType(session.deliveryType) };
      });
      if (reservation.state === 'not_found') return jsonResponse(404, { error: 'Pending image not found' });
      if (reservation.state === 'claimed' || reservation.state === 'busy') {
        return jsonResponse(409, { error: 'Image is no longer eligible for upload cleanup' });
      }
      if (reservation.state === 'deleted') {
        deletedCount++;
        continue;
      }

      try {
        const result = await cloudinary.uploader.destroy(publicId, {
          type: reservation.deliveryType, resource_type: 'image', invalidate: true,
        });
        if (result.result !== 'ok' && result.result !== 'not found') {
          throw new Error(`Unexpected Cloudinary deletion result: ${result.result || 'unknown'}`);
        }
        await sessionRef.update({ status: 'deleted', deletedAt: FieldValue.serverTimestamp() });
        deletedCount++;
      } catch (error) {
        failedCount++;
        await sessionRef.update({ status: 'cleanup_failed', cleanupFailedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
        const reference = db.collection('reconciliationTasks').doc().id;
        await recordReconciliationTask(db, {
          reference,
          operation: 'pending_upload_cleanup_failed',
          targetUid: publicId,
          actorUid: actor.uid,
          reason: 'An owner-authorized unclaimed E-GatePass upload could not be deleted',
          requiredActions: ['Verify the upload is unclaimed', 'Delete the Cloudinary asset and mark the upload session deleted'],
        });
        reconciliationReferences.push(reference);
        console.error('Pending upload cleanup requires reconciliation', {
          reference,
          uploadId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return jsonResponse(failedCount > 0 ? 202 : 200, {
      deletedCount,
      failedCount,
      reconciliationRequired: failedCount > 0,
      ...(reconciliationReferences.length ? { references: reconciliationReferences } : {}),
    });
  } catch (error) {
    console.error('Pending upload cleanup failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return handleAuthError(error);
  }
};
