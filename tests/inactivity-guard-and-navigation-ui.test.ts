// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseAuth = vi.fn();
const mockSignOut = vi.fn(async () => ({ error: null }));
const mockGetSession = vi.fn(async () => ({
  data: { session: { access_token: 'mock-access-token' } },
  error: null,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      signOut: () => mockSignOut(),
    },
  },
}));

import { HumanInactivityGuard } from '@/components/HumanInactivityGuard';

describe('Human 15-Minute Inactivity Guard & Single-Source Admin Navigation UI', () => {
  const originalFetch = globalThis.fetch;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ valid: true, expired: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('strictly exempts managed device sessions (e.g., emergency_device) from inactivity warnings and sign-out', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      uid: 'device-1',
      role: 'emergency_device',
      userData: {
        kind: 'device',
        alias: 'EMG-01',
        name: 'Emergency Tablet 1',
        type: 'emergency_device',
        gate: 'Main Gate',
        status: 'active',
      },
      serviceStatus: 'available',
      serviceMessage: null,
      refresh: async () => {},
    });

    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(HumanInactivityGuard)));
    });

    await act(async () => {
      vi.advanceTimersByTime(20 * 60 * 1000);
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows warning countdown before 15 minutes for human staff, resets on stay-signed-in click, and signs out at 15 minutes', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      uid: 'staff-1',
      role: 'admin',
      userData: {
        kind: 'staff',
        name: 'Admin User',
        email: 'admin@earist.edu.ph',
        role: 'admin',
        active: true,
        mustChangePassword: false,
        privacyAcceptedAt: '2026-11-01T00:00:00Z',
      },
      serviceStatus: 'available',
      serviceMessage: null,
      refresh: async () => {},
    });

    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(HumanInactivityGuard)));
    });

    // Advance 14 minutes -> 60-second warning modal should appear
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 500);
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    // Click primary Stay Signed In button inside modal
    const buttons = Array.from(dialog!.querySelectorAll('button'));
    const stayBtn = buttons.find((b) => b.textContent?.includes('Stay Signed In'));
    expect(stayBtn).toBeTruthy();
    await act(async () => {
      stayBtn!.click();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();

    // Advance full 15 minutes of inactivity without resetting
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1500);
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    const expireCall = vi.mocked(globalThis.fetch).mock.calls.find((call) => {
      const url = String(call[0]);
      const body = String((call[1] as RequestInit | undefined)?.body || '');
      return url.includes('/api/auth/session-activity') && body.includes('"expire"');
    });
    expect(expireCall).toBeTruthy();
  });

  it('maintains single-source sidebar navigation in AdminPage with zero duplicate sub-tab strips in child Admin views', () => {
    const adminPageSrc = readFileSync('src/pages/AdminPage.tsx', 'utf8');
    const childPages = [
      'src/pages/AdminDashboard.tsx',
      'src/pages/AdminUsers.tsx',
      'src/pages/DevicesPage.tsx',
      'src/pages/AdminSettings.tsx',
      'src/pages/AdminRecords.tsx',
    ];

    expect(adminPageSrc).toContain('useLocation');
    expect(adminPageSrc).toContain('?tab=');
    for (const file of childPages) {
      const src = readFileSync(file, 'utf8');
      expect(src, `Duplicate Sub-Tabs comment found in ${file}`).not.toContain('{/* Sub-Tabs Navigation */}');
      expect(src, `Duplicate role="tablist" found in ${file}`).not.toContain('role="tablist"');
    }
  });
});
