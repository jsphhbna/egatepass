import type { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { adminAuth } from './firebase-admin';
import { handleAuthError, requireAdmin, type StaffRole } from './utils/auth';
import { recordReconciliationTask } from './utils/reconciliation';
import { createAdministrativeAudit } from './utils/audit';

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(50),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/\d/),
  role: z.enum(['guard', 'admin']),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

class ReconciliationError extends Error {
  constructor(public readonly reference: string) {
    super('Account creation requires manual reconciliation');
  }
}

function jsonResponse(statusCode: number, body: object) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function isAdministrativeRole(value: unknown): value is 'admin' | 'superadmin' {
  return value === 'admin' || value === 'superadmin';
}

function firebaseAuthStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  if (error.code === 'auth/email-already-exists') return 409;
  if (error.code === 'auth/invalid-email' || error.code === 'auth/invalid-password') return 400;
  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 4096) return jsonResponse(413, { error: 'Request body is too large' });

  let createdUid: string | null = null;
  let actorUid = '';
  const db = getFirestore();
  const reconciliationReference = db.collection('reconciliationTasks').doc().id;

  try {
    const actor = await requireAdmin(event.headers.authorization || event.headers.Authorization);
    actorUid = actor.uid;

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const parsed = createUserSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid request body');
    const request = parsed.data;

    if (actor.role === 'admin' && request.role !== 'guard') {
      throw new RequestError(403, 'Admins may only create Guard accounts');
    }

    const authUser = await adminAuth.createUser({
      email: request.email,
      password: request.password,
      displayName: request.name,
      emailVerified: false,
      disabled: false,
    });
    createdUid = authUser.uid;

    try {
      const actorRef = db.collection('users').doc(actor.uid);
      const userRef = db.collection('users').doc(authUser.uid);
      await db.runTransaction(async (transaction) => {
        const actorSnapshot = await transaction.get(actorRef);
        const currentActor = actorSnapshot.data();
        const currentActorRole = currentActor?.role as StaffRole | undefined;
        if (!actorSnapshot.exists || currentActor?.active !== true || !isAdministrativeRole(currentActorRole)) {
          throw new RequestError(403, 'Actor account is no longer authorized');
        }
        if (currentActorRole === 'admin' && request.role !== 'guard') {
          throw new RequestError(403, 'Admins may only create Guard accounts');
        }

        transaction.create(userRef, {
          name: request.name,
          email: request.email,
          role: request.role,
          active: true,
          privacyAcceptedAt: null,
          mustChangePassword: request.role === 'guard',
          createdAt: FieldValue.serverTimestamp(),
        });
        createAdministrativeAudit(transaction, db, {
          action: `${request.role}_created`,
          actorUid: actor.uid,
          actorRole: currentActorRole,
          targetType: 'user',
          targetId: authUser.uid,
          targetUid: authUser.uid,
          previousRole: null,
          newRole: request.role,
          previousStatus: null,
          newStatus: 'active',
          result: 'success',
          metadata: { emailVerificationRequired: true },
        });
      });
    } catch (firestoreError) {
      try {
        await adminAuth.deleteUser(authUser.uid);
        createdUid = null;
      } catch (rollbackError) {
        console.error('CRITICAL: Failed to roll back Auth user after Firestore failure', {
          reference: reconciliationReference,
          targetUid: authUser.uid,
          error: rollbackError instanceof Error ? rollbackError.message : 'Unknown error',
        });
        await recordReconciliationTask(db, {
          reference: reconciliationReference,
          operation: 'create_user_rollback',
          targetUid: authUser.uid,
          actorUid: actor.uid,
          reason: 'Firestore profile creation failed and Auth cleanup did not complete',
          requiredActions: ['Delete the orphaned Firebase Auth user after verifying no users document exists'],
        });
        throw new ReconciliationError(reconciliationReference);
      }
      throw firestoreError;
    }

    return jsonResponse(201, {
      uid: authUser.uid,
      message: 'User account created successfully',
      emailVerificationRequired: true,
    });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    if (error instanceof ReconciliationError) {
      return jsonResponse(500, {
        error: 'Account creation did not complete cleanly. A Super Admin must reconcile the operation.',
        reconciliationRequired: true,
        reference: error.reference,
      });
    }
    const authStatus = firebaseAuthStatus(error);
    if (authStatus) {
      return jsonResponse(authStatus, {
        error: authStatus === 409 ? 'An account with this email already exists' : 'Invalid account credentials',
      });
    }
    console.error('Error creating user account', {
      actorUid,
      createdUid,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return handleAuthError(error);
  }
};
