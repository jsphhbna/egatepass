import { useRef, useState, useCallback, useEffect, useMemo } from 'react';

export interface UseWebcamOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  allowCaptureMirroring?: boolean;
  targetAspectRatio?: number;
}

export interface UseWebcamStartOptions {
  facingMode?: 'user' | 'environment';
}

export interface UseWebcamCaptureOptions {
  mirror?: boolean;
  targetAspectRatio?: number;
}

export interface UseWebcamResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  isStarting: boolean;
  error: string | null;
  activeFacingMode: 'user' | 'environment';
  mirrorPreview: boolean;
  mirrorCapture: boolean;
  canSwitchCamera: boolean;
  start: (startOptions?: UseWebcamStartOptions) => Promise<void>;
  stop: () => void;
  switchCamera: () => Promise<void>;
  setMirrorPreview: (mirror: boolean) => void;
  setMirrorCapture: (mirror: boolean) => void;
  toggleMirrorPreview: () => void;
  toggleMirrorCapture: () => void;
  capture: (options?: UseWebcamCaptureOptions) => Blob | null;
}

export function classifyCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Camera access was denied. Please allow camera permissions in your browser settings, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera was found on your device. Please ensure a camera is connected.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'The camera is currently in use by another application or tab. Please close other camera apps and try again.';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return 'The requested camera resolution or settings are not supported by your device camera.';
      case 'AbortError':
        return 'Camera access was aborted. Please try again.';
      default:
        return `Camera error (${err.name}): ${err.message || 'Unable to start camera'}.`;
    }
  }
  if (err instanceof Error) {
    return err.message || 'Failed to access camera. Please check your device.';
  }
  return 'Failed to access camera. Please check your device.';
}

