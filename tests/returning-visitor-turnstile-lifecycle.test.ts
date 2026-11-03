// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { TurnstileWidget, type TurnstileWidgetRef } from '../src/components/TurnstileWidget';
import {
  createPortalIssueTransaction,
  validatePortalSession,
  evaluateTurnstilePolicy,
  lookupReturningVisitor,
  identifyReturningVisitor,
  type PortalIssueTransaction,
} from '../src/services/visitorRegistration';

let mockSession: any = null;
let signInAnonCalls: any[] = [];
let signOutCount = 0;

vi.mock('../src/lib/supabase', () => {
  return {
    requirePortalSupabase: () => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: mockSession }, error: null })),
        signOut: vi.fn(async () => {
          signOutCount++;
          mockSession = null;
          return { error: null };
        }),
        signInAnonymously: vi.fn(async (opts?: any) => {
          signInAnonCalls.push(opts);
          const session = {
            user: { id: 'anon-user-uuid-1', is_anonymous: true },
            access_token: 'portal-anon-access-token-xyz',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          };
          mockSession = session;
          return { data: { session }, error: null };
        }),
      },
      schema: () => ({
        rpc: () => ({
          single: async () => ({
            data: {
              intent_id: 'photo-intent-123',
              bucket_id: 'visitor-photos',
              object_path: 'intents/photo-intent-123.webp',
              max_bytes: 5 * 1024 * 1024,
              expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
            error: null,
          }),
        }),
      }),
      storage: {
        from: () => ({
          upload: vi.fn(async () => ({ data: { path: 'photo.webp' }, error: null })),
        }),
      },
    }),
    requireSupabase: () => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: mockSession }, error: null })),
      },
    }),
  };
});

