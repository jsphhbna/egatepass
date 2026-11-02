import { jsonResponse } from '../../http.js';
import { isFaceVerificationConfigured, isFaceVerificationReady } from '../../lib/face-engine.js';
import { isReturningVisitorAvailable } from './identify-returning.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  // Priority 4: Verify true ONNX runtime readiness (model files, session creation, smoke inference)
  const isReady = await isFaceVerificationReady();
  const facialRecognitionConfigured = isFaceVerificationConfigured() && isReady;
  const returningVisitorAvailable = isReturningVisitorAvailable() && isReady;

  return jsonResponse(200, {
    returningVisitorAvailable,
    facialRecognitionConfigured,
  });
}

export default { fetch: handleRequest };
