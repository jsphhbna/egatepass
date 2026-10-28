import { useRef, useState, useCallback, useEffect } from 'react';

export interface UseWebcamOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  allowCaptureMirroring?: boolean;
}

export interface UseWebcamStartOptions {
  facingMode?: 'user' | 'environment';
}

export interface UseWebcamCaptureOptions {
  mirror?: boolean;
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

export function useWebcam(options: UseWebcamOptions = {}): UseWebcamResult {
  const { facingMode = 'user', width = 640, height = 480, allowCaptureMirroring = true } = options;
  const videoRef = useRef<HTMLVideoElement>(null);
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

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }

      const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
      const track = tracks?.[0];
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
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow camera access in your browser settings, then try again.'
          : 'Failed to access camera. Please check your device.';
      setError(message);
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

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }

      const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
      const track = tracks?.[0];
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
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera access was denied. Allow camera access in your browser settings, then try again.'
          : 'Failed to switch camera. Please check your device.';
      setError(message);
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
  }, []);

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
      if (allowCaptureMirroring && activeFacingMode === 'user') {
        setMirrorCaptureState(next);
      }
      return next;
    });
  }, [allowCaptureMirroring, activeFacingMode]);

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

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || width;
      canvas.height = video.videoHeight || height;

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

      ctx.drawImage(video, 0, 0);

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
    [isActive, mirrorCapture, allowCaptureMirroring, width, height]
  );

  // Cleanup on unmount
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
