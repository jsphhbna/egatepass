import type { Handler } from '@netlify/functions';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { handleAuthError, requireAdmin } from './utils/auth';
import { createAdministrativeAudit } from './utils/audit';

const purposeSchema = z.object({
  label: z.string().trim().min(3).max(100),
  requiresDetails: z.boolean(),
  detailPrompt: z.string().trim().max(160),
}).strict().refine((purpose) => !purpose.requiresDetails || purpose.detailPrompt.length >= 3);

const workingHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  timezone: z.literal('Asia/Manila'),
}).strict().refine((hours) => hours.start < hours.end);

const settingsSchema = z.object({
  peakMode: z.boolean(),
  rejectionReasons: z.array(z.string().trim().min(1).max(160)).max(50),
  visitPurposes: z.array(purposeSchema).min(1).max(50),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  visitorRetentionDays: z.number().int().min(7).max(365).optional(),
  imageRetentionDays: z.number().int().min(1).max(90).optional(),
  auditRetentionDays: z.number().int().min(90).max(1095).optional(),
  reconciliationRetentionDays: z.number().int().min(30).max(365).optional(),
  automaticCleanupEnabled: z.boolean().optional(),
  workingHours: workingHoursSchema.optional(),
}).strict();

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  if ((event.body?.length || 0) > 32768) return jsonResponse(413, { error: 'Request body is too large' });

  try {
    const actor = await requireAdmin(event.headers.authorization || event.headers.Authorization);
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      throw new RequestError(400, 'Invalid JSON body');
    }
    const parsed = settingsSchema.safeParse(rawBody);
    if (!parsed.success) throw new RequestError(400, 'Invalid settings');
    const changesRetention = parsed.data.retentionDays !== undefined || parsed.data.visitorRetentionDays !== undefined || parsed.data.imageRetentionDays !== undefined || parsed.data.auditRetentionDays !== undefined || parsed.data.reconciliationRetentionDays !== undefined || parsed.data.automaticCleanupEnabled !== undefined;
    if (actor.role !== 'superadmin' && (changesRetention || parsed.data.workingHours !== undefined)) {
      throw new RequestError(403, 'Only Super Admins may change security-sensitive settings');
    }

    const db = getFirestore();
    const settingsRef = db.collection('settings').doc('app');
    const actorRef = db.collection('users').doc(actor.uid);
    const changed = await db.runTransaction(async (transaction) => {
      const [actorSnapshot, settingsSnapshot] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(settingsRef),
      ]);
      const currentActor = actorSnapshot.data();
      if (
        !actorSnapshot.exists ||
        currentActor?.active !== true ||
        (currentActor?.role !== 'admin' && currentActor?.role !== 'superadmin')
      ) {
        throw new RequestError(403, 'Actor account is no longer authorized');
      }
      if (currentActor.role !== 'superadmin' && (changesRetention || parsed.data.workingHours !== undefined)) {
        throw new RequestError(403, 'Only Super Admins may change security-sensitive settings');
      }

      const previous = settingsSnapshot.data() || {};
      const update = {
        peakMode: parsed.data.peakMode,
        rejectionReasons: [...new Set(parsed.data.rejectionReasons)],
        visitPurposes: parsed.data.visitPurposes,
        ...(parsed.data.retentionDays !== undefined ? { retentionDays: parsed.data.retentionDays } : {}),
        ...(parsed.data.visitorRetentionDays !== undefined ? { visitorRetentionDays: parsed.data.visitorRetentionDays } : {}),
        ...(parsed.data.imageRetentionDays !== undefined ? { imageRetentionDays: parsed.data.imageRetentionDays } : {}),
        ...(parsed.data.auditRetentionDays !== undefined ? { auditRetentionDays: parsed.data.auditRetentionDays } : {}),
        ...(parsed.data.reconciliationRetentionDays !== undefined ? { reconciliationRetentionDays: parsed.data.reconciliationRetentionDays } : {}),
        ...(parsed.data.automaticCleanupEnabled !== undefined ? { automaticCleanupEnabled: parsed.data.automaticCleanupEnabled } : {}),
        ...(parsed.data.workingHours !== undefined ? { workingHours: parsed.data.workingHours } : {}),
        ...(!settingsSnapshot.exists ? { retentionDays: parsed.data.retentionDays ?? 30 } : {}),
      };
      const changedFields = Object.keys(update).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(update[key as keyof typeof update]));
      if (changedFields.length === 0) return false;

      transaction.set(settingsRef, update, { merge: true });
      createAdministrativeAudit(transaction, db, {
        action: 'settings_updated',
        actorUid: actor.uid,
        actorRole: currentActor.role,
        targetType: 'settings',
        targetId: 'app',
        result: 'success',
        metadata: {
          changedFields,
          previousPeakMode: previous.peakMode === true,
          newPeakMode: update.peakMode,
          previousRetentionDays: typeof previous.retentionDays === 'number' ? previous.retentionDays : null,
          newRetentionDays: 'retentionDays' in update ? update.retentionDays : previous.retentionDays ?? null,
          previousWorkingHours: previous.workingHours ?? null,
          newWorkingHours: 'workingHours' in update ? update.workingHours : previous.workingHours ?? null,
          rejectionReasonCount: update.rejectionReasons.length,
          visitPurposeCount: update.visitPurposes.length,
        },
      });
      return true;
    });

    return jsonResponse(200, { message: changed ? 'Settings updated successfully' : 'Settings are unchanged', changed });
  } catch (error) {
    if (error instanceof RequestError) return jsonResponse(error.statusCode, { error: error.message });
    console.error('Error updating settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    return handleAuthError(error);
  }
};
