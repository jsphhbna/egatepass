import type { Handler } from '@netlify/functions';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { handleAuthError, requireAdmin } from './utils/auth';
import { createAdministrativeAudit } from './utils/audit';

const deviceUpdateSchema = z.object({
  targetUid: z.string().min(1).max(128).refine((value) => !value.includes('/')),
  status: z.enum(['active', 'revoked']),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function isAdministrativeRole(value: unknown): value is 'admin' | 'superadmin' {
  return value === 'admin' || value === 'superadmin';
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 2048) return jsonResponse(413, { error: 'Request body is too large' });

  try {
    const actor = await requireAdmin(event.headers.authorization || event.headers.Authorization);
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const parsed = deviceUpdateSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid request body');

    const db = getFirestore();
    const actorRef = db.collection('users').doc(actor.uid);
    const deviceRef = db.collection('devices').doc(parsed.data.targetUid);

    await db.runTransaction(async (transaction) => {
      const [actorSnapshot, deviceSnapshot] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(deviceRef),
      ]);
      const currentActor = actorSnapshot.data();
      if (!actorSnapshot.exists || currentActor?.active !== true || !isAdministrativeRole(currentActor?.role)) {
        throw new RequestError(403, 'Actor account is no longer authorized');
      }
      if (!deviceSnapshot.exists) throw new RequestError(404, 'Device not found');
      const device = deviceSnapshot.data();
      if (device?.deletionPending === true) {
        throw new RequestError(409, 'Device deletion is pending reconciliation');
      }
      if (device?.status === parsed.data.status) {
        throw new RequestError(409, `Device is already ${parsed.data.status}`);
      }

      transaction.update(deviceRef, { status: parsed.data.status });
      createAdministrativeAudit(transaction, db, {
        action: parsed.data.status === 'active' ? 'device_reactivated' : 'device_revoked',
        actorUid: actor.uid,
        actorRole: currentActor.role,
        targetType: 'device',
        targetId: parsed.data.targetUid,
        targetUid: parsed.data.targetUid,
        previousStatus: device?.status ?? null,
        newStatus: parsed.data.status,
        result: 'success',
      });
    });

    return jsonResponse(200, { message: `Device ${parsed.data.status === 'active' ? 'reactivated' : 'revoked'} successfully` });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    console.error('Error updating device status:', error);
    return handleAuthError(error);
  }
};
