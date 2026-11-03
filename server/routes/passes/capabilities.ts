import { jsonResponse } from '../../http.js';
import { isFaceVerificationConfigured, isFaceVerificationReady } from '../../lib/face-engine.js';
import {
  isReturningVisitorAvailable,
  isReturningEnrollmentAvailable,
  isReturningCryptoConfigured,
  isThresholdConfigured,
  getThresholdMode,
  isReturningCalibrationConfigured,
} from './identify-returning.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  // Verify true ONNX runtime readiness (model files, session creation, smoke inference)
  const isReady = await isFaceVerificationReady();
  const facialRecognitionConfigured = isFaceVerificationConfigured() && isReady;
  const returningCryptoConfigured = isReturningCryptoConfigured();
  const thresholdConfigured = isThresholdConfigured();
  const thresholdMode = getThresholdMode();
  const returningEnrollmentAvailable = isReturningEnrollmentAvailable() && isReady;
  const returningVisitorAvailable = isReturningVisitorAvailable() && isReady;

  return jsonResponse(200, {
    returningVisitorAvailable,
    returningEnrollmentAvailable,
    facialRecognitionConfigured,
    returningCryptoConfigured,
    thresholdConfigured,
    thresholdMode,
    // Preserved for backward compatibility with existing tests
    returningCalibrationConfigured: isReturningCalibrationConfigured(),
  });
}

export default { fetch: handleRequest };
