import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';
import { Html5Qrcode } from 'html5-qrcode';
import { toast } from 'sonner';
import { LogOut as LogOutIcon, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { Device } from '@/types';
import { createOptimizedQrScanner, enableContinuousFocus, QR_SCAN_CONFIG } from '@/lib/qrScanner';

type ScanStatus = 'ready' | 'processing' | 'success' | 'warning' | 'error';

export function ExitScanPage() {
  const { userData } = useAuth();
  const [status, setStatus] = useState<ScanStatus>('ready');
  const [statusMessage, setStatusMessage] = useState('Scan QR to exit');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const debounceRef = useRef(false);
  const resetTimerRef = useRef<NodeJS.Timeout | null>(null);

  const device = userData as Device | null;
  const gate = device?.gate ?? 'Unknown Gate';

  const processQR = useCallback(async (passId: string) => {
    if (debounceRef.current) return;
    debounceRef.current = true;
    if ('vibrate' in navigator) navigator.vibrate(50);
    setStatus('processing');
    setStatusMessage('Verifying…');

    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw { code: 'unauthorized', message: 'Device session has expired' };
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
  }, [processQR]);

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
          if (window.confirm('Admin: Sign out of this scanner?')) auth.signOut();
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
    </main>
  );
}
