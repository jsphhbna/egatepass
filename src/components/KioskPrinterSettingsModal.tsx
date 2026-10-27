import React, { useState, useEffect, useRef } from 'react';
import { Modal, Button, Input } from '@/components/ui';
import type { ThermalPrinterController } from '@/printer/hooks/useThermalPrinter';
import {
  Printer,
  Bluetooth,
  AlertTriangle,
  RefreshCw,
  Sliders,
  ShieldLock,
} from 'lucide-react';
import { requireSupabase } from '@/lib/supabase';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';
import { toast } from 'sonner';

export interface KioskPrinterSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  printer: ThermalPrinterController;
}

const UNLOCK_TIMEOUT_MS = 15 * 60 * 1000; // 15-minute maximum unlock duration

export function getKioskReauthErrorMessage(status: number, errorCode?: string | null): string {
  if (status === 401) {
    if (errorCode === 'invalid_session' || errorCode === 'authentication_required') {
      return 'Kiosk session expired. Please sign in to the kiosk again.';
    }
    return 'Invalid kiosk device password.';
  }
  if (status === 403) {
    return 'Access denied: Kiosk device account required';
  }
  if (status >= 500) {
    return 'Printer settings could not be unlocked due to a server error.';
  }
  return 'Reauthentication failed';
}

