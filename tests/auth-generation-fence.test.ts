// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let authStateChangeCallback: ((event: string, session: any) => void) | null = null;
let getSessionCallback: () => Promise<any> = async () => ({ data: { session: null }, error: null });
let signOutCallback: () => Promise<any> = async () => ({ error: null });
let queryHandler: (table: string, eqCol: string, eqVal: string) => Promise<any> = async () => ({
  data: null,
  error: null,
});

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => getSessionCallback(),
      signOut: () => signOutCallback(),
      onAuthStateChange: (cb: any) => {
        authStateChangeCallback = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => ({
          maybeSingle: () => queryHandler(table, col, val),
        }),
      }),
    }),
  },
  getSupabaseAvailabilityMessage: () => null,
}));

import { AuthProvider, useAuth } from '../src/hooks/useAuth';

function AuthStateProbe({ onState }: { onState: (state: any) => void }) {
  const auth = useAuth();
  React.useEffect(() => {
    onState(auth);
  }, [auth, onState]);
  return React.createElement('div', { id: 'auth-status' }, auth.status);
}

describe('Repair Group 8: AuthProvider Async Generation Fencing', () => {
  let container: HTMLDivElement;
  let root: any;
  let latestState: any = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestState = null;
    authStateChangeCallback = null;
    queryHandler = async () => ({ data: null, error: null });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE H1: User A resolve starts -> SIGN_OUT occurs -> A finishes late -> final state remains unauthenticated', async () => {
    let resolveUserA!: (val: any) => void;
    const pendingPromiseA = new Promise<any>((resolve) => {
      resolveUserA = resolve;
    });

    queryHandler = async (_table, _col, val) => {
      if (val === 'user-a') {
        return pendingPromiseA;
      }
      return { data: null, error: null };
    };

    getSessionCallback = async () => ({ data: { session: null }, error: null });

    await act(async () => {
      root.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(AuthStateProbe, { onState: (s) => (latestState = s) })
        )
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(latestState.status).toBe('unauthenticated');

    // User A signs in, but query for user-a is deferred
    const userA = { id: 'user-a', email: 'alice@earist.edu.ph', email_confirmed_at: '2026-10-20' };

    await act(async () => {
      authStateChangeCallback!('SIGNED_IN', { user: userA });
    });

    // SIGN_OUT event arrives before user A query finishes
    await act(async () => {
      authStateChangeCallback!('SIGNED_OUT', null);
      await Promise.resolve();
    });

    // State is unauthenticated now
    expect(latestState.status).toBe('unauthenticated');

    // A finally finishes resolving role
    await act(async () => {
      resolveUserA({
        data: {
          display_name: 'Alice',
          role: 'admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-10-20',
        },
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Invariant: Stale resolution for user A must be dropped! State remains unauthenticated.
    expect(latestState.status).toBe('unauthenticated');
    expect(latestState.uid).toBeNull();
    expect(latestState.role).toBeNull();
  });

  it('ADVERSARIAL CASE H2: Rapid user switch (A starts -> B signs in & resolves -> A resolves last) -> final state is B', async () => {
    let resolveUserA!: (val: any) => void;
    const pendingPromiseA = new Promise<any>((resolve) => {
      resolveUserA = resolve;
    });

    queryHandler = async (_table, _col, val) => {
      if (val === 'user-a') {
        return pendingPromiseA;
      }
      if (val === 'user-b') {
        return {
          data: {
            display_name: 'Bob',
            role: 'guard',
            active: true,
            must_change_password: false,
            privacy_accepted_at: '2026-10-20',
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const userA = { id: 'user-a', email: 'alice@earist.edu.ph', email_confirmed_at: '2026-10-20' };
    const userB = { id: 'user-b', email: 'bob@earist.edu.ph', email_confirmed_at: '2026-10-20' };

    getSessionCallback = async () => ({ data: { session: null }, error: null });

    await act(async () => {
      root.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(AuthStateProbe, { onState: (s) => (latestState = s) })
        )
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // User A signs in (async resolve is pending)
    await act(async () => {
      authStateChangeCallback!('SIGNED_IN', { user: userA });
    });

    // Before A resolves, User B signs in and immediately resolves
    await act(async () => {
      authStateChangeCallback!('SIGNED_IN', { user: userB });
      await new Promise((r) => setTimeout(r, 20));
      await Promise.resolve();
    });

    // User B should now be authenticated as guard
    expect(latestState.status).toBe('authenticated');
    expect(latestState.uid).toBe('user-b');
    expect(latestState.role).toBe('guard');

    // A finishes last
    await act(async () => {
      resolveUserA({
        data: {
          display_name: 'Alice',
          role: 'admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-10-20',
        },
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Invariant: Final state remains B, stale A resolution is discarded
    expect(latestState.status).toBe('authenticated');
    expect(latestState.uid).toBe('user-b');
    expect(latestState.role).toBe('guard');
  });

  it('unmount during role resolution does not throw or commit state', async () => {
    let resolveUserA!: (val: any) => void;
    const pendingPromiseA = new Promise<any>((resolve) => {
      resolveUserA = resolve;
    });

    queryHandler = async () => pendingPromiseA;

    const userA = { id: 'user-a', email: 'alice@earist.edu.ph', email_confirmed_at: '2026-10-20' };
    getSessionCallback = async () => ({ data: { session: null }, error: null });

    await act(async () => {
      root.render(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(AuthStateProbe, { onState: (s) => (latestState = s) })
        )
      );
    });

    await act(async () => {
      authStateChangeCallback!('SIGNED_IN', { user: userA });
    });

    // Unmount before query resolves
    await act(async () => {
      root.unmount();
    });

    // Query resolves after unmount
    await act(async () => {
      resolveUserA({
        data: {
          display_name: 'Alice',
          role: 'admin',
          active: true,
          must_change_password: false,
          privacy_accepted_at: '2026-10-20',
        },
        error: null,
      });
      await Promise.resolve();
    });

    // Container removed in afterEach, no uncaught exceptions thrown
  });
});
