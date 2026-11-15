// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// Controllable auth mock state
const mockAuthState: {
  status: 'loading' | 'unauthenticated' | 'authenticated' | 'requires_password_change';
  uid: string | null;
  role: any;
  userData: any;
  aal: 'aal1' | 'aal2' | null;
  requiresMfa: boolean;
  serviceStatus: 'available' | 'unavailable';
  serviceMessage: string | null;
  refresh: () => Promise<void>;
} = {
  status: 'unauthenticated',
  uid: null,
  role: null,
  userData: null,
  aal: null,
  requiresMfa: false,
  serviceStatus: 'available',
  serviceMessage: null,
  refresh: vi.fn(async () => {}),
};

// Controllable Supabase Auth MFA mocks
const listFactorsMock = vi.fn();
const enrollMock = vi.fn();
const unenrollMock = vi.fn();
const challengeAndVerifyMock = vi.fn();
const challengeMock = vi.fn();
const verifyMock = vi.fn();
const getAalMock = vi.fn();
const signOutMock = vi.fn();
const signInWithPasswordMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: (...args: any[]) => signOutMock(...args),
      signInWithPassword: (...args: any[]) => signInWithPasswordMock(...args),
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'mock-token', user: { id: mockAuthState.uid } } },
        error: null,
      })),
      getUser: vi.fn(async () => ({
        data: { user: { id: mockAuthState.uid, email: 'staff@earist.edu.ph' } },
        error: null,
      })),
      mfa: {
        listFactors: (...args: any[]) => listFactorsMock(...args),
        enroll: (...args: any[]) => enrollMock(...args),
        unenroll: (...args: any[]) => unenrollMock(...args),
        challengeAndVerify: (...args: any[]) => challengeAndVerifyMock(...args),
        challenge: (...args: any[]) => challengeMock(...args),
        verify: (...args: any[]) => verifyMock(...args),
        getAuthenticatorAssuranceLevel: (...args: any[]) => getAalMock(...args),
      },
    },
    from: (...args: any[]) => fromMock(...args),
  },
  getSupabaseAvailabilityMessage: () => null,
}));

vi.mock('@/services/auth', () => ({
  evaluateAuthTurnstilePolicy: () => ({ allowed: true }),
  getAccessToken: vi.fn(async () => 'mock-access-token'),
  signOutCurrentActor: () => signOutMock(),
}));

