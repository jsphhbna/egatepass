import { HttpError } from './actors.js';
import { jsonResponse } from './http.js';
import type { RouteGroup } from './route-map.js';

export type HandlerFn = (request: Request) => Promise<Response> | Response;
export type HandlerModule =
  | HandlerFn
  | { fetch?: HandlerFn; default?: HandlerFn | { fetch?: HandlerFn } };

export function resolveHandler(mod: HandlerModule): HandlerFn {
  if (typeof mod === 'function') return mod;
  if (typeof (mod as any).fetch === 'function') return (mod as any).fetch;
  if (typeof (mod as any).default === 'function') return (mod as any).default;
  if (typeof (mod as any).default?.fetch === 'function') return (mod as any).default.fetch;
  throw new Error('Invalid route handler export');
}

export function extractRouteKey(pathname: string, group: RouteGroup): string | null {
  const clean = pathname.split('?')[0]?.replace(/^\/+|\/+$/g, '') || '';
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0 || parts[0] !== 'api') return null;

  // Direct group path: /api/<group>/<subpath>
  if (parts[1] === group && parts.length >= 3) {
    return parts.slice(2).join('/');
  }

  // Top-level rewritten path: /api/<subpath> for device, gate, system
  if (parts.length === 2 && (group === 'device' || group === 'gate' || group === 'system')) {
    return parts[1] || null;
  }

  // Webhook rewrite alias: /api/webhooks/resend -> resend-webhook for auth group
  if (group === 'auth' && parts[1] === 'webhooks' && parts[2] === 'resend') {
    return 'resend-webhook';
  }

  return null;
}

export function createGroupedRouter(
  group: RouteGroup,
  routes: Record<string, HandlerModule>
) {
  const handlerMap = new Map<string, HandlerFn>();
  for (const [key, mod] of Object.entries(routes)) {
    handlerMap.set(key, resolveHandler(mod));
  }

  const handleRequest: HandlerFn = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const routeKey = extractRouteKey(url.pathname, group);

      if (!routeKey) {
        return jsonResponse(404, { error: 'not_found' });
      }

      const handler = handlerMap.get(routeKey);
      if (!handler) {
        return jsonResponse(404, { error: 'not_found' });
      }

      return await handler(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.status, { error: error.code });
      }
      console.error(`Grouped router error (${group}):`, error instanceof Error ? error.message : 'unknown_error');
      return jsonResponse(500, { error: 'internal_server_error' });
    }
  };

  return {
    fetch: handleRequest,
    handleRequest,
    default: { fetch: handleRequest },
    GET: handleRequest,
    POST: handleRequest,
    PUT: handleRequest,
    PATCH: handleRequest,
    DELETE: handleRequest,
    HEAD: handleRequest,
    OPTIONS: handleRequest,
  };
}
