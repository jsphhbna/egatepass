import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireOfficeStaffActor } from '../server/lib/office.js';
import visitsHandler from '../server/routes/office/visits.js';
import personnelHandler from '../server/routes/office/personnel.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';
import { isOfficeStaff, USER_ROLES, formatUserRole } from '../src/lib/permissions.js';

describe('Office Authorization & Access Control Matrix', () => {
  const originalEnv = process.env;
  const officeA = '00000000-0000-4000-8000-000000000001';
  const officeB = '00000000-0000-4000-8000-000000000002';
  const mockJwtSecret = 'test-secret-long-enough-for-jwt-and-office-tokens!';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASS_TOKEN_SECRET: mockJwtSecret,
      RETURNING_MATCH_TOKEN_SECRET: mockJwtSecret,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-secret-key-supabase-admin-service-role',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Client Role Permissions (src/lib/permissions.ts)', () => {
    it('includes office_staff in USER_ROLES list', () => {
      expect(USER_ROLES).toContain('office_staff');
    });

    it('correctly identifies office_staff role', () => {
      expect(isOfficeStaff('office_staff')).toBe(true);
      expect(isOfficeStaff('admin')).toBe(false);
      expect(isOfficeStaff('superadmin')).toBe(false);
      expect(isOfficeStaff('guard')).toBe(false);
      expect(isOfficeStaff(undefined)).toBe(false);
    });

    it('formats office_staff role for human display', () => {
      expect(formatUserRole('office_staff')).toBe('Office Staff');
    });
  });

  describe('requireOfficeStaffActor Server Boundary Guard', () => {
    it('rejects anonymous sessions with 403 access_denied', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'anon-user-1' } as any,
        isAnonymous: true,
        isRecoverySession: false,
        sessionType: 'anonymous',
      });

      const mockAdmin = {} as any;
      await expect(
        requireOfficeStaffActor(mockAdmin, 'anon-token')
      ).rejects.toMatchObject({ status: 403, code: 'access_denied' });
    });

    it('rejects recovery sessions with 403 recovery_session_forbidden', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'recovery-user-1' } as any,
        isAnonymous: false,
        isRecoverySession: true,
        sessionType: 'authenticated',
      });

      const mockAdmin = {} as any;
      await expect(
        requireOfficeStaffActor(mockAdmin, 'recovery-token')
      ).rejects.toMatchObject({ status: 403, code: 'recovery_session_forbidden' });
    });

    it('rejects users with unverified emails with 403 email_verification_required', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'unverified-user-1', email: 'user@example.com', email_confirmed_at: null } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdmin = {} as any;
      await expect(
        requireOfficeStaffActor(mockAdmin, 'unverified-token')
      ).rejects.toMatchObject({ status: 403, code: 'email_verification_required' });
    });

    it('rejects staff who must change their initial password', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'must-change-1', email: 'mustchange@earist.edu.ph', email_confirmed_at: '2026-11-01' } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdmin = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              role: 'office_staff',
              active: true,
              must_change_password: true, // MUST CHANGE
              privacy_accepted_at: '2026-11-01',
            },
            error: null,
          }),
        })),
      } as any;

      await expect(
        requireOfficeStaffActor(mockAdmin, 'must-change-token')
      ).rejects.toMatchObject({ status: 403, code: 'access_denied' });
    });

    it('enforces assigned office scope for office_staff when targetOfficeId is specified', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'staff-office-a', email: 'staffA@earist.edu.ph', email_confirmed_at: '2026-11-01' } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  role: 'office_staff',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-11-01',
                },
                error: null,
              }),
            };
          }
          if (table === 'office_staff_assignments') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ office_id: officeA }], // Assigned to officeA only
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: officeA,
                    active: true,
                    publication_status: 'published',
                    archived_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }),
      } as any;

      // Accessing assigned officeA -> Allowed
      const actor = await requireOfficeStaffActor(mockAdmin, 'staff-token', officeA);
      expect(actor.role).toBe('office_staff');
      expect(actor.assignedOfficeIds).toContain(officeA);

      // Accessing unassigned officeB -> Denied with 403 unauthorized_for_this_office
      await expect(
        requireOfficeStaffActor(mockAdmin, 'staff-token', officeB)
      ).rejects.toMatchObject({ status: 403, code: 'unauthorized_for_this_office' });
    });

    it('permits admin and superadmin across any target office', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'admin-1', email: 'admin@earist.edu.ph', email_confirmed_at: '2026-11-01' } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  role: 'admin',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-11-01',
                },
                error: null,
              }),
            };
          }
          if (table === 'office_staff_assignments') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: officeA,
                    active: true,
                    publication_status: 'published',
                    archived_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }),
      } as any;

      // Admin accessing officeB (even without specific assignment) -> Allowed
      const actor = await requireOfficeStaffActor(mockAdmin, 'admin-token', officeB);
      expect(actor.role).toBe('admin');
    });
  });

  describe('GET /api/office/visits Scope Enforcements', () => {
    it('returns visits list for assigned office', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'staff-office-a', email: 'staffA@earist.edu.ph', email_confirmed_at: '2026-11-01' } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdminClient = {
        from: vi.fn((table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  role: 'office_staff',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-11-01',
                },
                error: null,
              }),
            };
          }
          if (table === 'office_staff_assignments') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ office_id: officeA }],
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: officeA, name: 'Registrar', description: 'Office of the Registrar' },
                error: null,
              }),
            };
          }
          if (table === 'office_visits') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'visit-1',
                    office_id: officeA,
                    approval_status: 'pending',
                    attendance_status: 'awaiting_entry',
                    visitor_first_name: 'Juan',
                    visitor_last_name: 'Dela Cruz',
                    visitor_email: 'juan@example.com',
                    purpose: 'Inquiry',
                    visit_date: '2026-11-06',
                    offices: { name: 'Registrar' },
                    office_personnel: { name: 'Mr. Garcia', title: 'Officer' },
                  },
                ],
                count: 1,
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: officeA,
                    active: true,
                    publication_status: 'published',
                    archived_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request(`http://localhost/api/office/visits?officeId=${officeA}&queue=pending`, {
        method: 'GET',
        headers: { Authorization: 'Bearer staff-token' },
      });

      const res = await visitsHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.visits).toHaveLength(1);
      expect(body.visits[0].id).toBe('visit-1');
    });

    it('rejects access when office staff tries to view visits of an unassigned office', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'staff-office-a', email: 'staffA@earist.edu.ph', email_confirmed_at: '2026-11-01' } as any,
        isAnonymous: false,
        isRecoverySession: false,
        sessionType: 'authenticated',
      });

      const mockAdminClient = {
        from: vi.fn((table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  role: 'office_staff',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-11-01',
                },
                error: null,
              }),
            };
          }
          if (table === 'office_staff_assignments') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ office_id: officeA }], // Only officeA!
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: officeA,
                    active: true,
                    publication_status: 'published',
                    archived_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request(`http://localhost/api/office/visits?officeId=${officeB}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer staff-token' },
      });

      const res = await visitsHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('unauthorized_for_this_office');
    });
  });

  describe('GET /api/office/personnel Directory Endpoint', () => {
    it('returns personnel directory for office', async () => {
      const mockAdminClient = {
        from: vi.fn((table: string) => {
          if (table === 'office_personnel') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'pers-1',
                    office_id: officeA,
                    name: 'Prof. Cruz',
                    title: 'Department Head',
                    active: true,
                  },
                ],
                error: null,
              }),
            };
          }
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: officeA,
                    active: true,
                    publication_status: 'published',
                    archived_at: null,
                  },
                  error: null,
                }),
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request(`http://localhost/api/office/personnel?officeId=${officeA}`, {
        method: 'GET',
      });

      const res = await personnelHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.personnel).toHaveLength(1);
      expect(body.personnel[0].name).toBe('Prof. Cruz');
    });
  });
});
