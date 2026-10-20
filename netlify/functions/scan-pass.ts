import type { Handler } from '@netlify/functions';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { adminAuth } from './firebase-admin';
import { closedPassImageExpiryUpdate } from './utils/image-lifecycle';

const scanSchema = z.object({
  passId: z.string().min(1).max(200).refine((value) => !value.includes('/')),
  mode: z.enum(['entry', 'exit']),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

type ScanResult =
  | { ok: true; status: 'pending' | 'exited'; message: string }
  | { ok: false; statusCode: number; code: string; message: string };

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function authErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function invalidResult(mode: 'entry' | 'exit', status: unknown): { code: string; message: string } {
  const entryResults: Record<string, { code: string; message: string }> = {
    pending: { code: 'already_scanned', message: 'Already scanned — awaiting guard approval' },
    inside: { code: 'already_scanned', message: 'Visitor is already inside' },
    rejected: { code: 'rejected', message: 'This pass was rejected' },
    exited: { code: 'already_used', message: 'This pass has already been used' },
    expired: { code: 'expired', message: 'This pass has expired' },
  };
  const exitResults: Record<string, { code: string; message: string }> = {
    issued: { code: 'not_entered', message: 'Visitor has not entered yet' },
    pending: { code: 'pending', message: 'Entry is still pending approval' },
    rejected: { code: 'rejected', message: 'This pass was rejected' },
    exited: { code: 'already_exited', message: 'Visitor has already exited' },
    expired: { code: 'expired', message: 'This pass has expired' },
  };
  return (mode === 'entry' ? entryResults[String(status)] : exitResults[String(status)]) || {
    code: 'unknown',
    message: 'Unknown pass status',
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 2048) return jsonResponse(413, { error: 'Request body is too large' });

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) throw new RequestError(401, 'Missing or invalid token');
    const decoded = await adminAuth.verifyIdToken(authHeader.slice('Bearer '.length));
    if (decoded.email_verified !== true) throw new RequestError(403, 'Device account is not verified');

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const parsed = scanSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid request body');
    const request = parsed.data;
    const db = getFirestore();
    const deviceRef = db.collection('devices').doc(decoded.uid);
    const passRef = db.collection('gatePasses').doc(request.passId);
    const logRef = db.collection('visitLogs').doc();

    const result = await db.runTransaction<ScanResult>(async (transaction) => {
      const [deviceSnapshot, passSnapshot] = await Promise.all([
        transaction.get(deviceRef),
        transaction.get(passRef),
      ]);
      const device = deviceSnapshot.data();
      if (
        !deviceSnapshot.exists ||
        device?.status !== 'active' ||
        device?.type !== request.mode ||
        typeof device?.gate !== 'string' ||
        device.gate.trim().length === 0
      ) {
        throw new RequestError(403, `An active ${request.mode} scanner is required`);
      }

      if (!passSnapshot.exists) {
        transaction.create(logRef, {
          passToken: request.passId,
          visitorId: null,
          event: 'invalid_scan',
          reason: 'QR code not recognized',
          deviceId: decoded.uid,
          gate: device.gate,
          guardUid: null,
          timestamp: FieldValue.serverTimestamp(),
        });
        return { ok: false, statusCode: 404, code: 'not_found', message: 'QR code not recognized' };
      }

      const pass = passSnapshot.data();
      const visitorId = typeof pass?.visitorId === 'string' ? pass.visitorId : null;
      const visitorRef = visitorId ? db.collection('visitors').doc(visitorId) : null;
      const visitorSnapshot = visitorRef ? await transaction.get(visitorRef) : null;
      const now = Timestamp.now();
      let outcome: ScanResult;

      if (!visitorId) {
        outcome = { ok: false, statusCode: 409, code: 'invalid_pass', message: 'Pass is missing its visitor record' };
      } else if (request.mode === 'entry' && pass?.status === 'issued') {
        const validFromMillis = typeof pass.validFrom?.toMillis === 'function' ? pass.validFrom.toMillis() : null;
        const validUntilMillis = typeof pass.validUntil?.toMillis === 'function' ? pass.validUntil.toMillis() : null;
        if (validFromMillis === null || validUntilMillis === null || validUntilMillis <= validFromMillis) {
          outcome = { ok: false, statusCode: 409, code: 'invalid_pass', message: 'Pass validity is invalid' };
        } else if (validUntilMillis < now.toMillis()) {
          transaction.update(passRef, { status: 'expired' });
          const expiryUpdate = closedPassImageExpiryUpdate(visitorSnapshot?.data());
          if (visitorRef && visitorSnapshot?.exists && expiryUpdate) transaction.update(visitorRef, expiryUpdate);
          outcome = { ok: false, statusCode: 409, code: 'expired', message: 'This pass has expired' };
        } else if (validFromMillis > now.toMillis()) {
          outcome = { ok: false, statusCode: 409, code: 'early', message: 'Pass is not yet valid' };
        } else {
          transaction.update(passRef, {
            status: 'pending',
            scannedAt: FieldValue.serverTimestamp(),
            entryDeviceId: decoded.uid,
            gate: device.gate,
          });
          transaction.create(logRef, {
            passToken: request.passId,
            visitorId,
            event: 'scan_entry',
            reason: null,
            deviceId: decoded.uid,
            gate: device.gate,
            guardUid: null,
            timestamp: FieldValue.serverTimestamp(),
          });
          return { ok: true, status: 'pending', message: 'Scanned! Waiting for guard approval…' };
        }
      } else if (request.mode === 'exit' && pass?.status === 'inside') {
        transaction.update(passRef, {
          status: 'exited',
          timeOut: FieldValue.serverTimestamp(),
          exitDeviceId: decoded.uid,
        });
        const expiryUpdate = closedPassImageExpiryUpdate(visitorSnapshot?.data());
        if (visitorRef && visitorSnapshot?.exists && expiryUpdate) transaction.update(visitorRef, expiryUpdate);
        transaction.create(logRef, {
          passToken: request.passId,
          visitorId,
          event: 'scan_exit',
          reason: null,
          deviceId: decoded.uid,
          gate: device.gate,
          guardUid: null,
          timestamp: FieldValue.serverTimestamp(),
        });
        return { ok: true, status: 'exited', message: 'Exit recorded. Goodbye!' };
      } else {
        const invalid = invalidResult(request.mode, pass?.status);
        outcome = { ok: false, statusCode: 409, ...invalid };
      }

      transaction.create(logRef, {
        passToken: request.passId,
        visitorId,
        event: 'invalid_scan',
        reason: outcome.message,
        deviceId: decoded.uid,
        gate: device.gate,
        guardUid: null,
        timestamp: FieldValue.serverTimestamp(),
      });
      return outcome;
    });

    return result.ok
      ? jsonResponse(200, result)
      : jsonResponse(result.statusCode, { error: result.message, code: result.code });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    if (authErrorCode(error)?.startsWith('auth/')) return jsonResponse(401, { error: 'Invalid or expired token' });
    console.error('Scanner transaction failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return jsonResponse(500, { error: 'Scan could not be processed' });
  }
};
