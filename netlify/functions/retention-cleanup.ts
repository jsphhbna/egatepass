import { schedule, type HandlerEvent, type HandlerContext } from '@netlify/functions';
import { handler as purgeImages } from './purge-images';
import { getFirestore } from 'firebase-admin/firestore';
import {
  cleanupAuditLogs,
  cleanupExpiredRateLimits,
  cleanupHistoricalVisits,
  cleanupResolvedReconciliation,
  type CleanupResult,
} from './utils/retention-maintenance';
import { writeAdministrativeAudit } from './utils/audit';

async function runCleanupCategory(name: string, operation: () => Promise<CleanupResult>): Promise<CleanupResult> {
  try {
    return await operation();
  } catch (error) {
    console.error(`Scheduled ${name} cleanup failed`, { error: error instanceof Error ? error.message : 'Unknown error' });
    return { scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 1, hasMore: true, cursorAdvanced: false };
  }
}

// Netlify invokes this internal scheduled function daily. The delegated handler
// still requires CRON_SECRET, so direct HTTP calls cannot trigger cleanup.
export const handler = schedule('@daily', async () => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('Scheduled retention cleanup is disabled: CRON_SECRET is not configured');
    return { statusCode: 500, body: JSON.stringify({ error: 'Scheduled cleanup is not configured' }) };
  }
  const db = getFirestore();
  const settings = (await db.collection('settings').doc('app').get()).data() || {};
  if (settings.automaticCleanupEnabled === false) return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'Automatic cleanup is disabled' }) };
  let response: Awaited<ReturnType<typeof purgeImages>> | undefined;
  let image: Record<string, unknown> = {};
  try {
    response = await purgeImages({
      httpMethod: 'POST', headers: { 'x-cron-secret': secret }, body: '{}',
    } as unknown as HandlerEvent, {} as HandlerContext);
    image = response ? JSON.parse(response.body || '{}') as Record<string, unknown> : { error: 'Scheduled image cleanup did not return a result' };
  } catch (error) {
    console.error('Scheduled image cleanup failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    image = { error: 'Scheduled image cleanup failed' };
  }
  const visitor = await runCleanupCategory('visitor', () => cleanupHistoricalVisits(db, typeof settings.visitorRetentionDays === 'number' ? settings.visitorRetentionDays : 30));
  const audit = await runCleanupCategory('audit', () => cleanupAuditLogs(db, typeof settings.auditRetentionDays === 'number' ? settings.auditRetentionDays : 365));
  const reconciliation = await runCleanupCategory('reconciliation', () => cleanupResolvedReconciliation(db, typeof settings.reconciliationRetentionDays === 'number' ? settings.reconciliationRetentionDays : 90));
  const rateLimitState = await runCleanupCategory('rate-limit state', () => cleanupExpiredRateLimits(db));
  const failed = visitor.failed + audit.failed + reconciliation.failed + rateLimitState.failed + (!response || response.statusCode >= 400 ? 1 : 0);
  const categories = { image, visitor, audit, reconciliation, rateLimitState };
  await writeAdministrativeAudit(db, {
    action: 'scheduled_retention_cleanup', actorUid: 'system', actorRole: 'system',
    targetType: 'retention', targetId: 'daily', result: failed ? 'partial' : 'success', metadata: categories,
  });
  return { statusCode: failed ? 207 : 200, body: JSON.stringify({ categories, partial: failed > 0 }) };
});