export function KioskPrinterSettingsModal({ isOpen, onClose, printer }: KioskPrinterSettingsModalProps) {
  const {
    isSupported,
    status,
    deviceName,
    lastError,
    config,
    connect,
    reconnect,
    disconnect,
    updateConfig,
    printTestTicket,
  } = printer;

  const [password, setPassword] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [unlockExpiresAt, setUnlockExpiresAt] = useState<number | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [connectionAction, setConnectionAction] = useState<'connect' | 'reconnect' | null>(null);

  const isConnecting = connectionAction !== null || status === 'connecting';

  const reauthGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 15-minute automatic relock timer (memory-only, cleared on timeout/close/reload/logout)
  useEffect(() => {
    if (!isAuthenticated || !unlockExpiresAt) return;

    const remaining = unlockExpiresAt - Date.now();
    if (remaining <= 0) {
      setIsAuthenticated(false);
      setPassword('');
      setUnlockExpiresAt(null);
      return;
    }

    const timer = setTimeout(() => {
      setIsAuthenticated(false);
      setPassword('');
      setUnlockExpiresAt(null);
      toast.info('Printer settings timed out and were relocked');
    }, remaining);

    return () => clearTimeout(timer);
  }, [isAuthenticated, unlockExpiresAt]);

  // Relock immediately if modal is closed
  useEffect(() => {
    if (!isOpen) {
      reauthGenerationRef.current += 1;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setIsAuthenticated(false);
      setPassword('');
      setUnlockExpiresAt(null);
      setIsAuthenticating(false);
    }
  }, [isOpen]);

  function handleCloseModal() {
    reauthGenerationRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsAuthenticated(false);
    setPassword('');
    setUnlockExpiresAt(null);
    setIsAuthenticating(false);
    onClose();
  }

  // Kiosk device password re-authentication via trusted server endpoint with generation fencing and timeout
  async function handleReauthenticate(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      toast.error('Kiosk device password is required');
      return;
    }

    const generation = ++reauthGenerationRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsAuthenticating(true);
    try {
      const client = requireSupabase();
      const sessionRes = await client.auth.getSession();
      const token = sessionRes.data.session?.access_token;
      if (!token) {
        if (generation === reauthGenerationRef.current) {
          toast.error('Kiosk session expired. Please sign in to the kiosk again.');
        }
        return;
      }

      const res = await fetchWithTimeout(
        '/api/device/reauthenticate',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ password }),
          signal: controller.signal,
        },
        10000
      );

      if (generation !== reauthGenerationRef.current) {
        // Modal was closed or a newer request began
        return;
      }

      if (res.ok) {
        setIsAuthenticated(true);
        setUnlockExpiresAt(Date.now() + UNLOCK_TIMEOUT_MS);
        setPassword('');
        toast.success('Printer settings unlocked');
      } else {
        const errData = await res.json().catch(() => null);
        const message = getKioskReauthErrorMessage(res.status, errData?.error);
        toast.error(message);
      }
    } catch (err: unknown) {
      if (generation !== reauthGenerationRef.current) {
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      toast.error('Reauthentication request failed. Please check network connectivity.');
    } finally {
      if (generation === reauthGenerationRef.current) {
        setIsAuthenticating(false);
        abortControllerRef.current = null;
      }
    }
  }

  async function handleConnect() {
    setConnectionAction('connect');
    try {
      const res = await connect();
      if (res.success) {
        toast.success(`Connected to ${res.deviceName || 'MXW01 Printer'}`);
      } else if (res.error && !res.error.includes('cancelled')) {
        toast.error(res.error);
      }
    } finally {
      setConnectionAction(null);
    }
  }

  async function handleReconnect() {
    setConnectionAction('reconnect');
    try {
      const res = await reconnect();
      if (res.outcome === 'success') {
        toast.success(`Reconnected to ${res.deviceName || 'MXW01 Printer'}`);
      } else if (res.outcome === 'no_authorized_device') {
        toast.info(res.error || 'Previously authorized MXW01 was not found. Choose the printer again.');
      } else if (res.outcome === 'connection_failed') {
        toast.error(res.error || 'MXW01 was found, but connection failed. Make sure the printer is powered on and nearby.');
      } else if (res.outcome === 'busy') {
        toast.info(res.error || 'Connection already in progress.');
      } else if (res.outcome === 'unsupported') {
        toast.error(res.error || 'Web Bluetooth is not supported on this device.');
      }
    } finally {
      setConnectionAction(null);
    }
  }

  async function handleTestPrint() {
    setIsTesting(true);
    try {
      const res = await printTestTicket();
      if (res.success) {
        toast.success('Test ticket printed successfully');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test print failed';
      toast.error(message);
    } finally {
      setIsTesting(false);
    }
  }

  const statusBadge = {
    connected: { label: 'Connected', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
    connecting: { label: 'Connecting…', color: 'bg-blue-100 text-blue-800 border-blue-300' },
    printing: { label: 'Printing…', color: 'bg-amber-100 text-amber-800 border-amber-300' },
    error: { label: 'Error', color: 'bg-rose-100 text-rose-800 border-rose-300' },
    disconnected: { label: 'Disconnected', color: 'bg-zinc-100 text-zinc-700 border-zinc-300' },
  }[status];

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCloseModal}
      title="Kiosk Thermal Printer (MXW01)"
      size="md"
    >
      {!isAuthenticated ? (
        <form onSubmit={handleReauthenticate} className="space-y-4 py-2">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]">
            <ShieldLock className="h-5 w-5 text-[var(--color-brand)] shrink-0" />
            <p>
              Re-enter this kiosk device's password to manage printer settings.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--color-text-primary)] mb-1">
              Kiosk Device Password
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter kiosk device password"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={handleCloseModal} disabled={isAuthenticating}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || isAuthenticating}>
              {isAuthenticating ? 'Verifying…' : 'Unlock Settings'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-6 py-2">
          {/* Hardware Capability Status */}
          {!isSupported && (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
              <div>
                <p className="font-semibold">Web Bluetooth Unavailable</p>
                <p className="mt-0.5 leading-relaxed">
                  This browser does not support Web Bluetooth. The kiosk will automatically fall back to standard browser printing.
                </p>
              </div>
            </div>
          )}

          {/* Connection Card */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Printer className="h-5 w-5 text-[var(--color-brand)]" />
                <span className="font-bold text-sm text-[var(--color-text-primary)]">
                  {deviceName || 'MXW01 Thermal Printer'}
                </span>
              </div>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${statusBadge.color}`}
              >
                {statusBadge.label}
              </span>
            </div>

            {lastError && status === 'error' && (
              <p className="text-xs text-rose-600 bg-rose-50 p-2 rounded-md border border-rose-100">
                {lastError}
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {status === 'connected' ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestPrint}
                    loading={isTesting}
                    disabled={isTesting}
                    size="sm"
                    icon={<Printer className="h-3.5 w-3.5" />}
                  >
                    Test Print
                  </Button>
                  <Button
                    type="button"
                    variant="destructive-outline"
                    onClick={disconnect}
                    disabled={isTesting}
                    size="sm"
                  >
                    Disconnect
                  </Button>
                </>
              ) : status === 'printing' ? (
                <span className="text-xs text-[var(--color-text-secondary)] italic self-center">
                  Printing…
                </span>
              ) : status === 'connecting' ? (
                <Button
                  type="button"
                  disabled
                  loading
                  size="sm"
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  Connecting…
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    onClick={handleConnect}
                    loading={connectionAction === 'connect'}
                    disabled={!isSupported || isConnecting}
                    size="sm"
                    icon={<Bluetooth className="h-3.5 w-3.5" />}
                  >
                    {config.lastDeviceId ? 'Choose Another Printer' : 'Connect MXW01'}
                  </Button>
                  {config.lastDeviceId && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleReconnect}
                      loading={connectionAction === 'reconnect'}
                      disabled={!isSupported || isConnecting}
                      size="sm"
                      icon={<RefreshCw className="h-3.5 w-3.5" />}
                    >
                      Reconnect MXW01
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Printer Preferences */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] flex items-center gap-1.5">
              <Sliders className="h-3.5 w-3.5" />
              Print Automation & Density
            </h4>

            {/* Auto Print Toggle */}
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] p-3">
              <div>
                <p className="text-xs font-semibold text-[var(--color-text-primary)]">
                  Auto-Print on Issuance
                </p>
                <p className="text-[11px] text-[var(--color-text-secondary)]">
                  Automatically trigger thermal pass print immediately after visitor registration succeeds.
                </p>
              </div>
              <input
                type="checkbox"
                checked={config.autoPrint}
                onChange={(e) => updateConfig({ autoPrint: e.target.checked })}
                className="h-4 w-4 rounded text-[var(--color-brand)] focus:ring-[var(--color-brand)] cursor-pointer"
              />
            </div>

            {/* Print Intensity / Darkness Slider */}
            <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-[var(--color-text-primary)]">
                  Print Density / Darkness
                </label>
                <span className="text-xs font-mono font-bold text-[var(--color-brand)]">
                  {config.intensity}%
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                value={config.intensity}
                onChange={(e) => updateConfig({ intensity: Number(e.target.value) })}
                className="w-full accent-[var(--color-brand)] cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-[var(--color-text-muted)]">
                <span>Standard (50%)</span>
                <span>Recommended (93%)</span>
                <span>Maximum (100%)</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button type="button" onClick={handleCloseModal}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
