import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getAccessToken, signOutCurrentActor } from '@/services/auth';
import { Html5Qrcode } from 'html5-qrcode';
import { LogOut as LogOutIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Clock3, QrCode, XCircle, AlertTriangle } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { createOptimizedQrScanner, enableContinuousFocus, QR_SCAN_CONFIG } from '@/lib/qrScanner';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { Modal, Button } from '@/components/ui';

type ScanStatus = 'ready' | 'processing' | 'pending' | 'warning' | 'error';

export function EntryScanPage() {
  const { userData } = useAuth();
  const [status, setStatus] = useState<ScanStatus>('ready');
  type CameraState = 'starting' | 'active' | 'permission_denied' | 'unavailable' | 'busy' | 'unsupported' | 'error';
  const [cameraState, setCameraState] = useState<CameraState>('starting');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Scan a QR code');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const debounceRef = useRef(false);
  const resetTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [scannerKey, setScannerKey] = useState(0);
  function retryCamera() {
    scannerRef.current?.stop().catch(() => undefined);
    scannerRef.current = null;
    setCameraState('starting');
    setCameraError(null);
    setScannerKey((k) => k + 1);
  }

  const device = userData?.kind === 'device' ? userData : null;
  const gate = device?.gate ?? 'Unknown Gate';

  const processQR = useCallback(async (passId: string) => {
    if (debounceRef.current) return;
    debounceRef.current = true;
    if ('vibrate' in navigator) navigator.vibrate(50);
    setStatus('processing');
    setStatusMessage('Verifying…');

    try {
      const token = await getAccessToken();
      const response = await fetch('/api/scan-pass', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ passId, mode: 'entry' }),
      });
      const result = await response.json().catch(() => null) as { code?: string; error?: string; message?: string } | null;
      if (!response.ok) {
        throw { code: result?.code || 'scan_failed', message: result?.error || 'Scan failed' };
      }
      setStatus('pending');
      setStatusMessage(result?.message || 'Scanned! Waiting for guard approval…');
      toast.success('Pass scanned — pending guard approval');
    } catch (error: unknown) {
      const scanError = error as { code?: string; message?: string };
      const message = scanError.message ?? 'Scan failed';
      const warningCodes = ['already_scanned', 'already_used', 'early'];
      setStatus(warningCodes.includes(scanError.code || '') ? 'warning' : 'error');
      setStatusMessage(message);
      toast.error(message);
    } finally {
      resetTimerRef.current = setTimeout(() => {
        setStatus('ready');
        setStatusMessage('Scan a QR code');
        debounceRef.current = false;
      }, 3000);
    }
  }, []);

  useEffect(() => {
    const scannerId = 'entry-qr-reader';
    let cancelled = false;
    const initTimer = setTimeout(async () => {
      try {
        const scanner = createOptimizedQrScanner(scannerId);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          QR_SCAN_CONFIG,
          (decodedText) => {
            if (!debounceRef.current) processQR(decodedText);
          },
          () => {},
        );
        if (cancelled) {
          await scanner.stop().catch(() => undefined);
          return;
        }
        setCameraState('active');
        setCameraError(null);
        await enableContinuousFocus(scanner);
      } catch (error: unknown) {
        console.error('QR scanner init error:', error);
        if (cancelled) return;
        setCameraState('error');
        const errName = typeof error === 'object' && error !== null && 'name' in error ? String((error as any).name) : '';
        const errMsg = typeof error === 'object' && error !== null && 'message' in error ? String((error as any).message) : String(error);
        
        if (errName === 'NotAllowedError' || errMsg.includes('Permission') || errMsg.includes('permission')) {
          setCameraError('Camera access denied. Please grant camera permission to scan gate passes.');
        } else if (errName === 'NotReadableError' || errMsg.includes('busy') || errMsg.includes('in use') || errMsg.includes('could not start')) {
          setCameraError('Camera is busy or in use by another application. Please close other camera apps and retry.');
        } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError' || errMsg.includes('found')) {
          setCameraError('No camera found on this device. Please connect a working camera.');
        } else if (errName === 'NotSupportedError' || errMsg.includes('secure context') || errMsg.includes('not supported')) {
          setCameraError('Camera scanning is not supported on this browser or insecure connection.');
        } else {
          setCameraError('Unable to start camera. Please verify device camera settings and retry.');
        }
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(initTimer);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      scannerRef.current?.stop().catch(() => undefined);
      scannerRef.current = null;
    };
  }, [processQR, scannerKey]);

  const statusConfig = {
    ready: { bg: 'var(--color-brand-dark)', icon: <QrCode className="h-8 w-8 text-white" /> },
    processing: {
      bg: 'var(--color-warning)',
      icon: <div className="h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />,
    },
    pending: { bg: 'var(--color-warning-dark)', icon: <Clock3 className="h-8 w-8 text-white" /> },
    warning: { bg: 'var(--color-warning-dark)', icon: <AlertTriangle className="h-8 w-8 text-white" /> },
    error: { bg: 'var(--color-danger)', icon: <XCircle className="h-8 w-8 text-white" /> },
  };
  const config = statusConfig[status];

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-scanner-canvas)] px-3 py-5 sm:px-6 sm:py-8">
      <div
        className="mb-5 cursor-default text-center"

      >
        <div className="mb-2 flex items-center justify-center gap-2">
          <BrandMark size="sm" />
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">Entry scanner</p>
        </div>
        <h1 className="text-xl font-extrabold text-white sm:text-2xl">{gate}</h1>
        <p className="mt-1 text-sm text-white/60">Present the visitor QR code to the camera</p>
      </div>

      <div className="scanner-viewport relative mb-5 overflow-hidden rounded-2xl border border-white/15 bg-black shadow-lg">
        <div id="entry-qr-reader" className="h-full w-full" />
        {cameraState !== 'active' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-4 text-center text-white space-y-3">
            {cameraState === 'starting' ? (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                <p className="text-sm font-medium">Starting camera...</p>
              </>
            ) : (
              <>
                <AlertCircle className="h-8 w-8 text-amber-400" />
                <p className="text-sm font-semibold text-white">{cameraError}</p>
                <p className="text-xs text-white/60">Check device camera permissions and refresh.</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={retryCamera}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  Retry Camera
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex min-h-16 w-[min(94vw,40rem)] items-center justify-center gap-3 rounded-xl px-5 py-3 text-center shadow-md sm:w-[min(94vw,64rem)]"
        style={{ backgroundColor: config.bg, borderRadius: 'var(--radius-lg)', transition: 'background-color 200ms ease' }}
      >
        {config.icon}
        <span className="text-base font-bold text-white sm:text-lg">{statusMessage}</span>
      </div>

      {!device && (
        <div className="mt-6 flex items-center gap-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] px-4 py-3 text-sm text-[var(--color-danger)]" role="alert">
          <AlertTriangle className="h-4 w-4" />
          Device not registered. Contact admin.
        </div>
      )}
      {/* Operator session button */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowSignOutConfirm(true)}
          className="inline-flex min-h-11 items-center gap-2 text-xs text-white/60 hover:text-white rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-white/40"
          aria-label="Device session options"
        >
          <LogOutIcon className="h-4 w-4" />
          <span>Device Session</span>
        </button>
      </div>

      <Modal
        isOpen={showSignOutConfirm}
        onClose={() => setShowSignOutConfirm(false)}
        title="Sign Out Scanner Device?"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Are you sure you want to sign out this entry scanner? A staff administrator will need to sign in again to activate the gate scanner.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowSignOutConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowSignOutConfirm(false);
                void signOutCurrentActor();
              }}
            >
              Sign Out Scanner
            </Button>
          </div>
        </div>
      </Modal>
    </main>
  );
}
