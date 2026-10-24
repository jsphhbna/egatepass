import { useRef, useState, useCallback, useEffect } from 'react';

interface UseWebcamOptions {
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
}

export interface UseWebcamResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  isStarting: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  capture: () => Blob | null;
}

export function useWebcam(options: UseWebcamOptions = {}): UseWebcamResult {
  const { facingMode = 'user', width = 640, height = 480 } = options;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (isStartingRef.current || isActive) return;
    isStartingRef.current = true;
    setIsStarting(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: width },
          height: { ideal: height },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsActive(true);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera access in your browser settings.'
          : 'Failed to access camera. Please check your device.';
      setError(message);
      setIsActive(false);
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  }, [facingMode, width, height]);

  const stop = useCallback(() => {
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

  const capture = useCallback((): Blob | null => {
    const video = videoRef.current;
    if (!video || !isActive) return null;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Mirror for user-facing camera
    if (facingMode === 'user') {
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
  }, [isActive, facingMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isStartingRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return { videoRef, isActive, isStarting, error, start, stop, capture };
}
