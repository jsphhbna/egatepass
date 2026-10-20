import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../server/actors.js';
import { jsonResponse, readBearerToken } from '../../server/http.js';
import { getServerSupabaseClients } from '../../server/supabase.js';

const maintenanceSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(200).default(50),
}).strict();

interface CallerContext {
  isCron: boolean;
  actorId?: string;
  role?: string;
}

async function authenticateMaintenance(request: Request, admin: any): Promise<CallerContext> {
  const authHeader = request.headers.get('authorization') || '';
  const cronSecret = process.env.CRON_SECRET?.trim();

  // 1. Check for Vercel Cron Bearer secret
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { isCron: true };
  }

  // 2. Otherwise require Super Admin staff session
  const token = readBearerToken(request);
  if (!token) {
    throw new HttpError(401, 'authentication_required');
  }

  const staff = await requireStaffActor(admin, token, ['superadmin']);
  return {
    isCron: false,
    actorId: staff.id,
    role: staff.role,
  };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST, GET' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const caller = await authenticateMaintenance(request, admin);

    let dryRun = false;
    let batchSize = 50;

    if (request.method === 'GET') {
      const url = new URL(request.url);
      dryRun = url.searchParams.get('dryRun') === 'true';
      const b = parseInt(url.searchParams.get('batchSize') || '50', 10);
      batchSize = Math.min(Math.max(Number.isFinite(b) ? b : 50, 1), 200);
    } else {
      const text = await request.text().catch(() => '');
      if (text.trim().length > 0) {
        const parsed = maintenanceSchema.safeParse(JSON.parse(text));
        if (parsed.success) {
          dryRun = parsed.data.dryRun;
          batchSize = parsed.data.batchSize;
        }
      }
    }

    // Load retention settings
    const { data: settings } = await admin
      .from('app_settings')
      .select('automatic_cleanup_enabled, image_retention_days, visitor_retention_days, reconciliation_retention_days, audit_retention_days')
      .eq('singleton', true)
      .maybeSingle();

    const cleanupEnabled = settings?.automatic_cleanup_enabled ?? true;
    const now = new Date().toISOString();

    const metrics = {
      timestamp: now,
      dryRun,
      callerType: caller.isCron ? 'cron' : 'superadmin',
      evidencePurged: 0,
      evidenceEligible: 0,
      abandonedIntentsCleaned: 0,
      visitorsAnonymized: 0,
      verificationCodesCleaned: 0,
      errors: [] as string[],
    };

    // REPAIR 5C: Enforce automatic_cleanup_enabled on scheduled cron runs
    if (caller.isCron && !cleanupEnabled) {
      return jsonResponse(200, {
        success: true,
        skipped: true,
        reason: 'automatic_cleanup_disabled',
        maintenance: metrics,
      });
    }

    // 1. Evidence Purge (oversample candidates to prevent hold starvation - REPAIR 5G)
    const oversampleLimit = Math.min(batchSize * 3, 300);
    const { data: expiredEvidence, error: evidenceError } = await admin
      .from('visitor_evidence')
      .select('id, visitor_id, bucket_id, object_path')
      .is('purged_at', null)
      .lte('expires_at', now)
      .order('expires_at', { ascending: true })
      .limit(oversampleLimit);

    if (evidenceError) {
      metrics.errors.push(`evidence_query_failed: ${evidenceError.message}`);
    } else if (expiredEvidence) {
      metrics.evidenceEligible = expiredEvidence.length;

      if (!dryRun) {
        let processedCount = 0;
        for (const item of expiredEvidence) {
          if (processedCount >= batchSize) break;

          const claimId = randomUUID();
          const { data: claimData, error: claimErr } = await admin
            .schema('api')
            .rpc('claim_evidence_for_purge', {
              requested_evidence_id: item.id,
              requested_claim_id: claimId,
            });

          if (claimErr) {
            metrics.errors.push(`claim_failed_${item.id}: ${claimErr.message}`);
            continue;
          }

          if (claimData?.claimed) {
            processedCount++;
            // Delete storage object
            const delRes = await admin.storage.from(item.bucket_id).remove([item.object_path]);
            const storageDeleted = !delRes.error;

            if (storageDeleted) {
              // REPAIR 5A: Canonically pass requested_success: true
              const { error: finErr } = await admin
                .schema('api')
                .rpc('finalize_evidence_purge', {
                  requested_evidence_id: item.id,
                  requested_claim_id: claimId,
                  requested_success: true,
                });

              if (finErr) {
                metrics.errors.push(`finalize_failed_${item.id}: ${finErr.message}`);
                // REPAIR 5B: Storage deleted, but DB finalize failed. Record reconciliation
                await recordReconciliation(
                  admin,
                  'image_purge_finalize_failed',
                  'visitor_evidence',
                  item.id,
                  finErr.message || 'db_finalize_failed',
                  { bucket_id: item.bucket_id, object_path: item.object_path, claimId, storageDeleted: true },
                );
              } else {
                metrics.evidencePurged++;
              }
            } else {
              metrics.errors.push(`storage_delete_failed_${item.id}: ${delRes.error?.message || 'unknown'}`);
              await recordReconciliation(
                admin,
                'evidence.purge_storage_failed',
                'visitor_evidence',
                item.id,
                delRes.error?.message || 'storage_removal_error',
                { bucket_id: item.bucket_id, object_path: item.object_path, claimId },
              );
            }
          }
        }
      }
    }

    // 2. Abandoned Upload Intents (pending and expired over 1 hour ago)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data: abandonedIntents, error: intentError } = await admin
      .from('upload_intents')
      .select('id, bucket_id, object_path')
      .eq('status', 'pending')
      .lt('expires_at', oneHourAgo)
      .limit(batchSize);

    if (intentError) {
      metrics.errors.push(`intent_query_failed: ${intentError.message}`);
    } else if (abandonedIntents && abandonedIntents.length > 0) {
      if (!dryRun) {
        for (const intent of abandonedIntents) {
          await admin.storage.from(intent.bucket_id).remove([intent.object_path]);
          await admin.from('upload_intents').update({ status: 'expired' }).eq('id', intent.id);
          metrics.abandonedIntentsCleaned++;
        }
      } else {
        metrics.abandonedIntentsCleaned = abandonedIntents.length;
      }
    }

    // 3. Expired Verification Codes (older than 24h)
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    if (!dryRun) {
      const { count } = await admin
        .from('pass_email_verifications')
        .delete({ count: 'exact' })
        .lt('expires_at', oneDayAgo);
      metrics.verificationCodesCleaned = count ?? 0;
    }

    // 4. Record audit event (REPAIR 5E: valid outcome enum, REPAIR 5F: check error)
    const auditOutcome: 'success' | 'partial' | 'failure' =
      metrics.errors.length === 0 ? 'success' : (metrics.evidencePurged > 0 ? 'partial' : 'failure');

    const { error: auditError } = await admin.from('audit_events').insert({
      actor_id: caller.actorId ?? null,
      actor_kind: caller.isCron ? 'system' : 'staff',
      actor_role: caller.isCron ? 'cron' : 'superadmin',
      action: 'maintenance.retention_run',
      target_type: 'system',
      target_id: 'retention_maintenance',
      outcome: auditOutcome,
      after_state: metrics,
    });

    if (auditError) {
      console.error('Audit recording failed during maintenance run:', auditError);
      await recordReconciliation(
        admin,
        'maintenance.audit_failed',
        'system',
        'retention_maintenance',
        auditError.message || 'audit_insert_error',
        { metrics, outcome: auditOutcome }
      ).catch(() => undefined);
    }

    return jsonResponse(200, {
      success: true,
      maintenance: metrics,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Retention maintenance failed:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(500, { error: 'retention_maintenance_failed' });
  }
}

export default { fetch: handleRequest };
