export type RouteGroup = 'admin' | 'auth' | 'passes' | 'device' | 'gate' | 'system';

export interface RouteContract {
  path: string;
  group: RouteGroup;
  subpath: string;
  allowedMethods: readonly string[];
  handlerModule: string;
}

export const ROUTE_CONTRACT_MATRIX: readonly RouteContract[] = [
  // Admin Router (9 routes)
  {
    path: '/api/admin/activity',
    group: 'admin',
    subpath: 'activity',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/activity.ts',
  },
  {
    path: '/api/admin/dashboard',
    group: 'admin',
    subpath: 'dashboard',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/dashboard.ts',
  },
  {
    path: '/api/admin/devices',
    group: 'admin',
    subpath: 'devices',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/devices.ts',
  },
  {
    path: '/api/admin/emergency',
    group: 'admin',
    subpath: 'emergency',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/emergency.ts',
  },
  {
    path: '/api/admin/holds',
    group: 'admin',
    subpath: 'holds',
    allowedMethods: ['GET', 'POST', 'DELETE', 'PATCH'],
    handlerModule: 'server/routes/admin/holds.ts',
  },
  {
    path: '/api/admin/records',
    group: 'admin',
    subpath: 'records',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/records.ts',
  },
  {
    path: '/api/admin/retention-maintenance',
    group: 'admin',
    subpath: 'retention-maintenance',
    allowedMethods: ['POST', 'GET'],
    handlerModule: 'server/routes/admin/retention-maintenance.ts',
  },
  {
    path: '/api/admin/settings',
    group: 'admin',
    subpath: 'settings',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/settings.ts',
  },
  {
    path: '/api/admin/users',
    group: 'admin',
    subpath: 'users',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/admin/users.ts',
  },

  // Auth Router (3 routes)
  {
    path: '/api/auth/complete-password-change',
    group: 'auth',
    subpath: 'complete-password-change',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/auth/complete-password-change.ts',
  },
  {
    path: '/api/auth/reset-password',
    group: 'auth',
    subpath: 'reset-password',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/auth/reset-password.ts',
  },
  {
    path: '/api/auth/send-email-hook',
    group: 'auth',
    subpath: 'send-email-hook',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/auth/send-email-hook.ts',
  },
  {
    path: '/api/auth/resend-webhook',
    group: 'auth',
    subpath: 'resend-webhook',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/auth/resend-webhook.ts',
  },

  // Passes Router (2 routes)
  {
    path: '/api/passes/email',
    group: 'passes',
    subpath: 'email',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/passes/email.ts',
  },
  {
    path: '/api/passes/issue',
    group: 'passes',
    subpath: 'issue',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/passes/issue.ts',
  },

  // Device Router (4 routes)
  {
    path: '/api/create-device',
    group: 'device',
    subpath: 'create-device',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/device/create-device.ts',
  },
  {
    path: '/api/delete-device',
    group: 'device',
    subpath: 'delete-device',
    allowedMethods: ['DELETE'],
    handlerModule: 'server/routes/device/delete-device.ts',
  },
  {
    path: '/api/update-device',
    group: 'device',
    subpath: 'update-device',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/device/update-device.ts',
  },
  {
    path: '/api/update-device-auth',
    group: 'device',
    subpath: 'update-device-auth',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/device/update-device-auth.ts',
  },

  // Gate Router (3 routes)
  {
    path: '/api/scan-pass',
    group: 'gate',
    subpath: 'scan-pass',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/gate/scan-pass.ts',
  },
  {
    path: '/api/decide-visit',
    group: 'gate',
    subpath: 'decide-visit',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/gate/decide-visit.ts',
  },
  {
    path: '/api/evidence',
    group: 'gate',
    subpath: 'evidence',
    allowedMethods: ['GET'],
    handlerModule: 'server/routes/gate/evidence.ts',
  },

  // System Router (5 routes)
  {
    path: '/api/create-user',
    group: 'system',
    subpath: 'create-user',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/system/create-user.ts',
  },
  {
    path: '/api/update-user',
    group: 'system',
    subpath: 'update-user',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/system/update-user.ts',
  },
  {
    path: '/api/update-settings',
    group: 'system',
    subpath: 'update-settings',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/system/update-settings.ts',
  },
  {
    path: '/api/purge-images',
    group: 'system',
    subpath: 'purge-images',
    allowedMethods: ['POST'],
    handlerModule: 'server/routes/system/purge-images.ts',
  },
  {
    path: '/api/reconciliation-items',
    group: 'system',
    subpath: 'reconciliation-items',
    allowedMethods: ['GET', 'PATCH'],
    handlerModule: 'server/routes/system/reconciliation-items.ts',
  },
] as const;

export function getRouteByPath(path: string): RouteContract | undefined {
  const normalized = path.split('?')[0]?.replace(/\/+$/, '') || '';
  return ROUTE_CONTRACT_MATRIX.find((r) => r.path === normalized);
}

export function getRoutesByGroup(group: RouteGroup): readonly RouteContract[] {
  return ROUTE_CONTRACT_MATRIX.filter((r) => r.group === group);
}
