// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { PGlite } from '@electric-sql/pglite';
import { handleRequest as adminOfficesHandler } from '../server/routes/admin/offices.js';
import { handleRequest as officePersonnelHandler } from '../server/routes/office/personnel.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';

const authState: {
  uid: string;
  role: 'admin' | 'superadmin' | 'office_staff';
} = {
  uid: '00000000-0000-4000-8000-000000000002',
  role: 'admin',
};

const toastCalls: {
  success: string[];
  error: string[];
  warning: string[];
} = {
  success: [],
  error: [],
  warning: [],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    uid: authState.uid,
    role: authState.role,
    userData: { kind: 'staff', name: 'Test Operator', role: authState.role, active: true },
    serviceStatus: 'available',
    serviceMessage: null,
    refresh: async () => {},
  }),
}));

vi.mock('@/services/auth', () => ({
  getAccessToken: async () => 'test-operator-jwt',
}));

vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => { toastCalls.success.push(msg); },
    error: (msg: string) => { toastCalls.error.push(msg); },
    warning: (msg: string) => { toastCalls.warning.push(msg); },
  },
}));

import { AdminUsers } from '../src/pages/AdminUsers';

/**
 * Lightweight PostgreSQL-backed Supabase client adapter executing queries directly
 * against PGlite so real constraint errors (e.g. 23505 offices_name_key) and
 * filtering (active = true AND verified = true) are tested against Postgres semantics.
 */
function createPGliteOfficeAdapter(db: PGlite) {
  return {
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
      },
    },
    from: (table: string) => {
      if (table === 'offices') {
        const filters: Array<{ col: string; op: 'eq' | 'in'; val: any }> = [];
        let orderCol = 'name';
        let ascending = true;

        const runSelect = async () => {
          const clauses: string[] = [];
          const params: any[] = [];
          for (const f of filters) {
            if (f.op === 'eq') {
              params.push(f.val);
              clauses.push(`${f.col} = $${params.length}`);
            } else if (f.op === 'in') {
              if (!Array.isArray(f.val) || f.val.length === 0) return { data: [], error: null };
              const placeholders = f.val.map((v: any) => {
                params.push(v);
                return `$${params.length}`;
              });
              clauses.push(`${f.col} in (${placeholders.join(', ')})`);
            }
          }
          const whereSql = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
          const res = await db.query(
            `select * from public.offices ${whereSql} order by ${orderCol} ${ascending ? 'asc' : 'desc'}`,
            params,
          );
          return { data: res.rows, error: null };
        };

        const builder: any = {
          select: (_cols?: string) => builder,
          eq: (col: string, val: any) => {
            filters.push({ col, op: 'eq', val });
            return builder;
          },
          in: (col: string, val: any[]) => {
            filters.push({ col, op: 'in', val });
            return builder;
          },
          order: (col: string, opts?: { ascending?: boolean }) => {
            orderCol = col;
            ascending = opts?.ascending !== false;
            return builder;
          },
          maybeSingle: async () => {
            const r = await runSelect();
            return { data: r.data[0] ?? null, error: null };
          },
          single: async () => {
            const r = await runSelect();
            return { data: r.data[0] ?? null, error: r.data[0] ? null : { code: 'PGRST116', message: 'Not found' } };
          },
          then: (resolve: (val: any) => any) => runSelect().then(resolve),
          insert: (row: Record<string, any>) => ({
            select: () => ({
              single: async () => {
                const cols = Object.keys(row);
                const vals = Object.values(row);
                const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
                try {
                  const res = await db.query(
                    `insert into public.offices (${cols.join(', ')}) values (${placeholders}) returning *`,
                    vals,
                  );
                  return { data: res.rows[0], error: null };
                } catch (err: any) {
                  return {
                    data: null,
                    error: {
                      code: err?.code,
                      message: err?.message || String(err),
                      constraint: err?.constraint,
                    },
                  };
                }
              },
            }),
          }),
          update: (updates: Record<string, any>) => ({
            eq: (col: string, val: any) => ({
              select: () => ({
                single: async () => {
                  const cols = Object.keys(updates);
                  const vals = Object.values(updates);
                  const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
                  vals.push(val);
                  try {
                    const res = await db.query(
                      `update public.offices set ${setSql} where ${col} = $${vals.length} returning *`,
                      vals,
                    );
                    return {
                      data: res.rows[0] ?? null,
                      error: res.rows[0] ? null : { code: 'PGRST116', message: 'Not found' },
                    };
                  } catch (err: any) {
                    return {
                      data: null,
                      error: { code: err?.code, message: err?.message || String(err) },
                    };
                  }
                },
              }),
            }),
          }),
        };
        return builder;
      }

      if (table === 'office_staff_assignments' || table === 'staff_profiles' || table === 'office_personnel') {
        const filters: Array<{ col: string; val: any }> = [];
        const builder: any = {
          select: () => builder,
          eq: (col: string, val: any) => {
            filters.push({ col, val });
            return builder;
          },
          in: () => builder,
          order: () => builder,
          maybeSingle: async () => {
            const conds = filters.map((f, i) => `${f.col} = $${i + 1}`).join(' and ');
            const res = await db.query(
              `select * from public.${table}${conds ? ` where ${conds}` : ''} limit 1`,
              filters.map((f) => f.val),
            );
            return { data: res.rows[0] ?? null, error: null };
          },
          then: async (resolve: (val: any) => any) => {
            const conds = filters.map((f, i) => `${f.col} = $${i + 1}`).join(' and ');
            const res = await db.query(
              `select * from public.${table}${conds ? ` where ${conds}` : ''}`,
              filters.map((f) => f.val),
            );
            return resolve({ data: res.rows, error: null });
          },
        };
        return builder;
      }

      return {} as any;
    },
  };
}

function setReactInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Issue B: Office Creation Reliability, Idempotency, Visibility & Unsupported Code Removal', () => {
  const superadminId = '00000000-0000-4000-8000-000000000001';
  const adminId = '00000000-0000-4000-8000-000000000002';

  describe('1. Real PostgreSQL (PGlite) + Backend API Contract Tests', () => {
    let db: PGlite;

    beforeEach(async () => {
      db = new PGlite();
      await db.exec(`
        create table public.staff_profiles (
          user_id uuid primary key,
          display_name text not null,
          role text not null,
          active boolean not null default true,
          must_change_password boolean not null default false,
          privacy_accepted_at timestamptz
        );

        create table public.offices (
          id uuid primary key default gen_random_uuid(),
          name text not null unique check (char_length(btrim(name)) between 2 and 150),
          description text check (description is null or char_length(btrim(description)) <= 500),
          active boolean not null default true,
          verified boolean not null default false,
          verified_at timestamptz,
          verified_by uuid references public.staff_profiles(user_id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by uuid references public.staff_profiles(user_id) on delete set null,
          updated_by uuid references public.staff_profiles(user_id) on delete set null
        );

        create table public.office_staff_assignments (
          office_id uuid not null references public.offices(id) on delete cascade,
          user_id uuid not null references public.staff_profiles(user_id) on delete cascade,
          assigned_at timestamptz not null default now(),
          created_by uuid,
          primary key (office_id, user_id)
        );

        create table public.office_personnel (
          id uuid primary key default gen_random_uuid(),
          office_id uuid not null references public.offices(id) on delete restrict,
          name text not null,
          title text,
          active boolean not null default true
        );

        insert into public.staff_profiles (user_id, display_name, role, active, privacy_accepted_at) values
          ('${superadminId}', 'Superadmin User', 'superadmin', true, now()),
          ('${adminId}', 'Admin User', 'admin', true, now());
      `);

      const adapter = createPGliteOfficeAdapter(db);
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: adapter as any,
        anon: {} as any,
      });
    }, 60000);

    afterEach(async () => {
      vi.restoreAllMocks();
      await db.close();
    }, 30000);

    it('rejects unauthorized roles (office_staff, guard_station, missing token) from creating offices', async () => {
      const noAuthRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Unauthorized Office' }),
        }),
      );
      expect(noAuthRes.status).toBe(401);

      vi.spyOn(actorsModule, 'requireStaffActor').mockRejectedValue(
        new actorsModule.HttpError(403, 'forbidden'),
      );
      const forbiddenRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer staff-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Unauthorized Office' }),
        }),
      );
      expect(forbiddenRes.status).toBe(403);
      const countRes = await db.query<{ count: string }>('select count(*)::text as count from public.offices');
      expect(Number(countRes.rows[0]?.count)).toBe(0);
    }, 30000);

    it('allows Admin and Superadmin to create offices, keeps verified=false, ignores/has no code column, and does not auto-create staff assignments', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValueOnce({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      const res1 = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create_office', name: 'Registrar', description: 'Student records' }),
        }),
      );
      expect(res1.status).toBe(201);
      const body1 = await res1.json();
      expect(body1.ok).toBe(true);
      expect(body1.office.name).toBe('Registrar');
      expect(body1.office.active).toBe(true);
      expect(body1.office.verified).toBe(false);
      expect(body1.office.code).toBeUndefined();

      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValueOnce({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const res2 = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer superadmin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create_office', name: 'Student Affairs' }),
        }),
      );
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.office.verified).toBe(false);

      // Office creation must NOT fabricate staff accounts or office_staff_assignments
      const assignCount = await db.query<{ count: string }>('select count(*)::text as count from public.office_staff_assignments');
      expect(Number(assignCount.rows[0]?.count)).toBe(0);

      const colsRes = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'offices'`,
      );
      expect(colsRes.rows.map((r) => r.column_name)).not.toContain('code');
    }, 30000);

    it('handles Postgres 23505 (offices_name_key): idempotent retry returns 200 existing record without duplicates, conflicting payload returns 409', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: adminId,
        email: 'admin@earist.edu.ph',
        role: 'admin',
      });

      // 1. Initial creation (simulating response succeeded on DB even if client dropped response)
      const firstRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_office',
            name: 'Engineering Department',
            description: 'Academic Building B',
          }),
        }),
      );
      expect(firstRes.status).toBe(201);
      const firstBody = await firstRes.json();

      // 2. Client retries identical payload after lost response -> 23505 handled -> 200 idempotent reconciliation
      const retryRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_office',
            name: '  Engineering Department  ',
            description: 'Academic Building B',
          }),
        }),
      );
      expect(retryRes.status).toBe(200);
      const retryBody = await retryRes.json();
      expect(retryBody.ok).toBe(true);
      expect(retryBody.idempotent).toBe(true);
      expect(retryBody.office.id).toBe(firstBody.office.id);

      // 3. Unique-name conflict with different details -> helpful 409 response + authoritative existing office
      const conflictRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_office',
            name: 'Engineering Department',
            description: 'Completely different description',
          }),
        }),
      );
      expect(conflictRes.status).toBe(409);
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error).toBe('office_already_exists');
      expect(conflictBody.message).toContain('Engineering Department');
      expect(conflictBody.office.id).toBe(firstBody.office.id);

      // Verify exactly 1 record exists in PostgreSQL
      const countRes = await db.query<{ count: string }>(
        `select count(*)::text as count from public.offices where name = 'Engineering Department'`,
      );
      expect(Number(countRes.rows[0]?.count)).toBe(1);
    }, 30000);

    it('shows new unverified office in Admin GET while hiding it from public visitors until Superadmin verifies it (and hides inactive ones)', async () => {
      vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
        id: superadminId,
        email: 'superadmin@earist.edu.ph',
        role: 'superadmin',
      });

      const createRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create_office', name: 'Guidance Office' }),
        }),
      );
      expect(createRes.status).toBe(201);
      const { office: createdOffice } = await createRes.json();

      // Admin directory GET includes newly created unverified office
      const adminGet1 = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        }),
      );
      expect(adminGet1.status).toBe(200);
      const adminBody1 = await adminGet1.json();
      expect(adminBody1.offices.map((o: any) => o.id)).toContain(createdOffice.id);

      // Public visitor directory excludes unverified office
      const publicGet1 = await officePersonnelHandler(new Request('http://localhost/api/office/personnel', { method: 'GET' }));
      expect(publicGet1.status).toBe(200);
      const publicBody1 = await publicGet1.json();
      expect(publicBody1.offices.map((o: any) => o.id)).not.toContain(createdOffice.id);

      // Superadmin verifies the office
      const verifyRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'POST',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'verify_office', officeId: createdOffice.id }),
        }),
      );
      expect(verifyRes.status).toBe(200);

      // Now active AND verified -> immediately appears in public visitor directory
      const publicGet2 = await officePersonnelHandler(new Request('http://localhost/api/office/personnel', { method: 'GET' }));
      const publicBody2 = await publicGet2.json();
      expect(publicBody2.offices.map((o: any) => o.id)).toContain(createdOffice.id);

      // Deactivating a verified office hides it from public visitors while keeping it visible in Admin GET
      const patchRes = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'PATCH',
          headers: { Authorization: 'Bearer sa-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: createdOffice.id, active: false }),
        }),
      );
      expect(patchRes.status).toBe(200);

      const publicGet3 = await officePersonnelHandler(new Request('http://localhost/api/office/personnel', { method: 'GET' }));
      const publicBody3 = await publicGet3.json();
      expect(publicBody3.offices.map((o: any) => o.id)).not.toContain(createdOffice.id);

      const adminGet2 = await adminOfficesHandler(
        new Request('http://localhost/api/admin/offices', {
          method: 'GET',
          headers: { Authorization: 'Bearer sa-jwt' },
        }),
      );
      const adminBody2 = await adminGet2.json();
      const row = adminBody2.offices.find((o: any) => o.id === createdOffice.id);
      expect(row).toMatchObject({ active: false, verified: true });
    }, 30000);
  });

  describe('2. AdminUsers UI & State Integration Tests (happy-dom)', () => {
    let container: HTMLDivElement;
    let root: Root;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      authState.uid = adminId;
      authState.role = 'admin';
      toastCalls.success = [];
      toastCalls.error = [];
      toastCalls.warning = [];
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    async function renderDirectoryTab() {
      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/admin/users?tab=directory'] },
            React.createElement(AdminUsers),
          ),
        );
        await new Promise((r) => setTimeout(r, 25));
      });
    }

    it('renders all 4 office statuses, hides Code column/input, and strips code from POST payload', async () => {
      authState.role = 'superadmin';
      authState.uid = superadminId;

      const officesList = [
        { id: 'o1', name: 'Alpha Verified Active', description: 'Desc 1', active: true, verified: true },
        { id: 'o2', name: 'Beta Unverified Active', description: 'Desc 2', active: true, verified: false },
        { id: 'o3', name: 'Gamma Verified Inactive', description: 'Desc 3', active: false, verified: true },
        { id: 'o4', name: 'Delta Unverified Inactive', description: 'Desc 4', active: false, verified: false },
      ];
      let capturedPostBody: any = null;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices' && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ offices: officesList }), { status: 200 });
        }
        if (url === '/api/admin/offices' && init?.method === 'POST') {
          capturedPostBody = JSON.parse(String(init.body));
          const created = {
            id: 'o5',
            name: capturedPostBody.name,
            description: capturedPostBody.description ?? null,
            active: true,
            verified: false,
          };
          officesList.push(created);
          return new Response(JSON.stringify({ ok: true, office: created }), { status: 201 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }) as typeof fetch;

      await renderDirectoryTab();

      const headerTexts = Array.from(container.querySelectorAll('th')).map((th) => th.textContent?.trim());
      expect(headerTexts).not.toContain('Code');
      expect(container.textContent).toContain('Active / Verified');
      expect(container.textContent).toContain('Active / Unverified');
      expect(container.textContent).toContain('Inactive / Verified');
      expect(container.textContent).toContain('Inactive / Unverified');
      expect(container.textContent).toContain('Hidden from visitors until verified by Superadmin');

      const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add Office'));
      expect(addBtn).toBeDefined();
      await act(async () => {
        addBtn!.click();
        await Promise.resolve();
      });

      expect(document.body.querySelector('#new-office-code')).toBeNull();
      const nameInput = document.body.querySelector('#new-office-name') as HTMLInputElement;
      const descInput = document.body.querySelector('#new-office-desc') as HTMLInputElement;
      expect(nameInput).not.toBeNull();

      await act(async () => {
        setReactInputValue(nameInput, 'Research Office');
        setReactInputValue(descInput, 'Innovation center');
        await Promise.resolve();
      });

      const submitBtn = Array.from(document.body.querySelectorAll('button[type="submit"]')).find((b) =>
        b.textContent?.includes('Create Office'),
      ) as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 25));
      });

      expect(capturedPostBody).toEqual({
        action: 'create_office',
        name: 'Research Office',
        description: 'Innovation center',
      });
      expect(capturedPostBody).not.toHaveProperty('code');
      expect(container.textContent).toContain('Research Office');
    });

    it('surfaces non-2xx GET errors visibly and preserves newly created office when post-create GET fails', async () => {
      let getCallCount = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices' && (!init?.method || init.method === 'GET')) {
          getCallCount += 1;
          return new Response(JSON.stringify({ error: 'database_timeout', message: 'Directory DB timed out' }), {
            status: 503,
          });
        }
        if (url === '/api/admin/offices' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              ok: true,
              office: {
                id: 'new-office-99',
                name: 'Library Annex',
                description: 'North Campus',
                active: true,
                verified: false,
              },
            }),
            { status: 201 },
          );
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;

      await renderDirectoryTab();

      // 1. Initial GET failed with 503 -> must surface visible error alert and toast
      expect(getCallCount).toBe(1);
      const alertBanner = container.querySelector('[role="alert"]');
      expect(alertBanner?.textContent).toContain('Directory DB timed out');
      expect(toastCalls.error.some((m) => m.includes('Directory DB timed out'))).toBe(true);

      // 2. Admin creates "Library Annex" successfully while GET still fails (call #2 -> 503)
      const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add Office'));
      await act(async () => {
        addBtn!.click();
        await Promise.resolve();
      });

      const nameInput = document.body.querySelector('#new-office-name') as HTMLInputElement;
      await act(async () => {
        setReactInputValue(nameInput, 'Library Annex');
        await Promise.resolve();
      });

      const submitBtn = Array.from(document.body.querySelectorAll('button[type="submit"]')).find((b) =>
        b.textContent?.includes('Create Office'),
      ) as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 25));
      });

      expect(getCallCount).toBe(2);
      // Newly created office must remain visible despite failed refresh!
      expect(container.textContent).toContain('Library Annex');
      const statusWarning = container.querySelector('[role="status"]');
      expect(statusWarning?.textContent).toContain('Library Annex');
      expect(statusWarning?.textContent).toContain('refreshing the directory failed');
      expect(toastCalls.warning.length).toBeGreaterThan(0);
    });

    it('prevents concurrent duplicate submit, preserves form inputs on failure, and clears after retry reconciliation', async () => {
      let postAttempts = 0;
      let resolveFirstPost: ((res: Response) => void) | null = null;
      const serverOffices: any[] = [];

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices' && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ offices: serverOffices }), { status: 200 });
        }
        if (url === '/api/admin/offices' && init?.method === 'POST') {
          postAttempts += 1;
          if (postAttempts === 1) {
            return await new Promise<Response>((resolve) => {
              resolveFirstPost = resolve;
            });
          }
          const body = JSON.parse(String(init.body));
          const reconciled = {
            id: 'reconciled-office-1',
            name: body.name,
            description: body.description ?? null,
            active: true,
            verified: false,
          };
          if (serverOffices.length === 0) serverOffices.push(reconciled);
          return new Response(
            JSON.stringify({
              ok: true,
              idempotent: true,
              alreadyExists: true,
              office: reconciled,
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;

      await renderDirectoryTab();

      const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add Office'));
      await act(async () => {
        addBtn!.click();
        await Promise.resolve();
      });

      const nameInput = document.body.querySelector('#new-office-name') as HTMLInputElement;
      const descInput = document.body.querySelector('#new-office-desc') as HTMLInputElement;
      await act(async () => {
        setReactInputValue(nameInput, 'Finance Office');
        setReactInputValue(descInput, 'Cashier wing');
        await Promise.resolve();
      });

      const form = document.body.querySelector('form')!;
      // Fire two rapid submits before first finishes -> only 1 POST allowed
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(postAttempts).toBe(1);

      // Simulate lost response / 502 error on attempt #1 (server actually committed row)
      serverOffices.push({
        id: 'reconciled-office-1',
        name: 'Finance Office',
        description: 'Cashier wing',
        active: true,
        verified: false,
      });
      await act(async () => {
        resolveFirstPost!(new Response(JSON.stringify({ error: 'gateway_timeout', message: 'Lost connection' }), { status: 504 }));
        await new Promise((r) => setTimeout(r, 25));
      });

      // Modal stays open and form values are preserved for retry
      expect((document.body.querySelector('#new-office-name') as HTMLInputElement)?.value).toBe('Finance Office');
      expect((document.body.querySelector('#new-office-desc') as HTMLInputElement)?.value).toBe('Cashier wing');

      // Retry submit -> hits 200 idempotent reconciliation -> clears form & closes modal
      await act(async () => {
        document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 25));
      });

      expect(postAttempts).toBe(2);
      expect(document.body.querySelector('#new-office-name')).toBeNull();
      expect(container.textContent).toContain('Finance Office');

      // Reopen Add Office modal to prove form values were cleared after confirmed reconciliation
      await act(async () => {
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add Office'))!.click();
        await Promise.resolve();
      });
      expect((document.body.querySelector('#new-office-name') as HTMLInputElement)?.value).toBe('');
      expect((document.body.querySelector('#new-office-desc') as HTMLInputElement)?.value).toBe('');
    });

    it('handles 409 unique-name conflict by displaying useful feedback, preserving inputs, and syncing authoritative office record', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/admin/users')) {
          return new Response(JSON.stringify({ users: [], nextCursor: null, hasMore: false }), { status: 200 });
        }
        if (url === '/api/admin/offices' && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify({ offices: [] }), { status: 200 });
        }
        if (url === '/api/admin/offices' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              error: 'office_already_exists',
              message: 'An office named "Registrar" already exists.',
              office: {
                id: 'existing-reg-1',
                name: 'Registrar',
                description: 'Official Academic Records',
                active: true,
                verified: true,
              },
            }),
            { status: 409 },
          );
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;

      await renderDirectoryTab();

      const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add Office'));
      await act(async () => {
        addBtn!.click();
        await Promise.resolve();
      });

      const nameInput = document.body.querySelector('#new-office-name') as HTMLInputElement;
      const descInput = document.body.querySelector('#new-office-desc') as HTMLInputElement;
      await act(async () => {
        setReactInputValue(nameInput, 'Registrar');
        setReactInputValue(descInput, 'Attempted duplicate description');
        await Promise.resolve();
      });

      const submitBtn = Array.from(document.body.querySelectorAll('button[type="submit"]')).find((b) =>
        b.textContent?.includes('Create Office'),
      ) as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
        await new Promise((r) => setTimeout(r, 25));
      });

      // Useful conflict message displayed in modal and toast, inputs preserved
      const modalAlert = document.body.querySelector('[role="alert"]');
      expect(modalAlert?.textContent).toContain('An office named "Registrar" already exists.');
      expect((document.body.querySelector('#new-office-name') as HTMLInputElement)?.value).toBe('Registrar');
      expect((document.body.querySelector('#new-office-desc') as HTMLInputElement)?.value).toBe('Attempted duplicate description');

      // Conflicting authoritative record from server was also synced into directory table
      expect(container.textContent).toContain('Registrar');
      expect(container.textContent).toContain('Active / Verified');
    });
  });
});
