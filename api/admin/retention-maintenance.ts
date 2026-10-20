import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../server/actors.js';
import { decodeCursor, encodeCursor } from '../../server/cursor.js';
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

const PROTECTED_AUDIT_ACTIONS = [
  'initial_superadmin_bootstrapped',
  'superadmin_created',
  'admin_created',
  'admin_deleted',
  'device_registered',
  'device_deleted',
  'settings_updated',
  'device_credentials_updated',
  'user_role_and_status_changed',
  'user_role_changed',
  'user_reactivated',
  'user_deactivated',
  'maintenance.retention_run',
  'security_hold_created',
  'security_hold_released',
];

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
      visitorsEligible: 0,
      auditEventsCleaned: 0,
      reconciliationTasksCleaned: 0,
      verificationCodesCleaned: 0,
      errors: [] as string[],
    };

    // Scheduled cron runs respect automatic_cleanup_enabled; manual Super Admin execution is always allowed
    if (caller.isCron && !cleanupEnabled) {
      return jsonResponse(200, {
        success: true,
        result: 'skipped',
        reason: 'automatic_cleanup_disabled',
        maintenance: metrics,
      });
    }

    // =========================================================================
    // 1. EVIDENCE PURGE (REPAIR J: Persistent Maintenance Cursor to Prevent Starvation)
    // =========================================================================
    const evidenceJobName = 'retention_evidence_purge';
    const { data: mState } = await admin
      .from('maintenance_state')
      .select('cursor_value')
      .eq('job_name', evidenceJobName)
      .maybeSingle();

    let evidenceCursor = decodeCursor(mState?.cursor_value, { idType: 'uuid' });

    let evidenceQuery = admin
      .from('visitor_evidence')
      .select('id, visitor_id, bucket_id, object_path, expires_at')
      .is('purged_at', null)
      .lte('expires_at', now)
      .order('expires_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(batchSize);

    if (evidenceCursor?.timestamp && evidenceCursor.id) {
      evidenceQuery = evidenceQuery.or(
        `expires_at.gt.${evidenceCursor.timestamp},and(expires_at.eq.${evidenceCursor.timestamp},id.gt.${evidenceCursor.id})`
      );
    }

    let { data: expiredEvidence, error: evidenceError } = await evidenceQuery;

    // Wrap around to start if cursor reached the end of the unpurged queue
    if ((!expiredEvidence || expiredEvidence.length === 0) && evidenceCursor) {
      evidenceCursor = null;
      const wrapRes = await admin
        .from('visitor_evidence')
        .select('id, visitor_id, bucket_id, object_path, expires_at')
        .is('purged_at', null)
        .lte('expires_at', now)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(batchSize);
      expiredEvidence = wrapRes.data;
      evidenceError = wrapRes.error;
    }

    let nextEvidenceCursor: { timestamp: string; id: string } | null = null;

    if (evidenceError) {
      metrics.errors.push(`evidence_query_failed: ${evidenceError.message}`);
    } else if (expiredEvidence) {
      metrics.evidenceEligible = expiredEvidence.length;

      if (!dryRun) {
        for (const item of expiredEvidence) {
          // Advance cursor past this record regardless of whether it was held or purged
          nextEvidenceCursor = { timestamp: item.expires_at, id: item.id };

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
            // Delete storage object
            const delRes = await admin.storage.from(item.bucket_id).remove([item.object_path]);
            const storageDeleted = !delRes.error;

            if (storageDeleted) {
              const { error: finErr } = await admin
                .schema('api')
                .rpc('finalize_evidence_purge', {
                  requested_evidence_id: item.id,
                  requested_claim_id: claimId,
                  requested_success: true,
                });

              if (finErr) {
                metrics.errors.push(`finalize_failed_${item.id}: ${finErr.message}`);
                await recordReconciliation(
                  admin,
                  'image_purge_finalize_failed',
                  'visitor_evidence',
                  item.id,
                  finErr.message || 'db_finalize_failed',
                  { bucket_id: item.bucket_id, object_path: item.object_path, claimId, storageDeleted: true },
                ).catch(() => undefined);
              } else {
                metrics.evidencePurged++;
              }
            } else {
              metrics.errors.push(`storage_delete_failed_${item.id}: ${delRes.error?.message || 'unknown'}`);
              // Release claim safely on storage failure
              try {
                await admin
                  .schema('api')
                  .rpc('finalize_evidence_purge', {
                    requested_evidence_id: item.id,
                    requested_claim_id: claimId,
                    requested_success: false,
                  });
              } catch {
                // Best-effort release
              }

              await recordReconciliation(
                admin,
                'evidence.purge_storage_failed',
                'visitor_evidence',
                item.id,
                delRes.error?.message || 'storage_removal_error',
                { bucket_id: item.bucket_id, object_path: item.object_path, claimId },
              ).catch(() => undefined);
            }
          }
        }

        // Persist updated evidence cursor to maintenance_state
        const encodedCursor = nextEvidenceCursor
          ? encodeCursor(nextEvidenceCursor.timestamp, nextEvidenceCursor.id)
          : null;

        try {
          await admin
            .from('maintenance_state')
            .upsert({
              job_name: evidenceJobName,
              cursor_value: encodedCursor,
              last_started_at: now,
              last_completed_at: new Date().toISOString(),
              last_outcome: metrics.errors.length === 0 ? 'success' : (metrics.evidencePurged > 0 ? 'partial' : 'failure'),
            }, { onConflict: 'job_name' });
        } catch (err: unknown) {
          console.error('Failed to update maintenance_state cursor:', err);
        }
      }
    }

    // =========================================================================
    // 2. ABANDONED UPLOAD INTENTS (REPAIR I: Validate Both Storage and DB Ops)
    // =========================================================================
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
          const { error: removeErr } = await admin.storage.from(intent.bucket_id).remove([intent.object_path]);
          if (removeErr) {
            metrics.errors.push(`intent_storage_failed_${intent.id}: ${removeErr.message}`);
            await recordReconciliation(
              admin,
              'upload_intent.storage_delete_failed',
              'upload_intents',
              intent.id,
              removeErr.message,
              { bucket_id: intent.bucket_id, object_path: intent.object_path }
            ).catch(() => undefined);
            continue;
          }

          const { error: updateErr } = await admin
            .from('upload_intents')
            .update({ status: 'expired' })
            .eq('id', intent.id);

          if (updateErr) {
            metrics.errors.push(`intent_db_failed_${intent.id}: ${updateErr.message}`);
            await recordReconciliation(
              admin,
              'upload_intent.db_expire_failed',
              'upload_intents',
              intent.id,
              updateErr.message,
              { bucket_id: intent.bucket_id, object_path: intent.object_path, physical_deletion: true }
            ).catch(() => undefined);
          } else {
            metrics.abandonedIntentsCleaned++;
          }
        }
      } else {
        metrics.abandonedIntentsCleaned = abandonedIntents.length;
      }
    }

    // =========================================================================
    // 3. VISITOR PII ANONYMIZATION (REPAIR H2: visitor_retention_days)
    // =========================================================================
    const visitorRetentionDays = settings?.visitor_retention_days ?? 30;
    const visitorCutoff = new Date(Date.now() - visitorRetentionDays * 86_400_000).toISOString();

    const { data: candidateVisitors, error: visitorErr } = await admin
      .from('visitors')
      .select('id, created_at')
      .is('anonymized_at', null)
      .lte('created_at', visitorCutoff)
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (visitorErr) {
      metrics.errors.push(`visitor_query_failed: ${visitorErr.message}`);
    } else if (candidateVisitors && candidateVisitors.length > 0) {
      metrics.visitorsEligible = candidateVisitors.length;

      if (!dryRun) {
        for (const visitor of candidateVisitors) {
          // Check protection: active hold by visitor_id
          const { data: visitorHolds } = await admin
            .from('incident_holds')
            .select('id')
            .eq('visitor_id', visitor.id)
            .eq('active', true)
            .limit(1);

          if (visitorHolds && visitorHolds.length > 0) continue;

          // Check protection: active hold by pass belonging to this visitor
          const { data: passHolds } = await admin
            .from('incident_holds')
            .select('id, passes!inner(visitor_id)')
            .eq('passes.visitor_id', visitor.id)
            .eq('active', true)
            .limit(1);

          if (passHolds && passHolds.length > 0) continue;

          // Check protection: active, pending, or future issued passes
          const { data: activePasses } = await admin
            .from('passes')
            .select('id')
            .eq('visitor_id', visitor.id)
            .or(`status.in.(inside,pending),and(status.eq.issued,valid_until.gt.${now})`)
            .limit(1);

          if (activePasses && activePasses.length > 0) continue;

          // Anonymize personal fields while preserving relational IDs
          const { error: anonErr } = await admin
            .from('visitors')
            .update({
              full_name: '[Anonymized]',
              contact_number: '[Anonymized]',
              email: null,
              anonymized_at: now,
            })
            .eq('id', visitor.id)
            .is('anonymized_at', null);

          if (anonErr) {
            metrics.errors.push(`visitor_anonymize_failed_${visitor.id}: ${anonErr.message}`);
            await recordReconciliation(
              admin,
              'visitor.anonymize_failed',
              'visitors',
              visitor.id,
              anonErr.message,
              { visitor_id: visitor.id }
            ).catch(() => undefined);
          } else {
            metrics.visitorsAnonymized++;
          }
        }
      } else {
        metrics.visitorsAnonymized = candidateVisitors.length;
      }
    }

    // =========================================================================
    // 4. ADMINISTRATIVE AUDIT RETENTION (REPAIR H3: audit_retention_days)
    // =========================================================================
    const auditRetentionDays = settings?.audit_retention_days ?? 365;
    const auditCutoff = new Date(Date.now() - auditRetentionDays * 86_400_000).toISOString();

    const { data: auditCandidates, error: auditQueryErr } = await admin
      .from('audit_events')
      .select('id')
      .lt('occurred_at', auditCutoff)
      .not('action', 'in', `(${PROTECTED_AUDIT_ACTIONS.join(',')})`)
      .order('occurred_at', { ascending: true })
      .limit(batchSize);

    if (auditQueryErr) {
      metrics.errors.push(`audit_query_failed: ${auditQueryErr.message}`);
    } else if (auditCandidates && auditCandidates.length > 0) {
      if (!dryRun) {
        const auditIds = auditCandidates.map((a: any) => a.id);
        const { count, error: auditDelErr } = await admin
          .from('audit_events')
          .delete({ count: 'exact' })
          .in('id', auditIds);

        if (auditDelErr) {
          metrics.errors.push(`audit_cleanup_failed: ${auditDelErr.message}`);
        } else {
          metrics.auditEventsCleaned = count ?? 0;
        }
      } else {
        metrics.auditEventsCleaned = auditCandidates.length;
      }
    }

    // =========================================================================
    // 5. RECONCILIATION TASK RETENTION (REPAIR H4: reconciliation_retention_days)
    // =========================================================================
    const reconciliationRetentionDays = settings?.reconciliation_retention_days ?? 90;
    const reconCutoff = new Date(Date.now() - reconciliationRetentionDays * 86_400_000).toISOString();

    const { data: resolvedRecon, error: reconQueryErr } = await admin
      .from('reconciliation_tasks')
      .select('id')
      .eq('status', 'resolved')
      .lt('resolved_at', reconCutoff)
      .limit(batchSize);

    if (reconQueryErr) {
      metrics.errors.push(`reconciliation_query_failed: ${reconQueryErr.message}`);
    } else if (resolvedRecon && resolvedRecon.length > 0) {
      if (!dryRun) {
        const reconIds = resolvedRecon.map((r: any) => r.id);
        const { count, error: reconDelErr } = await admin
          .from('reconciliation_tasks')
          .delete({ count: 'exact' })
          .in('id', reconIds);

        if (reconDelErr) {
          metrics.errors.push(`reconciliation_cleanup_failed: ${reconDelErr.message}`);
        } else {
          metrics.reconciliationTasksCleaned = count ?? 0;
        }
      } else {
        metrics.reconciliationTasksCleaned = resolvedRecon.length;
      }
    }

    // =========================================================================
    // 6. EXPIRED VERIFICATION CODES (REPAIR H5: Handle Deletion Errors)
    // =========================================================================
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    if (!dryRun) {
      const { count, error: codeErr } = await admin
        .from('pass_email_verifications')
        .delete({ count: 'exact' })
        .lt('expires_at', oneDayAgo);

      if (codeErr) {
        metrics.errors.push(`verification_code_cleanup_failed: ${codeErr.message}`);
      } else {
        metrics.verificationCodesCleaned = count ?? 0;
      }
    }

    // =========================================================================
    // 7. RECORD AUDIT EVENT AND RETURN TRUTHFUL SEMANTICS (REPAIR K)
    // =========================================================================
    const hasWorkDone =
      metrics.evidencePurged > 0 ||
      metrics.abandonedIntentsCleaned > 0 ||
      metrics.visitorsAnonymized > 0 ||
      metrics.auditEventsCleaned > 0 ||
      metrics.reconciliationTasksCleaned > 0 ||
      metrics.verificationCodesCleaned > 0;

    const resultStatus: 'success' | 'partial' | 'failure' =
      metrics.errors.length === 0 ? 'success' : (hasWorkDone ? 'partial' : 'failure');

    const auditOutcome: 'success' | 'partial' | 'failure' = resultStatus;

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
      metrics.errors.push(`audit_insert_failed: ${auditError.message}`);
      await recordReconciliation(
        admin,
        'maintenance.audit_failed',
        'system',
        'retention_maintenance',
        auditError.message || 'audit_insert_error',
        { metrics, outcome: auditOutcome }
      ).catch(() => undefined);
    }

    return jsonResponse(resultStatus === 'failure' ? 500 : 200, {
      success: resultStatus !== 'failure',
      result: resultStatus,
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
