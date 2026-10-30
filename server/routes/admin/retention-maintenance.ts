import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { decodeCursor, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const maintenanceSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(200).default(50),
}).strict();

interface CallerContext {
  isCron: boolean;
  actorId?: string;
  role?: string;
}

export const CLOSED_PASS_STATUSES = new Set(['exited', 'rejected', 'expired']);

export const PROTECTED_AUDIT_ACTIONS = [
  // Canonical runtime actions (current vocabulary)
  'superadmin.bootstrap',
  'staff.create',
  'staff.update',
  'device.create',
  'device.update',
  'device.retire',
  'device.password_update',
  'settings_updated',
  'maintenance.retention_run',
  'security_hold_created',
  'incident_hold.released',

  // Backward-compatible legacy aliases (historical retention preservation)
  'initial_superadmin_bootstrapped',
  'superadmin_created',
  'admin_created',
  'admin_deleted',
  'device_registered',
  'device_deleted',
  'device_credentials_updated',
  'user_role_and_status_changed',
  'user_role_changed',
  'user_reactivated',
  'user_deactivated',
  'security_hold_released',
];

export function isClosedPassStatus(status: unknown): boolean {
  return typeof status === 'string' && CLOSED_PASS_STATUSES.has(status);
}

export function isProtectedAuditAction(action: unknown): boolean {
  return typeof action === 'string' && PROTECTED_AUDIT_ACTIONS.includes(action);
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

    // Load retention settings (fail-closed if authoritative settings cannot be retrieved)
    const { data: settings, error: settingsError } = await admin
      .from('app_settings')
      .select('automatic_cleanup_enabled, image_retention_days, visitor_retention_days, reconciliation_retention_days, audit_retention_days')
      .eq('singleton', true)
      .maybeSingle();

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
      rateLimitBucketsCleaned: 0,
      anonymousAuthEligible: 0,
      anonymousAuthDeleted: 0,
      anonymousAuthDeleteFailures: 0,
      returningProfilesCleaned: 0,
      returningAttemptsCleaned: 0,
      errors: [] as string[],
    };

    if (settingsError || !settings) {
      const errorMsg = settingsError?.message || 'missing_authoritative_settings';
      metrics.errors.push(`settings_query_failed: ${errorMsg}`);

      await recordReconciliation(
        admin,
        'maintenance.settings_failed',
        'app_settings',
        'singleton',
        errorMsg,
        { callerType: metrics.callerType }
      ).catch(() => undefined);

      const { error: settingsAuditError } = await admin.from('audit_events').insert({
        actor_id: caller.actorId ?? null,
        actor_kind: caller.isCron ? 'system' : 'staff',
        actor_role: caller.isCron ? 'cron' : 'superadmin',
        action: 'maintenance.retention_run',
        target_type: 'system',
        target_id: 'retention_maintenance',
        outcome: 'failure',
        after_state: metrics,
      });

      if (settingsAuditError) {
        metrics.errors.push(`audit_insert_failed: ${settingsAuditError.message || 'audit_insert_failed'}`);
        const recRecorded = await recordReconciliation(
          admin,
          'maintenance.audit_insert_failed',
          'system',
          'retention_maintenance',
          settingsAuditError.message || 'audit_insert_failed',
          { callerType: metrics.callerType, stage: 'settings_failure' }
        ).catch(() => false);
        if (!recRecorded) {
          metrics.errors.push('reconciliation_task_failed: audit_failure_unrecorded');
        }
      }

      return jsonResponse(500, {
        success: false,
        result: 'failure',
        reason: 'settings_unavailable',
        maintenance: metrics,
      });
    }

    const cleanupEnabled = settings.automatic_cleanup_enabled ?? true;

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
    const { data: mState, error: mStateErr } = await admin
      .from('maintenance_state')
      .select('cursor_value')
      .eq('job_name', evidenceJobName)
      .maybeSingle();

    if (mStateErr) {
      metrics.errors.push(`maintenance_state_query_failed: ${mStateErr.message}`);
    }

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

        const { error: upsertError } = await admin
          .from('maintenance_state')
          .upsert({
            job_name: evidenceJobName,
            cursor_value: encodedCursor,
            last_started_at: now,
            last_completed_at: new Date().toISOString(),
            last_outcome: metrics.errors.length === 0 ? 'success' : (metrics.evidencePurged > 0 ? 'partial' : 'failure'),
          }, { onConflict: 'job_name' });

        if (upsertError) {
          console.error('Failed to update maintenance_state cursor:', upsertError);
          metrics.errors.push(`maintenance_cursor_upsert_failed: ${upsertError.message}`);
          await recordReconciliation(
            admin,
            'maintenance.cursor_upsert_failed',
            'maintenance_state',
            evidenceJobName,
            upsertError.message || 'cursor_upsert_error',
            { cursor: encodedCursor }
          ).catch(() => undefined);
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
          const { data: visitorHolds, error: visitorHoldsErr } = await admin
            .from('incident_holds')
            .select('id')
            .eq('visitor_id', visitor.id)
            .eq('active', true)
            .limit(1);

          if (visitorHoldsErr) {
            metrics.errors.push(`visitor_hold_query_failed_${visitor.id}: ${visitorHoldsErr.message}`);
            await recordReconciliation(
              admin,
              'visitor.hold_check_failed',
              'visitors',
              visitor.id,
              visitorHoldsErr.message,
              { protection_type: 'visitor_hold' }
            ).catch(() => undefined);
            continue; // Protected by uncertainty: DO NOT ANONYMIZE
          }

          if (visitorHolds && visitorHolds.length > 0) continue;

          // Check protection: active hold by pass belonging to this visitor
          const { data: passHolds, error: passHoldsErr } = await admin
            .from('incident_holds')
            .select('id, passes!inner(visitor_id)')
            .eq('passes.visitor_id', visitor.id)
            .eq('active', true)
            .limit(1);

          if (passHoldsErr) {
            metrics.errors.push(`pass_hold_query_failed_${visitor.id}: ${passHoldsErr.message}`);
            await recordReconciliation(
              admin,
              'visitor.pass_hold_check_failed',
              'visitors',
              visitor.id,
              passHoldsErr.message,
              { protection_type: 'pass_hold' }
            ).catch(() => undefined);
            continue; // Protected by uncertainty: DO NOT ANONYMIZE
          }

          if (passHolds && passHolds.length > 0) continue;

          // Check protection: active, pending, or future issued passes
          const { data: activePasses, error: activePassesErr } = await admin
            .from('passes')
            .select('id')
            .eq('visitor_id', visitor.id)
            .or(`status.in.(inside,pending),and(status.eq.issued,valid_until.gt.${now})`)
            .limit(1);

          if (activePassesErr) {
            metrics.errors.push(`active_pass_query_failed_${visitor.id}: ${activePassesErr.message}`);
            await recordReconciliation(
              admin,
              'visitor.active_pass_check_failed',
              'visitors',
              visitor.id,
              activePassesErr.message,
              { protection_type: 'active_passes' }
            ).catch(() => undefined);
            continue; // Protected by uncertainty: DO NOT ANONYMIZE
          }

          if (activePasses && activePasses.length > 0) continue;

          // Anonymize personal fields while preserving relational IDs
          const { error: anonErr } = await admin
            .from('visitors')
            .update({
              full_name: '[Anonymized]',
              contact_number: '[Anonymized]',
              home_address: '[Anonymized]',
              email: null,
              purpose: '[Anonymized]',
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
            // Anonymize visit vehicle declaration PII associated with this visitor (Section 52)
            await admin
              .from('visit_vehicle_declarations')
              .update({
                plate_number: '[Anonymized]',
                plate_key: '[Anonymized]',
                color: '[Anonymized]',
                make_model: null,
              })
              .eq('visitor_id', visitor.id);

            metrics.visitorsAnonymized++;
          }
        }
      } else {
        metrics.visitorsAnonymized = candidateVisitors.length;
      }
    }

    // =========================================================================
    // 3.5 RETURNING VISITOR & BIOMETRIC RETENTION (Section 52)
    // =========================================================================
    try {
      const { data: expiredProfiles, error: profErr } = await admin
        .from('returning_visitor_profiles')
        .select('id')
        .lte('expires_at', now)
        .limit(batchSize);

      if (profErr) {
        metrics.errors.push(`returning_profile_query_failed: ${profErr.message}`);
      } else if (expiredProfiles && expiredProfiles.length > 0) {
        const profileIds = expiredProfiles.map((p: any) => p.id);
        if (!dryRun) {
          // Deleting profile cascades to returning_face_templates and returning_visitor_vehicles
          const { error: delErr } = await admin
            .from('returning_visitor_profiles')
            .delete()
            .in('id', profileIds);

          if (delErr) {
            metrics.errors.push(`returning_profile_delete_failed: ${delErr.message}`);
          } else {
            metrics.returningProfilesCleaned = profileIds.length;
          }
        } else {
          metrics.returningProfilesCleaned = profileIds.length;
        }
      }

      // Purge expired returning identity attempts (15-min TTL)
      if (!dryRun) {
        const { error: attDelErr } = await admin
          .from('returning_identity_attempts')
          .delete()
          .lte('expires_at', now);

        if (attDelErr) {
          metrics.errors.push(`returning_attempts_delete_failed: ${attDelErr.message}`);
        }
      }
    } catch (retentionErr) {
      metrics.errors.push(`returning_retention_error: ${retentionErr instanceof Error ? retentionErr.message : 'unknown'}`);
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
    // 6.5 EXPIRED RATE-LIMIT BUCKETS CLEANUP (via least-privilege RPC)
    // =========================================================================
    const { data: rlCleaned, error: rlErr } = await admin
      .schema('api')
      .rpc('cleanup_expired_rate_limit_buckets', {
        requested_batch_size: 5000,
        requested_dry_run: dryRun,
      });

    if (rlErr) {
      metrics.errors.push(`rate_limit_cleanup_failed: ${rlErr.message}`);
    } else {
      metrics.rateLimitBucketsCleaned = typeof rlCleaned === 'number' ? rlCleaned : 0;
    }

    // =========================================================================
    // =========================================================================
    // 6.6 ORPHAN ANONYMOUS AUTH USER CLEANUP (REPAIR R1 & R2)
    // =========================================================================
    try {
      const ANONYMOUS_AUTH_RETENTION_MS = 24 * 60 * 60 * 1000; // 24-hour safety buffer
      const anonCutoff = Date.now() - ANONYMOUS_AUTH_RETENTION_MS;
      let page = 1;
      const perPage = 1000;
      let hasMorePages = true;
      let totalDeleteFailures = 0;
      let totalDeleted = 0;
      const allEligibleUsers: any[] = [];
      let anonymousCleanupUnsafe = false;

      while (hasMorePages) {
        const { data: authData, error: authListError } = await admin.auth.admin.listUsers({
          page,
          perPage,
        });

        if (authListError) {
          anonymousCleanupUnsafe = true;
          metrics.errors.push(`anonymous_auth_list_failed_page_${page}: ${authListError.message}`);
          // Fail closed safely: abort enumeration immediately on any page failure
          break;
        }

        const users = authData?.users ?? [];
        if (users.length === 0) {
          break;
        }

        const candidateUsers = users.filter((u: any) => {
          if (!u.is_anonymous && u.app_metadata?.provider !== 'anonymous') return false;
          const createdAt = new Date(u.created_at).getTime();
          return Number.isFinite(createdAt) && createdAt <= anonCutoff;
        });

        if (candidateUsers.length > 0) {
          const candidateIds = candidateUsers.map((u: any) => u.id);

          // Find IDs referenced by visitors
          const { data: referencedVisitors, error: visitorRefErr } = await admin
            .from('visitors')
            .select('owner_id')
            .in('owner_id', candidateIds);

          // Find IDs referenced by upload_intents
          const { data: referencedIntents, error: intentRefErr } = await admin
            .from('upload_intents')
            .select('owner_id')
            .in('owner_id', candidateIds);

          // Exclude staff_profiles
          const { data: staffRows, error: staffRefErr } = await admin
            .from('staff_profiles')
            .select('user_id')
            .in('user_id', candidateIds);

          // Exclude devices
          const { data: deviceRows, error: deviceRefErr } = await admin
            .from('devices')
            .select('user_id')
            .in('user_id', candidateIds);

          // REPAIR R1: FAIL CLOSED ON ANY PROTECTION QUERY FAILURE FOR ENTIRE RUN
          if (visitorRefErr || intentRefErr || staffRefErr || deviceRefErr) {
            anonymousCleanupUnsafe = true;
            if (visitorRefErr) metrics.errors.push(`anonymous_auth_protection_visitor_failed: ${visitorRefErr.message}`);
            if (intentRefErr) metrics.errors.push(`anonymous_auth_protection_intent_failed: ${intentRefErr.message}`);
            if (staffRefErr) metrics.errors.push(`anonymous_auth_protection_staff_failed: ${staffRefErr.message}`);
            if (deviceRefErr) metrics.errors.push(`anonymous_auth_protection_device_failed: ${deviceRefErr.message}`);
            // Incomplete/unreliable protection data -> halt entire cleanup run
            break;
          } else {
            const visitorOwnerIds = new Set((referencedVisitors ?? []).map((v: any) => v.owner_id));
            const intentOwnerIds = new Set((referencedIntents ?? []).map((i: any) => i.owner_id));
            const staffUserIds = new Set((staffRows ?? []).map((s: any) => s.user_id));
            const deviceUserIds = new Set((deviceRows ?? []).map((d: any) => d.user_id));

            // Retain only strictly unreferenced, old orphan anonymous accounts
            const eligibleUsers = candidateUsers.filter(
              (u: any) =>
                !visitorOwnerIds.has(u.id) &&
                !intentOwnerIds.has(u.id) &&
                !staffUserIds.has(u.id) &&
                !deviceUserIds.has(u.id)
            );

            allEligibleUsers.push(...eligibleUsers);
          }
        }

        if (users.length < perPage) {
          hasMorePages = false;
        } else {
          page++;
          if (page > 100) {
            // Defensive ceiling to prevent infinite loops
            anonymousCleanupUnsafe = true;
            metrics.errors.push('anonymous_auth_pagination_ceiling_exceeded');
            break;
          }
        }
      }

      if (anonymousCleanupUnsafe) {
        // Run-level fail-closed: ANY enumeration or protection failure prohibits destructive deletion
        allEligibleUsers.length = 0;
        metrics.anonymousAuthEligible = 0;
        metrics.anonymousAuthDeleted = 0;
        metrics.anonymousAuthDeleteFailures = 0;
      } else {
        metrics.anonymousAuthEligible = allEligibleUsers.length;

        if (!dryRun && allEligibleUsers.length > 0) {
          const usersToClean = allEligibleUsers.slice(0, batchSize);
          for (const user of usersToClean) {
            const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
            if (delErr) {
              totalDeleteFailures++;
              metrics.errors.push(`anonymous_auth_delete_failed for user ${user.id}: ${delErr.message}`);
              await recordReconciliation(
                admin,
                'maintenance.anonymous_auth_delete_failed',
                'auth.users',
                user.id,
                delErr.message || 'auth_delete_failed',
                { userId: user.id }
              ).catch(() => undefined);
            } else {
              totalDeleted++;
            }
          }
        }

        metrics.anonymousAuthDeleted = dryRun ? 0 : totalDeleted;
        metrics.anonymousAuthDeleteFailures = totalDeleteFailures;
      }
    } catch (anonErr) {
      const msg = anonErr instanceof Error ? anonErr.message : 'anonymous_auth_cleanup_exception';
      metrics.errors.push(`anonymous_auth_cleanup_exception: ${msg}`);
      metrics.anonymousAuthEligible = 0;
      metrics.anonymousAuthDeleted = 0;
      metrics.anonymousAuthDeleteFailures = 0;
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
      metrics.verificationCodesCleaned > 0 ||
      metrics.rateLimitBucketsCleaned > 0 ||
      metrics.anonymousAuthDeleted > 0;

    let preAuditOutcome: 'success' | 'partial' | 'failure' =
      metrics.errors.length === 0 ? 'success' : (hasWorkDone ? 'partial' : 'failure');

    const { error: auditError } = await admin.from('audit_events').insert({
      actor_id: caller.actorId ?? null,
      actor_kind: caller.isCron ? 'system' : 'staff',
      actor_role: caller.isCron ? 'cron' : 'superadmin',
      action: 'maintenance.retention_run',
      target_type: 'system',
      target_id: 'retention_maintenance',
      outcome: preAuditOutcome,
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
        { metrics, outcome: preAuditOutcome }
      ).catch(() => undefined);
    }

    // Result status MUST be calculated AFTER all operations, including audit & reconciliation
    const finalResultStatus: 'success' | 'partial' | 'failure' =
      metrics.errors.length === 0
        ? 'success'
        : (hasWorkDone ? 'partial' : 'failure');

    const isSuccess = metrics.errors.length === 0 && finalResultStatus === 'success';

    return jsonResponse(finalResultStatus === 'failure' ? 500 : 200, {
      success: isSuccess,
      result: finalResultStatus,
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
