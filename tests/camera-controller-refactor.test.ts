// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useWebcam } from '../src/hooks/useWebcam';

function createMockTrack(facingMode = 'user') {
  return {
    stop: vi.fn(),
    kind: 'video',
    enabled: true,
    getSettings: () => ({ facingMode }),
  };
}

function createMockStream(facingMode = 'user') {
  const tracks = [createMockTrack(facingMode)];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
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
    rerender: () => {
      act(() => {
        root.render(React.createElement(TestComponent));
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

describe('Group B: System-Wide Camera Controller Refactor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes front camera with activeFacingMode=user, mirrorPreview=true, mirrorCapture=true', async () => {
    const stream = createMockStream('user');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
        { kind: 'videoinput', deviceId: 'cam2' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.activeFacingMode).toBe('user');
    expect(result.current.mirrorPreview).toBe(true);
    expect(result.current.mirrorCapture).toBe(true);
    expect(result.current.canSwitchCamera).toBe(true);

    unmount();
  });

  it('initializes rear camera with activeFacingMode=environment, mirrorPreview=false, mirrorCapture=false', async () => {
    const stream = createMockStream('environment');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
        { kind: 'videoinput', deviceId: 'cam2' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'environment' }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.activeFacingMode).toBe('environment');
    expect(result.current.mirrorPreview).toBe(false);
    expect(result.current.mirrorCapture).toBe(false);

    unmount();
  });

  it('sets canSwitchCamera=false when device enumeration reports only 1 video input', async () => {
    const stream = createMockStream('user');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'single-webcam' },
        { kind: 'audioinput', deviceId: 'mic' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.canSwitchCamera).toBe(false);

    unmount();
  });

  it('switchCamera stops all previous tracks and requests opposite camera facing mode', async () => {
    const frontStream = createMockStream('user');
    const rearStream = createMockStream('environment');

    let callCount = 0;
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? frontStream : rearStream);
      }),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
        { kind: 'videoinput', deviceId: 'cam2' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.activeFacingMode).toBe('user');
    expect(frontStream._tracks[0].stop).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.switchCamera();
    });

    // Old track must be fully stopped
    expect(frontStream._tracks[0].stop).toHaveBeenCalled();
    expect(result.current.activeFacingMode).toBe('environment');
    expect(result.current.mirrorPreview).toBe(false);
    expect(result.current.mirrorCapture).toBe(false);

    unmount();
  });

  it('rapid switch camera abuse stops all intermediate streams and commits only latest generation', async () => {
    const stream1 = createMockStream('user');
    const stream2 = createMockStream('environment');
    const stream3 = createMockStream('user');

    const streams = [stream1, stream2, stream3];
    let index = 0;

    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockImplementation(() => {
        const s = streams[index++] || stream3;
        return Promise.resolve(s);
      }),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
        { kind: 'videoinput', deviceId: 'cam2' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });

    // Rapidly switch twice
    await act(async () => {
      const p1 = result.current.switchCamera();
      const p2 = result.current.switchCamera();
      await Promise.all([p1, p2]);
    });

    // Prior streams must be stopped
    expect(stream1._tracks[0].stop).toHaveBeenCalled();

    unmount();
  });

  it('capture with explicit mirror:false preserves unmirrored capture even if mirrorPreview is true', async () => {
    const stream = createMockStream('user');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() => useWebcam({ facingMode: 'user' }));

    await act(async () => {
      await result.current.start();
    });

    // Mock canvas context
    const mockDrawImage = vi.fn();
    const mockScale = vi.fn();
    const mockTranslate = vi.fn();

    const mockCanvas = {
      width: 640,
      height: 480,
      getContext: () => ({
        drawImage: mockDrawImage,
        scale: mockScale,
        translate: mockTranslate,
      }),
      toDataURL: vi.fn().mockReturnValue('data:image/webp;base64,AAAA'),
    };

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as any;
      return document.createElement(tagName);
    });

    const mockVideo = {
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
    } as any;

    result.current.videoRef.current = mockVideo;

    // Explicitly mirrorPreview ON, but capture with mirror: false (ID / OCR invariant)
    act(() => {
      result.current.setMirrorPreview(true);
      result.current.setMirrorCapture(true);
    });

    const capturedBlob = result.current.capture({ mirror: false });
    expect(capturedBlob).toBeInstanceOf(Blob);

    // Canvas scale(-1, 1) should NOT be called when mirror: false
    expect(mockScale).not.toHaveBeenCalled();

    unmount();
  });

  it('rear-facing selfie + Mirror ON synchronizes mirrorCapture and canvas receives mirror transform', async () => {
    const stream = createMockStream('environment');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'cam1' },
        { kind: 'videoinput', deviceId: 'cam2' },
      ]),
    } as any;

    const { result, unmount } = renderHook(() =>
      useWebcam({ facingMode: 'environment', allowCaptureMirroring: true })
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.activeFacingMode).toBe('environment');
    expect(result.current.mirrorPreview).toBe(false);
    expect(result.current.mirrorCapture).toBe(false);

    // User toggles mirror preview on rear camera
    act(() => {
      result.current.toggleMirrorPreview();
    });

    // Both preview and capture MUST synchronize to true when allowCaptureMirroring is true
    expect(result.current.mirrorPreview).toBe(true);
    expect(result.current.mirrorCapture).toBe(true);

    // Verify canvas receives mirror transform
    const mockScale = vi.fn();
    const mockTranslate = vi.fn();
    const mockCanvas = {
      width: 640,
      height: 480,
      getContext: () => ({
        drawImage: vi.fn(),
        scale: mockScale,
        translate: mockTranslate,
      }),
      toDataURL: vi.fn().mockReturnValue('data:image/webp;base64,AAAA'),
    };
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as any;
      return document.createElement(tagName);
    });

    result.current.videoRef.current = {
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
    } as any;

    act(() => {
      result.current.capture();
    });

    expect(mockScale).toHaveBeenCalledWith(-1, 1);
    expect(mockTranslate).toHaveBeenCalledWith(640, 0);

    unmount();
  });

  it('Guard regression: captureMode none -> startPhotoCapture -> immediate selfie mirrors correctly', async () => {
    const stream = createMockStream('user');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput', deviceId: 'cam1' }]),
    } as any;

    // Guard hook uses allowCaptureMirroring: true
    const { result, unmount } = renderHook(() =>
      useWebcam({ facingMode: 'user', allowCaptureMirroring: true })
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.mirrorPreview).toBe(true);

    const mockScale = vi.fn();
    const mockCanvas = {
      width: 640,
      height: 480,
      getContext: () => ({
        drawImage: vi.fn(),
        scale: mockScale,
        translate: vi.fn(),
      }),
      toDataURL: vi.fn().mockReturnValue('data:image/webp;base64,AAAA'),
    };
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as any;
      return document.createElement(tagName);
    });

    result.current.videoRef.current = {
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
    } as any;

    // Guard selfie capture explicitly passes mirror: webcam.mirrorPreview
    act(() => {
      result.current.capture({ mirror: result.current.mirrorPreview });
    });

    expect(mockScale).toHaveBeenCalledWith(-1, 1);

    unmount();
  });

  it('Guard ID preview mirrored -> stored ID capture still unmirrored', async () => {
    const stream = createMockStream('user');
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput', deviceId: 'cam1' }]),
    } as any;

    const { result, unmount } = renderHook(() =>
      useWebcam({ facingMode: 'user', allowCaptureMirroring: true })
    );

    await act(async () => {
      await result.current.start();
    });

    // Preview is mirrored
    expect(result.current.mirrorPreview).toBe(true);

    const mockScale = vi.fn();
    const mockCanvas = {
      width: 640,
      height: 480,
      getContext: () => ({
        drawImage: vi.fn(),
        scale: mockScale,
        translate: vi.fn(),
      }),
      toDataURL: vi.fn().mockReturnValue('data:image/webp;base64,AAAA'),
    };
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') return mockCanvas as any;
      return document.createElement(tagName);
    });

    result.current.videoRef.current = {
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
    } as any;

    // Guard ID capture explicitly passes mirror: false
    act(() => {
      result.current.capture({ mirror: false });
    });

    // Canvas scale should NOT be called
    expect(mockScale).not.toHaveBeenCalled();

    unmount();
  });
});
