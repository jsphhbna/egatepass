import { jsonResponse } from '../../http.js';
import { isReturningVisitorAvailable } from './identify-returning.js';

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const returningVisitorAvailable = isReturningVisitorAvailable();

  return jsonResponse(200, {
    returningVisitorAvailable,
    facialRecognitionConfigured: returningVisitorAvailable,
  });
}

export default { fetch: handleRequest };
