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
        visitor_retention_days,
        audit_retention_days,
        reconciliation_retention_days,
        visitor_instructions,
        automatic_cleanup_enabled,
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
      visitorRetentionDays: data.visitor_retention_days,
      retentionDays: data.visitor_retention_days,
      auditRetentionDays: data.audit_retention_days,
      reconciliationRetentionDays: data.reconciliation_retention_days,
      automaticCleanupEnabled: (data as any).automatic_cleanup_enabled ?? true,
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
