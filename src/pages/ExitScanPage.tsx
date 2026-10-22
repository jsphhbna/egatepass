import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getAccessToken, signOutCurrentActor } from '@/services/auth';
import { Html5Qrcode } from 'html5-qrcode';
import { toast } from 'sonner';
import { LogOut as LogOutIcon, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { createOptimizedQrScanner, enableContinuousFocus, QR_SCAN_CONFIG } from '@/lib/qrScanner';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { Modal, Button } from '@/components/ui';

type ScanStatus = 'ready' | 'processing' | 'success' | 'warning' | 'error';

export function ExitScanPage() {
  const { userData } = useAuth();
  const [status, setStatus] = useState<ScanStatus>('ready');
  type CameraState = 'starting' | 'active' | 'permission_denied' | 'unavailable' | 'busy' | 'unsupported' | 'error';
  const [cameraState, setCameraState] = useState<CameraState>('starting');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Scan QR to exit');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const debounceRef = useRef(false);
  const resetTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [scannerKey, setScannerKey] = useState(0);
  function retryCamera() {
    setCameraState('starting');
    setCameraError(null);
    setScannerKey(k => k + 1);
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
        body: JSON.stringify({ passId, mode: 'exit' }),
      });
      const result = await response.json().catch(() => null) as { code?: string; error?: string; message?: string } | null;
      if (!response.ok) {
        throw { code: result?.code || 'scan_failed', message: result?.error || 'Scan failed' };
      }
      setStatus('success');
      setStatusMessage(result?.message || 'Exit recorded. Goodbye!');
      toast.success('Exit recorded successfully');
    } catch (error: unknown) {
      const scanError = error as { code?: string; message?: string };
      const message = scanError.message ?? 'Scan failed';
      const warningCodes = ['not_entered', 'pending', 'already_exited'];
      setStatus(warningCodes.includes(scanError.code || '') ? 'warning' : 'error');
      setStatusMessage(message);
      toast.error(message);
    } finally {
      resetTimerRef.current = setTimeout(() => {
        setStatus('ready');
        setStatusMessage('Scan QR to exit');
        debounceRef.current = false;
      }, 3000);
    }
  }, []);

  useEffect(() => {
    const scannerId = 'exit-qr-reader';
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
        await enableContinuousFocus(scanner);
      } catch (error) {
        console.error('QR scanner init error:', error);
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
    ready: { bg: 'var(--color-brand-dark)', icon: <LogOutIcon className="h-8 w-8 text-white" /> },
    processing: {
      bg: 'var(--color-warning)',
      icon: <div className="h-8 w-8 animate-spin rounded-full border-3 border-white border-t-transparent" />,
    },
    success: { bg: 'var(--color-success)', icon: <CheckCircle2 className="h-8 w-8 text-white" /> },
    warning: { bg: 'var(--color-warning-dark)', icon: <AlertTriangle className="h-8 w-8 text-white" /> },
    error: { bg: 'var(--color-danger)', icon: <XCircle className="h-8 w-8 text-white" /> },
  };
  const config = statusConfig[status];

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-scanner-canvas)] px-3 py-5 sm:px-6 sm:py-8">
      <div
        className="mb-5 cursor-default text-center"
        onDoubleClick={() => {
          if (window.confirm('Admin: Sign out of this scanner?')) void signOutCurrentActor();
        }}
      >
        <div className="mb-2 inline-flex rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-1">
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-[var(--color-accent)]">Exit scanner</p>
        </div>
        <h1 className="text-xl font-extrabold text-white sm:text-2xl">{gate}</h1>
        <p className="mt-1 text-sm text-white/60">Scan the visitor pass to record departure</p>
      </div>

      <div className="scanner-viewport relative mb-5 overflow-hidden rounded-2xl border border-[var(--color-accent)]/30 bg-black shadow-lg">
        <div id="exit-qr-reader" className="h-full w-full" />
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
          className="inline-flex items-center gap-1.5 text-xs text-white/50 hover:text-white rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-white/40"
          aria-label="Device session options"
        >
          <LogOutIcon className="h-3.5 w-3.5" />
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
            Are you sure you want to sign out this exit scanner? A staff administrator will need to sign in again to activate the gate scanner.
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
