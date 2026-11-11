import type { AuthRole, DeviceType, UserRole } from '@/types';

export const USER_ROLES: readonly UserRole[] = ['guard', 'admin', 'superadmin', 'office_staff'];
export const DEVICE_TYPES: readonly DeviceType[] = ['entry', 'exit', 'kiosk', 'guard_station', 'emergency_device'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole);
}

export function isManagedDeviceRole(role: AuthRole): role is DeviceType {
  return typeof role === 'string' && DEVICE_TYPES.includes(role as DeviceType);
}

export function getDefaultHomeForRole(role: AuthRole): string {
  switch (role) {
    case 'admin':
    case 'superadmin':
      return '/admin';
    case 'office_staff':
      return '/office';
    case 'entry':
      return '/scan/entry';
    case 'exit':
      return '/scan/exit';
    case 'kiosk':
      return '/kiosk';
    case 'guard_station':
      return '/guard';
    case 'emergency_device':
      return '/emergency-device';
    default:
      return '/login';
  }
}

export function hasAdminAccess(role: AuthRole): role is 'admin' | 'superadmin' {
  return role === 'admin' || role === 'superadmin';
}

export function isSuperAdmin(role: AuthRole): role is 'superadmin' {
  return role === 'superadmin';
}

export function isOfficeStaff(role: AuthRole): role is 'office_staff' {
  return role === 'office_staff';
}

export function formatUserRole(role: UserRole): string {
  if (role === 'superadmin') return 'Super Admin';
  if (role === 'office_staff') return 'Office Staff';
  return role.charAt(0).toUpperCase() + role.slice(1);
}
