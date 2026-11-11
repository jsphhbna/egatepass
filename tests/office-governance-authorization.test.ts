import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRequest as adminOfficesHandler } from '../server/routes/admin/offices.js';
import { handleRequest as updateUserHandler } from '../server/routes/system/update-user.js';
import { handleRequest as officePersonnelHandler } from '../server/routes/office/personnel.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';

describe('Office Governance & Authorization Test Suite', () => {
  const originalEnv = process.env;
  const superadminId = '00000000-0000-4000-8000-000000000001';
  const adminId = '00000000-0000-4000-8000-000000000002';
  const staffUserId1 = '00000000-0000-4000-8000-000000000003';
  const staffUserId2 = '00000000-0000-4000-8000-000000000004';

  const office1Id = '11111111-1111-4111-8111-111111111111'; // active & verified
  const office2Id = '22222222-2222-4222-8222-222222222222'; // active & UNVERIFIED
  const office3Id = '33333333-3333-4333-8333-333333333333'; // inactive & verified

  let mockOffices: Array<any> = [];
  let mockAssignments: Array<{ office_id: string; user_id: string; created_at?: string; created_by?: string }> = [];
  let mockStaffProfiles: Array<any> = [];
  let mockPersonnel: Array<any> = [];

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-service-key',
      OFFICE_VISIT_HMAC_SECRET: 'test-hmac-secret-at-least-32-chars-long-strictly',
    };

    mockOffices = [
      {
        id: office1Id,
        name: 'Registrar Office',
        description: 'Student records and transcripts',
        active: true,
        verified: true,
        publication_status: 'published',
        requires_approval_before_pass: true,
        archived_at: null,
        verified_at: '2026-11-01T00:00:00Z',
        verified_by: superadminId,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: office2Id,
        name: 'New Unverified Office',
        description: 'Under review',
        active: true,
        verified: false,
        publication_status: 'draft',
        requires_approval_before_pass: true,
        archived_at: null,
        verified_at: null,
        verified_by: null,
        created_at: '2026-11-02T00:00:00Z',
        updated_at: '2026-11-02T00:00:00Z',
      },
      {
        id: office3Id,
        name: 'Deactivated Office',
        description: 'Currently closed',
        active: false,
        verified: true,
        publication_status: 'published',
        requires_approval_before_pass: true,
        archived_at: null,
        verified_at: '2026-11-01T00:00:00Z',
        verified_by: superadminId,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
    ];

    mockStaffProfiles = [
      {
        user_id: superadminId,
        role: 'superadmin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-11-01T00:00:00Z',
      },
      {
        user_id: adminId,
        role: 'admin',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-11-01T00:00:00Z',
      },
      {
        user_id: staffUserId1,
        role: 'office_staff',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-11-01T00:00:00Z',
      },
      {
        user_id: staffUserId2,
        role: 'office_staff',
        active: true,
        must_change_password: false,
        privacy_accepted_at: '2026-11-01T00:00:00Z',
      },
    ];

    mockAssignments = [
      {
        office_id: office1Id,
        user_id: staffUserId1,
        created_at: '2026-11-01T00:00:00Z',
        created_by: superadminId,
      },
    ];

    mockPersonnel = [
      {
        id: '55555555-5555-4555-8555-555555555551',
        office_id: office1Id,
        name: 'Dr. Jane Smith',
        title: 'Registrar Head',
        active: true,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: '55555555-5555-4555-8555-555555555552',
        office_id: office1Id,
        name: 'John Doe',
        title: 'Former Assistant',
        active: false,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
    ];

    // Supabase Mock
    const mockAdminClient = {
      from: vi.fn((table: string) => {
        if (table === 'offices') {
          return {
            select: vi.fn((cols: string) => {
              let filtered = [...mockOffices];
              const builder: any = {
                order: vi.fn().mockImplementation(() => builder),
                eq: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r) => r[field] === val);
                  return builder;
                }),
                is: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r) => (r[field] ?? null) === val);
                  return builder;
                }),
                in: vi.fn((field: string, vals: any[]) => {
                  filtered = filtered.filter((r) => vals.includes(r[field]));
                  return builder;
                }),
                maybeSingle: vi.fn().mockImplementation(async () => ({
                  data: filtered[0] || null,
                  error: null,
                })),
                single: vi.fn().mockImplementation(async () => ({
                  data: filtered[0] || null,
                  error: filtered.length ? null : new Error('PGRST116'),
                })),
                then: (resolve: any) => resolve({ data: filtered, error: null }),
              };
              return builder;
            }),
            insert: vi.fn((row: any) => {
              const newRow = {
                id: '44444444-4444-4444-8444-444444444444',
                verified: false,
                verified_at: null,
                verified_by: null,
                created_at: '2026-11-09T00:00:00Z',
                updated_at: '2026-11-09T00:00:00Z',
                ...row,
              };
              mockOffices.push(newRow);
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: newRow, error: null }),
                }),
              };
            }),
            update: vi.fn((updates: any) => {
              return {
                eq: vi.fn((field: string, val: any) => {
                  const idx = mockOffices.findIndex((r) => r[field] === val);
                  if (idx >= 0) {
                    mockOffices[idx] = { ...mockOffices[idx], ...updates };
                    return {
                      select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({ data: mockOffices[idx], error: null }),
                      }),
                    };
                  }
                  return {
                    select: vi.fn().mockReturnValue({
                      single: vi.fn().mockResolvedValue({ data: null, error: new Error('PGRST116') }),
                    }),
                  };
                }),
              };
            }),
          };
        }

        if (table === 'office_staff_assignments') {
          return {
            select: vi.fn((cols: string) => {
              let filtered = [...mockAssignments];
              const builder: any = {
                eq: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r) => r[field] === val);
                  return builder;
                }),
                then: (resolve: any) => resolve({ data: filtered, error: null }),
              };
              return builder;
            }),
            upsert: vi.fn((row: any) => {
              const idx = mockAssignments.findIndex(
                (a) => a.office_id === row.office_id && a.user_id === row.user_id,
              );
              if (idx >= 0) {
                mockAssignments[idx] = { ...mockAssignments[idx], ...row };
              } else {
                mockAssignments.push(row);
              }
              return Promise.resolve({ error: null });
            }),
            insert: vi.fn((rows: any) => {
              const items = Array.isArray(rows) ? rows : [rows];
              for (const item of items) {
                mockAssignments.push(item);
              }
              return Promise.resolve({ error: null });
            }),
            delete: vi.fn(() => {
              const builder: any = {
                eq: vi.fn((field: string, val: any) => {
                  mockAssignments = mockAssignments.filter((a) => (a as any)[field] !== val);
                  return builder;
                }),
                then: (resolve: any) => resolve({ error: null }),
              };
              return builder;
            }),
          };
        }

        if (table === 'staff_profiles') {
          return {
            select: vi.fn((cols: string) => {
              let filtered = [...mockStaffProfiles];
              const builder: any = {
                eq: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r) => r[field] === val);
                  return builder;
                }),
                maybeSingle: vi.fn().mockImplementation(async () => ({
                  data: filtered[0] || null,
                  error: null,
                })),
                single: vi.fn().mockImplementation(async () => ({
                  data: filtered[0] || null,
                  error: filtered.length ? null : new Error('PGRST116'),
                })),
                then: (resolve: any) => resolve({ data: filtered, error: null }),
              };
              return builder;
            }),
            update: vi.fn((updates: any) => ({
              eq: vi.fn(() => Promise.resolve({ error: null })),
            })),
          };
        }

        if (table === 'office_personnel') {
          return {
            select: vi.fn((cols: string) => {
              let filtered = [...mockPersonnel];
              const builder: any = {
                order: vi.fn().mockImplementation(() => builder),
                eq: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r) => r[field] === val);
                  return builder;
                }),
                then: (resolve: any) => resolve({ data: filtered, error: null }),
              };
              return builder;
            }),
          };
        }

        return {} as any;
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (name: string, args: any) => {
          if (name === 'replace_staff_office_assignments') {
            const target = mockStaffProfiles.find((p) => p.user_id === args.requested_user_id);
            if (!target) return { data: null, error: { code: 'P0002', message: 'staff user not found' } };
            const ids: string[] = Array.isArray(args.requested_office_ids) ? [...new Set<string>(args.requested_office_ids)] : [];
            if (ids.length > 0) {
              if (!target.active) return { data: null, error: { code: '42501', message: 'staff account is inactive' } };
              if (target.role !== 'office_staff') return { data: null, error: { code: '22023', message: 'office assignments require office_staff role' } };
              const matched = mockOffices.filter((o) => ids.includes(o.id));
              if (matched.length !== ids.length) {
                return { data: null, error: { code: 'P0002', message: 'one or more office ids do not exist' } };
              }
            }
            mockAssignments = mockAssignments.filter((a) => a.user_id !== args.requested_user_id);
            for (const oid of ids) {
              mockAssignments.push({
                user_id: args.requested_user_id,
                office_id: oid,
                created_by: args.requested_actor_id,
                created_at: new Date().toISOString(),
              });
            }
            return { data: { userId: args.requested_user_id, officeIds: ids }, error: null };
          }
          if (name === 'save_office_record') {
            if (!args.requested_office_id) {
              const dup = mockOffices.find((o) => o.name.toLowerCase() === String(args.requested_name || '').toLowerCase());
              if (dup) {
                return { data: null, error: { code: '23505', message: 'office_name_duplicate' } };
              }
              const newOffice = {
                id: '44444444-4444-4444-8444-444444444444',
                name: args.requested_name,
                description: args.requested_description ?? null,
                active: args.requested_active ?? true,
                verified: false,
                publication_status: 'draft',
                requires_approval_before_pass: args.requested_requires_approval_before_pass ?? true,
                archived_at: null,
                verified_at: null,
                verified_by: null,
                created_at: '2026-11-09T00:00:00Z',
                updated_at: '2026-11-09T00:00:00Z',
              };
              mockOffices.push(newOffice);
              return { data: newOffice, error: null };
            }
            const idx = mockOffices.findIndex((o) => o.id === args.requested_office_id);
            if (idx < 0) return { data: null, error: { code: 'P0002', message: 'office_not_found' } };
            mockOffices[idx] = {
              ...mockOffices[idx],
              name: args.requested_name ?? mockOffices[idx].name,
              description: args.requested_description !== null ? args.requested_description : mockOffices[idx].description,
              active: args.requested_active !== null ? args.requested_active : mockOffices[idx].active,
              requires_approval_before_pass:
                args.requested_requires_approval_before_pass !== null
                  ? args.requested_requires_approval_before_pass
                  : mockOffices[idx].requires_approval_before_pass,
              updated_at: new Date().toISOString(),
            };
            return { data: mockOffices[idx], error: null };
          }
          if (name === 'update_office_publication') {
            if (args.requested_actor_id !== superadminId) {
              return { data: null, error: { code: '42501', message: 'superadmin_required' } };
            }
            const idx = mockOffices.findIndex((o) => o.id === args.requested_office_id);
            if (idx < 0) return { data: null, error: { code: 'P0002', message: 'office_not_found' } };
            const isPub = args.requested_status === 'published';
            mockOffices[idx] = {
              ...mockOffices[idx],
              publication_status: args.requested_status,
              verified: isPub,
              verified_at: isPub ? '2026-11-12T00:00:00Z' : null,
              verified_by: isPub ? args.requested_actor_id : null,
              archived_at: args.requested_status === 'archived' ? '2026-11-12T00:00:00Z' : null,
              updated_at: new Date().toISOString(),
            };
            return { data: mockOffices[idx], error: null };
          }
          return { data: null, error: null };
        }),
      })),
      rpc: vi.fn().mockResolvedValue({ error: null }),
      auth: {
        admin: {
          updateUserById: vi.fn().mockResolvedValue({ error: null }),
        },
      },
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdminClient as any,
      anon: {} as any,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('1. Superadmin Mutation Exclusivity on /api/admin/offices', () => {
    it('rejects Admin from POST verify_office with 403 superadmin_required', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'verify_office', officeId: office2Id }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('superadmin_required');
    });

    it('permits Admin to POST create_office (Phase A1)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Admin Authorized Office' }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('permits Admin to POST assign_staff (Phase A1)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'assign_staff', userId: staffUserId2, officeId: office1Id }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('permits Admin to POST remove_staff (Phase A1)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'remove_staff', userId: staffUserId1, officeId: office1Id }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('permits Admin to PATCH active status, but rejects PATCH verified with 403 superadmin_required (Phase A1)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      // 1. Admin can toggle active
      const reqActive = new Request('http://localhost/api/admin/offices', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: office1Id, active: false }),
      });
      const resActive = await adminOfficesHandler(reqActive);
      expect(resActive.status).toBe(200);

      // 2. Admin cannot modify verified status
      const reqVerify = new Request('http://localhost/api/admin/offices', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: office1Id, verified: true }),
      });
      const resVerify = await adminOfficesHandler(reqVerify);
      expect(resVerify.status).toBe(403);
      const bodyVerify = await resVerify.json();
      expect(bodyVerify.error).toBe('superadmin_required');
    });

    it('allows Superadmin to verify an office', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'verify_office', officeId: office2Id }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.office.verified).toBe(true);
      expect(body.office.verified_by).toBe(superadminId);
    });

    it('returns 404 office_not_found when verifying a non-existent office', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'verify_office', officeId: '99999999-9999-4999-8999-999999999999' }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('office_not_found');
    });

    it('returns 404 staff_not_found when assigning a non-existent staff member', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'assign_staff',
          userId: '99999999-9999-4999-8999-999999999999',
          officeId: office1Id,
        }),
      });

      const res = await adminOfficesHandler(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('staff_not_found');
    });
  });

  describe('2. Superadmin Guard on officeIds in /api/system/update-user', () => {
    it('rejects Admin from updating staff officeIds with 403 superadmin_required', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/system/update-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: staffUserId2,
          officeIds: [office1Id],
        }),
      });

      const res = await updateUserHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('superadmin_required');
    });

    it('rejects Superadmin with 400 invalid_office_id if officeIds contains non-existent ID', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/system/update-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: staffUserId2,
          officeIds: ['99999999-9999-4999-8999-999999999999'],
        }),
      });

      const res = await updateUserHandler(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_office_id');
    });

    it('allows Superadmin to update staff officeIds when valid', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/system/update-user', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: staffUserId2,
          officeIds: [office1Id],
        }),
      });

      const res = await updateUserHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockAssignments.some((a) => a.user_id === staffUserId2 && a.office_id === office1Id)).toBe(true);
    });
  });

  describe('3. Staff Boundary & Public Protection in /api/office/personnel', () => {
    it('returns only active AND verified offices to unauthenticated public visitors', async () => {
      const req = new Request('http://localhost/api/office/personnel', {
        method: 'GET',
      });

      const res = await officePersonnelHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      // Only office1Id is both active: true AND verified: true
      expect(body.offices).toHaveLength(1);
      expect(body.offices[0].id).toBe(office1Id);
      expect(body.offices[0].verified).toBe(true);
      expect(body.offices[0].active).toBe(true);

      // Verify unverified (office2Id) and inactive (office3Id) are strictly excluded from public
      const ids = body.offices.map((o: any) => o.id);
      expect(ids.includes(office2Id)).toBe(false);
      expect(ids.includes(office3Id)).toBe(false);
    });

    it('returns code no_office_assigned_to_staff when authenticated office staff has 0 assignments', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: staffUserId2, email: 'staff2@earist.edu.ph', email_confirmed_at: '2026-11-01T00:00:00Z' },
        isAnonymous: false,
        isRecoverySession: false,
      } as any);

      const req = new Request('http://localhost/api/office/personnel', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-staff2-token' },
      });

      const res = await officePersonnelHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.offices).toEqual([]);
      expect(body.code).toBe('no_office_assigned_to_staff');
    });

    it('returns 403 unauthorized_for_this_office when office staff queries an unassigned office', async () => {
      // staffUserId1 is assigned ONLY to office1Id
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: staffUserId1, email: 'staff1@earist.edu.ph', email_confirmed_at: '2026-11-01T00:00:00Z' },
        isAnonymous: false,
        isRecoverySession: false,
      } as any);

      const req = new Request(`http://localhost/api/office/personnel?officeId=${office2Id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-staff1-token' },
      });

      const res = await officePersonnelHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('unauthorized_for_this_office');
    });

    it('allows office staff to see all personnel (including inactive) for their assigned office', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: staffUserId1, email: 'staff1@earist.edu.ph', email_confirmed_at: '2026-11-01T00:00:00Z' },
        isAnonymous: false,
        isRecoverySession: false,
      } as any);

      const req = new Request(`http://localhost/api/office/personnel?officeId=${office1Id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-staff1-token' },
      });

      const res = await officePersonnelHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.personnel).toHaveLength(2); // Both active (Dr. Jane) and inactive (John Doe)
    });

    it('returns only active personnel to public unauthenticated visitor for an office', async () => {
      const req = new Request(`http://localhost/api/office/personnel?officeId=${office1Id}`, {
        method: 'GET',
      });

      const res = await officePersonnelHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.personnel).toHaveLength(1);
      expect(body.personnel[0].name).toBe('Dr. Jane Smith');
      expect(body.personnel[0].active).toBe(true);
    });
  });
});
