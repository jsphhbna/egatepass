import {
  FieldPath,
  Timestamp,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { recordReconciliationTask } from './reconciliation';

export interface CleanupResult {
  scanned: number;
  eligible: number;
  deleted: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
  cursorAdvanced: boolean;
}

export const CLOSED_PASS_STATUSES = new Set(['exited', 'rejected', 'expired']);
export const PROTECTED_AUDIT_ACTIONS = new Set([
  'initial_superadmin_bootstrapped', 'superadmin_created', 'admin_created', 'admin_deleted',
  'device_registered', 'device_deleted', 'settings_updated', 'device_credentials_updated',
  'user_role_and_status_changed', 'user_role_changed', 'user_reactivated', 'user_deactivated',
  'image_delivery_migration',
]);

interface CleanupCursor {
  sortMillis: number;
  documentId: string;
}

const STATE_COLLECTION = 'maintenanceState';
const STATE_DOCUMENT = 'retentionCleanup';
const MAX_DEPENDENT_RECORDS_PER_KIND = 200;

export function isClosedPassStatus(status: unknown): boolean {
  return typeof status === 'string' && CLOSED_PASS_STATUSES.has(status);
}

export function isProtectedAuditAction(action: unknown): boolean {
  return typeof action === 'string' && PROTECTED_AUDIT_ACTIONS.has(action);
}

const result = (): CleanupResult => ({
  scanned: 0,
  eligible: 0,
  deleted: 0,
  skipped: 0,
  failed: 0,
  hasMore: false,
  cursorAdvanced: false,
});

const cutoff = (days: number) => Timestamp.fromMillis(Date.now() - days * 86_400_000);

function parseCursor(value: unknown): CleanupCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sortMillis === 'number' && typeof candidate.documentId === 'string'
    ? { sortMillis: candidate.sortMillis, documentId: candidate.documentId }
    : null;
}

async function loadCursor(db: Firestore, field: string): Promise<CleanupCursor | null> {
  const snapshot = await db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT).get();
  return parseCursor(snapshot.data()?.[field]);
}

function timestampMillis(snapshot: QueryDocumentSnapshot, field: string): number | null {
  const value = snapshot.data()[field];
  return typeof value?.toMillis === 'function' ? value.toMillis() : null;
}

async function finishPage(
  db: Firestore,
  field: string,
  docs: QueryDocumentSnapshot[],
  pageLimit: number,
  sortField: string,
  summary: CleanupResult,
): Promise<void> {
  const last = docs.at(-1);
  const sortMillis = last ? timestampMillis(last, sortField) : null;
  const hasMore = docs.length === pageLimit;
  summary.hasMore = hasMore;
  summary.cursorAdvanced = Boolean(last && sortMillis !== null);
  await db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT).set({
    [field]: hasMore && last && sortMillis !== null
      ? { sortMillis, documentId: last.id }
      : null,
    updatedAt: Timestamp.now(),
  }, { merge: true });
}

function withCursor(query: Query, cursor: CleanupCursor | null): Query {
  return cursor
    ? query.startAfter(Timestamp.fromMillis(cursor.sortMillis), cursor.documentId)
    : query;
}

async function recordCleanupFailure(
  db: Firestore,
  operation: string,
  targetUid: string,
  reason: string,
  requiredActions: string[],
): Promise<void> {
  const reference = `retention_${operation}_${targetUid}`;
  const recorded = await recordReconciliationTask(db, {
    reference,
    operation,
    targetUid,
    actorUid: 'system',
    reason,
    requiredActions,
  });
  if (!recorded) {
    console.error('CRITICAL: Retention failure could not be added to reconciliation', { operation, targetUid });
  }
}

