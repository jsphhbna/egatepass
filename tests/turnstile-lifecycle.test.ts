// @vitest-environment happy-dom
import React, { useState, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { TurnstileWidget } from '../src/components/TurnstileWidget.js';
import { evaluateTurnstilePolicy } from '../src/services/visitorRegistration.js';

describe('TurnstileWidget Component Lifecycle & Fail-Closed Policy (Repair Group 5)', () => {
  let container: HTMLDivElement;
  let root: any;
  let renderMock: any;
  let removeMock: any;
  let resetMock: any;
  let capturedOptions: any = null;
  let widgetCount = 0;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    widgetCount = 0;
    capturedOptions = null;
    renderMock = vi.fn((_el: HTMLElement, opts: any) => {
      widgetCount++;
      capturedOptions = opts;
      return `widget-${widgetCount}`;
    });
    removeMock = vi.fn();
    resetMock = vi.fn();

    window.turnstile = {
      render: renderMock,
      remove: removeMock,
      reset: resetMock,
    };

    // Configure test environment site key
    (import.meta as any).env = {
      ...(import.meta as any).env,
      VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAABbbbbbb',
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as any).turnstile;
  });

  function ParentWrapper({
    resetKey = 0,
    onVerifySpy,
  }: {
    resetKey?: number;
    onVerifySpy?: (token: string) => void;
  }) {
    const [token, setToken] = useState<string | null>(null);
    const [unrelated, setUnrelated] = useState(0);

    return React.createElement(
      'div',
      null,
      React.createElement('div', { 'data-testid': 'token-val' }, token),
      React.createElement('div', { 'data-testid': 'unrelated-val' }, unrelated),
      React.createElement(
        'button',
        {
          'data-testid': 'unrelated-btn',
          onClick: () => setUnrelated((c) => c + 1),
        },
        'Bump'
      ),
      React.createElement(TurnstileWidget, {
        resetKey,
        onVerify: (t: string) => {
          setToken(t);
          onVerifySpy?.(t);
        },
        onExpire: () => setToken(null),
        onError: () => setToken(null),
      })
    );
  }

  it('1. Initial render creates exactly one Turnstile widget', async () => {
    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 0 }));
    });

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(widgetCount).toBe(1);
    expect(capturedOptions).toBeDefined();
    expect(typeof capturedOptions.sitekey).toBe('string');
    expect(capturedOptions.sitekey.length).toBeGreaterThan(5);
  });

  it('2 & 3. Verification callback updates parent state without creating a second widget', async () => {
    const onVerifySpy = vi.fn();

    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 0, onVerifySpy }));
    });

    expect(renderMock).toHaveBeenCalledTimes(1);

    // Simulate Cloudflare Turnstile token resolution
    await act(async () => {
      capturedOptions.callback('cf-token-valid-123');
    });

    // Parent state updated
    expect(onVerifySpy).toHaveBeenCalledWith('cf-token-valid-123');
    expect(container.querySelector('[data-testid="token-val"]')?.textContent).toBe('cf-token-valid-123');

    // Rerender must NOT have destroyed/recreated widget
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('4. Changing unrelated parent state does NOT recreate Turnstile widget', async () => {
    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 0 }));
    });

    expect(renderMock).toHaveBeenCalledTimes(1);

    const btn = container.querySelector('[data-testid="unrelated-btn"]') as HTMLButtonElement;

    // Trigger parent rerender via unrelated state change
    await act(async () => {
      btn.click();
    });

    expect(container.querySelector('[data-testid="unrelated-val"]')?.textContent).toBe('1');
    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('5. Changing resetKey performs intentional reset/recreation behavior', async () => {
    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 0 }));
    });

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();

    // Change resetKey prop to simulate explicit challenge reset
    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 1 }));
    });

    // Old widget removed, fresh widget rendered
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(widgetCount).toBe(2);
  });

  it('6. Unmounting component cleans up and removes widget', async () => {
    await act(async () => {
      root.render(React.createElement(ParentWrapper, { resetKey: 0 }));
    });

    expect(renderMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });

    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('7. Production missing site key remains strictly fail-closed', () => {
    const missingKey = evaluateTurnstilePolicy('portal', true, undefined, 'some-token');
    expect(missingKey.allowed).toBe(false);
    expect(missingKey.error).toBe('Visitor registration is currently unavailable due to missing security configuration.');

    const emptyKey = evaluateTurnstilePolicy('portal', true, '   ', 'some-token');
    expect(emptyKey.allowed).toBe(false);
  });

  it('8. Production submission without CAPTCHA token remains denied', () => {
    const noToken = evaluateTurnstilePolicy('portal', true, '0x4AAAAAAABbbbbbb', undefined);
    expect(noToken.allowed).toBe(false);
    expect(noToken.error).toBe('Verification challenge required to start registration.');

    const emptyToken = evaluateTurnstilePolicy('portal', true, '0x4AAAAAAABbbbbbb', '   ');
    expect(emptyToken.allowed).toBe(false);
  });

  it('9. Local development behavior remains intentional and documented', () => {
    const devPortal = evaluateTurnstilePolicy('portal', false, undefined, undefined);
    expect(devPortal.allowed).toBe(true);

    const devKiosk = evaluateTurnstilePolicy('kiosk', false, undefined, undefined);
    expect(devKiosk.allowed).toBe(true);

    const prodKiosk = evaluateTurnstilePolicy('kiosk', true, '0x4AAAAAAABbbbbbb', undefined);
    expect(prodKiosk.allowed).toBe(true);
  });
});
