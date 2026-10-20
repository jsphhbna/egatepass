import type { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { adminAuth } from './firebase-admin';
import { handleAuthError, requireSuperAdmin } from './utils/auth';
import { recordReconciliationTask } from './utils/reconciliation';
import { administrativeAuditData } from './utils/audit';

const deleteDeviceSchema = z.object({
  targetUid: z.string().min(1).max(128).refine((value) => !value.includes('/')),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function isAuthUserNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'auth/user-not-found';
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'DELETE') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 2048) return jsonResponse(413, { error: 'Request body is too large' });

  const db = getFirestore();
  let actorUid = '';
  let auditId = '';

  try {
    const actor = await requireSuperAdmin(event.headers.authorization || event.headers.Authorization);
    actorUid = actor.uid;
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const parsed = deleteDeviceSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid request body');

    const actorRef = db.collection('users').doc(actor.uid);
    const deviceRef = db.collection('devices').doc(parsed.data.targetUid);
    const auditRef = db.collection('auditLogs').doc();
    auditId = auditRef.id;
    let previousStatus = 'revoked';

    await db.runTransaction(async (transaction) => {
      const [actorSnapshot, deviceSnapshot] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(deviceRef),
      ]);
      const currentActor = actorSnapshot.data();
      if (!actorSnapshot.exists || currentActor?.active !== true || currentActor?.role !== 'superadmin') {
        throw new RequestError(403, 'Actor account is no longer authorized');
      }
      if (!deviceSnapshot.exists) throw new RequestError(404, 'Device not found');
      if (deviceSnapshot.data()?.deletionPending === true) {
        throw new RequestError(409, 'Device deletion is already pending reconciliation');
      }
      previousStatus = typeof deviceSnapshot.data()?.status === 'string' ? deviceSnapshot.data()?.status : 'revoked';
      transaction.update(deviceRef, { status: 'revoked', deletionPending: true });
      transaction.create(auditRef, administrativeAuditData({
        action: 'device_deleted',
        actorUid: actor.uid,
        actorRole: 'superadmin',
        targetType: 'device',
        targetId: parsed.data.targetUid,
        targetUid: parsed.data.targetUid,
        previousStatus,
        newStatus: 'deleted',
        result: 'pending',
      }));
    });

    try {
      await adminAuth.deleteUser(parsed.data.targetUid);
    } catch (error) {
      if (!isAuthUserNotFound(error)) {
        try {
          await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(deviceRef);
            if (snapshot.exists && snapshot.data()?.deletionPending === true) {
              transaction.update(deviceRef, {
                status: previousStatus,
                deletionPending: FieldValue.delete(),
              });
            }
            transaction.update(auditRef, {
              result: 'failure',
              'metadata.failureStage': 'before_auth_deletion',
              completedAt: FieldValue.serverTimestamp(),
            });
          });
        } catch (cleanupError) {
          const reference = db.collection('reconciliationTasks').doc().id;
          await recordReconciliationTask(db, {
            reference,
            operation: 'delete_device_cleanup',
            targetUid: parsed.data.targetUid,
            actorUid: actor.uid,
            reason: 'Auth deletion failed and the reversible Firestore preparation could not be restored',
            requiredActions: [
              'Confirm the Firebase Auth device account still exists',
              `Restore device status to ${previousStatus} and clear deletionPending`,
              `Mark audit ${auditRef.id} failed`,
            ],
          });
          console.error('Device deletion cleanup requires reconciliation', {
            reference,
            targetUid: parsed.data.targetUid,
            error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
          });
          return jsonResponse(500, {
            error: 'Device deletion failed, and follow-up cleanup is required.',
            reconciliationRequired: true,
            reference,
          });
        }
        throw error;
      }
    }

    try {
      const batch = db.batch();
      batch.delete(deviceRef);
      batch.update(auditRef, { result: 'success', completedAt: FieldValue.serverTimestamp() });
      await batch.commit();
    } catch {
      const reference = db.collection('reconciliationTasks').doc().id;
      await recordReconciliationTask(db, {
        reference,
        operation: 'delete_device_finalize',
        targetUid: parsed.data.targetUid,
        actorUid: actor.uid,
        reason: 'Firebase Auth account was deleted, but Firestore deletion did not complete',
        requiredActions: [
          'Confirm the Firebase Auth device account is absent',
          'Delete the revoked devices document',
          `Mark audit ${auditRef.id} completed`,
        ],
      });
      return jsonResponse(202, {
        error: 'The login was deleted, but follow-up reconciliation is required.',
        reconciliationRequired: true,
        reference,
      });
    }

    return jsonResponse(200, { message: 'Device deleted successfully' });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    console.error('Error deleting device', {
      actorUid,
      auditId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return handleAuthError(error);
  }
};
