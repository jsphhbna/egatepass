// @vitest-environment happy-dom
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { TurnstileWidget, type TurnstileWidgetRef } from '../src/components/TurnstileWidget';
import {
  invalidatePortalEvidenceCheckpoint,
  type PortalIssueTransaction,
} from '../src/services/visitorRegistration';

describe('Turnstile Just-In-Time Pre-Registration & Checkpoint Invalidation', () => {
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    delete (window as any).turnstile;
    delete (window as any).__MOCK_TURNSTILE_TOKEN__;
    document.querySelectorAll('script[src*="turnstile/v0/api.js"]').forEach((s) => s.remove());

    (import.meta as any).env = {
      ...(import.meta as any).env,
      VITE_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      PROD: true,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.querySelectorAll('script[src*="turnstile/v0/api.js"]').forEach((s) => s.remove());
    delete (window as any).turnstile;
    delete (window as any).__MOCK_TURNSTILE_TOKEN__;
    vi.restoreAllMocks();
  });

  it('exposes imperative executeChallenge and resetChallenge via ref', async () => {
    (window as any).__MOCK_TURNSTILE_TOKEN__ = 'mock-cf-token-12345';
    const ref = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    expect(ref.current).toBeDefined();
    expect(typeof ref.current?.executeChallenge).toBe('function');
    expect(typeof ref.current?.resetChallenge).toBe('function');

    const token = await ref.current!.executeChallenge();
    expect(token).toBe('mock-cf-token-12345');

    // resetChallenge should not throw
    expect(() => ref.current?.resetChallenge()).not.toThrow();
  });

  it('resolves execution via turnstile.execute when widget is rendered in browser', async () => {
    let capturedCallback: ((token: string) => void) | null = null;
    let executeCalledWithWidgetId: string | null = null;

    (window as any).turnstile = {
      render: vi.fn((_el: any, options: any) => {
        capturedCallback = options.callback;
        return 'widget-id-abc';
      }),
      execute: vi.fn((widgetId: string) => {
        executeCalledWithWidgetId = widgetId;
        // Simulate Turnstile async challenge resolution
        setTimeout(() => {
          if (capturedCallback) {
            capturedCallback('live-token-777');
          }
        }, 10);
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };

    const ref = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    const challengePromise = ref.current!.executeChallenge();
    expect((window as any).turnstile.execute).toHaveBeenCalled();

    const token = await challengePromise;
    expect(token).toBe('live-token-777');
    expect(executeCalledWithWidgetId).toBe('widget-id-abc');
  });

  it('handles turnstile challenge failure and rejection cleanly', async () => {
    let capturedErrorCallback: ((code: string) => void) | null = null;

    (window as any).turnstile = {
      render: vi.fn((_el: any, options: any) => {
        capturedErrorCallback = options['error-callback'];
        return 'widget-id-fail';
      }),
      execute: vi.fn(() => {
        setTimeout(() => {
          if (capturedErrorCallback) {
            capturedErrorCallback('110100');
          }
        }, 10);
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };

    const ref = createRef<TurnstileWidgetRef>();

    await act(async () => {
      root.render(
        React.createElement(TurnstileWidget, {
          ref,
          execution: 'execute',
          appearance: 'interaction-only',
        })
      );
    });

    await expect(ref.current!.executeChallenge()).rejects.toThrow();
  });

  it('invalidates portal checkpoints correctly for photo and id retakes', () => {
    const transaction: PortalIssueTransaction = {
      token: 'session-token',
      requestId: 'req-111',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      phase: 'ready',
      photoCheckpoint: {
        intentId: 'photo-intent-1',
        bucket: 'visitor-photos',
        path: 'photo.webp',
        sha256Hex: 'aaa',
        byteSize: 100,
        uploadedAt: new Date().toISOString(),
      },
      idCheckpoint: {
        intentId: 'id-intent-1',
        bucket: 'visitor-ids',
        path: 'id.webp',
        sha256Hex: 'bbb',
        byteSize: 200,
        uploadedAt: new Date().toISOString(),
      },
      verifiedPhotoIntentId: 'photo-intent-1',
      verifiedIdIntentId: 'id-intent-1',
    };

    // Invalidate photo checkpoint
    invalidatePortalEvidenceCheckpoint(transaction, 'photo');
    expect(transaction.photoCheckpoint).toBeNull();
    expect(transaction.verifiedPhotoIntentId).toBeNull();
    // ID checkpoint remains intact
    expect(transaction.idCheckpoint).not.toBeNull();
    expect(transaction.verifiedIdIntentId).toBe('id-intent-1');

    // Invalidate ID checkpoint
    invalidatePortalEvidenceCheckpoint(transaction, 'id');
    expect(transaction.idCheckpoint).toBeNull();
    expect(transaction.verifiedIdIntentId).toBeNull();

    // Calling on null transaction does not throw
    expect(() => invalidatePortalEvidenceCheckpoint(null, 'photo')).not.toThrow();
  });
});
