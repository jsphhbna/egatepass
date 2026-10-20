import type { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { adminAuth } from './firebase-admin';
import { handleAuthError, requireSuperAdmin } from './utils/auth';
import { recordReconciliationTask } from './utils/reconciliation';
import { administrativeAuditData } from './utils/audit';

const credentialUpdateSchema = z.object({
  targetUid: z.string().min(1).max(128).refine((value) => !value.includes('/')),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  password: z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/\d/).optional(),
}).strict().refine((value) => value.email !== undefined || value.password !== undefined);

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
  if ((event.body?.length || 0) > 4096) return jsonResponse(413, { error: 'Request body is too large' });

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
    const parsed = credentialUpdateSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid request body');
    const request = parsed.data;

    const authUser = await adminAuth.getUser(request.targetUid);
    const previousEmail = authUser.email || null;
    if (request.email && request.email === previousEmail && !request.password) {
      throw new RequestError(409, 'Device username is unchanged');
    }

    const actorRef = db.collection('users').doc(actor.uid);
    const deviceRef = db.collection('devices').doc(request.targetUid);
    const auditRef = db.collection('auditLogs').doc();
    auditId = auditRef.id;

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
        throw new RequestError(409, 'Device deletion is pending reconciliation');
      }
      if (deviceSnapshot.data()?.credentialUpdatePending) {
        throw new RequestError(409, 'Another credential update is already pending');
      }

      transaction.update(deviceRef, { credentialUpdatePending: auditRef.id });
      transaction.create(auditRef, administrativeAuditData({
        action: 'device_credentials_updated',
        actorUid: actor.uid,
        actorRole: 'superadmin',
        targetType: 'device',
        targetId: request.targetUid,
        targetUid: request.targetUid,
        result: 'pending',
        metadata: {
          emailChanged: request.email !== undefined && request.email !== previousEmail,
          passwordChanged: request.password !== undefined,
        },
      }));
    });

    try {
      await adminAuth.updateUser(request.targetUid, {
        ...(request.email ? { email: request.email } : {}),
        ...(request.password ? { password: request.password } : {}),
      });
    } catch (error) {
      try {
        await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(deviceRef);
          if (snapshot.exists && snapshot.data()?.credentialUpdatePending === auditRef.id) {
            transaction.update(deviceRef, { credentialUpdatePending: FieldValue.delete() });
          }
        transaction.update(auditRef, {
          result: 'failure',
          'metadata.failureStage': 'before_auth_mutation',
          completedAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (cleanupError) {
        const reference = db.collection('reconciliationTasks').doc().id;
        await recordReconciliationTask(db, {
          reference,
          operation: 'update_device_credentials_cleanup',
          targetUid: request.targetUid,
          actorUid: actor.uid,
          reason: 'Auth rejected the credential change and the pending Firestore state could not be cleared',
          requiredActions: [
            `Mark audit ${auditRef.id} failed`,
            `Clear credentialUpdatePending when it equals ${auditRef.id}`,
          ],
        });
        console.error('Credential mutation cleanup requires reconciliation', {
          reference,
          targetUid: request.targetUid,
          error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error',
        });
        return jsonResponse(500, {
          error: 'The credential change was rejected, but follow-up cleanup is required.',
          reconciliationRequired: true,
          reference,
        });
      }
      const code = authErrorCode(error);
      if (code === 'auth/email-already-exists') throw new RequestError(409, 'That device username is already in use');
      if (code === 'auth/invalid-email' || code === 'auth/invalid-password') throw new RequestError(400, 'Invalid device credentials');
      throw error;
    }

    let reconciliationReference: string | null = null;
    let reconciliationReason: string | null = null;
    if (request.password) {
      try {
        await adminAuth.revokeRefreshTokens(request.targetUid);
      } catch {
        reconciliationReference = db.collection('reconciliationTasks').doc().id;
        reconciliationReason = 'Password changed, but existing refresh tokens could not be revoked';
      }
    }

    try {
      const batch = db.batch();
      batch.update(deviceRef, {
        ...(request.email ? { email: request.email } : {}),
        credentialUpdatePending: FieldValue.delete(),
      });
      batch.update(auditRef, {
        result: reconciliationReference ? 'partial' : 'success',
        ...(reconciliationReference ? { 'metadata.reconciliationReference': reconciliationReference } : {}),
        completedAt: FieldValue.serverTimestamp(),
      });
      await batch.commit();
    } catch {
      if (request.email && previousEmail) {
        try {
          await adminAuth.updateUser(request.targetUid, { email: previousEmail });
        } catch {
          // The reconciliation task below records that the email may also differ.
        }
      }
      reconciliationReference ||= db.collection('reconciliationTasks').doc().id;
      reconciliationReason = request.password
        ? 'Password changed irreversibly and the Firestore finalization did not complete'
        : 'Credential update finalization failed; verify Auth email and Firestore device metadata';
    }

    if (reconciliationReference && reconciliationReason) {
      await recordReconciliationTask(db, {
        reference: reconciliationReference,
        operation: 'update_device_credentials',
        targetUid: request.targetUid,
        actorUid: actor.uid,
        reason: reconciliationReason,
        requiredActions: [
          'Verify the Firebase Auth email matches the devices document',
          ...(request.password ? ['Notify the device owner that the new password remains effective', 'Revoke refresh tokens'] : []),
          `Resolve pending audit ${auditRef.id} and clear credentialUpdatePending`,
        ],
      });
      return jsonResponse(202, {
        error: 'Credentials changed, but follow-up reconciliation is required.',
        reconciliationRequired: true,
        reference: reconciliationReference,
      });
    }

    return jsonResponse(200, { message: 'Device credentials updated successfully' });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    const code = authErrorCode(error);
    if (code === 'auth/user-not-found') return jsonResponse(404, { error: 'Device login account not found' });
    console.error('Error updating device credentials', {
      actorUid,
      auditId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return handleAuthError(error);
  }
};
