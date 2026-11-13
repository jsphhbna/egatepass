// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import guardStationFeedHandler from '../server/routes/gate/guard-station-feed.js';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';

const authMockState: {
  status: 'loading' | 'unauthenticated' | 'authenticated' | 'requires_password_change';
  uid: string | null;
  role: any;
  userData: any;
  serviceStatus: 'available' | 'unavailable';
  serviceMessage: string | null;
  refresh: () => Promise<void>;
} = {
  status: 'unauthenticated',
  uid: null,
  role: null,
  userData: null,
  serviceStatus: 'available',
  serviceMessage: null,
  refresh: async () => {},
};

const signOutMock = vi.fn(async () => ({ error: null }));
const getAccessTokenMock = vi.fn(async () => 'live-supabase-station-jwt');

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authMockState,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: (...args: any[]) => signOutMock(...args),
      signInWithPassword: vi.fn(),
      resend: vi.fn(),
    },
    from: vi.fn(),
  },
  getSupabaseAvailabilityMessage: () => null,
}));

vi.mock('@/services/auth', () => ({
  evaluateAuthTurnstilePolicy: () => ({ allowed: true }),
  getAccessToken: () => getAccessTokenMock(),
  signOutCurrentActor: () => signOutMock(),
}));

vi.mock('@/components/TurnstileWidget', () => ({
  TurnstileWidget: () => null,
}));

import { LoginPage } from '../src/pages/LoginPage';
import { ProtectedRoute } from '../src/components/ProtectedRoute';
import { AdminPage } from '../src/pages/AdminPage';
import { GuardPage } from '../src/pages/GuardPage';

function LocationProbe({ label }: { label: string }) {
  const loc = useLocation();
  return React.createElement('div', { 'data-testid': 'location-probe' }, `${label}:${loc.pathname}`);
}