export async function cleanupHistoricalVisits(db: Firestore, days: number, pageLimit = 10): Promise<CleanupResult> {
  const summary = result();
  const cursorField = 'historicalVisitsCursor';
  const cursor = await loadCursor(db, cursorField);
  const baseQuery = db.collection('gatePasses')
    .where('status', 'in', [...CLOSED_PASS_STATUSES])
    .where('issuedAt', '<=', cutoff(days))
    .orderBy('issuedAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  const passes = await withCursor(baseQuery, cursor).limit(pageLimit).get();
  summary.scanned = passes.size;

  for (const pass of passes.docs) {
    const data = pass.data();
    if (!isClosedPassStatus(data.status) || typeof data.visitorId !== 'string') {
      summary.skipped++;
      continue;
    }
    const visitor = await db.collection('visitors').doc(data.visitorId).get();
    const [otherPasses, pendingForPass, pendingForVisitor] = await Promise.all([
      db.collection('gatePasses').where('visitorId', '==', data.visitorId).limit(2).get(),
      db.collection('reconciliationTasks').where('status', '==', 'pending').where('targetUid', '==', pass.id).limit(1).get(),
      db.collection('reconciliationTasks').where('status', '==', 'pending').where('targetUid', '==', data.visitorId).limit(1).get(),
    ]);
    if (!visitor.exists || visitor.data()?.imagesPurgedAt == null || otherPasses.size !== 1 || !pendingForPass.empty || !pendingForVisitor.empty) {
      summary.skipped++;
      continue;
    }
    summary.eligible++;
    try {
      const [logs, uploads] = await Promise.all([
        db.collection('visitLogs').where('passToken', '==', pass.id).limit(MAX_DEPENDENT_RECORDS_PER_KIND + 1).get(),
        db.collection('imageUploads').where('passId', '==', pass.id).limit(MAX_DEPENDENT_RECORDS_PER_KIND + 1).get(),
      ]);
      if (logs.size > MAX_DEPENDENT_RECORDS_PER_KIND || uploads.size > MAX_DEPENDENT_RECORDS_PER_KIND) {
        throw new Error('Dependent record count exceeds the bounded cleanup batch');
      }
      const batch = db.batch();
      logs.docs.forEach((item) => batch.delete(item.ref));
      uploads.docs.forEach((item) => batch.delete(item.ref));
      batch.delete(pass.ref);
      batch.delete(visitor.ref);
      await batch.commit();
      summary.deleted++;
    } catch (error) {
      summary.failed++;
      await recordCleanupFailure(
        db,
        'historical_visit_cleanup_failed',
        pass.id,
        'A closed visitor/pass record could not be removed in its bounded cleanup batch',
        ['Inspect dependent visit logs and upload metadata', 'Complete or retry the bounded parent-last cleanup'],
      );
      console.error('Historical visit cleanup requires reconciliation', {
        passId: pass.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await finishPage(db, cursorField, passes.docs, pageLimit, 'issuedAt', summary);
  return summary;
}

export async function cleanupAuditLogs(db: Firestore, days: number, pageLimit = 25): Promise<CleanupResult> {
  const summary = result();
  const cursorField = 'auditLogsCursor';
  const cursor = await loadCursor(db, cursorField);
  const baseQuery = db.collection('auditLogs')
    .where('timestamp', '<=', cutoff(days))
    .orderBy('timestamp', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  const docs = await withCursor(baseQuery, cursor).limit(pageLimit).get();
  summary.scanned = docs.size;
  for (const item of docs.docs) {
    if (isProtectedAuditAction(item.data().action)) {
      summary.skipped++;
      continue;
    }
    summary.eligible++;
    try {
      await item.ref.delete();
      summary.deleted++;
    } catch (error) {
      summary.failed++;
      await recordCleanupFailure(
        db,
        'audit_log_cleanup_failed',
        item.id,
        'An eligible ordinary audit event could not be removed',
        ['Review the audit record and retry deletion without removing protected security history'],
      );
      console.error('Audit cleanup requires reconciliation', {
        auditId: item.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  await finishPage(db, cursorField, docs.docs, pageLimit, 'timestamp', summary);
  return summary;
}

export async function cleanupResolvedReconciliation(db: Firestore, days: number, pageLimit = 25): Promise<CleanupResult> {
  const summary = result();
  const cursorField = 'resolvedReconciliationCursor';
  const cursor = await loadCursor(db, cursorField);
  const baseQuery = db.collection('reconciliationTasks')
    .where('status', '==', 'resolved')
    .where('createdAt', '<=', cutoff(days))
    .orderBy('createdAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  const docs = await withCursor(baseQuery, cursor).limit(pageLimit).get();
  summary.scanned = docs.size;
  summary.eligible = docs.size;
  for (const item of docs.docs) {
    try {
      await item.ref.delete();
      summary.deleted++;
    } catch (error) {
      summary.failed++;
      console.error('Resolved reconciliation cleanup failed and will be retried on the next cursor cycle', {
        reconciliationId: item.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  await finishPage(db, cursorField, docs.docs, pageLimit, 'createdAt', summary);
  return summary;
}

// Free-tier-safe expiry maintenance: expiresAt remains ordinary Firestore data,
// and this bounded scheduled pass is the only deletion mechanism.
export async function cleanupExpiredRateLimits(db: Firestore, pageLimit = 50): Promise<CleanupResult> {
  const summary = result();
  const docs = await db.collection('rateLimits')
    .where('expiresAt', '<=', Timestamp.now())
    .orderBy('expiresAt', 'asc')
    .limit(pageLimit)
    .get();
  summary.scanned = docs.size;
  summary.eligible = docs.size;
  if (!docs.empty) {
    try {
      const batch = db.batch();
      docs.docs.forEach((item) => batch.delete(item.ref));
      await batch.commit();
      summary.deleted = docs.size;
    } catch (error) {
      summary.failed = docs.size;
      console.error('Expired rate-limit state cleanup failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  summary.hasMore = docs.size === pageLimit;
  summary.cursorAdvanced = false;
  return summary;
}
