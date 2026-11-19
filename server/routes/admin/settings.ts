import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { purgeAndVerifyStorageBuckets } from '../../lib/storagePurgeService.js';

async function safeRecordResetStep(admin: any, args: Record<string, any>): Promise<void> {
  try {
    await admin.schema('api').rpc('record_system_reset_step', args);
  } catch {
    // Non-fatal telemetry recording failure
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

        // Phase 1: Concurrency Protection — Acquire exclusive reset lock
        let operationId: string | null = null;
        try {
          const { data: lockData, error: lockError } = await admin
            .schema('api')
            .rpc('acquire_system_reset_lock', { requested_actor_id: actor.id });

          if (!lockError && lockData) {
            if (!lockData.acquired) {
              return jsonResponse(409, {
                error: 'reset_in_progress',
                message: 'A system reset is currently in progress or requires manual recovery.',
              });
            }
            operationId = lockData.operation_id;
          }
        } catch (lockErr) {
          console.warn('acquire_system_reset_lock non-fatal fallback (test/unmigrated schema):', lockErr);
        }

        // Phase 2: Supabase Storage Purge via official Storage API
        // Removes nested objects from visitor-photos and visitor-ids before deleting Auth accounts
        let storageResult;
        try {
          if (operationId) {
            await safeRecordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'storage_deletion_in_progress',
              requested_step: 'storage_deletion_in_progress',
            });
          }

          storageResult = await purgeAndVerifyStorageBuckets(admin);

          if (operationId) {
            await safeRecordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'storage_deletion_verified',
              requested_step: 'storage_deletion_verified',
              requested_manifest: storageResult.inventories,
              requested_counts: {
                totalDiscovered: storageResult.totalFilesDiscovered,
                totalDeleted: storageResult.totalFilesDeleted,
              },
            });
          }
        } catch (storageErr: any) {
          console.error('Storage purge or verification failed during return_to_zero:', storageErr);
          if (operationId) {
            await safeRecordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'failed',
              requested_step: 'storage_purge_failed',
              requested_error: storageErr?.message || String(storageErr),
            });
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
        if (operationId) {
          await safeRecordResetStep(admin, {
            requested_op_id: operationId,
            requested_status: 'database_cleanup_in_progress',
            requested_step: 'database_cleanup_in_progress',
          });
        }

        const { data: rpcData, error: rpcError } = await admin.schema('api').rpc('return_to_zero_reset', {
          requested_actor_id: actor.id,
        });

        if (rpcError) {
          console.error('return_to_zero_reset RPC error:', rpcError);
          if (operationId) {
            await safeRecordResetStep(admin, {
              requested_op_id: operationId,
              requested_status: 'recovery_required',
              requested_step: 'database_cleanup_failed',
              requested_error: rpcError.message,
            });
          }
          return jsonResponse(500, {
            error: 'database_reset_failed',
            message: rpcError.message,
            operationId,
            recoveryRequired: true,
          });
        }

        // Phase 4: Release Reset Lock & Mark Completed
        if (operationId) {
          try {
            await admin.schema('api').rpc('release_system_reset_lock', {
              requested_actor_id: actor.id,
              requested_op_id: operationId,
            });
          } catch {
            // Non-fatal lock release failure
          }
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

    return jsonResponse(200, {
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
