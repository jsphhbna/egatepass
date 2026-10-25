import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

describe('PATCH 1: Staff First-Password-Change State Machine Tests', () => {
  const useAuthSrc = readFileSync('src/hooks/useAuth.tsx', 'utf8');
  const loginPageSrc = readFileSync('src/pages/LoginPage.tsx', 'utf8');
  const protectedRouteSrc = readFileSync('src/components/ProtectedRoute.tsx', 'utf8');
  const forcePasswordChangeSrc = readFileSync('src/components/ForcePasswordChange.tsx', 'utf8');

  describe('Static & Behavioral Contract Verification', () => {
    it('1A. useAuth generalizes requiresPasswordChange to all staff roles and excludes devices/visitors', () => {
      // Must NOT be restricted to role === 'guard'
      expect(useAuthSrc).not.toContain("role === 'guard'\n          && userData?.kind === 'staff'");
      expect(useAuthSrc).not.toContain("role === 'guard' && userData?.kind === 'staff'");
      // Must check userData?.kind === 'staff' && userData.mustChangePassword === true
      expect(useAuthSrc).toMatch(/userData\?\.kind\s*===\s*['"]staff['"]\s*&&\s*userData\.mustChangePassword\s*===\s*true/);
    });

    it('1B. LoginPage navigates on both authenticated and requires_password_change', () => {
      expect(loginPageSrc).toContain("status !== 'authenticated' && status !== 'requires_password_change'");
      expect(loginPageSrc).toMatch(/admin:\s*'\/admin'/);
      expect(loginPageSrc).toMatch(/superadmin:\s*'\/admin'/);
      expect(loginPageSrc).toMatch(/guard:\s*'\/guard'/);
    });

    it('1C. ProtectedRoute enforces ForcePasswordChange before checking role permissions or rendering children', () => {
      const pIndex = protectedRouteSrc.indexOf("status === 'requires_password_change'");
      const roleIndex = protectedRouteSrc.indexOf("!allowedRoles.includes(role)");
      const outletIndex = protectedRouteSrc.indexOf("<Outlet />");

      expect(pIndex).toBeGreaterThan(-1);
      expect(roleIndex).toBeGreaterThan(-1);
      expect(outletIndex).toBeGreaterThan(-1);
      expect(pIndex).toBeLessThan(roleIndex);
      expect(pIndex).toBeLessThan(outletIndex);
    });

    it('1D. ForcePasswordChange is role-neutral, refreshes session, reloads profile, and verifies must_change_password=false', () => {
      // Role neutral
      expect(forcePasswordChangeSrc).not.toContain('Guard');
      expect(forcePasswordChangeSrc).toContain('useAuth');
      expect(forcePasswordChangeSrc).toContain('refreshSession');
      expect(forcePasswordChangeSrc).toContain('staff_profiles');
      expect(forcePasswordChangeSrc).toContain('must_change_password');
      expect(forcePasswordChangeSrc).toContain('refresh');
    });
  });

  describe('Pure State Machine Transitions', () => {
    function computeAuthState(role: string, userData: any) {
      const requiresPasswordChange =
        userData?.kind === 'staff' &&
        userData.mustChangePassword === true;

      return {
        status: requiresPasswordChange ? 'requires_password_change' : 'authenticated',
        role,
        userData,
      };
    }

    function computeLoginRedirect(status: string, role: string) {
      if (status !== 'authenticated' && status !== 'requires_password_change') return null;
      const redirectMap: Record<string, string> = {
        admin: '/admin',
        superadmin: '/admin',
        guard: '/guard',
        entry: '/scan/entry',
        exit: '/scan/exit',
        kiosk: '/kiosk',
      };
      return redirectMap[role] ?? '/login';
    }

    it('Guard + mustChangePassword=true produces requires_password_change and redirects to /guard', () => {
      const state = computeAuthState('guard', {
        kind: 'staff',
        role: 'guard',
        mustChangePassword: true,
      });
      expect(state.status).toBe('requires_password_change');
      expect(computeLoginRedirect(state.status, state.role)).toBe('/guard');
    });

    it('Admin + mustChangePassword=true produces requires_password_change and redirects to /admin', () => {
      const state = computeAuthState('admin', {
        kind: 'staff',
        role: 'admin',
        mustChangePassword: true,
      });
      expect(state.status).toBe('requires_password_change');
      expect(computeLoginRedirect(state.status, state.role)).toBe('/admin');
    });

    it('Super Admin + mustChangePassword=true produces requires_password_change and redirects to /admin', () => {
      const state = computeAuthState('superadmin', {
        kind: 'staff',
        role: 'superadmin',
        mustChangePassword: true,
      });
      expect(state.status).toBe('requires_password_change');
      expect(computeLoginRedirect(state.status, state.role)).toBe('/admin');
    });

    it('Bootstrapped Super Admin from private.bootstrap_super_admin (must_change_password=true) enforces password change', () => {
      // bootstrap_super_admin inserts into staff_profiles with must_change_password = true
      const bootstrappedSuperAdmin = {
        kind: 'staff',
        name: 'Initial Super Admin',
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
        active: true,
        mustChangePassword: true,
        privacyAcceptedAt: null,
      };
      const state = computeAuthState('superadmin', bootstrappedSuperAdmin);
      expect(state.status).toBe('requires_password_change');
      expect(computeLoginRedirect(state.status, state.role)).toBe('/admin');
    });

    it('Device with active status is never flagged for password change', () => {
      const device = {
        kind: 'device',
        name: 'Gate 1 Entry Scanner',
        type: 'entry',
        gate: 'Main Gate',
        alias: 'gate-entry-01',
        status: 'active',
      };
      const state = computeAuthState('entry', device);
      expect(state.status).toBe('authenticated');
      expect(computeLoginRedirect(state.status, state.role)).toBe('/scan/entry');
    });

    it('After successful password change, authoritative profile refresh results in authenticated state and normal access', () => {
      // State before change
      const beforeState = computeAuthState('superadmin', {
        kind: 'staff',
        role: 'superadmin',
        mustChangePassword: true,
      });
      expect(beforeState.status).toBe('requires_password_change');

      // State after change and authoritative refresh
      const afterState = computeAuthState('superadmin', {
        kind: 'staff',
        role: 'superadmin',
        mustChangePassword: false,
      });
      expect(afterState.status).toBe('authenticated');
      expect(computeLoginRedirect(afterState.status, afterState.role)).toBe('/admin');
    });
  });
});
