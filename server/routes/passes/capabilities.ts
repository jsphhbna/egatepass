import { jsonResponse } from '../../http.js';
import { isFaceVerificationConfigured } from '../../lib/face-engine.js';
import { isReturningVisitorAvailable } from './identify-returning.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const facialRecognitionConfigured = isFaceVerificationConfigured();
  const returningVisitorAvailable = isReturningVisitorAvailable();

  return jsonResponse(200, {
    returningVisitorAvailable,
    facialRecognitionConfigured,
  });
}

export default { fetch: handleRequest };
