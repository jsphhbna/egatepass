import type { AuthRole, UserRole } from '@/types';

export const USER_ROLES: readonly UserRole[] = ['guard', 'admin', 'superadmin'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole);
}

export function hasAdminAccess(role: AuthRole): role is 'admin' | 'superadmin' {
  return role === 'admin' || role === 'superadmin';
}

export function isSuperAdmin(role: AuthRole): role is 'superadmin' {
  return role === 'superadmin';
}

export function formatUserRole(role: UserRole): string {
  if (role === 'superadmin') return 'Super Admin';
  return role.charAt(0).toUpperCase() + role.slice(1);
}
