import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { purgeAndVerifyStorageBuckets } from '../../lib/storagePurgeService.js';

async function recordResetStep(admin: any, args: Record<string, any>): Promise<void> {
  const { error } = await admin.schema('api').rpc('record_system_reset_step', args);
  if (error) {
    throw new Error(
      `Failed to record reset step (${args.requested_step || 'unknown'}): ${error.message || JSON.stringify(error)}`
    );
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();

    if (request.method === 'POST') {
      const actor = await requireStaffActor(admin, token, ['superadmin']);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: 'invalid_json', message: 'Malformed JSON payload.' });
      }

      if (body?.action === 'return_to_zero') {
        if (body?.confirmationPhrase !== 'DELETE ALL OPERATIONAL DATA') {
          return jsonResponse(400, {
            error: 'invalid_confirmation_phrase',
            message: 'You must provide the exact confirmation phrase: DELETE ALL OPERATIONAL DATA',
          });
        }

        // Phase 1: Concurrency Protection — Mandatory exclusive reset lock acquisition
        let lockRes: any;
        try {
          lockRes = await admin
            .schema('api')
            .rpc('acquire_system_reset_lock', {
              requested_actor_id: actor.id,
              ...(body.resumeOperationId ? { requested_resume_op_id: body.resumeOperationId } : {}),
            });
        } catch (lockErr: any) {
          console.error('Lock acquisition RPC threw exception:', lockErr);
          return jsonResponse(500, {
            error: 'lock_acquisition_failed',
            message: `Failed to acquire system reset lock: ${lockErr?.message || 'Unexpected exception'}`,
          });
        }

        const { data: lockData, error: lockError } = lockRes ?? {};
        if (lockError) {
          console.error('acquire_system_reset_lock returned error:', lockError);
          return jsonResponse(500, {
            error: 'lock_acquisition_failed',
            message: `Failed to acquire system reset lock: ${lockError.message || JSON.stringify(lockError)}`,
          });
        }

        if (!lockData || typeof lockData !== 'object') {
          return jsonResponse(500, {
            error: 'lock_acquisition_failed',
            message: 'Invalid or null response from lock acquisition RPC.',
          });
        }

        if (lockData.acquired !== true) {
          return jsonResponse(409, {
            error: lockData.reason === 'recovery_required' ? 'recovery_required' : 'reset_in_progress',
            message:
              lockData.reason === 'recovery_required'
                ? 'A previous system reset failed or requires manual recovery before a new reset can run.'
                : 'A system reset is currently in progress.',
            details: lockData,
          });
        }

        if (
          !lockData.operation_id ||
          typeof lockData.operation_id !== 'string' ||
          lockData.operation_id.trim().length === 0
        ) {
          return jsonResponse(500, {
            error: 'lock_acquisition_failed',
            message: 'Lock acquisition succeeded but operation ID was missing or invalid.',
          });
        }

        const operationId: string = lockData.operation_id;
        const workerGeneration: number = typeof lockData.worker_generation === 'number' ? lockData.worker_generation : 1;
        const workerId: string | null = typeof lockData.worker_id === 'string' ? lockData.worker_id : null;

        const checkWorkerOwnership = async () => {
          const { error: ownErr } = await admin.schema('api').rpc('assert_system_reset_worker_active', {
            requested_op_id: operationId,
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });
          if (ownErr) {
            throw new Error(`Worker fencing revoked: ${ownErr.message || JSON.stringify(ownErr)}`);
          }
        };

        // Phase 2: Supabase Storage Purge via official Storage API
        // Removes nested objects from visitor-photos and visitor-ids before deleting Auth accounts
        let storageResult;
        try {
          await recordResetStep(admin, {
            requested_op_id: operationId,
            requested_status: 'storage_deletion_in_progress',
            requested_step: 'storage_deletion_in_progress',
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });

          storageResult = await purgeAndVerifyStorageBuckets(admin, checkWorkerOwnership);

          const effectiveCounts = (storageResult.totalFilesDeleted > 0 || !lockData.purged_counts)
            ? {
                totalDiscovered: storageResult.totalFilesDiscovered,
                totalDeleted: storageResult.totalFilesDeleted,
              }
            : lockData.purged_counts;

          await recordResetStep(admin, {
            requested_op_id: operationId,
            requested_status: 'storage_deletion_verified',
            requested_step: 'storage_deletion_verified',
            requested_manifest: storageResult.inventories,
            requested_counts: effectiveCounts,
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });
        } catch (storageErr: any) {
          console.error('Storage purge or verification failed during return_to_zero:', storageErr);
          try {
            await recordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'recovery_required',
              requested_step: 'storage_purge_failed',
              requested_error: storageErr?.message || String(storageErr),
              requested_worker_generation: workerGeneration,
              ...(workerId ? { requested_worker_id: workerId } : {}),
            });
          } catch (recErr) {
            console.error('Failed to record recovery_required status:', recErr);
          }
          return jsonResponse(500, {
            error: 'storage_purge_failed',
            message: `Storage purge failed: ${storageErr?.message || 'Storage verification failed.'}`,
            operationId,
            recoveryRequired: true,
          });
        }

        // Phase 3: Database Cleanup RPC
        // Topologically wipes operational records, preserves active superadmins and configuration,
        // and durably appends authoritative reset audit event.
        try {
          await recordResetStep(admin, {
            requested_op_id: operationId,
            requested_status: 'database_cleanup_in_progress',
            requested_step: 'database_cleanup_in_progress',
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });
        } catch (recErr: any) {
          console.error('Failed to record database_cleanup_in_progress:', recErr);
          return jsonResponse(500, {
            error: 'reset_step_recording_failed',
            message: recErr.message,
            operationId,
            recoveryRequired: true,
          });
        }

        let rpcData: any;
        try {
          const { data, error: rpcError } = await admin.schema('api').rpc('return_to_zero_reset', {
            requested_actor_id: actor.id,
            requested_op_id: operationId,
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });

          if (rpcError) {
            throw new Error(rpcError.message || JSON.stringify(rpcError));
          }
          rpcData = data;
        } catch (rpcErr: any) {
          console.error('return_to_zero_reset RPC failed:', rpcErr);
          try {
            await recordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'recovery_required',
              requested_step: 'database_cleanup_failed',
              requested_error: rpcErr?.message || String(rpcErr),
              requested_worker_generation: workerGeneration,
              ...(workerId ? { requested_worker_id: workerId } : {}),
            });
          } catch (recErr) {
            console.error('Failed to record database_cleanup_failed status:', recErr);
          }
          return jsonResponse(500, {
            error: 'database_reset_failed',
            message: rpcErr?.message || 'Database reset RPC execution failed.',
            operationId,
            recoveryRequired: true,
          });
        }

        // Phase 4: Release Reset Lock & Mark Completed
        let releaseRes: any;
        try {
          releaseRes = await admin.schema('api').rpc('release_system_reset_lock', {
            requested_actor_id: actor.id,
            requested_op_id: operationId,
            requested_worker_generation: workerGeneration,
            ...(workerId ? { requested_worker_id: workerId } : {}),
          });
        } catch (relEx: any) {
          console.error('release_system_reset_lock threw exception:', relEx);
          try {
            await recordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'recovery_required',
              requested_step: 'lock_release_failed',
              requested_error: relEx?.message || String(relEx),
              requested_worker_generation: workerGeneration,
              ...(workerId ? { requested_worker_id: workerId } : {}),
            });
          } catch {}
          return jsonResponse(500, {
            error: 'lock_release_failed',
            message: `Reset completed database cleanup but lock release threw exception: ${relEx?.message || 'Unknown error'}`,
            operationId,
            recoveryRequired: true,
          });
        }

        const { error: releaseError } = releaseRes ?? {};
        if (releaseError) {
          console.error('release_system_reset_lock returned error:', releaseError);
          try {
            await recordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'recovery_required',
              requested_step: 'lock_release_failed',
              requested_error: releaseError.message,
              requested_worker_generation: workerGeneration,
              ...(workerId ? { requested_worker_id: workerId } : {}),
            });
          } catch {}
          return jsonResponse(500, {
            error: 'lock_release_failed',
            message: `Reset completed database cleanup but lock release failed: ${releaseError.message}`,
            operationId,
            recoveryRequired: true,
          });
        }

        return jsonResponse(200, {
          success: true,
          message: 'System has been successfully reset to zero. All operational data purged.',
          operationId,
          result: rpcData,
          storage: {
            filesPurged: storageResult.totalFilesDeleted,
            verifiedEmpty: storageResult.verifiedEmpty,
          },
        });
      }

      if (body?.action === 'reconcile_system_reset' || body?.action === 'reconcile_reset') {
        const opId = typeof body.operationId === 'string' ? body.operationId.trim() : null;
        if (!opId) {
          return jsonResponse(400, {
            error: 'invalid_request',
            message: 'Valid UUID operationId is required for reset reconciliation.',
          });
        }

        const reconcileAction = body.reconcileAction || 'mark_failed';
        const { data: recData, error: recError } = await admin
          .schema('api')
          .rpc('reconcile_system_reset_operation', {
            requested_actor_id: actor.id,
            requested_op_id: opId,
            requested_action: reconcileAction,
            requested_note: body.note || null,
          });

        if (recError) {
          return jsonResponse(500, {
            error: 'reconciliation_failed',
            message: recError.message || 'System reset reconciliation RPC failed.',
          });
        }

        return jsonResponse(200, {
          success: true,
          result: recData,
        });
      }

      return jsonResponse(400, { error: 'unsupported_action' });
    }

    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const { data, error } = await admin
      .from('app_settings')
      .select(`
        working_hours_start,
        working_hours_end,
        timezone,
        scheduling_days_ahead,
        peak_mode,
        visit_purposes,
        rejection_reasons,
        image_retention_days,
        photo_retention_days,
        id_retention_days,
        photo_retention_enabled,
        id_retention_enabled,
        vehicle_photo_retention_enabled,
        vehicle_photo_retention_days,
        visitor_retention_enabled,
        visitor_retention_days,
        returning_profile_retention_enabled,
        returning_profile_retention_days,
        retention_overrides,
        audit_retention_days,
        reconciliation_retention_days,
        visitor_instructions,
        automatic_cleanup_enabled,
        global_retention_freeze,
        global_retention_freeze_reason,
        global_retention_freeze_updated_by,
        global_retention_freeze_updated_at,
        allow_emergency_exception,
        emergency_exception_policy_note,
        emergency_record_retention_enabled,
        emergency_record_retention_days,
        default_expected_gate,
        updated_at
      `)
      .eq('singleton', true)
      .maybeSingle();

    if (error) throw error;
    if (!data) return jsonResponse(404, { error: 'settings_not_found' });

    const startTime = typeof data.working_hours_start === 'string'
      ? data.working_hours_start.slice(0, 5)
      : '08:00';
    const endTime = typeof data.working_hours_end === 'string'
      ? data.working_hours_end.slice(0, 5)
      : '17:00';

    const turnstileSiteKeyConfigured = Boolean(process.env.VITE_TURNSTILE_SITE_KEY?.trim());
    const turnstileVerifierConfigured = Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());

    let systemResetStatus: any = { isLocked: false, status: 'idle', activeOperation: null };
    try {
      const { data: statusData, error: statusErr } = await admin
        .schema('api')
        .rpc('get_system_reset_status');

      if (!statusErr && statusData) {
        systemResetStatus = statusData;
      }
    } catch (maintErr) {
      console.warn('Could not query get_system_reset_status for reset status:', maintErr);
    }

    return jsonResponse(200, {
      systemReset: systemResetStatus,
      workingHours: {
        start: startTime,
        end: endTime,
        timezone: data.timezone || 'Asia/Manila',
      },
      peakMode: data.peak_mode !== 'off',
      peakModeScope: data.peak_mode,
      rejectionReasons: Array.isArray(data.rejection_reasons) ? data.rejection_reasons : [],
      visitPurposes: Array.isArray(data.visit_purposes) ? data.visit_purposes : [],
      visitorInstructions: Array.isArray(data.visitor_instructions) ? data.visitor_instructions : [],
      imageRetentionDays: data.image_retention_days,
      photoRetentionDays: data.photo_retention_days ?? data.image_retention_days ?? 7,
      idRetentionDays: data.id_retention_days ?? 30,
      photoRetentionEnabled: (data as any).photo_retention_enabled ?? true,
      idRetentionEnabled: (data as any).id_retention_enabled ?? true,
      vehiclePhotoRetentionEnabled: (data as any).vehicle_photo_retention_enabled ?? true,
      vehiclePhotoRetentionDays: (data as any).vehicle_photo_retention_days ?? 30,
      visitorRetentionEnabled: (data as any).visitor_retention_enabled ?? true,
      returningProfileRetentionEnabled: (data as any).returning_profile_retention_enabled ?? true,
      returningProfileRetentionDays: (data as any).returning_profile_retention_days ?? 30,
      retentionOverrides: (data as any).retention_overrides ?? [],
      visitorRetentionDays: data.visitor_retention_days,
      retentionDays: data.visitor_retention_days,
      auditRetentionDays: data.audit_retention_days,
      reconciliationRetentionDays: data.reconciliation_retention_days,
      automaticCleanupEnabled: (data as any).automatic_cleanup_enabled ?? true,
      globalRetentionFreeze: Boolean((data as any).global_retention_freeze),
      globalRetentionFreezeReason: (data as any).global_retention_freeze_reason ?? null,
      globalRetentionFreezeUpdatedBy: (data as any).global_retention_freeze_updated_by ?? null,
      globalRetentionFreezeUpdatedAt: (data as any).global_retention_freeze_updated_at ?? null,
      allowEmergencyException: Boolean((data as any).allow_emergency_exception),
      emergencyExceptionPolicyNote: (data as any).emergency_exception_policy_note ?? null,
      emergencyRecordRetentionEnabled: (data as any).emergency_record_retention_enabled ?? true,
      emergencyRecordRetentionDays: (data as any).emergency_record_retention_days ?? 90,
      defaultExpectedGate: (data as any).default_expected_gate ?? null,
      security: {
        turnstileSiteKeyConfigured,
        turnstileVerifierConfigured,
        turnstileFullyVerified: turnstileSiteKeyConfigured && turnstileVerifierConfigured,
        biometricStorageRetired: true,
      },
      schedulingDaysAhead: data.scheduling_days_ahead,
      updatedAt: data.updated_at,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    console.error('Failed to load settings', error);
    return jsonResponse(500, { error: 'failed_to_load_settings' });
  }
}

export default handleRequest;
export { handleRequest as GET, handleRequest as POST };
