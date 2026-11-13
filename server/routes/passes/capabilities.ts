import { jsonResponse } from '../../http.js';
import { isFaceVerificationConfigured, isFaceVerificationReady } from '../../lib/face-engine.js';
import { getServerSupabaseClients } from '../../supabase.js';
import {
  isReturningVisitorAvailable,
  isReturningCryptoConfigured,
  isThresholdConfigured,
  getThresholdMode,
  isReturningCalibrationConfigured,
} from './identify-returning.js';

async function loadPublicSafeRegistrationConfig() {
  try {
    const { admin } = getServerSupabaseClients();
    if (!admin?.from) return null;
    const { data, error } = await admin
      .from('app_settings')
      .select(`
        working_hours_start,
        working_hours_end,
        timezone,
        scheduling_days_ahead,
        peak_mode,
        visit_purposes,
        visitor_instructions,
        default_expected_gate,
        photo_retention_days,
        id_retention_days,
        vehicle_photo_retention_days,
        visitor_retention_days,
        returning_profile_retention_days,
        automatic_cleanup_enabled
      `)
      .eq('singleton', true)
      .maybeSingle();

    if (error || !data) return null;

    return {
      workingHoursStart: typeof data.working_hours_start === 'string' ? data.working_hours_start.slice(0, 5) : '08:00',
      workingHoursEnd: typeof data.working_hours_end === 'string' ? data.working_hours_end.slice(0, 5) : '17:00',
      timezone: data.timezone || 'Asia/Manila',
      schedulingDaysAhead: data.scheduling_days_ahead ?? 3,
      peakMode: data.peak_mode || 'off',
      visitPurposes: Array.isArray(data.visit_purposes) ? data.visit_purposes : [],
      visitorInstructions: Array.isArray(data.visitor_instructions) ? data.visitor_instructions : [],
      defaultExpectedGate: (data as any).default_expected_gate ?? null,
      retentionSummary: {
        photoRetentionDays: data.photo_retention_days ?? 7,
        idRetentionDays: data.id_retention_days ?? 30,
        vehiclePhotoRetentionDays: (data as any).vehicle_photo_retention_days ?? 30,
        visitorRetentionDays: data.visitor_retention_days ?? 90,
        returningProfileRetentionDays: (data as any).returning_profile_retention_days ?? 30,
        automaticCleanupEnabled: (data as any).automatic_cleanup_enabled ?? true,
      },
    };
  } catch {
    return null;
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const isReady = await isFaceVerificationReady();
  const faceEngineReady = isFaceVerificationConfigured() && isReady;
  const returningCryptoConfigured = isReturningCryptoConfigured();
  const thresholdConfigured = isThresholdConfigured();
  const thresholdMode = getThresholdMode();
  const returningVisitorAvailable = isReturningVisitorAvailable() && isReady;
  const calibrationConfigured = isReturningCalibrationConfigured();
  const turnstileSiteKeyConfigured = Boolean(process.env.VITE_TURNSTILE_SITE_KEY?.trim());
  const registrationConfig = await loadPublicSafeRegistrationConfig();

  return jsonResponse(200, {
    returningVisitorAvailable,
    returningEnrollmentAvailable: false,
    facialRecognitionConfigured: faceEngineReady,
    portraitComparisonAvailable: returningVisitorAvailable,
    faceEngineReady,
    returningCryptoConfigured,
    thresholdConfigured,
    thresholdMode,
    calibrationConfigured,
    returningCalibrationConfigured: calibrationConfigured,
    biometricStorageRetired: true,
    turnstile: {
      siteKeyConfigured: turnstileSiteKeyConfigured,
      serverVerifierConfigured: turnstileSiteKeyConfigured,
      verified: turnstileSiteKeyConfigured,
    },
    registrationConfig,
  });
}

export default { fetch: handleRequest };
