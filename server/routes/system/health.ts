/**
 * server/routes/system/health.ts
 *
 * Truthful System Health & Liveness/Readiness Endpoint:
 * Performs real-time runtime verification of core infrastructure dependencies (PostgreSQL via Supabase).
 * Never mutates records, sends test emails, or returns false healthy status based on build metadata.
 *
 * Returns:
 * - 200 OK: { status: 'healthy', database: 'connected', liveness: 'ok', timestamp: string }
 * - 503 Service Unavailable: { status: 'unhealthy', database: 'disconnected', liveness: 'degraded', error: string, timestamp: string }
 */

import { jsonResponse } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

export async function healthHandler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const timestamp = new Date().toISOString();
  const headers = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Content-Type': 'application/json',
  };

  try {
    const { admin } = getServerSupabaseClients();
    const { error } = await admin
      .from('app_settings')
      .select('singleton')
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('System health check: database unreachable:', error);
      return jsonResponse(
        503,
        {
          status: 'unhealthy',
          database: 'disconnected',
          liveness: 'degraded',
          error: 'database_unavailable',
          timestamp,
        },
        headers
      );
    }

    return jsonResponse(
      200,
      {
        status: 'healthy',
        database: 'connected',
        liveness: 'ok',
        timestamp,
      },
      headers
    );
  } catch (err) {
    console.error('System health check unexpected error:', err);
    return jsonResponse(
      503,
      {
        status: 'unhealthy',
        database: 'disconnected',
        liveness: 'degraded',
        error: err instanceof Error ? err.message : 'health_check_failed',
        timestamp,
      },
      headers
    );
  }
}

export default { fetch: healthHandler };