describe('Issue A & Issue C: Guard Station Auth Lifecycle & Admin Sidebar Navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    signOutMock.mockClear();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('live-supabase-station-jwt');

    authMockState.status = 'unauthenticated';
    authMockState.uid = null;
    authMockState.role = null;
    authMockState.userData = null;
    authMockState.serviceStatus = 'available';
    authMockState.serviceMessage = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function renderInRouter(initialEntry: string, element: React.ReactElement) {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [initialEntry] },
          element,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  describe('1. LoginPage role redirection & legacy guard block', () => {
    it('redirects authenticated guard_station device to /guard', async () => {
      authMockState.status = 'authenticated';
      authMockState.uid = 'station-user-1';
      authMockState.role = 'guard_station';
      authMockState.userData = {
        kind: 'device',
        alias: 'gate1-station',
        name: 'Main Gate Guard Station',
        type: 'guard_station',
        gate: 'Gate 1',
        status: 'active',
      };

      await renderInRouter(
        '/login',
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/login', element: React.createElement(LoginPage) }),
          React.createElement(Route, { path: '/guard', element: React.createElement(LocationProbe, { label: 'GUARD_TARGET' }) }),
        ),
      );

      expect(container.textContent).toContain('GUARD_TARGET:/guard');
    });

    it('preserves office_staff redirect to /office through shared /login', async () => {
      authMockState.status = 'authenticated';
      authMockState.uid = 'staff-office-1';
      authMockState.role = 'office_staff';
      authMockState.userData = {
        kind: 'staff',
        name: 'Registrar Custodian',
        email: 'registrar@earist.edu.ph',
        role: 'office_staff',
        active: true,
        mustChangePassword: false,
        privacyAcceptedAt: '2026-11-01T00:00:00Z',
      };

      await renderInRouter(
        '/login',
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/login', element: React.createElement(LoginPage) }),
          React.createElement(Route, { path: '/office', element: React.createElement(LocationProbe, { label: 'OFFICE_TARGET' }) }),
        ),
      );

      expect(container.textContent).toContain('OFFICE_TARGET:/office');
    });

    it('rejects legacy guard actor on LoginPage and signs out without redirecting to /guard', async () => {
      authMockState.status = 'authenticated';
      authMockState.uid = 'legacy-guard-1';
      authMockState.role = 'guard';

      await renderInRouter(
        '/login',
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/login', element: React.createElement(LoginPage) }),
          React.createElement(Route, { path: '/guard', element: React.createElement(LocationProbe, { label: 'GUARD_TARGET' }) }),
        ),
      );

      expect(signOutMock).toHaveBeenCalledTimes(1);
      expect(container.textContent).not.toContain('GUARD_TARGET');
      expect(container.textContent).toContain('This legacy Guard account is disabled. Gate monitoring now uses a Guard Station device.');
    });
  });

  describe('2. ProtectedRoute enforcement for /guard and /office', () => {
    it.each(['guard_station', 'admin', 'superadmin'] as const)(
      'allows %s onto /guard protected route',
      async (allowedRole) => {
        authMockState.status = 'authenticated';
        authMockState.role = allowedRole;

        await renderInRouter(
          '/guard',
          React.createElement(
            Routes,
            null,
            React.createElement(
              Route,
              { element: React.createElement(ProtectedRoute, { allowedRoles: ['guard_station', 'admin', 'superadmin'] }) },
              React.createElement(Route, { path: '/guard', element: React.createElement(LocationProbe, { label: 'ALLOWED_GUARD' }) }),
            ),
            React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'DENIED_LOGIN' }) }),
          ),
        );

        expect(container.textContent).toContain('ALLOWED_GUARD:/guard');
      },
    );

    it.each(['visitor', 'kiosk', 'entry', 'exit', 'guard', 'office_staff'] as const)(
      'blocks %s from /guard protected route and redirects to /login',
      async (blockedRole) => {
        authMockState.status = 'authenticated';
        authMockState.role = blockedRole;

        await renderInRouter(
          '/guard',
          React.createElement(
            Routes,
            null,
            React.createElement(
              Route,
              { element: React.createElement(ProtectedRoute, { allowedRoles: ['guard_station', 'admin', 'superadmin'] }) },
              React.createElement(Route, { path: '/guard', element: React.createElement(LocationProbe, { label: 'ALLOWED_GUARD' }) }),
            ),
            React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'DENIED_LOGIN' }) }),
          ),
        );

        expect(container.textContent).toContain('DENIED_LOGIN:/login');
        expect(container.textContent).not.toContain('ALLOWED_GUARD');
      },
    );

    it('keeps dedicated /office route accessible for office_staff', async () => {
      authMockState.status = 'authenticated';
      authMockState.role = 'office_staff';

      await renderInRouter(
        '/office',
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { element: React.createElement(ProtectedRoute, { allowedRoles: ['office_staff', 'admin', 'superadmin'] }) },
            React.createElement(Route, { path: '/office', element: React.createElement(LocationProbe, { label: 'ALLOWED_OFFICE' }) }),
          ),
          React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'DENIED_LOGIN' }) }),
        ),
      );

      expect(container.textContent).toContain('ALLOWED_OFFICE:/office');
    });
  });

  describe('3. GuardPage retrieves session bearer token via Supabase Auth and loads feed', () => {
    it('attaches Supabase access token to /api/guard-station-feed instead of reading obsolete egatepass_token', async () => {
      localStorage.removeItem('egatepass_token');
      sessionStorage.removeItem('egatepass_token');

      const seenAuthHeaders: string[] = [];
      globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenAuthHeaders.push(headers.get('Authorization') ?? '');
        return new Response(
          JSON.stringify({
            station: { id: 'gs-1', name: 'Main Gate Guard Station', alias: 'gs-main', gate: 'Gate 1' },
            businessDate: '2026-11-11',
            entries: [
              {
                passId: 'pass-101',
                publicReference: 'PASS-GS-101',
                status: 'inside',
                source: 'portal',
                enteredAt: '2026-11-11T08:00:00Z',
                visitorName: 'Juan Dela Cruz',
                purpose: 'Registrar Document Request',
                photoEvidenceId: null,
                gate: 'Gate 1',
                vehicle: null,
              },
            ],
            hasMore: false,
            nextCursor: null,
            total: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      await renderInRouter('/guard', React.createElement(GuardPage));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(getAccessTokenMock).toHaveBeenCalled();
      expect(seenAuthHeaders[0]).toBe('Bearer live-supabase-station-jwt');
      expect(container.textContent).toContain('Main Gate Guard Station');
      expect(container.textContent).toContain('Gate 1');
      expect(container.textContent).toContain('Juan Dela Cruz');
    });
  });

  describe('4. /api/guard-station-feed active device, gate confinement, and revoked device boundary', () => {
    function buildMockSupabase({
      device,
      staff,
      passes = [],
    }: {
      device: any;
      staff: any;
      passes?: any[];
    }) {
      return {
        from: vi.fn((table: string) => {
          let rows: any[] = [];
          if (table === 'devices') rows = device ? [device] : [];
          else if (table === 'staff_profiles') rows = staff ? [staff] : [];
          else if (table === 'passes') rows = [...passes];

          let headOnly = false;
          const builder: any = {
            select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
              headOnly = Boolean(opts?.head);
              return builder;
            }),
            eq: vi.fn((col: string, val: any) => {
              rows = rows.filter((r) => r[col] === val);
              return builder;
            }),
            in: vi.fn((col: string, vals: any[]) => {
              rows = rows.filter((r) => vals.includes(r[col]));
              return builder;
            }),
            not: vi.fn((col: string, op: string, val: any) => {
              if (op === 'is' && val === null) {
                rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
              }
              return builder;
            }),
            is: vi.fn((col: string, val: any) => {
              if (val === null) {
                rows = rows.filter((r) => r[col] === null || r[col] === undefined);
              }
              return builder;
            }),
            gt: vi.fn(() => builder),
            gte: vi.fn(() => builder),
            lte: vi.fn(() => builder),
            or: vi.fn(() => builder),
            order: vi.fn(() => builder),
            limit: vi.fn((n: number) => {
              rows = rows.slice(0, n);
              return builder;
            }),
            maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
            then: (resolve: (value: any) => any) =>
              resolve(
                headOnly
                  ? { count: rows.length, error: null }
                  : { data: rows, error: null },
              ),
          };
          return builder;
        }),
      };
    }

    it('returns assigned-gate feed for active guard_station device and rejects cross-gate override', async () => {
      const stationUserId = 'station-active-uuid';
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: stationUserId, is_anonymous: false } as any,
        isAnonymous: false,
        isRecoverySession: false,
      });

      const mockDb = buildMockSupabase({
        device: {
          user_id: stationUserId,
          name: 'Gate 1 Station',
          alias: 'gs-gate1',
          type: 'guard_station',
          gate: 'Gate 1',
          status: 'active',
        },
        staff: null,
        passes: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            public_reference: 'REF-G1',
            status: 'inside',
            source: 'portal',
            entry_scanned_at: '2026-11-11T01:00:00Z',
            time_in: '2026-11-11T01:00:00Z',
            time_out: null,
            visitor_id: 'v-1',
            gate: 'Gate 1',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            public_reference: 'REF-G2',
            status: 'inside',
            source: 'portal',
            entry_scanned_at: '2026-11-11T01:05:00Z',
            time_in: '2026-11-11T01:05:00Z',
            time_out: null,
            visitor_id: 'v-2',
            gate: 'Gate 2',
          },
        ],
      });

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockDb as any,
        anon: {} as any,
      });

      // Even if a guard_station passes ?gate=Gate 2, feed must remain confined to its assigned Gate 1
      const req = new Request('http://localhost/api/guard-station-feed?gate=Gate%202', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-station-token' },
      });

      const res = await guardStationFeedHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.station.gate).toBe('Gate 1');
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].publicReference).toBe('REF-G1');
      expect(body.entries[0].gate).toBe('Gate 1');
    });

    it.each(['inactive', 'revoked', 'decommissioned'])('denies %s guard_station device with 403 access_denied', async (badStatus) => {
      const revokedStationId = 'station-revoked-uuid';
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: revokedStationId, is_anonymous: false } as any,
        isAnonymous: false,
        isRecoverySession: false,
      });

      const mockDb = buildMockSupabase({
        device: {
          user_id: revokedStationId,
          name: 'Revoked Station',
          alias: 'gs-revoked',
          type: 'guard_station',
          gate: 'Gate 1',
          status: badStatus,
        },
        staff: null,
      });

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockDb as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/guard-station-feed', {
        method: 'GET',
        headers: { Authorization: 'Bearer revoked-station-token' },
      });

      const res = await guardStationFeedHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('access_denied');
    });

    it('denies legacy guard, kiosk, entry, exit, office_staff, and visitor actors on /api/guard-station-feed', async () => {
      for (const actorCase of [
        { label: 'visitor', isAnonymous: true, device: null, staff: null },
        { label: 'kiosk', isAnonymous: false, device: { user_id: 'u1', type: 'kiosk', status: 'active', gate: 'Gate 1' }, staff: null },
        { label: 'entry', isAnonymous: false, device: { user_id: 'u2', type: 'entry', status: 'active', gate: 'Gate 1' }, staff: null },
        { label: 'exit', isAnonymous: false, device: { user_id: 'u3', type: 'exit', status: 'active', gate: 'Gate 1' }, staff: null },
        {
          label: 'legacy_guard',
          isAnonymous: false,
          device: null,
          staff: { user_id: 'u4', role: 'guard', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' },
        },
        {
          label: 'office_staff',
          isAnonymous: false,
          device: null,
          staff: { user_id: 'u5', role: 'office_staff', active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' },
        },
      ]) {
        vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
          user: { id: 'actor-id', is_anonymous: actorCase.isAnonymous } as any,
          isAnonymous: actorCase.isAnonymous,
          isRecoverySession: false,
        });

        const mockDb = buildMockSupabase({ device: actorCase.device, staff: actorCase.staff });
        vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
          admin: mockDb as any,
          anon: {} as any,
        });

        const req = new Request('http://localhost/api/guard-station-feed', {
          method: 'GET',
          headers: { Authorization: 'Bearer some-token' },
        });
        const res = await guardStationFeedHandler.fetch(req);
        expect(res.status, `Expected 403 for ${actorCase.label}`).toBe(403);
      }
    });

    it('preserves Admin and Superadmin monitoring access on /api/guard-station-feed', async () => {
      for (const role of ['admin', 'superadmin'] as const) {
        vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
          user: { id: `${role}-1`, is_anonymous: false } as any,
          isAnonymous: false,
          isRecoverySession: false,
        });

        const mockDb = buildMockSupabase({
          device: { user_id: 'active-dev', status: 'active', type: 'guard_station', gate: 'Gate 1', name: 'GS', alias: 'gs' },
          staff: {
            user_id: `${role}-1`,
            role,
            active: true,
            must_change_password: false,
            privacy_accepted_at: '2026-01-01T00:00:00Z',
          },
        });
        // Ensure admin querying devices for active gates gets Gate 1 while device lookup by user_id returns null
        mockDb.from = vi.fn((table: string) => {
          let rows: any[] = [];
          if (table === 'devices') rows = [{ user_id: 'other-station', status: 'active', type: 'guard_station', gate: 'Gate 1' }];
          else if (table === 'staff_profiles') rows = [{ user_id: `${role}-1`, role, active: true, must_change_password: false, privacy_accepted_at: '2026-01-01T00:00:00Z' }];
          let headOnly = false;
          const builder: any = {
            select: vi.fn((_c?: string, o?: { head?: boolean }) => { headOnly = Boolean(o?.head); return builder; }),
            eq: vi.fn((col: string, val: any) => { rows = rows.filter((r) => r[col] === val); return builder; }),
            in: vi.fn(() => builder),
            not: vi.fn(() => builder),
            gte: vi.fn(() => builder),
            lte: vi.fn(() => builder),
            order: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
            then: (resolve: (v: any) => any) => resolve(headOnly ? { count: rows.length, error: null } : { data: rows, error: null }),
          };
          return builder;
        });

        vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
          admin: mockDb as any,
          anon: {} as any,
        });

        const req = new Request('http://localhost/api/guard-station-feed', {
          method: 'GET',
          headers: { Authorization: `Bearer ${role}-token` },
        });
        const res = await guardStationFeedHandler.fetch(req);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('5. AdminPage sidebar removes duplicate Office Portal while keeping /office route', () => {
    it('omits Office Portal and /office link from Admin sidebar', async () => {
      authMockState.status = 'authenticated';
      authMockState.role = 'admin';
      authMockState.userData = { kind: 'staff', name: 'Campus Admin', email: 'admin@earist.edu.ph', role: 'admin', active: true };

      await renderInRouter(
        '/admin',
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { path: '/admin', element: React.createElement(AdminPage) },
            React.createElement(Route, { index: true, element: React.createElement('div', null, 'Admin Home') }),
          ),
        ),
      );

      const nav = container.querySelector('nav[aria-label="Admin navigation"]');
      expect(nav).not.toBeNull();
      expect(nav!.textContent).toContain('Dashboard');
      expect(nav!.textContent).toContain('Users');
      expect(nav!.textContent).toContain('Settings');
      expect(nav!.textContent).not.toContain('Office Portal');
      expect(nav!.querySelector('a[href="/office"]')).toBeNull();
      expect(nav!.textContent).not.toContain('Print Templates');
    });

    it('omits Office Portal and /office link from Superadmin sidebar while keeping Print Templates', async () => {
      authMockState.status = 'authenticated';
      authMockState.role = 'superadmin';
      authMockState.userData = { kind: 'staff', name: 'Campus Superadmin', email: 'superadmin@earist.edu.ph', role: 'superadmin', active: true };

      await renderInRouter(
        '/admin',
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { path: '/admin', element: React.createElement(AdminPage) },
            React.createElement(Route, { index: true, element: React.createElement('div', null, 'Superadmin Home') }),
          ),
        ),
      );

      const nav = container.querySelector('nav[aria-label="Admin navigation"]');
      expect(nav).not.toBeNull();
      expect(nav!.textContent).toContain('Print Templates');
      expect(nav!.textContent).not.toContain('Office Portal');
      expect(nav!.querySelector('a[href="/office"]')).toBeNull();
    });

    it('preserves dedicated /office route declaration in src/App.tsx', () => {
      const appSrc = readFileSync('src/App.tsx', 'utf8');
      expect(appSrc).toContain('path="/office" element={<OfficeDashboardPage />}');
      expect(appSrc).toContain("allowedRoles={['office_staff', 'admin', 'superadmin']}");
    });
  });
});
