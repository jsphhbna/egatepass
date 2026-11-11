import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRequest as adminCalendarHandler } from '../server/routes/admin/calendar.js';
import { handleRequest as systemCalendarHandler } from '../server/routes/system/calendar.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';
import { isDateInClosure, type CampusCalendarClosure } from '../src/types/calendar.js';

describe('Institutional Calendar Frontend/API Contract & Governance Test Suite', () => {
  const originalEnv = process.env;
  const superadminId = '00000000-0000-4000-8000-000000000001';
  const adminId = '00000000-0000-4000-8000-000000000002';
  const staffId = '00000000-0000-4000-8000-000000000003';

  let mockClosures: Array<{
    id: string;
    title: string;
    closure_type: string;
    start_date: string;
    end_date: string;
    description: string | null;
    active: boolean;
    published: boolean;
    created_by: string | null;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
  }> = [];

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-service-key',
    };

    mockClosures = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Rizal Day',
        closure_type: 'holiday',
        start_date: '2026-12-30',
        end_date: '2026-12-30',
        description: 'National Regular Holiday',
        active: true,
        published: true,
        archived_at: null,
        archived_by: null,
        created_by: superadminId,
        updated_by: superadminId,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Semestral Academic Break',
        closure_type: 'campus_closure',
        start_date: '2026-12-20',
        end_date: '2027-01-05',
        description: 'University semestral closure',
        active: true,
        published: true,
        archived_at: null,
        archived_by: null,
        created_by: superadminId,
        updated_by: superadminId,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Draft Maintenance Day',
        closure_type: 'campus_closure',
        start_date: '2026-11-15',
        end_date: '2026-11-15',
        description: 'Internal server maintenance',
        active: false,
        published: false,
        archived_at: null,
        archived_by: null,
        created_by: superadminId,
        updated_by: superadminId,
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      },
    ];

    const mockAdminClient = {
      schema: vi.fn((schemaName: string) => ({
        rpc: vi.fn(async (fnName: string, args: any) => {
          if (schemaName !== 'api') return { data: null, error: null };
          if (fnName === 'save_campus_calendar_closure') {
            if (args.requested_actor_id !== superadminId) {
              return { data: null, error: { code: '42501', message: 'superadmin_required' } };
            }
            const id = args.requested_closure_id;
            if (!id) {
              if (args.requested_end_date < args.requested_start_date) {
                return { data: null, error: { code: '22023', message: 'end_date must be >= start_date' } };
              }
              const newRow = {
                id: '44444444-4444-4444-8444-444444444444',
                title: args.requested_title,
                closure_type: args.requested_closure_type,
                start_date: args.requested_start_date,
                end_date: args.requested_end_date,
                description: args.requested_description ?? null,
                active: args.requested_active ?? true,
                published: args.requested_published ?? true,
                archived_at: null,
                archived_by: null,
                created_by: args.requested_actor_id,
                updated_by: args.requested_actor_id,
                created_at: '2026-11-09T00:00:00Z',
                updated_at: '2026-11-09T00:00:00Z',
              };
              mockClosures.push(newRow);
              return {
                data: {
                  id: newRow.id,
                  title: newRow.title,
                  closureType: newRow.closure_type,
                  startDate: newRow.start_date,
                  endDate: newRow.end_date,
                  description: newRow.description,
                  active: newRow.active,
                  published: newRow.published,
                  archivedAt: null,
                },
                error: null,
              };
            }

            const idx = mockClosures.findIndex((r) => r.id === id);
            if (idx < 0) {
              return { data: null, error: { code: 'P0002', message: 'closure_not_found' } };
            }
            const cur = mockClosures[idx]!;
            const nextStart = args.requested_start_date ?? cur.start_date;
            const nextEnd = args.requested_end_date ?? cur.end_date;
            if (nextEnd < nextStart) {
              return { data: null, error: { code: '22023', message: 'end_date must be >= start_date' } };
            }
            const updated = {
              ...cur,
              title: args.requested_title ?? cur.title,
              closure_type: args.requested_closure_type ?? cur.closure_type,
              start_date: nextStart,
              end_date: nextEnd,
              description: args.requested_description !== null ? args.requested_description : cur.description,
              active: args.requested_archive ? false : (args.requested_active !== null ? args.requested_active : cur.active),
              published: args.requested_archive ? false : (args.requested_published !== null ? args.requested_published : cur.published),
              archived_at: args.requested_archive ? '2026-11-12T00:00:00Z' : cur.archived_at,
              archived_by: args.requested_archive ? args.requested_actor_id : cur.archived_by,
              updated_by: args.requested_actor_id,
              updated_at: '2026-11-12T00:00:00Z',
            };
            mockClosures[idx] = updated;
            return {
              data: {
                id: updated.id,
                title: updated.title,
                closureType: updated.closure_type,
                startDate: updated.start_date,
                endDate: updated.end_date,
                description: updated.description,
                active: updated.active,
                published: updated.published,
                archivedAt: updated.archived_at,
              },
              error: null,
            };
          }

          if (fnName === 'delete_campus_calendar_closure') {
            if (args.requested_actor_id !== superadminId) {
              return { data: null, error: { code: '42501', message: 'superadmin_required' } };
            }
            const idx = mockClosures.findIndex((r) => r.id === args.requested_closure_id);
            if (idx < 0) {
              return { data: null, error: { code: 'P0002', message: 'closure_not_found' } };
            }
            const cur = mockClosures[idx]!;
            if (cur.published || cur.active) {
              return { data: null, error: { code: '42501', message: 'published_or_active_closure_must_be_archived' } };
            }
            mockClosures.splice(idx, 1);
            return { data: { deleted: true }, error: null };
          }
          return { data: null, error: null };
        }),
      })),
      from: vi.fn((table: string) => {
        if (table === 'campus_calendar_closures') {
          return {
            select: vi.fn((cols: string) => {
              let filtered = [...mockClosures];
              const builder: any = {
                order: vi.fn().mockImplementation(() => builder),
                eq: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r: any) => r[field] === val);
                  return builder;
                }),
                is: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r: any) => (r[field] ?? null) === val);
                  return builder;
                }),
                gte: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r: any) => r[field] >= val);
                  return builder;
                }),
                lte: vi.fn((field: string, val: any) => {
                  filtered = filtered.filter((r: any) => r[field] <= val);
                  return builder;
                }),
                maybeSingle: vi.fn().mockImplementation(async () => {
                  return { data: filtered[0] || null, error: null };
                }),
                single: vi.fn().mockImplementation(async () => {
                  if (filtered.length === 0) return { data: null, error: new Error('PGRST116') };
                  return { data: filtered[0], error: null };
                }),
                then: (resolve: any) => resolve({ data: filtered, error: null }),
              };
              return builder;
            }),
            insert: vi.fn((row: any) => {
              const newRow = {
                id: '44444444-4444-4444-8444-444444444444',
                created_at: '2026-11-09T00:00:00Z',
                updated_at: '2026-11-09T00:00:00Z',
                ...row,
              };
              mockClosures.push(newRow);
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: newRow, error: null }),
                }),
              };
            }),
            update: vi.fn((updates: any) => {
              return {
                eq: vi.fn((field: string, val: any) => {
                  const idx = mockClosures.findIndex((r: any) => r[field] === val);
                  if (idx >= 0) {
                    mockClosures[idx] = { ...mockClosures[idx], ...updates };
                    return {
                      select: vi.fn().mockReturnValue({
                        single: vi.fn().mockResolvedValue({ data: mockClosures[idx], error: null }),
                        maybeSingle: vi.fn().mockResolvedValue({ data: mockClosures[idx], error: null }),
                      }),
                    };
                  }
                  return {
                    select: vi.fn().mockReturnValue({
                      single: vi.fn().mockResolvedValue({ data: null, error: new Error('PGRST116') }),
                      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                    }),
                  };
                }),
              };
            }),
            delete: vi.fn(() => {
              return {
                eq: vi.fn((field: string, val: any) => {
                  const idx = mockClosures.findIndex((r: any) => r[field] === val);
                  if (idx >= 0) {
                    mockClosures.splice(idx, 1);
                  }
                  return Promise.resolve({ error: null });
                }),
              };
            }),
          };
        }
        return {} as any;
      }),
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

  describe('1. GET /api/admin/calendar (Canonical Contract)', () => {
    it('returns list of closures with canonical camelCase fields', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        headers: { Authorization: 'Bearer valid-admin-token' },
      });
      const res = await adminCalendarHandler(req);
      if (res.status !== 200) {
        console.log('PATCH test failed with:', res.status, await res.clone().json());
      }
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.closures).toBeDefined();
      expect(Array.isArray(body.closures)).toBe(true);
      expect(body.closures.length).toBe(3);

      const first = body.closures[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('closureType');
      expect(first).toHaveProperty('startDate');
      expect(first).toHaveProperty('endDate');
      expect(first).toHaveProperty('description');
      expect(first).toHaveProperty('active');
      expect(first).toHaveProperty('published');
      expect(first).toHaveProperty('createdBy');
      expect(first).toHaveProperty('updatedBy');
      expect(first).toHaveProperty('createdAt');
      expect(first).toHaveProperty('updatedAt');

      // Check values
      expect(first.title).toBe('Rizal Day');
      expect(first.closureType).toBe('holiday');
      expect(first.startDate).toBe('2026-12-30');
      expect(first.endDate).toBe('2026-12-30');
    });

    it('filters by activeOnly=true when requested', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/calendar?activeOnly=true', {
        headers: { Authorization: 'Bearer valid-admin-token' },
      });
      const res = await adminCalendarHandler(req);
      if (res.status !== 200) {
        console.log('PATCH test failed with:', res.status, await res.clone().json());
      }
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.closures.every((c: any) => c.active === true)).toBe(true);
    });
  });

  describe('2. POST /api/admin/calendar (Creation & Validation)', () => {
    it('allows Superadmin to create a single-day closure (startDate === endDate)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Bonifacio Day',
          closureType: 'holiday',
          startDate: '2026-11-30',
          endDate: '2026-11-30',
          description: 'Official National Regular Holiday',
          active: true,
          published: true,
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.closure.title).toBe('Bonifacio Day');
      expect(body.closure.startDate).toBe('2026-11-30');
      expect(body.closure.endDate).toBe('2026-11-30');
      expect(body.closure.active).toBe(true);
      expect(body.closure.published).toBe(true);
    });

    it('allows Superadmin to create a multi-day closure (startDate < endDate)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Institutional Foundation Week',
          closureType: 'campus_closure',
          startDate: '2027-02-15',
          endDate: '2027-02-20',
          description: 'Campus closed for annual university celebration',
          active: true,
          published: true,
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.closure.title).toBe('Institutional Foundation Week');
      expect(body.closure.startDate).toBe('2027-02-15');
      expect(body.closure.endDate).toBe('2027-02-20');
    });

    it('rejects invalid payload where endDate is earlier than startDate with 400', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Invalid Date Closure',
          closureType: 'holiday',
          startDate: '2026-12-25',
          endDate: '2026-12-20', // earlier!
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('rejects Admin from creating closures with 403 superadmin_required', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Unauthorized Closure',
          closureType: 'holiday',
          startDate: '2026-12-25',
          endDate: '2026-12-25',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('superadmin_required');
    });
  });

  describe('3. PATCH /api/admin/calendar (Update by ID)', () => {
    it('allows Superadmin to update closure status, title, and dates by ID', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          active: false,
          published: false,
          description: 'Updated holiday description',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.closure.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(body.closure.active).toBe(false);
      expect(body.closure.published).toBe(false);
      expect(body.closure.description).toBe('Updated holiday description');
    });

    it('returns 404 closure_not_found when patching non-existent ID', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '99999999-9999-4999-8999-999999999999',
          title: 'Non-existent',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('closure_not_found');
    });

    it('rejects Admin from patching closures with 403 superadmin_required', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          active: false,
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('superadmin_required');
    });
  });

  describe('4. DELETE /api/admin/calendar (Deletion by ID with Body)', () => {
    it('allows Superadmin to delete a closure by ID using JSON body', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '33333333-3333-4333-8333-333333333333',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockClosures.some((c) => c.id === '33333333-3333-4333-8333-333333333333')).toBe(false);
    });

    it('rejects deleting published/active closure with 409 and allows archiving instead', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const delReq = new Request('http://localhost/api/admin/calendar', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
        }),
      });
      const delRes = await adminCalendarHandler(delReq);
      expect(delRes.status).toBe(409);
      const delBody = await delRes.json();
      expect(delBody.error).toBe('published_or_active_closure_must_be_archived');

      const archReq = new Request('http://localhost/api/admin/calendar', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          archive: true,
        }),
      });
      const archRes = await adminCalendarHandler(archReq);
      expect(archRes.status).toBe(200);
      const archBody = await archRes.json();
      expect(archBody.closure.active).toBe(false);
      expect(archBody.closure.published).toBe(false);
      expect(archBody.closure.archivedAt).toBeTruthy();
    });

    it('returns 404 closure_not_found when deleting non-existent ID', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-superadmin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '99999999-9999-4999-8999-999999999999',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('closure_not_found');
    });

    it('rejects Admin from deleting closures with 403 superadmin_required', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const req = new Request('http://localhost/api/admin/calendar', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
        }),
      });

      const res = await adminCalendarHandler(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('superadmin_required');
    });
  });

  describe('5. GET /api/system/calendar (Public System Endpoint)', () => {
    it('returns active and published closures with camelCase fields', async () => {
      const req = new Request('http://localhost/api/system/calendar');
      const res = await systemCalendarHandler(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.closures)).toBe(true);
      expect(body.closures.length).toBe(2); // Rizal Day and Semestral Break (Draft is inactive/unpublished)

      const closure = body.closures[0];
      expect(closure.id).toBe('11111111-1111-4111-8111-111111111111');
      expect(closure.title).toBe('Rizal Day');
      expect(closure.startDate).toBe('2026-12-30');
      expect(closure.endDate).toBe('2026-12-30');
      expect(closure.closureType).toBe('holiday');
    });
  });

  describe('6. Overlap Invariant & Client Date Check', () => {
    it('allows overlapping closures and isDateInClosure matches single & multi-day dates', () => {
      // Invariant: Institutional semester break overlapping with Rizal Day
      const semestralBreak: CampusCalendarClosure = {
        id: 'c1',
        title: 'Semestral Break',
        closureType: 'campus_closure',
        startDate: '2026-12-20',
        endDate: '2027-01-05',
        description: null,
        active: true,
        published: true,
      };

      const rizalDay: CampusCalendarClosure = {
        id: 'c2',
        title: 'Rizal Day',
        closureType: 'holiday',
        startDate: '2026-12-30',
        endDate: '2026-12-30',
        description: null,
        active: true,
        published: true,
      };

      // Dec 30 matches both
      expect(isDateInClosure('2026-12-30', semestralBreak)).toBe(true);
      expect(isDateInClosure('2026-12-30', rizalDay)).toBe(true);

      // Dec 25 matches semestralBreak but not rizalDay
      expect(isDateInClosure('2026-12-25', semestralBreak)).toBe(true);
      expect(isDateInClosure('2026-12-25', rizalDay)).toBe(false);

      // Dec 19 is open
      expect(isDateInClosure('2026-12-19', semestralBreak)).toBe(false);
      expect(isDateInClosure('2026-12-19', rizalDay)).toBe(false);

      // Inactive closure is not closed
      const inactiveClosure: CampusCalendarClosure = {
        ...rizalDay,
        active: false,
      };
      expect(isDateInClosure('2026-12-30', inactiveClosure)).toBe(false);
    });
  });
});
