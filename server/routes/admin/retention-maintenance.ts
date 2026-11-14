import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { decodeCursor, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const maintenanceSchema = z.object({
  dryRun: z.boolean().optional(),
  confirmExecution: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(200).optional(),
}).strict();

const TERMINAL_OFFICE_ATTENDANCE = new Set(['completed', 'exited_unconfirmed', 'cancelled', 'expired']);

function isActiveOfficeVisit(visit: { approval_status?: string | null; attendance_status?: string | null }): boolean {
  const isTerminalApproval = visit.approval_status === 'rejected';
  const isTerminalAttendance = TERMINAL_OFFICE_ATTENDANCE.has(String(visit.attendance_status || ''));
  return !(isTerminalApproval || isTerminalAttendance);
}

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

    if (request.method === 'GET' && !caller.isCron) {
      return jsonResponse(403, {
        error: 'cron_only_get',
        message: 'GET method is reserved for scheduled cron execution. Use POST with confirmExecution for manual runs.',
      });
    }

    let dryRun = caller.isCron ? false : true;
    let confirmExecution = false;
    let batchSize = 50;

    if (request.method === 'GET') {
      const url = new URL(request.url);
      dryRun = url.searchParams.get('dryRun') === 'true';
      const b = parseInt(url.searchParams.get('batchSize') || '50', 10);
      batchSize = Math.min(Math.max(Number.isFinite(b) ? b : 50, 1), 200);
    } else {
      const text = await request.text().catch(() => '');
      if (text.trim().length > 0) {
        let rawJson: unknown;
        try {
          rawJson = JSON.parse(text);
        } catch {
          return jsonResponse(400, {
            error: 'invalid_json_body',
            message: 'Request body must be valid JSON.',
          });
        }
        const parsed = maintenanceSchema.safeParse(rawJson);
        if (!parsed.success) {
          return jsonResponse(400, {
            error: 'invalid_request',
            message: 'Invalid maintenance request payload.',
          });
        }
        dryRun = parsed.data.dryRun ?? (caller.isCron ? false : true);
        confirmExecution = parsed.data.confirmExecution === true;
        batchSize = parsed.data.batchSize ?? 50;
      }
    }

    if (!caller.isCron && !dryRun && !confirmExecution) {
      return jsonResponse(400, {
        error: 'confirmation_required',
        message: 'Manual live retention execution requires confirmExecution: true alongside dryRun: false.',
      });
    }

    // Load retention settings (fail-closed if authoritative settings cannot be retrieved)
    const { data: settings, error: settingsError } = await admin
      .from('app_settings')
      .select('automatic_cleanup_enabled, image_retention_days, photo_retention_days, id_retention_days, photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled, vehicle_photo_retention_days, visitor_retention_enabled, visitor_retention_days, returning_profile_retention_enabled, returning_profile_retention_days, reconciliation_retention_days, audit_retention_days, global_retention_freeze, global_retention_freeze_reason, emergency_record_retention_enabled, emergency_record_retention_days')
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
      emergencyRecordsEligible: 0,
      emergencyRecordsAnonymized: 0,
      stalePassesExpired: 0,
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

    if (Boolean((settings as any).global_retention_freeze)) {
      const freezeReason = (settings as any).global_retention_freeze_reason ?? null;

      // Non-destructive housekeeping: Authoritative pass expiration is preserved during retention freeze
      try {
        const { data: expiredPassesCount, error: expirePassesErr } = await admin
          .schema('api')
          .rpc('expire_stale_passes');
        if (expirePassesErr) {
          metrics.errors.push(`expire_stale_passes_failed: ${expirePassesErr.message}`);
        } else {
          metrics.stalePassesExpired = expiredPassesCount ?? 0;
        }
      } catch (passExpireErr: any) {
        metrics.errors.push(`expire_stale_passes_exception: ${passExpireErr.message}`);
      }

      const { error: freezeAuditErr } = await admin.from('audit_events').insert({
        actor_id: caller.actorId ?? null,
        actor_kind: caller.isCron ? 'system' : 'staff',
        actor_role: caller.isCron ? 'cron' : 'superadmin',
        action: 'maintenance.retention_frozen_skip',
        target_type: 'system',
        target_id: 'retention_maintenance',
        outcome: 'success',
        after_state: {
          global_retention_freeze: true,
          freezeReason,
          dryRun,
          callerType: metrics.callerType,
          stalePassesExpired: metrics.stalePassesExpired,
        },
      });
      if (freezeAuditErr) {
        metrics.errors.push(`audit_insert_failed: ${freezeAuditErr.message || 'audit_insert_failed'}`);
        await recordReconciliation(
          admin,
          'maintenance.audit_insert_failed',
          'system',
          'retention_maintenance',
          freezeAuditErr.message || 'audit_insert_failed',
          { callerType: metrics.callerType, stage: 'global_retention_freeze' }
        ).catch(() => undefined);
      }
      return jsonResponse(200, {
        success: true,
        result: 'frozen',
        frozen: true,
        reason: 'global_retention_freeze_active',
        freezeReason,
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

    const photoEnabled = (settings as any).photo_retention_enabled ?? true;
    const idEnabled = (settings as any).id_retention_enabled ?? true;
    const vehicleEnabled = (settings as any).vehicle_photo_retention_enabled ?? true;
    const allowedKinds: string[] = [];
    if (photoEnabled) allowedKinds.push('photo');
    if (idEnabled) allowedKinds.push('id');
    if (vehicleEnabled) allowedKinds.push('vehicle_photo');

    const photoDays = (settings as any).photo_retention_days ?? (settings as any).image_retention_days ?? 7;
    const idDays = (settings as any).id_retention_days ?? 30;
    const vehicleDays = (settings as any).vehicle_photo_retention_days ?? (settings as any).image_retention_days ?? 7;

    function isEvidenceItemEligible(item: any): boolean {
      const nowMs = Date.now();
      if (item.kind === 'photo') {
        if (!photoEnabled) return false;
        if (item.created_at) {
          return new Date(item.created_at).getTime() <= nowMs - photoDays * 86_400_000;
        }
        return new Date(item.expires_at).getTime() <= nowMs;
      }
      if (item.kind === 'id') {
        if (!idEnabled) return false;
        if (item.created_at) {
          return new Date(item.created_at).getTime() <= nowMs - idDays * 86_400_000;
        }
        return new Date(item.expires_at).getTime() <= nowMs;
      }
      if (item.kind === 'vehicle_photo') {
        if (!vehicleEnabled) return false;
        if (item.created_at) {
          return new Date(item.created_at).getTime() <= nowMs - vehicleDays * 86_400_000;
        }
        return new Date(item.expires_at).getTime() <= nowMs;
      }
      return new Date(item.expires_at).getTime() <= nowMs;
    }

    let evidenceQuery = admin
      .from('visitor_evidence')
      .select('id, visitor_id, bucket_id, object_path, expires_at, kind, created_at, verified_at')
      .is('purged_at', null)
      .order('expires_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(batchSize);

    if (allowedKinds.length > 0) {
      evidenceQuery = evidenceQuery.in('kind', allowedKinds);
    } else {
      // All evidence retention categories disabled by Superadmin policy
      evidenceQuery = evidenceQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    }

    if (evidenceCursor?.timestamp && evidenceCursor.id) {
      evidenceQuery = evidenceQuery.or(
        `expires_at.gt.${evidenceCursor.timestamp},and(expires_at.eq.${evidenceCursor.timestamp},id.gt.${evidenceCursor.id})`
      );
    }

    let { data: expiredEvidence, error: evidenceError } = await evidenceQuery;

    // Wrap around to start if cursor reached the end of the unpurged queue
    if ((!expiredEvidence || expiredEvidence.length === 0) && evidenceCursor) {
      evidenceCursor = null;
      let wrapQuery = admin
        .from('visitor_evidence')
        .select('id, visitor_id, bucket_id, object_path, expires_at, kind, created_at, verified_at')
        .is('purged_at', null)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(batchSize);
      if (allowedKinds.length > 0) {
        wrapQuery = wrapQuery.in('kind', allowedKinds);
      } else {
        wrapQuery = wrapQuery.eq('id', '00000000-0000-0000-0000-000000000000');
      }
      const wrapRes = await wrapQuery;
      expiredEvidence = wrapRes.data;
      evidenceError = wrapRes.error;
    }

    let nextEvidenceCursor: { timestamp: string; id: string } | null = null;

    if (evidenceError) {
      metrics.errors.push(`evidence_query_failed: ${evidenceError.message}`);
    } else if (expiredEvidence) {
      if (expiredEvidence.length > 0) {
        const lastExamined = expiredEvidence[expiredEvidence.length - 1];
        if (lastExamined) {
          nextEvidenceCursor = { timestamp: lastExamined.expires_at, id: lastExamined.id };
        }
      }
      const eligibleItems = expiredEvidence.filter(isEvidenceItemEligible);
      metrics.evidenceEligible = eligibleItems.length;

      if (!dryRun) {
        for (const item of eligibleItems) {
          // Cursor is fixed to the last candidate examined in the ordered page (lastExamined),
          // never regressed or overwritten by earlier eligible items in the page.
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
    // 2. ABANDONED UPLOAD INTENTS (Durable storage cleanup tracking & DB-first safety)
    // =========================================================================
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const nowIso = new Date().toISOString();
    const { data: abandonedIntents, error: intentError } = await admin
      .from('upload_intents')
      .select('id, bucket_id, object_path, status, visitor_id, held_until')
      .in('status', ['pending', 'expired'])
      .is('visitor_id', null)
      .is('storage_cleaned_at', null)
      .or(`held_until.is.null,held_until.lt.${nowIso}`)
      .lt('expires_at', oneHourAgo)
      .limit(batchSize);

    if (intentError) {
      metrics.errors.push(`intent_query_failed: ${intentError.message}`);
    } else if (abandonedIntents && abandonedIntents.length > 0) {
      if (!dryRun) {
        for (const intent of abandonedIntents) {
          // 1. Database-first safety: If intent is currently 'pending', conditionally mark it 'expired'
          // before any storage operations.
          if (intent.status === 'pending') {
            const { data: transitionRows, error: transErr } = await admin
              .from('upload_intents')
              .update({ status: 'expired' })
              .eq('id', intent.id)
              .eq('status', 'pending')
              .is('visitor_id', null)
              .select('id, status, visitor_id');

            if (transErr || !transitionRows || transitionRows.length === 0) {
              metrics.errors.push(`intent_db_expire_failed_${intent.id}: ${transErr?.message || 'State conflict or already claimed'}`);
              await recordReconciliation(
                admin,
                'upload_intent.db_expire_failed',
                'upload_intents',
                intent.id,
                transErr?.message || 'conditional_transition_failed',
                { bucket_id: intent.bucket_id, object_path: intent.object_path }
              ).catch(() => undefined);
              continue; // Abort storage removal if database transition was not confirmed
            }
          }

          // 2. Double-check fresh row state to verify it is expired and strictly unclaimed
          const { data: freshIntent, error: freshErr } = await admin
            .from('upload_intents')
            .select('id, status, visitor_id, bucket_id, object_path, storage_cleaned_at, held_until')
            .eq('id', intent.id)
            .maybeSingle();

          if (freshErr || !freshIntent) {
            metrics.errors.push(`intent_verify_failed_${intent.id}: ${freshErr?.message || 'not found'}`);
            continue;
          }

          // Never delete storage if claimed, held by pending office visit, or associated with a visitor profile
          if (
            freshIntent.status === 'claimed' ||
            freshIntent.visitor_id !== null ||
            (freshIntent.held_until && new Date(freshIntent.held_until).getTime() > Date.now())
          ) {
            metrics.errors.push(`intent_claimed_guard_${intent.id}: Intent was claimed or held, skipping storage deletion`);
            continue;
          }

          // If already cleaned by concurrent worker or endpoint, skip
          if (freshIntent.storage_cleaned_at !== null) {
            continue;
          }

          if (freshIntent.status !== 'expired') {
            metrics.errors.push(`intent_invalid_status_${intent.id}: Status is ${freshIntent.status}, skipping storage deletion`);
            continue;
          }

          // 3. Attempt physical storage removal
          let storageSuccess = false;
          let storageErrMsg: string | null = null;

          try {
            const { error: removeErr } = await admin.storage
              .from(freshIntent.bucket_id)
              .remove([freshIntent.object_path]);

            if (removeErr) {
              const msg = removeErr.message || String(removeErr);
              // Supabase storage object-not-found is idempotent success (already absent)
              if (
                msg.toLowerCase().includes('not found') ||
                msg.toLowerCase().includes('does not exist') ||
                (removeErr as any).statusCode === '404' ||
                (removeErr as any).status === 404
              ) {
                storageSuccess = true;
              } else {
                storageErrMsg = msg;
              }
            } else {
              storageSuccess = true;
            }
          } catch (storageException) {
            storageErrMsg = storageException instanceof Error ? storageException.message : String(storageException);
          }

          if (!storageSuccess) {
            metrics.errors.push(`intent_storage_failed_${intent.id}: ${storageErrMsg || 'storage_removal_failed'}`);
            await recordReconciliation(
              admin,
              'upload_intent.storage_delete_failed',
              'upload_intents',
              intent.id,
              storageErrMsg || 'storage_removal_failed',
              { bucket_id: freshIntent.bucket_id, object_path: freshIntent.object_path }
            ).catch(() => undefined);
            continue;
          }

          // 4. Record persistent storage cleanup completion marker
          const cleanedAt = new Date().toISOString();
          const { error: cleanMarkerErr } = await admin
            .from('upload_intents')
            .update({ storage_cleaned_at: cleanedAt })
            .eq('id', intent.id)
            .is('visitor_id', null)
            .eq('status', 'expired');

          if (cleanMarkerErr) {
            metrics.errors.push(`intent_marker_failed_${intent.id}: ${cleanMarkerErr.message}`);
            await recordReconciliation(
              admin,
              'upload_intent.storage_cleaned_marker_failed',
              'upload_intents',
              intent.id,
              cleanMarkerErr.message,
              { bucket_id: freshIntent.bucket_id, object_path: freshIntent.object_path }
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
    // 3. VISITOR PII ANONYMIZATION (REPAIR H2: visitor_retention_days & category toggle)
    // =========================================================================
    const visitorRetentionEnabled = (settings as any).visitor_retention_enabled ?? true;
    const visitorRetentionDays = settings?.visitor_retention_days ?? 30;
    const visitorCutoff = new Date(Date.now() - visitorRetentionDays * 86_400_000).toISOString();

    let candidateVisitors: any[] | null = null;
    let visitorErr: any = null;

    if (visitorRetentionEnabled) {
      const res = await admin
        .from('visitors')
        .select('id, created_at')
        .is('anonymized_at', null)
        .lte('created_at', visitorCutoff)
        .order('created_at', { ascending: true })
        .limit(batchSize);
      candidateVisitors = res.data;
      visitorErr = res.error;
    }

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

          // Safeguard 4: check active office visits (fail-closed on uncertainty)
          const { data: visitorOfficeVisits, error: visitorOfficeVisitErr } = await admin
            .from('office_visits')
            .select('id, approval_status, attendance_status')
            .eq('visitor_id', visitor.id);

          if (visitorOfficeVisitErr) {
            metrics.errors.push(`office_visit_query_failed_${visitor.id}: ${visitorOfficeVisitErr.message}`);
            await recordReconciliation(
              admin,
              'visitor.office_visit_check_failed',
              'visitors',
              visitor.id,
              visitorOfficeVisitErr.message,
              { protection_type: 'office_visits' }
            ).catch(() => undefined);
            continue;
          }

          if (visitorOfficeVisits && visitorOfficeVisits.some((ov: any) => isActiveOfficeVisit(ov))) {
            continue;
          }

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
      const returningProfilesEnabled = (settings as any).returning_profile_retention_enabled ?? true;
      const returningProfileDays = (settings as any).returning_profile_retention_days ?? 30;
      const returningCutoff = new Date(Date.now() - returningProfileDays * 86_400_000).toISOString();

      if (returningProfilesEnabled) {
        let profQuery = admin
          .from('returning_visitor_profiles')
          .select('id, created_at, last_used_at, expires_at, revoked_at');

        if (typeof (profQuery as any).or === 'function') {
          profQuery = profQuery.or(`and(expires_at.lte.${now},created_at.lte.${returningCutoff}),revoked_at.not.is.null`);
        } else {
          profQuery = profQuery.lte('expires_at', now).lte('created_at', returningCutoff);
        }

        const { data: expiredProfiles, error: profErr } = await profQuery.limit(batchSize);

        if (profErr) {
          metrics.errors.push(`returning_profile_query_failed: ${profErr.message}`);
        } else if (expiredProfiles && expiredProfiles.length > 0) {
          const eligibleProfileIds: string[] = [];

          for (const p of expiredProfiles) {
            // Check last_used_at cutoff for normal expiration (revoked profiles bypass last_used_at)
            if (!p.revoked_at && p.last_used_at && new Date(p.last_used_at).getTime() > Date.now() - returningProfileDays * 86_400_000) {
              continue;
            }

            // Safeguard 1: check if linked visitor is currently on campus (fail-closed)
            const { data: insidePasses, error: insideErr } = await admin
              .from('visitors')
              .select('id, passes!inner(status)')
              .eq('returning_profile_id', p.id)
              .eq('passes.status', 'inside')
              .limit(1);
            if (insideErr) {
              metrics.errors.push(`returning_inside_check_failed_${p.id}: ${insideErr.message}`);
              continue;
            }
            if (insidePasses && insidePasses.length > 0) continue;

            // Safeguard 2: check if linked visitor has active or future issued passes (fail-closed)
            const { data: activePasses, error: activeErr } = await admin
              .from('visitors')
              .select('id, passes!inner(id, status, valid_until)')
              .eq('returning_profile_id', p.id)
              .or(`passes.status.in.(inside,pending),and(passes.status.eq.issued,passes.valid_until.gt.${now})`)
              .limit(1);
            if (activeErr) {
              metrics.errors.push(`returning_active_pass_check_failed_${p.id}: ${activeErr.message}`);
              continue;
            }
            if (activePasses && activePasses.length > 0) continue;

            // Safeguard 3: check active incident holds (fail-closed)
            const { data: holds, error: holdsErr } = await admin
              .from('incident_holds')
              .select('id, visitors!inner(returning_profile_id)')
              .eq('visitors.returning_profile_id', p.id)
              .eq('active', true)
              .limit(1);
            if (holdsErr) {
              metrics.errors.push(`returning_hold_check_failed_${p.id}: ${holdsErr.message}`);
              continue;
            }
            if (holds && holds.length > 0) continue;

            // Safeguard 4: check active office visits linked to visitors using this returning profile (fail-closed)
            const { data: linkedVisitors, error: linkedVisErr } = await admin
              .from('visitors')
              .select('id')
              .eq('returning_profile_id', p.id);
            if (linkedVisErr) {
              metrics.errors.push(`returning_linked_visitors_check_failed_${p.id}: ${linkedVisErr.message}`);
              continue;
            }
            const linkedVisitorIds = (linkedVisitors ?? []).map((lv: any) => lv.id).filter(Boolean);
            if (linkedVisitorIds.length > 0) {
              const { data: linkedVisits, error: linkedVisitsErr } = await admin
                .from('office_visits')
                .select('id, approval_status, attendance_status')
                .in('visitor_id', linkedVisitorIds);
              if (linkedVisitsErr) {
                metrics.errors.push(`returning_office_visit_check_failed_${p.id}: ${linkedVisitsErr.message}`);
                continue;
              }
              if (linkedVisits && linkedVisits.some((ov: any) => isActiveOfficeVisit(ov))) {
                continue;
              }
            }

            eligibleProfileIds.push(p.id);
          }

          if (eligibleProfileIds.length > 0) {
            if (!dryRun) {
              const { error: delErr } = await admin
                .from('returning_visitor_profiles')
                .delete()
                .in('id', eligibleProfileIds);

              if (delErr) {
                metrics.errors.push(`returning_profile_delete_failed: ${delErr.message}`);
              } else {
                metrics.returningProfilesCleaned = eligibleProfileIds.length;
              }
            } else {
              metrics.returningProfilesCleaned = eligibleProfileIds.length;
            }
          }
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
    // 3.7 EMERGENCY OFFLINE GATE RECORDS RETENTION (M90)
    // =========================================================================
    try {
      const emergencyRetentionEnabled = (settings as any).emergency_record_retention_enabled ?? true;
      const emergencyRetentionDays = (settings as any).emergency_record_retention_days ?? 90;
      const emergencyCutoff = new Date(Date.now() - emergencyRetentionDays * 86_400_000).toISOString();

      if (emergencyRetentionEnabled) {
        const { data: emergencyCandidates, error: emergencyQueryErr } = await admin
          .from('emergency_gate_records')
          .select('id, local_recorded_at, reconciliation_status, anonymized_at')
          .is('anonymized_at', null)
          .not('reconciliation_status', 'in', '(pending_sync,received,needs_review)')
          .lte('local_recorded_at', emergencyCutoff)
          .order('local_recorded_at', { ascending: true })
          .limit(batchSize);

        if (emergencyQueryErr) {
          metrics.errors.push(`emergency_records_query_failed: ${emergencyQueryErr.message}`);
        } else if (emergencyCandidates && emergencyCandidates.length > 0) {
          metrics.emergencyRecordsEligible = emergencyCandidates.length;
          if (!dryRun) {
            for (const rec of emergencyCandidates) {
              const { data: anonRes, error: anonRpcErr } = await admin
                .schema('api')
                .rpc('anonymize_expired_emergency_gate_record', {
                  requested_record_id: rec.id,
                });
              if (anonRpcErr) {
                metrics.errors.push(`emergency_record_anonymize_failed_${rec.id}: ${anonRpcErr.message}`);
              } else if (anonRes && (anonRes as any).anonymized === true) {
                metrics.emergencyRecordsAnonymized += 1;
              }
            }
          }
        }
      }
    } catch (emergencyRetErr) {
      metrics.errors.push(`emergency_retention_error: ${emergencyRetErr instanceof Error ? emergencyRetErr.message : 'unknown'}`);
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

          // Find IDs referenced by office_visits
          const { data: officeVisitRows, error: officeVisitRefErr } = await admin
            .from('office_visits')
            .select('visitor_actor_id, approval_status, attendance_status, updated_at, created_at')
            .in('visitor_actor_id', candidateIds);

          // REPAIR R1: FAIL CLOSED ON ANY PROTECTION QUERY FAILURE FOR ENTIRE RUN
          if (visitorRefErr || intentRefErr || staffRefErr || deviceRefErr || officeVisitRefErr) {
            anonymousCleanupUnsafe = true;
            if (visitorRefErr) metrics.errors.push(`anonymous_auth_protection_visitor_failed: ${visitorRefErr.message}`);
            if (intentRefErr) metrics.errors.push(`anonymous_auth_protection_intent_failed: ${intentRefErr.message}`);
            if (staffRefErr) metrics.errors.push(`anonymous_auth_protection_staff_failed: ${staffRefErr.message}`);
            if (deviceRefErr) metrics.errors.push(`anonymous_auth_protection_device_failed: ${deviceRefErr.message}`);
            if (officeVisitRefErr) metrics.errors.push(`anonymous_auth_protection_office_visit_failed: ${officeVisitRefErr.message}`);
            // Incomplete/unreliable protection data -> halt entire cleanup run
            break;
          } else {
            const visitorOwnerIds = new Set((referencedVisitors ?? []).map((v: any) => v.owner_id));
            const intentOwnerIds = new Set((referencedIntents ?? []).map((i: any) => i.owner_id));
            const staffUserIds = new Set((staffRows ?? []).map((s: any) => s.user_id));
            const deviceUserIds = new Set((deviceRows ?? []).map((d: any) => d.user_id));

            const TERMINAL_ATTENDANCE = new Set(['completed', 'exited_unconfirmed', 'cancelled', 'expired']);
            const visitorRetentionCutoffMs = Date.now() - (settings?.visitor_retention_days ?? 30) * 86_400_000;

            const protectedOfficeActorIds = new Set<string>();
            for (const ov of officeVisitRows ?? []) {
              if (!ov.visitor_actor_id) continue;

              const isTerminalApproval = ov.approval_status === 'rejected';
              const isTerminalAttendance = TERMINAL_ATTENDANCE.has(ov.attendance_status);
              const isTerminal = isTerminalApproval || isTerminalAttendance;

              if (!isTerminal) {
                // Active: pending, approved awaiting entry, inside campus, or confirmed present -> MUST protect
                protectedOfficeActorIds.add(ov.visitor_actor_id);
              } else {
                // Terminal: protect if still within the visitor retention window
                const rowDateMs = new Date(ov.updated_at || ov.created_at).getTime();
                if (Number.isFinite(rowDateMs) && rowDateMs > visitorRetentionCutoffMs) {
                  protectedOfficeActorIds.add(ov.visitor_actor_id);
                }
              }
            }

            // Retain only strictly unreferenced, old orphan anonymous accounts
            const eligibleUsers = candidateUsers.filter(
              (u: any) =>
                !visitorOwnerIds.has(u.id) &&
                !intentOwnerIds.has(u.id) &&
                !staffUserIds.has(u.id) &&
                !deviceUserIds.has(u.id) &&
                !protectedOfficeActorIds.has(u.id)
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
    // 8.5 AUTHORITATIVE PASS EXPIRATION
    // =========================================================================
    try {
      const { data: expiredPassesCount, error: expirePassesErr } = await admin
        .schema('api')
        .rpc('expire_stale_passes');
      if (expirePassesErr) {
        metrics.errors.push(`expire_stale_passes_failed: ${expirePassesErr.message}`);
      } else {
        metrics.stalePassesExpired = expiredPassesCount ?? 0;
      }
    } catch (passExpireErr: any) {
      metrics.errors.push(`expire_stale_passes_exception: ${passExpireErr.message}`);
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
      metrics.anonymousAuthDeleted > 0 ||
      metrics.returningProfilesCleaned > 0 ||
      metrics.emergencyRecordsAnonymized > 0;

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

export { handleRequest };
export default { fetch: handleRequest };
