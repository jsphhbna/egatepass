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
    return React.createElement('video', {
      ref: (result.current as any).videoRef,
    });
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
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      value: 4,
      configurable: true,
      writable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    const srcObjects = new WeakMap<any, any>();
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      get() {
        return srcObjects.get(this) ?? null;
      },
      set(val) {
        srcObjects.set(this, val);
      },
      configurable: true,
    });
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

function renderHookWithController<T>(hook: () => T) {
  let result = { current: undefined as unknown as T };
  let setVideoMounted: (mounted: boolean) => void;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function TestComponent() {
    result.current = hook();
    const [mounted, setMounted] = React.useState(true);
    setVideoMounted = setMounted;
    return mounted
      ? React.createElement('video', {
          ref: (result.current as any).videoRef,
        })
      : null;
  }

  act(() => {
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    setVideoMounted: (mounted: boolean) => {
      act(() => {
        setVideoMounted(mounted);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('Priority 2: useWebcam Remount Lifecycle & Fail-Closed Behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      value: 4,
      configurable: true,
      writable: true,
    });
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    const srcObjects = new WeakMap<any, any>();
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      get() {
        return srcObjects.get(this) ?? null;
      },
      set(val) {
        srcObjects.set(this, val);
      },
      configurable: true,
    });
  });

  it('1. Remount while stream active: re-verifies readiness, attaches stream, and keeps camera active', async () => {
    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, setVideoMounted, unmount } = renderHookWithController(() => useWebcam());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isActive).toBe(true);

    // Unmount video element
    setVideoMounted(false);
    expect(result.current.videoRef.current).toBeNull();
    // Capture unavailable when video is unmounted
    expect(result.current.capture()).toBeNull();

    // Remount video element
    await act(async () => {
      setVideoMounted(true);
    });

    // Successfully reattached and verified
    expect(result.current.isActive).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.videoRef.current).not.toBeNull();
    expect(result.current.videoRef.current?.srcObject).toBe(mockStream);

    unmount();
  });

  it('2. Playback rejection during reattachment fails closed: surfaces classified error, stops tracks, not active', async () => {
    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, setVideoMounted, unmount } = renderHookWithController(() => useWebcam());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isActive).toBe(true);

    // Unmount video
    setVideoMounted(false);

    // Next play() call rejects with NotAllowedError (e.g. autoplay restriction on remounted element)
    HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(
      new DOMException('Autoplay blocked on remount', 'NotAllowedError')
    );

    // Remount video
    await act(async () => {
      setVideoMounted(true);
      await new Promise((r) => setTimeout(r, 20));
    });

    // FAIL-CLOSED: isActive is false, classified error surfaced, tracks stopped
    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toContain('Camera access was denied');
    expect(mockStream._tracks[0].stop).toHaveBeenCalled();
    // Capture fails closed
    expect(result.current.capture()).toBeNull();

    unmount();
  });

  it('3. Track ending during reattachment: fails closed and surfaces disconnect error', async () => {
    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, setVideoMounted, unmount } = renderHookWithController(() => useWebcam());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isActive).toBe(true);

    // Unmount
    setVideoMounted(false);

    // Remount
    await act(async () => {
      setVideoMounted(true);
    });
    expect(result.current.isActive).toBe(true);

    // Now track ends (e.g. user unplugs camera USB)
    act(() => {
      mockStream._tracks[0].onended?.();
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.error).toContain('Camera device was disconnected');

    unmount();
  });

  it('4. Capture unavailable when video is paused or readyState < 2', async () => {
    const mockStream = createMockStream();
    const getUserMediaMock = vi.fn().mockResolvedValue(mockStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, unmount } = renderHookWithController(() => useWebcam());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isActive).toBe(true);

    // Simulate paused video
    Object.defineProperty(result.current.videoRef.current!, 'paused', {
      value: true,
      configurable: true,
    });
    expect(result.current.capture()).toBeNull();

    // Reset paused, set readyState < 2
    Object.defineProperty(result.current.videoRef.current!, 'paused', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(result.current.videoRef.current!, 'readyState', {
      value: 1, // HAVE_METADATA only, not playable data
      configurable: true,
    });
    expect(result.current.capture()).toBeNull();

    unmount();
  });

  it('5. Rapid remount and camera switch race does not leak older stream or collide generations', async () => {
    const streamUser = createMockStream();
    const streamEnv = createMockStream();

    let switchCall = 0;
    const getUserMediaMock = vi.fn().mockImplementation(() => {
      switchCall++;
      return Promise.resolve(switchCall === 1 ? streamUser : streamEnv);
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: getUserMediaMock },
      configurable: true,
    });

    const { result, setVideoMounted, unmount } = renderHookWithController(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.isActive).toBe(true);

    // Rapid remount during camera switch
    let switchPromise: Promise<void>;
    act(() => {
      switchPromise = result.current.switchCamera();
      setVideoMounted(false);
      setVideoMounted(true);
    });

    await act(async () => {
      await switchPromise;
    });

    expect(result.current.isActive).toBe(true);
    // Older user stream tracks must be stopped
    expect(streamUser._tracks[0].stop).toHaveBeenCalled();

    unmount();
  });
});