export function useWebcam(options: UseWebcamOptions = {}): UseWebcamResult {
  const { facingMode = 'user', width = 640, height = 480, allowCaptureMirroring = true, targetAspectRatio } = options;
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const videoMountWaiters = useRef<Array<(el: HTMLVideoElement) => void>>([]);

  const videoRef = useMemo(() => {
    const fn = (node: HTMLVideoElement | null) => {
      videoElRef.current = node;
      if (node) {
        const waiters = [...videoMountWaiters.current];
        videoMountWaiters.current = [];
        waiters.forEach((cb) => cb(node));
      }
    };
    Object.defineProperty(fn, 'current', {
      get: () => videoElRef.current,
      set: (node: HTMLVideoElement | null) => {
        videoElRef.current = node;
        if (node) {
          const waiters = [...videoMountWaiters.current];
          videoMountWaiters.current = [];
          waiters.forEach((cb) => cb(node));
        }
      },
      configurable: true,
      enumerable: true,
    });
    return fn as unknown as React.RefObject<HTMLVideoElement | null>;
  }, []);

  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const [isStarting, setIsStarting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFacingMode, setActiveFacingMode] = useState<'user' | 'environment'>(facingMode);
  const [mirrorPreview, setMirrorPreviewState] = useState<boolean>(facingMode === 'user');
  const [mirrorCapture, setMirrorCaptureState] = useState<boolean>(facingMode === 'user' && allowCaptureMirroring);
  const [canSwitchCamera, setCanSwitchCamera] = useState<boolean>(false);

  const refreshDeviceCount = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((d) => d.kind === 'videoinput');
        setCanSwitchCamera(videoInputs.length > 1);
      } catch {
        // Ignore device enumeration errors
      }
    }
  }, []);

  const start = useCallback(async (startOptions?: UseWebcamStartOptions) => {
    if (isStartingRef.current || isActive) return;
    const generation = ++generationRef.current;
    isStartingRef.current = true;
    setIsStarting(true);
    setError(null);
    const targetFacingMode = startOptions?.facingMode ?? facingMode;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: targetFacingMode,
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      let video = videoRef.current;
      if (!video) {
        video = await new Promise<HTMLVideoElement | null>((resolve) => {
          const timer = setTimeout(() => {
            const idx = videoMountWaiters.current.indexOf(onMount);
            if (idx !== -1) videoMountWaiters.current.splice(idx, 1);
            resolve(null);
          }, 1500);
          const onMount = (el: HTMLVideoElement) => {
            clearTimeout(timer);
            resolve(el);
          };
          videoMountWaiters.current.push(onMount);
        });
      }

      if (!video) {
        throw new Error('No video element attached to webcam preview.');
      }

      video.srcObject = stream;

      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) return resolve();
        let settled = false;
        const onReady = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onError = (e: any) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e || new Error('Video failed to load stream data.'));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        };
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener('canplay', onReady, { once: true });
        video.addEventListener('error', onError, { once: true });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            if (video.readyState >= 2) {
              resolve();
            } else {
              reject(new Error('Video element timed out waiting for playable stream data.'));
            }
          }
        }, 3000);
      });

      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      await video.play();

      const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
      const track = tracks?.[0];
      if (!track || (track.readyState && track.readyState !== 'live')) {
        throw new Error('Camera stream track is not available.');
      }

      if (tracks) {
        tracks.forEach((t) => {
          t.onended = () => {
            if (mountedRef.current && generationRef.current === generation) {
              setError('Camera device was disconnected. Please reconnect your camera.');
              setIsActive(false);
            }
          };
        });
      }

      let realFacingMode: 'user' | 'environment' = targetFacingMode;
      if (track && typeof track.getSettings === 'function') {
        const settings = track.getSettings();
        if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
          realFacingMode = settings.facingMode;
        }
      }

      if (mountedRef.current && generation === generationRef.current) {
        setActiveFacingMode(realFacingMode);
        if (realFacingMode === 'user') {
          setMirrorPreviewState(true);
          setMirrorCaptureState(allowCaptureMirroring !== false);
        } else {
          setMirrorPreviewState(false);
          setMirrorCaptureState(false);
        }
        setIsActive(true);
        void refreshDeviceCount();
      }
    } catch (err) {
      if (!mountedRef.current || generation !== generationRef.current) {
        return;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setError(classifyCameraError(err));
      setIsActive(false);
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        isStartingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [facingMode, width, height, isActive, allowCaptureMirroring, refreshDeviceCount]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    isStartingRef.current = false;
    setIsStarting(false);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsActive(false);
  }, []);

  const switchCamera = useCallback(async () => {
    if (isStartingRef.current) return;
    const targetFacingMode: 'user' | 'environment' = activeFacingMode === 'user' ? 'environment' : 'user';
    const generation = ++generationRef.current;
    isStartingRef.current = true;
    setIsStarting(true);
    setError(null);

    // Stop all current tracks and clear srcObject before requesting new stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: targetFacingMode,
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      let video = videoRef.current;
      if (!video) {
        video = await new Promise<HTMLVideoElement | null>((resolve) => {
          const timer = setTimeout(() => {
            const idx = videoMountWaiters.current.indexOf(onMount);
            if (idx !== -1) videoMountWaiters.current.splice(idx, 1);
            resolve(null);
          }, 1500);
          const onMount = (el: HTMLVideoElement) => {
            clearTimeout(timer);
            resolve(el);
          };
          videoMountWaiters.current.push(onMount);
        });
      }

      if (!video) {
        throw new Error('No video element attached to webcam preview.');
      }

      video.srcObject = stream;

      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 2) return resolve();
        let settled = false;
        const onReady = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onError = (e: any) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(e || new Error('Video failed to load stream data.'));
        };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        };
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener('canplay', onReady, { once: true });
        video.addEventListener('error', onError, { once: true });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            if (video.readyState >= 2) {
              resolve();
            } else {
              reject(new Error('Video element timed out waiting for playable stream data.'));
            }
          }
        }, 3000);
      });

      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      await video.play();

      const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
      const track = tracks?.[0];
      if (!track || (track.readyState && track.readyState !== 'live')) {
        throw new Error('Camera stream track is not available.');
      }

      let realFacingMode: 'user' | 'environment' = targetFacingMode;
      if (track && typeof track.getSettings === 'function') {
        const settings = track.getSettings();
        if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
          realFacingMode = settings.facingMode;
        }
      }

      if (mountedRef.current && generation === generationRef.current) {
        setActiveFacingMode(realFacingMode);
        if (realFacingMode === 'user') {
          setMirrorPreviewState(true);
          setMirrorCaptureState(allowCaptureMirroring !== false);
        } else {
          setMirrorPreviewState(false);
          setMirrorCaptureState(false);
        }
        setIsActive(true);
        void refreshDeviceCount();
      }
    } catch (err) {
      if (!mountedRef.current || generation !== generationRef.current) {
        return;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setError(classifyCameraError(err));
      setIsActive(false);
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        isStartingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [activeFacingMode, width, height, allowCaptureMirroring, refreshDeviceCount]);

  const setMirrorPreview = useCallback((mirror: boolean) => {
    setMirrorPreviewState(mirror);
    if (allowCaptureMirroring) {
      setMirrorCaptureState(mirror);
    }
  }, [allowCaptureMirroring]);

  const setMirrorCapture = useCallback(
    (mirror: boolean) => {
      if (!allowCaptureMirroring) {
        setMirrorCaptureState(false);
        return;
      }
      setMirrorCaptureState(mirror);
    },
    [allowCaptureMirroring]
  );

  const toggleMirrorPreview = useCallback(() => {
    setMirrorPreviewState((prev) => {
      const next = !prev;
      if (allowCaptureMirroring) {
        setMirrorCaptureState(next);
      }
      return next;
    });
  }, [allowCaptureMirroring]);

  const toggleMirrorCapture = useCallback(() => {
    if (!allowCaptureMirroring) {
      setMirrorCaptureState(false);
      return;
    }
    setMirrorCaptureState((prev) => !prev);
  }, [allowCaptureMirroring]);

  const capture = useCallback(
    (captureOptions?: UseWebcamCaptureOptions): Blob | null => {
      const video = videoRef.current;
      if (!video || !isActive) return null;

      const videoW = video.videoWidth || width;
      const videoH = video.videoHeight || height;

      const effectiveTargetAspectRatio = captureOptions?.targetAspectRatio ?? targetAspectRatio;

      let cropX = 0;
      let cropY = 0;
      let cropW = videoW;
      let cropH = videoH;

      if (effectiveTargetAspectRatio && effectiveTargetAspectRatio > 0) {
        const streamRatio = videoW / Math.max(1, videoH);
        if (streamRatio > effectiveTargetAspectRatio) {
          // Stream is wider than target aspect ratio (crop horizontally, centered)
          cropW = Math.round(videoH * effectiveTargetAspectRatio);
          cropH = videoH;
          cropX = Math.round((videoW - cropW) / 2);
          cropY = 0;
        } else if (streamRatio < effectiveTargetAspectRatio) {
          // Stream is taller than target aspect ratio (crop vertically, centered)
          cropW = videoW;
          cropH = Math.round(videoW / effectiveTargetAspectRatio);
          cropX = 0;
          cropY = Math.round((videoH - cropH) / 2);
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;

      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const shouldMirror =
        captureOptions?.mirror !== undefined
          ? captureOptions.mirror
          : allowCaptureMirroring
            ? mirrorCapture
            : false;

      if (shouldMirror) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      // Convert to blob synchronously via dataURL for immediate use
      const dataUrl = canvas.toDataURL('image/webp', 0.85);
      const byteString = atob(dataUrl.split(',')[1]!);
      const mimeString = dataUrl.split(',')[0]!.split(':')[1]!.split(';')[0]!;
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      return new Blob([ab], { type: mimeString });
    },
    [isActive, mirrorCapture, allowCaptureMirroring, width, height, targetAspectRatio]
  );

  // Cleanup on unmount
  // Ensure media stream is safely attached when video element mounts or remounts
  useEffect(() => {
    if (isActive && streamRef.current && videoRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => undefined);
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      isStartingRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  return {
    videoRef,
    isActive,
    isStarting,
    error,
    activeFacingMode,
    mirrorPreview,
    mirrorCapture,
    canSwitchCamera,
    start,
    stop,
    switchCamera,
    setMirrorPreview,
    setMirrorCapture,
    toggleMirrorPreview,
    toggleMirrorCapture,
    capture,
  };
}
