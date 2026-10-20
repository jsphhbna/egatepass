import { z } from 'zod';
import { HttpError, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

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
      parsed.data.schedulingDaysAhead !== undefined;

    if (actor.role !== 'superadmin' && changesSecuritySettings) {
      throw new HttpError(403, 'Only Super Admins may change security-sensitive settings');
    }

    const { data: beforeData, error: readError } = await admin
      .from('app_settings')
      .select('*')
      .eq('singleton', true)
      .maybeSingle();

    if (readError) throw readError;

    let peakModeScope: 'off' | 'portal' | 'kiosk' | 'both';
    if (typeof parsed.data.peakMode === 'boolean') {
      peakModeScope = parsed.data.peakMode ? 'both' : 'off';
    } else {
      peakModeScope = parsed.data.peakMode;
    }

    const updatePayload: Record<string, unknown> = {
      peak_mode: peakModeScope,
      rejection_reasons: [...new Set(parsed.data.rejectionReasons)],
      visit_purposes: parsed.data.visitPurposes,
      updated_by: actor.id,
      updated_at: new Date().toISOString(),
    };

    if (actor.role === 'superadmin') {
      if (parsed.data.workingHours) {
        updatePayload.working_hours_start = parsed.data.workingHours.start;
        updatePayload.working_hours_end = parsed.data.workingHours.end;
      }
      if (parsed.data.imageRetentionDays !== undefined) {
        updatePayload.image_retention_days = parsed.data.imageRetentionDays;
      }
      const vDays = parsed.data.visitorRetentionDays ?? parsed.data.retentionDays;
      if (vDays !== undefined) {
        updatePayload.visitor_retention_days = vDays;
      }
      if (parsed.data.auditRetentionDays !== undefined) {
        updatePayload.audit_retention_days = parsed.data.auditRetentionDays;
      }
      if (parsed.data.reconciliationRetentionDays !== undefined) {
        updatePayload.reconciliation_retention_days = parsed.data.reconciliationRetentionDays;
      }
      if (parsed.data.schedulingDaysAhead !== undefined) {
        updatePayload.scheduling_days_ahead = parsed.data.schedulingDaysAhead;
      }
    }

    const { error: updateError } = await admin
      .from('app_settings')
      .update(updatePayload)
      .eq('singleton', true);

    if (updateError) throw updateError;

    await admin.from('audit_events').insert({
      actor_id: actor.id,
      actor_kind: 'staff',
      actor_role: actor.role,
      action: 'settings_updated',
      target_type: 'settings',
      target_id: 'app',
      before_state: beforeData ? (beforeData as Record<string, unknown>) : null,
      after_state: updatePayload,
      outcome: 'success',
    });

    return jsonResponse(200, { success: true, settings: updatePayload });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    console.error('Failed to update settings', error);
    return jsonResponse(500, { error: 'failed_to_update_settings' });
  }
}

export default handleRequest;
export { handleRequest as POST };
