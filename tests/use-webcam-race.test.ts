// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useWebcam } from '../src/hooks/useWebcam';

function createMockTrack() {
  return {
    stop: vi.fn(),
    kind: 'video',
    enabled: true,
  };
}

function createMockStream() {
  const tracks = [createMockTrack()];
  return {
    getTracks: () => tracks,
    _tracks: tracks,
  };
}

function renderHook<T>(hook: () => T) {
  let result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent() {
    result.current = hook();
    return null;
  }

  act(() => {
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('PATCH 8: useWebcam Late-Resolution Race & Cancellation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('8E. getUserMedia pending -> stop() -> promise resolves: stopped tracks, isActive false', async () => {
    let resolveMedia: (stream: any) => void;
    const mediaPromise = new Promise((resolve) => {
      resolveMedia = resolve;
    });

    const mockStream = createMockStream();

    const getUserMediaMock = vi.fn().mockImplementation(() => mediaPromise);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHook(() => useWebcam());
    expect(result.current.isActive).toBe(false);

    // 1. Start camera (pending)
    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    expect(result.current.isStarting).toBe(true);

    // 2. Stop camera before resolution
    act(() => {
      result.current.stop();
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.isStarting).toBe(false);

    // 3. Late resolution of getUserMedia
    await act(async () => {
      resolveMedia(mockStream);
      await startPromise;
    });

    // 4. Assert: returned stream tracks stopped, not active
    expect(mockStream._tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);

    unmount();
  });

  it('8E. Start A -> stop -> start B -> A resolves late -> B resolves: only B remains active', async () => {
    let resolveA: (stream: any) => void;
    let resolveB: (stream: any) => void;

    const streamA = createMockStream();
    const streamB = createMockStream();

    let callCount = 0;
    const getUserMediaMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((res) => {
          resolveA = res;
        });
      }
      return new Promise((res) => {
        resolveB = res;
      });
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHook(() => useWebcam());

    // Start A
    let promiseA: Promise<void>;
    act(() => {
      promiseA = result.current.start();
    });

    // Stop A
    act(() => {
      result.current.stop();
    });

    // Start B
    let promiseB: Promise<void>;
    act(() => {
      promiseB = result.current.start();
    });

    // A resolves late
    await act(async () => {
      resolveA(streamA);
      await promiseA;
    });

    // Stream A tracks should be stopped immediately
    expect(streamA._tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.isActive).toBe(false);

    // B resolves
    await act(async () => {
      resolveB(streamB);
      await promiseB;
    });

    // Stream B tracks must NOT be stopped
    expect(streamB._tracks[0].stop).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);

    unmount();
  });

  it('8D. Unmount during pending getUserMedia: stops tracks without state updates', async () => {
    let resolveMedia: (stream: any) => void;
    const mediaPromise = new Promise((resolve) => {
      resolveMedia = resolve;
    });

    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockImplementation(() => mediaPromise);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHook(() => useWebcam());

    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });

    // Unmount while start is pending
    unmount();

    // Now resolve media
    await act(async () => {
      resolveMedia(mockStream);
      await startPromise;
    });

    expect(mockStream._tracks[0].stop).toHaveBeenCalledTimes(1);
  });
});