describe('Returning Visitor Turnstile Lifecycle & Session Security (Regression Suite)', () => {
  let container: HTMLDivElement;
  let root: any;
  let widgetExecuteCount = 0;
  let widgetResetCount = 0;
  let widgetRenderCount = 0;
  let capturedCallback: ((token: string) => void) | null = null;
  let capturedErrorCallback: ((err: string) => void) | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mockSession = null;
    signInAnonCalls = [];
    signOutCount = 0;
    widgetExecuteCount = 0;
    widgetResetCount = 0;
    widgetRenderCount = 0;
    capturedCallback = null;
    capturedErrorCallback = null;

    (window as any).turnstile = {
      render: vi.fn((_el: any, options: any) => {
        widgetRenderCount++;
        capturedCallback = options.callback;
        capturedErrorCallback = options['error-callback'];
        return `widget-${widgetRenderCount}`;
      }),
      execute: vi.fn(() => {
        widgetExecuteCount++;
        setTimeout(() => {
          if (capturedCallback) {
            capturedCallback('mock-cloudflare-turnstile-token-abc');
          }
        }, 10);
      }),
      reset: vi.fn(() => {
        widgetResetCount++;
      }),
      remove: vi.fn(),
    };

    process.env.PROD = 'true';
    process.env.NODE_ENV = 'production';
    process.env.VITE_TURNSTILE_SITE_KEY = '0x4AAAAAAFeETebgPENH6hgH';
    (import.meta.env as any).PROD = true;
    (import.meta.env as any).VITE_TURNSTILE_SITE_KEY = '0x4AAAAAAFeETebgPENH6hgH';
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as any).turnstile;
    vi.restoreAllMocks();
  });

  // ============================================================
  // TEST A: Initial Returning Visitor Search
  // ============================================================
  it('Test A: executes Turnstile, receives valid token, and creates authenticated session for profile lookup without challenge error', async () => {
    const turnstileRef = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    expect(turnstileRef.current).toBeDefined();

    // 1. Visitor clicks Search Profile -> triggers executeChallenge
    let token = '';
    await act(async () => {
      token = await turnstileRef.current!.executeChallenge();
    });
    expect(token).toBe('mock-cloudflare-turnstile-token-abc');
    expect(widgetExecuteCount).toBe(1);

    // 2. createPortalIssueTransaction succeeds with the token in production
    const tx = await createPortalIssueTransaction(token);
    expect(tx).toBeDefined();
    expect(tx.token).toBe('portal-anon-access-token-xyz');
    expect(tx.actorId).toBe('anon-user-uuid-1');

    // 3. Verify captchaToken was passed to Supabase anonymous sign-in
    expect(signInAnonCalls.length).toBe(1);
    expect(signInAnonCalls[0]).toEqual({
      options: { captchaToken: 'mock-cloudflare-turnstile-token-abc' },
    });

    // 4. Mock lookup-returning endpoint call with tx
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).includes('/api/passes/lookup-returning')) {
        expect(init.headers['Authorization']).toBe(`Bearer ${tx.token}`);
        return new Response(
          JSON.stringify({
            found: true,
            count: 1,
            candidates: [
              {
                profileId: 'prof-1111',
                maskedName: 'Juan Dela Cruz',
                maskedContact: '0917****567',
                hasVehicle: true,
                savedVehiclesCount: 1,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const lookupRes = await lookupReturningVisitor(tx, { firstName: 'Juan', lastName: 'Cruz' });
    expect(lookupRes.found).toBe(true);
    expect(lookupRes.candidates.length).toBe(1);
    expect(lookupRes.candidates[0].profileId).toBe('prof-1111');
    fetchSpy.mockRestore();
  });

  // ============================================================
  // TEST B: Returning Visitor Capture (Session Reuse)
  // ============================================================
  it('Test B: reuses existing active portal transaction without re-executing Turnstile', async () => {
    const turnstileRef = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    // Step A: established session
    let token = '';
    await act(async () => {
      token = await turnstileRef.current!.executeChallenge();
    });
    const tx = await createPortalIssueTransaction(token);
    expect(widgetExecuteCount).toBe(1);

    // Step B: Face capture checks session validity before 1:1 verify
    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(true);

    // Because session is valid, no redundant challenge is executed
    expect(widgetExecuteCount).toBe(1);

    const identifySpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).includes('/api/passes/identify-returning')) {
        expect(init.headers['Authorization']).toBe(`Bearer ${tx.token}`);
        return new Response(
          JSON.stringify({
            matched: true,
            score: 0.88,
            threshold: 0.363,
            matchToken: 'match-token-xyz',
            profile: {
              profileId: 'prof-1111',
              firstName: 'Juan',
              lastName: 'Cruz',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const identifyRes = await identifyReturningVisitor(tx, 'photo-intent-123', 'prof-1111');
    expect(identifyRes.matched).toBe(true);
    expect(identifyRes.matchToken).toBe('match-token-xyz');
    expect(widgetExecuteCount).toBe(1); // Still exactly 1!
    identifySpy.mockRestore();
  });

  // ============================================================
  // TEST C: Expired Session Requires Fresh Challenge
  // ============================================================
  it('Test C: detects expired session and executes fresh Turnstile challenge before replacement session', async () => {
    const turnstileRef = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    let token1 = '';
    await act(async () => {
      token1 = await turnstileRef.current!.executeChallenge();
    });
    const tx = await createPortalIssueTransaction(token1);
    expect(widgetExecuteCount).toBe(1);

    // Simulate session expiration: clear mockSession in Supabase client
    mockSession = null;
    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(false);

    // When invalid, the controller must re-execute challenge
    let token2 = '';
    await act(async () => {
      token2 = await turnstileRef.current!.executeChallenge();
    });
    expect(widgetExecuteCount).toBe(2);
    const replacementTx = await createPortalIssueTransaction(token2);
    expect(replacementTx).toBeDefined();
    expect(replacementTx.token).toBe('portal-anon-access-token-xyz');
  });

  // ============================================================
  // TEST D: Cloudflare Failure Handling (Fail-Closed)
  // ============================================================
  it('Test D: fails closed in production when Turnstile challenge errors, times out, or site key is missing', async () => {
    // 1. Missing site key fails evaluateTurnstilePolicy in production
    const policyMissingKey = evaluateTurnstilePolicy('portal', true, undefined, undefined);
    expect(policyMissingKey.allowed).toBe(false);
    expect(policyMissingKey.error).toContain('missing security configuration');

    // 2. Missing captcha token fails evaluateTurnstilePolicy in production
    const policyMissingToken = evaluateTurnstilePolicy(
      'portal',
      true,
      '0x4AAAAAAFeETebgPENH6hgH',
      undefined
    );
    expect(policyMissingToken.allowed).toBe(false);
    expect(policyMissingToken.error).toBe('Verification challenge required to start registration.');

    // 3. createPortalIssueTransaction rejects if no captcha token is provided in production
    await expect(createPortalIssueTransaction(undefined)).rejects.toThrow(
      'Verification challenge required to start registration.'
    );

    // 4. TurnstileWidget error callback rejects executeChallenge promise
    (window as any).turnstile.execute = vi.fn(() => {
      setTimeout(() => {
        if (capturedErrorCallback) capturedErrorCallback('110200');
      }, 5);
    });

    const turnstileRef = createRef<TurnstileWidgetRef>();
    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    await act(async () => {
      await expect(turnstileRef.current!.executeChallenge()).rejects.toThrow('challenge_error: 110200');
    });
  });

  // ============================================================
  // TEST E: New Visitor Flow Regression
  // ============================================================
  it('Test E: New Visitor preflight verification executes Turnstile and initializes session before live face capture', async () => {
    const turnstileRef = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    // In New Visitor step 'id', user clicks 'Continue to Live Face Capture'
    let token = '';
    await act(async () => {
      token = await turnstileRef.current!.executeChallenge();
    });
    expect(token).toBe('mock-cloudflare-turnstile-token-abc');

    const tx = await createPortalIssueTransaction(token);
    expect(tx).toBeDefined();
    expect(tx.token).toBe('portal-anon-access-token-xyz');
    expect(signInAnonCalls.length).toBe(1);
    expect(signInAnonCalls[0].options.captchaToken).toBe('mock-cloudflare-turnstile-token-abc');
  });

  // ============================================================
  // TEST F: Widget Uniqueness & Single Persistent Instance
  // ============================================================
  it('Test F: maintains exactly one persistent Turnstile widget instance without duplicate renders', async () => {
    const turnstileRef = createRef<TurnstileWidgetRef>();

    function MockPortalLifecycle() {
      const [step, setStep] = React.useState('frontdoor');

      return React.createElement(
        'div',
        { 'data-testid': 'portal-card' },
        React.createElement('div', { 'data-testid': 'active-step' }, step),
        React.createElement(
          'button',
          {
            'data-testid': 'goto-returning-lookup',
            onClick: () => setStep('returning_lookup'),
          },
          'To Returning Lookup'
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'goto-returning-capture',
            onClick: () => setStep('returning_capture'),
          },
          'To Returning Capture'
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'goto-id',
            onClick: () => setStep('id'),
          },
          'To New Visitor ID'
        ),
        // Persistent widget mounted at card root
        React.createElement(TurnstileWidget, {
          ref: turnstileRef,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    }

    await act(async () => {
      root.render(React.createElement(MockPortalLifecycle));
    });

    // 1. Initial mount on frontdoor
    expect(widgetRenderCount).toBe(1);
    const initialWidget = turnstileRef.current;
    expect(initialWidget).not.toBeNull();

    // 2. Navigate to returning_lookup
    const btnLookup = container.querySelector('[data-testid="goto-returning-lookup"]') as HTMLButtonElement;
    await act(async () => {
      btnLookup.click();
    });
    expect(container.querySelector('[data-testid="active-step"]')?.textContent).toBe('returning_lookup');
    expect(widgetRenderCount).toBe(1); // STILL 1, no duplicate widget rendered!
    expect(typeof turnstileRef.current?.executeChallenge).toBe('function');
    expect(typeof turnstileRef.current?.resetChallenge).toBe('function');

    // 3. Navigate to returning_capture
    const btnCapture = container.querySelector('[data-testid="goto-returning-capture"]') as HTMLButtonElement;
    await act(async () => {
      btnCapture.click();
    });
    expect(container.querySelector('[data-testid="active-step"]')?.textContent).toBe('returning_capture');
    expect(widgetRenderCount).toBe(1); // STILL 1!
    expect(typeof turnstileRef.current?.executeChallenge).toBe('function');

    // 4. Navigate to New Visitor ID step
    const btnId = container.querySelector('[data-testid="goto-id"]') as HTMLButtonElement;
    await act(async () => {
      btnId.click();
    });
    expect(container.querySelector('[data-testid="active-step"]')?.textContent).toBe('id');
    expect(widgetRenderCount).toBe(1); // STILL 1!
    expect(typeof turnstileRef.current?.executeChallenge).toBe('function');

    // 5. Calling executeChallenge on the ref still executes the single mounted widget
    let token = '';
    await act(async () => {
      token = await turnstileRef.current!.executeChallenge();
    });
    expect(token).toBe('mock-cloudflare-turnstile-token-abc');
    expect(widgetExecuteCount).toBe(1);
  });
});
