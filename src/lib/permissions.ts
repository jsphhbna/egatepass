import type { AuthRole, UserRole } from '@/types';

export const USER_ROLES: readonly UserRole[] = ['guard', 'admin', 'superadmin', 'office_staff'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole);
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
