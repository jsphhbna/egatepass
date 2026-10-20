import type { Handler } from '@netlify/functions';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { handleAuthError, requireAdmin, type StaffRole } from './utils/auth';
import { createAdministrativeAudit } from './utils/audit';

const userUpdateSchema = z.object({
  targetUid: z.string().min(1).max(128).refine((value) => !value.includes('/')),
  role: z.enum(['guard', 'admin', 'superadmin']).optional(),
  active: z.boolean().optional(),
}).strict().refine(
  (value) => value.role !== undefined || value.active !== undefined,
  { message: 'A role or active status change is required' },
);

const allowedRoleTransitions: Record<StaffRole, readonly StaffRole[]> = {
  guard: ['admin'],
  admin: ['guard', 'superadmin'],
  superadmin: ['admin'],
};

class RequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function isStaffRole(value: unknown): value is StaffRole {
  return value === 'guard' || value === 'admin' || value === 'superadmin';
}

function jsonResponse(statusCode: number, body: object) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  if ((event.body?.length || 0) > 2048) {
    return jsonResponse(413, { error: 'Request body is too large' });
  }

  try {
    const actor = await requireAdmin(event.headers.authorization || event.headers.Authorization);

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }

    const parsed = userUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new RequestError(400, 'Invalid request body');
    }

    const request = parsed.data;
    const db = getFirestore();
    const targetRef = db.collection('users').doc(request.targetUid);
    const actorRef = db.collection('users').doc(actor.uid);

    await db.runTransaction(async (transaction) => {
      const targetSnapshot = await transaction.get(targetRef);
      if (!targetSnapshot.exists) {
        throw new RequestError(404, 'User not found');
      }

      // Re-read the actor inside the same transaction that applies the change.
      // This prevents a stale authorization decision if another administrator
      // deactivates or demotes the actor while this request is in flight.
      const actorSnapshot = request.targetUid === actor.uid
        ? targetSnapshot
        : await transaction.get(actorRef);
      const transactionalActor = actorSnapshot.data();
      if (!actorSnapshot.exists || transactionalActor?.active !== true || !isStaffRole(transactionalActor.role)) {
        throw new RequestError(403, 'Actor account is no longer authorized');
      }
      const actorRole = transactionalActor.role;
      if (actorRole !== 'admin' && actorRole !== 'superadmin') {
        throw new RequestError(403, 'Actor account is no longer authorized');
      }

      const target = targetSnapshot.data();
      const previousRole = target?.role;
      const previousActive = target?.active === true;
      if (!isStaffRole(previousRole)) {
        throw new RequestError(409, 'Target account has an invalid role');
      }

      if (actorRole === 'admin') {
        if (request.targetUid === actor.uid) {
          throw new RequestError(403, 'Admins cannot modify their own administrative account');
        }
        if (previousRole !== 'guard' || request.role !== undefined) {
          throw new RequestError(403, 'Admins may only activate or deactivate Guard accounts');
        }
      }

      const nextRole = request.role ?? previousRole;
      const nextActive = request.active ?? previousActive;

      if (request.role !== undefined && request.role !== previousRole) {
        if (actorRole !== 'superadmin') {
          throw new RequestError(403, 'Only Super Admins may change roles');
        }
        if (!allowedRoleTransitions[previousRole].includes(request.role)) {
          throw new RequestError(400, `Invalid role transition from ${previousRole} to ${request.role}`);
        }
        if (request.role === 'superadmin' && !nextActive) {
          throw new RequestError(400, 'An inactive account cannot be promoted to Super Admin');
        }
      }

      if (nextRole === previousRole && nextActive === previousActive) {
        throw new RequestError(409, 'The requested account state is already active');
      }

      const removesActiveSuperAdmin = previousRole === 'superadmin' && previousActive && (
        nextRole !== 'superadmin' || !nextActive
      );

      if (removesActiveSuperAdmin) {
        const activeSuperAdmins = await transaction.get(
          db.collection('users').where('role', '==', 'superadmin'),
        );
        const hasAnotherActiveSuperAdmin = activeSuperAdmins.docs.some(
          (document) => document.id !== request.targetUid && document.data().active === true,
        );
        if (!hasAnotherActiveSuperAdmin) {
          throw new RequestError(409, 'The final active Super Admin cannot be demoted or deactivated');
        }
      }

      const update: { role?: StaffRole; active?: boolean } = {};
      if (request.role !== undefined) update.role = request.role;
      if (request.active !== undefined) update.active = request.active;

      const roleChanged = nextRole !== previousRole;
      const statusChanged = nextActive !== previousActive;
      const action = roleChanged && statusChanged
        ? 'user_role_and_status_changed'
        : roleChanged
          ? 'user_role_changed'
          : nextActive
            ? 'user_reactivated'
            : 'user_deactivated';

      transaction.update(targetRef, update);
      createAdministrativeAudit(transaction, db, {
        action,
        actorUid: actor.uid,
        actorRole,
        targetType: 'user',
        targetId: request.targetUid,
        targetUid: request.targetUid,
        previousRole,
        newRole: nextRole,
        previousStatus: previousActive ? 'active' : 'inactive',
        newStatus: nextActive ? 'active' : 'inactive',
        result: 'success',
      });
    });

    return jsonResponse(200, { message: 'User account updated successfully' });
  } catch (error) {
    if (error instanceof RequestError) {
      return jsonResponse(error.statusCode, { error: error.message });
    }
    console.error('Error updating user account:', error);
    return handleAuthError(error);
  }
};
