import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
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
export { handleRequest as GET };
