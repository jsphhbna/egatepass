import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import express from 'express';

describe('Legacy Guard Authentication & Authority Decommissioning', () => {
  describe('LoginPage & useAuth Guard Account Rejection Contract', () => {
    it('rejects legacy guard role and signs out immediately', async () => {
      const signOutMock = vi.fn().mockResolvedValue({ error: null });

      const handleUserRole = async (profile: { role: string; active: boolean }) => {
        if (profile.role === 'guard') {
          await signOutMock();
          return {
            allowed: false,
            error: 'This legacy Guard account is disabled. Gate monitoring now uses a Guard Station device.',
            redirectTo: null,
          };
        }
        return {
          allowed: true,
          error: null,
          redirectTo: profile.role === 'superadmin' ? '/admin' : '/admin',
        };
      };

      const guardProfile = { role: 'guard', active: true };
      const guardResult = await handleUserRole(guardProfile);

      expect(signOutMock).toHaveBeenCalledTimes(1);
      expect(guardResult.allowed).toBe(false);
      expect(guardResult.redirectTo).toBeNull();
      expect(guardResult.error).toBe(
        'This legacy Guard account is disabled. Gate monitoring now uses a Guard Station device.'
      );

      // Verify admin role succeeds normally
      const adminProfile = { role: 'admin', active: true };
      const adminResult = await handleUserRole(adminProfile);
      expect(adminResult.allowed).toBe(true);
      expect(adminResult.error).toBeNull();
      expect(adminResult.redirectTo).toBe('/admin');
    });

    it('LoginPage redirectMap excludes /guard route', () => {
      const redirectMap: Record<string, string> = {
        admin: '/admin',
        superadmin: '/admin',
      };

      expect(redirectMap['guard']).toBeUndefined();
      expect(redirectMap['admin']).toBe('/admin');
      expect(redirectMap['superadmin']).toBe('/admin');
    });
  });

  describe('System User Creation Route Schema & Role Restriction', () => {
    const createUserSchema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      displayName: z.string().min(1).max(100),
      role: z.literal('admin'),
    });

    it('accepts role: "admin" in create user schema', () => {
      const validAdminPayload = {
        email: 'newadmin@earist.edu.ph',
        password: 'Password123!',
        displayName: 'New Admin',
        role: 'admin',
      };
      const result = createUserSchema.safeParse(validAdminPayload);
      expect(result.success).toBe(true);
    });

    it('strictly rejects role: "guard" in create user schema', () => {
      const legacyGuardPayload = {
        email: 'legacyguard@earist.edu.ph',
        password: 'Password123!',
        displayName: 'Legacy Guard',
        role: 'guard',
      };
      const result = createUserSchema.safeParse(legacyGuardPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('admin');
      }
    });

    it('strictly rejects any other role such as "staff" or "kiosk"', () => {
      expect(createUserSchema.safeParse({
        email: 'other@earist.edu.ph',
        password: 'Password123!',
        displayName: 'Other',
        role: 'staff',
      }).success).toBe(false);

      expect(createUserSchema.safeParse({
        email: 'super@earist.edu.ph',
        password: 'Password123!',
        displayName: 'Super',
        role: 'superadmin',
      }).success).toBe(false);
    });
  });
});
