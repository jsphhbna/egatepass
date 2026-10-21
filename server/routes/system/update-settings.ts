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
  retentionDays: z.number().int().min(1).max(3650).optional(),
  visitorRetentionDays: z.number().int().min(7).max(730).optional(),
  imageRetentionDays: z.number().int().min(1).max(365).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  reconciliationRetentionDays: z.number().int().min(30).max(3650).optional(),
  automaticCleanupEnabled: z.boolean().optional(),
  workingHours: workingHoursSchema.optional(),
  schedulingDaysAhead: z.number().int().min(0).max(90).optional(),
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
    return jsonResponse(400, { error: 'invalid_settings', details: parsed.error.issues });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const changesSecuritySettings =
      parsed.data.retentionDays !== undefined ||
      parsed.data.visitorRetentionDays !== undefined ||
      parsed.data.imageRetentionDays !== undefined ||
      parsed.data.auditRetentionDays !== undefined ||
      parsed.data.reconciliationRetentionDays !== undefined ||
      parsed.data.workingHours !== undefined ||
      parsed.data.schedulingDaysAhead !== undefined ||
      parsed.data.automaticCleanupEnabled !== undefined;

    if (actor.role !== 'superadmin' && changesSecuritySettings) {
      throw new HttpError(403, 'Only Super Admins may change security-sensitive settings');
    }

    let peakModeScope: 'off' | 'portal' | 'kiosk' | 'both';
    if (typeof parsed.data.peakMode === 'boolean') {
      peakModeScope = parsed.data.peakMode ? 'both' : 'off';
    } else {
      peakModeScope = parsed.data.peakMode;
    }

    const startVal = parsed.data.workingHours?.start ?? null;
    const endVal = parsed.data.workingHours?.end ?? null;
    const imgRet = parsed.data.imageRetentionDays ?? null;
    const visRet = parsed.data.visitorRetentionDays ?? parsed.data.retentionDays ?? null;
    const audRet = parsed.data.auditRetentionDays ?? null;
    const recRet = parsed.data.reconciliationRetentionDays ?? null;
    const schedDays = parsed.data.schedulingDaysAhead ?? null;
    const cleanupVal = parsed.data.automaticCleanupEnabled ?? null;

    // Atomic audited RPC invocation in schema api (logs action: 'settings_updated' in same SQL transaction)
    const rpcResult = await admin.schema('api').rpc('update_app_settings', {
      requested_actor_id: actor.id,
      requested_peak_mode: peakModeScope,
      requested_rejection_reasons: [...new Set(parsed.data.rejectionReasons)],
      requested_visit_purposes: parsed.data.visitPurposes,
      requested_working_hours_start: startVal,
      requested_working_hours_end: endVal,
      requested_image_retention_days: imgRet,
      requested_visitor_retention_days: visRet,
      requested_audit_retention_days: audRet,
      requested_reconciliation_retention_days: recRet,
      requested_scheduling_days_ahead: schedDays,
      requested_automatic_cleanup_enabled: cleanupVal,
      requested_request_id: randomUUID(),
    });

    // P0-03: Zero direct table write fallback; fail closed on any RPC error
    if (rpcResult.error) {
      const errCode = rpcResult.error.code;
      const errMsg = rpcResult.error.message || 'settings_update_failed';
      console.error('update_app_settings RPC failed:', rpcResult.error);

      if (errCode === '42501' || errMsg.includes('access_denied') || errMsg.includes('permission denied')) {
        throw new HttpError(403, errMsg);
      }
      if (errCode === 'P0002' || errMsg.includes('not_found')) {
        throw new HttpError(404, errMsg);
      }
      if (errCode === '23514' || errMsg.includes('check_violation') || errMsg.includes('opening time must be earlier')) {
        throw new HttpError(400, errMsg);
      }
      if (errCode === 'PGRST202' || errMsg.includes('function api.update_app_settings') || errMsg.includes('Could not find the function')) {
        throw new HttpError(503, 'service_unavailable_migration_required');
      }
      throw new HttpError(503, errMsg);
    }

    return jsonResponse(200, {
      success: true,
      settings: {
        peak_mode: peakModeScope,
        rejection_reasons: parsed.data.rejectionReasons,
        visit_purposes: parsed.data.visitPurposes,
        working_hours_start: startVal,
        working_hours_end: endVal,
        image_retention_days: imgRet,
        visitor_retention_days: visRet,
        audit_retention_days: audRet,
        reconciliation_retention_days: recRet,
        scheduling_days_ahead: schedDays,
        automatic_cleanup_enabled: cleanupVal,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    console.error('Settings update failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
