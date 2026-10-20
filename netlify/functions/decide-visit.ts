import { Handler } from '@netlify/functions';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { handleAuthError, requireGuardOrAdmin } from './utils/auth';
import { closedPassImageExpiryUpdate } from './utils/image-lifecycle';

type Decision = 'approved' | 'rejected';

interface DecisionRequest {
  passId: string;
  decision: Decision;
  reason: string | null;
}

class RequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parseRequest(body: unknown): DecisionRequest {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('passId' in body) ||
    !('decision' in body) ||
    !('reason' in body) ||
    Object.keys(body).some((key) => !['passId', 'decision', 'reason'].includes(key))
  ) {
    throw new RequestError(400, 'Invalid request body');
  }

  const { passId, decision, reason } = body;
  if (typeof passId !== 'string' || passId.length === 0 || passId.length > 200 || passId.includes('/')) {
    throw new RequestError(400, 'Invalid pass ID');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new RequestError(400, 'Invalid decision');
  }
  if (decision === 'approved' && reason !== null) {
    throw new RequestError(400, 'An approval cannot include a rejection reason');
  }
  let normalizedReason: string | null = null;
  if (decision === 'rejected') {
    if (typeof reason !== 'string') {
      throw new RequestError(400, 'A rejection reason is required');
    }
    normalizedReason = reason.trim();
    if (normalizedReason.length === 0 || normalizedReason.length > 500) {
      throw new RequestError(400, 'A rejection reason is required');
    }
  }

  return {
    passId,
    decision,
    reason: normalizedReason,
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const actor = await requireGuardOrAdmin(event.headers.authorization);
    let body: unknown;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const request = parseRequest(body);
    const db = getFirestore();
    const passRef = db.collection('gatePasses').doc(request.passId);
    const guardRef = db.collection('users').doc(actor.uid);
    const visitLogRef = db.collection('visitLogs').doc();

    await db.runTransaction(async (transaction) => {
      const [passSnapshot, guardSnapshot] = await Promise.all([
        transaction.get(passRef),
        transaction.get(guardRef),
      ]);

      if (!passSnapshot.exists) {
        throw new RequestError(404, 'Pass not found');
      }

      const pass = passSnapshot.data();
      if (pass?.status !== 'pending') {
        throw new RequestError(409, 'This pass is no longer waiting for a decision');
      }
      if (typeof pass.visitorId !== 'string' || pass.visitorId.length === 0) {
        throw new RequestError(409, 'Pass is missing its visitor record');
      }

      const visitorRef = db.collection('visitors').doc(pass.visitorId);
      const visitorSnapshot = await transaction.get(visitorRef);

      const guardName = typeof guardSnapshot.data()?.name === 'string' && guardSnapshot.data()?.name.trim()
        ? guardSnapshot.data()!.name.trim()
        : actor.email;
      const gate = typeof pass.gate === 'string' ? pass.gate : null;

      transaction.update(
        passRef,
        request.decision === 'approved'
          ? {
              status: 'inside',
              timeIn: FieldValue.serverTimestamp(),
              decidedByUid: actor.uid,
            }
          : {
              status: 'rejected',
              rejectionReason: request.reason,
              decidedByUid: actor.uid,
            },
      );
      if (request.decision === 'rejected') {
        const expiryUpdate = closedPassImageExpiryUpdate(visitorSnapshot.data());
        if (visitorSnapshot.exists && expiryUpdate) transaction.update(visitorRef, expiryUpdate);
      }

      transaction.create(visitLogRef, {
        passToken: passRef.id,
        visitorId: pass.visitorId,
        event: request.decision,
        reason: request.reason,
        deviceId: null,
        gate,
        guardUid: actor.uid,
        guardName,
        timestamp: FieldValue.serverTimestamp(),
      });
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Visitor decision recorded' }),
    };
  } catch (error) {
    console.error('Error recording visitor decision:', error);
    if (error instanceof RequestError) {
      return {
        statusCode: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message }),
      };
    }
    return handleAuthError(error);
  }
};
