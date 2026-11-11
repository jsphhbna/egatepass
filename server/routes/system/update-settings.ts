import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const purposeSchema = z.object({
  label: z.string().trim().min(3).max(100),
  requiresDetails: z.boolean(),
  detailPrompt: z.string().trim().max(160),
}).strict().refine((purpose) => !purpose.requiresDetails || purpose.detailPrompt.length >= 3, {
  message: 'Instruction is required when details are enabled',
});

const workingHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  timezone: z.literal('Asia/Manila').optional(),
}).strict().refine((hours) => hours.start < hours.end, {
  message: 'Campus opening time must be earlier than closing time',
});

const settingsSchema = z.object({
  peakMode: z.union([z.boolean(), z.enum(['off', 'portal', 'kiosk', 'both'])]),
  rejectionReasons: z.array(z.string().trim().min(1).max(160)).max(50),
  visitPurposes: z.array(purposeSchema).min(1).max(50),
  visitorInstructions: z.array(z.string().trim().min(3).max(180)).min(1).max(8).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  visitorRetentionDays: z.number().int().min(7).max(730).optional(),
  imageRetentionDays: z.number().int().min(1).max(365).optional(),
  photoRetentionDays: z.number().int().min(1).max(365).optional(),
  idRetentionDays: z.number().int().min(1).max(365).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  reconciliationRetentionDays: z.number().int().min(30).max(3650).optional(),
  automaticCleanupEnabled: z.boolean().optional(),
  workingHours: workingHoursSchema.optional(),
  schedulingDaysAhead: z.number().int().min(0).max(90).optional(),
  photoRetentionEnabled: z.boolean().optional(),
  idRetentionEnabled: z.boolean().optional(),
  vehiclePhotoRetentionEnabled: z.boolean().optional(),
  vehiclePhotoRetentionDays: z.number().int().min(1).max(365).optional(),
  visitorRetentionEnabled: z.boolean().optional(),
  returningProfileRetentionEnabled: z.boolean().optional(),
  returningProfileRetentionDays: z.number().int().min(1).max(365).optional(),
  overrideReason: z.string().trim().max(500).optional(),
}).strict();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' });
  }

  const parsed = settingsSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const issuePath = firstIssue?.path?.length ? firstIssue.path.join('.') : 'settings';
    return jsonResponse(400, {
      error: 'invalid_settings',
      message: firstIssue ? `Invalid ${issuePath}: ${firstIssue.message}` : 'Invalid settings payload.',
      details: parsed.error.issues,
    });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

    // Fetch current settings to verify if security-sensitive settings or peakMode changed
    const { data: currentSettings, error: currentSettingsError } = await admin
      .from('app_settings')
      .select('peak_mode')
      .eq('singleton', true)
      .maybeSingle();

    if (currentSettingsError) {
      console.error('Failed to read current settings before update:', currentSettingsError);
      throw new HttpError(503, 'settings_load_failed');
    }

    let peakModeScope: 'off' | 'portal' | 'kiosk' | 'both';
    if (typeof parsed.data.peakMode === 'boolean') {
      peakModeScope = parsed.data.peakMode ? 'both' : 'off';
    } else {
      peakModeScope = parsed.data.peakMode;
    }

    const peakModeChanged = currentSettings !== null && peakModeScope !== currentSettings.peak_mode;

    const changesSecuritySettings =
      peakModeChanged ||
      parsed.data.retentionDays !== undefined ||
      parsed.data.visitorRetentionDays !== undefined ||
      parsed.data.imageRetentionDays !== undefined ||
      parsed.data.photoRetentionDays !== undefined ||
      parsed.data.idRetentionDays !== undefined ||
      parsed.data.auditRetentionDays !== undefined ||
      parsed.data.reconciliationRetentionDays !== undefined ||
      parsed.data.workingHours !== undefined ||
      parsed.data.schedulingDaysAhead !== undefined ||
      parsed.data.automaticCleanupEnabled !== undefined ||
      parsed.data.photoRetentionEnabled !== undefined ||
      parsed.data.idRetentionEnabled !== undefined ||
      parsed.data.vehiclePhotoRetentionEnabled !== undefined ||
      parsed.data.vehiclePhotoRetentionDays !== undefined ||
      parsed.data.visitorRetentionEnabled !== undefined ||
      parsed.data.returningProfileRetentionEnabled !== undefined ||
      parsed.data.returningProfileRetentionDays !== undefined;

    if (actor.role !== 'superadmin' && changesSecuritySettings) {
      throw new HttpError(403, 'Only Super Admins may change security-sensitive settings');
    }

    const startVal = parsed.data.workingHours?.start ?? null;
    const endVal = parsed.data.workingHours?.end ?? null;
    const imgRet = parsed.data.imageRetentionDays ?? null;
    const photoRet = parsed.data.photoRetentionDays ?? null;
    const idRet = parsed.data.idRetentionDays ?? null;
    const visRet = parsed.data.visitorRetentionDays ?? parsed.data.retentionDays ?? null;
    const audRet = parsed.data.auditRetentionDays ?? null;
    const recRet = parsed.data.reconciliationRetentionDays ?? null;
    const schedDays = parsed.data.schedulingDaysAhead ?? null;
    const cleanupVal = parsed.data.automaticCleanupEnabled ?? null;

    const hasGranularRetentionUpdates =
      parsed.data.photoRetentionEnabled !== undefined ||
      parsed.data.idRetentionEnabled !== undefined ||
      parsed.data.vehiclePhotoRetentionEnabled !== undefined ||
      parsed.data.vehiclePhotoRetentionDays !== undefined ||
      parsed.data.visitorRetentionEnabled !== undefined ||
      parsed.data.returningProfileRetentionEnabled !== undefined ||
      parsed.data.returningProfileRetentionDays !== undefined;

    const dedupedRejectionReasons = [...new Set(parsed.data.rejectionReasons)];

    // Atomic single-transaction RPC invocation in schema api (logs action: 'settings_updated' + retention overrides + expiry sync)
    const rpcResult = await admin.schema('api').rpc('save_system_settings', {
      requested_actor_id: actor.id,
      requested_peak_mode: peakModeScope,
      requested_rejection_reasons: dedupedRejectionReasons,
      requested_visit_purposes: parsed.data.visitPurposes,
      requested_visitor_instructions: parsed.data.visitorInstructions ?? null,
      requested_working_hours_start: startVal,
      requested_working_hours_end: endVal,
      requested_image_retention_days: imgRet,
      requested_photo_retention_days: photoRet,
      requested_id_retention_days: idRet,
      requested_visitor_retention_days: visRet,
      requested_audit_retention_days: audRet,
      requested_reconciliation_retention_days: recRet,
      requested_scheduling_days_ahead: schedDays,
      requested_automatic_cleanup_enabled: cleanupVal,
      requested_update_retention_policies: actor.role === 'superadmin' && hasGranularRetentionUpdates,
      requested_photo_enabled: parsed.data.photoRetentionEnabled ?? null,
      requested_policy_photo_days: photoRet,
      requested_id_enabled: parsed.data.idRetentionEnabled ?? null,
      requested_policy_id_days: idRet,
      requested_vehicle_enabled: parsed.data.vehiclePhotoRetentionEnabled ?? null,
      requested_vehicle_days: parsed.data.vehiclePhotoRetentionDays ?? null,
      requested_visitor_enabled: parsed.data.visitorRetentionEnabled ?? null,
      requested_policy_visitor_days: visRet,
      requested_returning_enabled: parsed.data.returningProfileRetentionEnabled ?? null,
      requested_returning_days: parsed.data.returningProfileRetentionDays ?? null,
      requested_override_reason: parsed.data.overrideReason ?? null,
      requested_request_id: randomUUID(),
    });

    // Zero direct table write fallback; fail closed atomically on any RPC error
    if (rpcResult.error) {
      const errCode = rpcResult.error.code;
      const errMsg = rpcResult.error.message || 'settings_update_failed';
      console.error('save_system_settings RPC failed:', rpcResult.error);

      if (
        errCode === '42501' ||
        errMsg.includes('access_denied') ||
        errMsg.includes('permission denied') ||
        errMsg.includes('super administrator required') ||
        errMsg.includes('administrator required')
      ) {
        throw new HttpError(403, errMsg);
      }
      if (errCode === 'P0002' || errMsg.includes('not_found')) {
        throw new HttpError(404, errMsg);
      }
      if (
        errCode === '23514' ||
        errCode === '22023' ||
        errMsg.includes('check_violation') ||
        errMsg.includes('opening time must be earlier') ||
        errMsg.includes('start time must be earlier') ||
        errMsg.includes('visitor instruction') ||
        errMsg.includes('rejection reason') ||
        errMsg.includes('retention_days')
      ) {
        throw new HttpError(400, errMsg);
      }
      if (errCode === 'PGRST202' || errMsg.includes('function api.save_system_settings') || errMsg.includes('Could not find the function')) {
        throw new HttpError(503, 'service_unavailable_migration_required');
      }
      throw new HttpError(503, errMsg);
    }

    const saved = (rpcResult.data && typeof rpcResult.data === 'object' ? rpcResult.data : {}) as Record<string, unknown>;

    return jsonResponse(200, {
      success: true,
      atomic: true,
      settings: {
        peak_mode: saved.peak_mode ?? peakModeScope,
        rejection_reasons: saved.rejection_reasons ?? dedupedRejectionReasons,
        visit_purposes: saved.visit_purposes ?? parsed.data.visitPurposes,
        visitor_instructions: saved.visitor_instructions ?? parsed.data.visitorInstructions,
        visitorInstructions: saved.visitor_instructions ?? parsed.data.visitorInstructions,
        working_hours_start: saved.working_hours_start ?? startVal,
        working_hours_end: saved.working_hours_end ?? endVal,
        image_retention_days: saved.image_retention_days ?? imgRet,
        photo_retention_days: saved.photo_retention_days ?? photoRet,
        id_retention_days: saved.id_retention_days ?? idRet,
        photoRetentionDays: saved.photo_retention_days ?? photoRet,
        idRetentionDays: saved.id_retention_days ?? idRet,
        visitor_retention_days: saved.visitor_retention_days ?? visRet,
        audit_retention_days: saved.audit_retention_days ?? audRet,
        reconciliation_retention_days: saved.reconciliation_retention_days ?? recRet,
        scheduling_days_ahead: saved.scheduling_days_ahead ?? schedDays,
        automatic_cleanup_enabled: saved.automatic_cleanup_enabled ?? cleanupVal,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code, message: error.message });
    }
    console.error('Settings update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable', message: 'Failed to save system settings.' });
  }
}

export default { fetch: handleRequest };
