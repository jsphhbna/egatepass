// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { TurnstileWidget } from '../src/components/TurnstileWidget';

describe('Repair Group 7: Turnstile Existing-Script Lifecycle & Bounded Readiness', () => {
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();

    delete (window as any).turnstile;
    // Remove any leftover scripts
    document.querySelectorAll('script[src*="turnstile/v0/api.js"]').forEach((s) => s.remove());

    (import.meta as any).env = {
      ...(import.meta as any).env,
      VITE_TURNSTILE_SITE_KEY: 'test-turnstile-key',
      PROD: false,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.querySelectorAll('script[src*="turnstile/v0/api.js"]').forEach((s) => s.remove());
    delete (window as any).turnstile;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE G: Existing script tag exists but global never initializes -> times out after 12s to error UI with Retry', async () => {
    // Add dummy script tag to simulate existing script tag
    const existingScript = document.createElement('script');
    existingScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(existingScript);

    // window.turnstile remains undefined
    await act(async () => {
      root.render(React.createElement(TurnstileWidget, { onVerify: vi.fn() }));
    });

    // Initially loading
    expect(container.textContent).toContain('Loading security check…');

    // Fast-forward 11.9 seconds: still loading
    await act(async () => {
      vi.advanceTimersByTime(11_900);
    });
    expect(container.textContent).toContain('Loading security check…');

    // Advance past 12-second bounded timeout
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    // Invariant: Bounded failure, error UI displayed, Retry button available, no infinite spinner!
    expect(container.textContent).toContain('Security verification could not load.');
    expect(container.textContent).toContain('Retry');
  });

  it('Existing script tag with delayed global: initializes cleanly when global appears', async () => {
    const existingScript = document.createElement('script');
    existingScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(existingScript);

    const renderSpy = vi.fn(() => 'widget-123');
    const removeSpy = vi.fn();

    await act(async () => {
      root.render(React.createElement(TurnstileWidget, { onVerify: vi.fn() }));
    });

    expect(container.textContent).toContain('Loading security check…');

    // Simulate window.turnstile appearing after 500ms
    (window as any).turnstile = {
      render: renderSpy,
      remove: removeSpy,
      reset: vi.fn(),
    };

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // Exactly one widget rendered
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // On unmount, widget is removed
    await act(async () => {
      root.unmount();
    });
    expect(removeSpy).toHaveBeenCalledWith('widget-123');
  });

  it('Unmount before global initialization cancels timers and prevents widget leak', async () => {
    const existingScript = document.createElement('script');
    existingScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(existingScript);

    const renderSpy = vi.fn();

    await act(async () => {
      root.render(React.createElement(TurnstileWidget, { onVerify: vi.fn() }));
    });

    // Unmount before global appears
    await act(async () => {
      root.unmount();
    });

    // Global appears later
    (window as any).turnstile = {
      render: renderSpy,
      remove: vi.fn(),
      reset: vi.fn(),
    };

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    // renderSpy must NOT be called after unmount
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('Retry after failed script removes stale script tag and recovers', async () => {
    const staleScript = document.createElement('script');
    staleScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(staleScript);

    await act(async () => {
      root.render(React.createElement(TurnstileWidget, { onVerify: vi.fn() }));
    });

    // Trigger timeout
    await act(async () => {
      vi.advanceTimersByTime(12_100);
    });

    expect(container.textContent).toContain('Retry');

    // Setup working turnstile for retry
    const renderSpy = vi.fn(() => 'widget-retry-1');
    (window as any).turnstile = {
      render: renderSpy,
      remove: vi.fn(),
      reset: vi.fn(),
    };

    // Click Retry
    const retryBtn = container.querySelector('button');
    await act(async () => {
      retryBtn?.click();
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