vi.mock('@/components/TurnstileWidget', () => ({
  TurnstileWidget: () => null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { ProtectedRoute } from '../src/components/ProtectedRoute';
import { LoginPage } from '../src/pages/LoginPage';
import { TotpEnrollModal } from '../src/components/auth/TotpEnrollModal';

function LocationProbe({ label }: { label: string }) {
  const loc = useLocation();
  return React.createElement('div', { 'data-testid': 'location-probe' }, `${label}:${loc.pathname}`);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flushAsync() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('Frontend TOTP MFA & AAL2 Lifecycle Verification', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    vi.clearAllMocks();

    mockAuthState.status = 'unauthenticated';
    mockAuthState.uid = null;
    mockAuthState.role = null;
    mockAuthState.userData = null;
    mockAuthState.aal = null;
    mockAuthState.requiresMfa = false;
    mockAuthState.serviceStatus = 'available';
    mockAuthState.serviceMessage = null;
    mockAuthState.refresh = vi.fn(async () => {});

    listFactorsMock.mockResolvedValue({
      data: { all: [], totp: [], phone: [], webauthn: [], recovery_code: [] },
      error: null,
    });
    enrollMock.mockResolvedValue({
      data: {
        id: 'factor-new-totp',
        type: 'totp',
        totp: {
          qr_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/></svg>',
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/EARIST%20E-GatePass:user?secret=JBSWY3DPEHPK3PXP&issuer=EARIST%20E-GatePass',
        },
      },
      error: null,
    });
    unenrollMock.mockResolvedValue({ data: { id: 'factor-id' }, error: null });
    challengeAndVerifyMock.mockResolvedValue({
      data: { access_token: 'mock-aal2-jwt', refresh_token: 'mock-refresh' },
      error: null,
    });
    getAalMock.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: ['totp'] },
      error: null,
    });
    signOutMock.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    // Clean up any lingering modal portals in document.body
    document.body.innerHTML = '';
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

  // =========================================================================
  // 1. ProtectedRoute MFA & AAL2 Guard Verification
  // =========================================================================
  describe('1. ProtectedRoute Enforcement', () => {
    it('blocks human staff at AAL1 (requiresMfa = true) and redirects to /login', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'admin-user-1';
      mockAuthState.role = 'admin';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'admin', name: 'Admin User' };

      await renderInRouter('/admin', React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          element: React.createElement(ProtectedRoute, { allowedRoles: ['admin', 'superadmin'] }),
        }, React.createElement(Route, { path: '/admin', element: React.createElement('div', null, 'Admin Secret Content') })),
        React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'LOGIN' }) }),
      ));

      expect(document.body.textContent).toContain('LOGIN:/login');
      expect(document.body.textContent).not.toContain('Admin Secret Content');
    });

    it('allows human staff at AAL2 (requiresMfa = false) to access protected staff route', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'admin-user-1';
      mockAuthState.role = 'admin';
      mockAuthState.aal = 'aal2';
      mockAuthState.requiresMfa = false;
      mockAuthState.userData = { kind: 'staff', role: 'admin', name: 'Admin User' };

      await renderInRouter('/admin', React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          element: React.createElement(ProtectedRoute, { allowedRoles: ['admin', 'superadmin'] }),
        }, React.createElement(Route, { path: '/admin', element: React.createElement('div', null, 'Admin Secret Content') })),
        React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'LOGIN' }) }),
      ));

      expect(document.body.textContent).toContain('Admin Secret Content');
    });

    it('allows device accounts to access their station without requiring AAL2', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'device-kiosk-1';
      mockAuthState.role = 'kiosk';
      mockAuthState.aal = null;
      mockAuthState.requiresMfa = false;
      mockAuthState.userData = { kind: 'device', type: 'kiosk', name: 'Main Kiosk' };

      await renderInRouter('/kiosk', React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          element: React.createElement(ProtectedRoute, { allowedRoles: ['kiosk'] }),
        }, React.createElement(Route, { path: '/kiosk', element: React.createElement('div', null, 'Kiosk Operational View') })),
      ));

      expect(document.body.textContent).toContain('Kiosk Operational View');
    });

    it('denies unauthenticated visitors and redirects to /login', async () => {
      mockAuthState.status = 'unauthenticated';
      mockAuthState.uid = null;
      mockAuthState.role = null;
      mockAuthState.requiresMfa = false;

      await renderInRouter('/admin', React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          element: React.createElement(ProtectedRoute, { allowedRoles: ['admin'] }),
        }, React.createElement(Route, { path: '/admin', element: React.createElement('div', null, 'Admin Secret Content') })),
        React.createElement(Route, { path: '/login', element: React.createElement(LocationProbe, { label: 'LOGIN' }) }),
      ));

      expect(document.body.textContent).toContain('LOGIN:/login');
    });
  });

  // =========================================================================
  // 2. TotpEnrollModal Lifecycle & Edge Cases
  // =========================================================================
  describe('2. TotpEnrollModal Enrollment & Verification', () => {
    it('cleans up stale unverified factors before calling enroll()', async () => {
      listFactorsMock.mockResolvedValueOnce({
        data: {
          all: [
            { id: 'stale-factor-1', factor_type: 'totp', status: 'unverified' },
            { id: 'stale-factor-2', factor_type: 'totp', status: 'unverified' },
          ],
          totp: [],
        },
        error: null,
      });

      const onEnrolled = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(TotpEnrollModal, {
            isOpen: true,
            onEnrolled,
            onCancel,
          })
        );
      });
      await flushAsync();

      // Verify unenroll was called for both stale unverified factors
      expect(unenrollMock).toHaveBeenCalledWith({ factorId: 'stale-factor-1' });
      expect(unenrollMock).toHaveBeenCalledWith({ factorId: 'stale-factor-2' });
      // Verify clean enrollment was initiated
      expect(enrollMock).toHaveBeenCalledWith({
        factorType: 'totp',
        issuer: 'EARIST E-GatePass',
      });
      // Secret key must be visible in document.body
      expect(document.body.textContent).toContain('JBSWY3DPEHPK3PXP');
    });

    it('verifies valid 6-digit TOTP code, checks AAL2 elevation, and fires onEnrolled', async () => {
      const onEnrolled = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(TotpEnrollModal, {
            isOpen: true,
            onEnrolled,
            onCancel,
          })
        );
      });
      await flushAsync();

      const input = document.body.querySelector('input') as HTMLInputElement;
      expect(input).not.toBeNull();

      await act(async () => {
        setInputValue(input, '123456');
      });

      const form = document.body.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(challengeAndVerifyMock).toHaveBeenCalledWith({
        factorId: 'factor-new-totp',
        code: '123456',
      });
      expect(getAalMock).toHaveBeenCalled();
      expect(onEnrolled).toHaveBeenCalled();
    });

    it('blocks access on invalid TOTP code, surfaces error, and DOES NOT blindly retry challenge', async () => {
      challengeAndVerifyMock.mockResolvedValueOnce({
        data: null,
        error: new Error('Invalid TOTP code'),
      });

      const onEnrolled = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(TotpEnrollModal, {
            isOpen: true,
            onEnrolled,
            onCancel,
          })
        );
      });
      await flushAsync();

      const input = document.body.querySelector('input') as HTMLInputElement;
      await act(async () => {
        setInputValue(input, '000000');
      });

      const form = document.body.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      // challengeMock must NOT have been called (no blind second challenge!)
      expect(challengeMock).not.toHaveBeenCalled();
      expect(verifyMock).not.toHaveBeenCalled();
      expect(onEnrolled).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Invalid verification code');
    });

    it('handles expired verification challenge cleanly', async () => {
      challengeAndVerifyMock.mockResolvedValueOnce({
        data: null,
        error: new Error('MFA challenge expired'),
      });

      const onEnrolled = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(TotpEnrollModal, {
            isOpen: true,
            onEnrolled,
            onCancel,
          })
        );
      });
      await flushAsync();

      const input = document.body.querySelector('input') as HTMLInputElement;
      await act(async () => {
        setInputValue(input, '654321');
      });

      const form = document.body.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(challengeMock).not.toHaveBeenCalled();
      expect(onEnrolled).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('challenge has expired');
    });

    it('unenrolls pending unverified factor when user cancels enrollment', async () => {
      const onEnrolled = vi.fn();
      const onCancel = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(TotpEnrollModal, {
            isOpen: true,
            onEnrolled,
            onCancel,
          })
        );
      });
      await flushAsync();

      // Find "Sign Out / Cancel" button
      const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Sign Out') || b.textContent?.includes('Cancel')
      );
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn!.click();
      });
      await flushAsync();

      expect(unenrollMock).toHaveBeenCalledWith({ factorId: 'factor-new-totp' });
      expect(onCancel).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. LoginPage Lifecycle: First-Time Enrollment & Returning Challenge
  // =========================================================================
  describe('3. LoginPage MFA Flow', () => {
    it('triggers enrollment for staff authenticated at AAL1 with zero verified factors', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'staff-new-1';
      mockAuthState.role = 'admin';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'admin', name: 'New Admin' };

      listFactorsMock.mockResolvedValueOnce({
        data: { all: [], totp: [] },
        error: null,
      });

      await renderInRouter('/login', React.createElement(LoginPage));
      await flushAsync();

      // Must open modal with Set Up Two-Factor Authentication in document.body
      expect(document.body.textContent).toContain('Set Up Two-Factor Authentication');
      expect(document.body.textContent).toContain('Mandatory MFA Enrollment');
    });

    it('triggers challenge for staff authenticated at AAL1 with existing verified factor', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'staff-returning-1';
      mockAuthState.role = 'office_staff';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'office_staff', name: 'Registrar' };

      listFactorsMock.mockResolvedValueOnce({
        data: {
          all: [{ id: 'factor-verified-1', factor_type: 'totp', status: 'verified' }],
          totp: [{ id: 'factor-verified-1', factor_type: 'totp', status: 'verified' }],
        },
        error: null,
      });

      await renderInRouter('/login', React.createElement(LoginPage));
      await flushAsync();

      // Must render Two-Factor Challenge form
      expect(document.body.textContent).toContain('Two-Factor Challenge');
      expect(document.body.textContent).toContain('Enter the 6-digit verification code from your authenticator app');
    });

    it('verifies challenge code, refreshes auth session, and redirects to staff portal', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'staff-returning-1';
      mockAuthState.role = 'office_staff';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'office_staff', name: 'Registrar' };

      listFactorsMock.mockResolvedValueOnce({
        data: {
          totp: [{ id: 'factor-verified-1', factor_type: 'totp', status: 'verified' }],
        },
        error: null,
      });

      await renderInRouter('/login', React.createElement(
        Routes,
        null,
        React.createElement(Route, { path: '/login', element: React.createElement(LoginPage) }),
        React.createElement(Route, { path: '/office', element: React.createElement(LocationProbe, { label: 'OFFICE' }) }),
      ));
      await flushAsync();

      expect(document.body.textContent).toContain('Two-Factor Challenge');

      const codeInput = document.body.querySelector('#totp-code') as HTMLInputElement;
      expect(codeInput).not.toBeNull();

      await act(async () => {
        setInputValue(codeInput, '112233');
      });

      const form = document.body.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(challengeAndVerifyMock).toHaveBeenCalledWith({
        factorId: 'factor-verified-1',
        code: '112233',
      });
      expect(getAalMock).toHaveBeenCalled();
      expect(mockAuthState.refresh).toHaveBeenCalled();
      expect(document.body.textContent).toContain('OFFICE:/office');
    });

    it('blocks invalid TOTP challenge code without duplicate blind challenge retry', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'staff-returning-1';
      mockAuthState.role = 'admin';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'admin', name: 'Admin' };

      listFactorsMock.mockResolvedValueOnce({
        data: {
          totp: [{ id: 'factor-verified-1', factor_type: 'totp', status: 'verified' }],
        },
        error: null,
      });

      challengeAndVerifyMock.mockResolvedValueOnce({
        data: null,
        error: new Error('Invalid TOTP code'),
      });

      await renderInRouter('/login', React.createElement(LoginPage));
      await flushAsync();

      const codeInput = document.body.querySelector('#totp-code') as HTMLInputElement;
      await act(async () => {
        setInputValue(codeInput, '999999');
      });

      const form = document.body.querySelector('form') as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushAsync();

      expect(challengeMock).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Invalid authenticator code');
    });

    it('signs out completely when user cancels login challenge', async () => {
      mockAuthState.status = 'authenticated';
      mockAuthState.uid = 'staff-returning-1';
      mockAuthState.role = 'admin';
      mockAuthState.aal = 'aal1';
      mockAuthState.requiresMfa = true;
      mockAuthState.userData = { kind: 'staff', role: 'admin', name: 'Admin' };

      listFactorsMock.mockResolvedValueOnce({
        data: {
          totp: [{ id: 'factor-verified-1', factor_type: 'totp', status: 'verified' }],
        },
        error: null,
      });

      await renderInRouter('/login', React.createElement(LoginPage));
      await flushAsync();

      const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Sign Out') || b.textContent?.includes('Cancel')
      );
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn!.click();
      });
      await flushAsync();

      expect(signOutMock).toHaveBeenCalled();
      expect(mockAuthState.refresh).toHaveBeenCalled();
    });
  });
});
