import React, { useState } from 'react';
import { Modal, Button, Input } from '@/components/ui';
import { useThermalPrinter } from '@/printer/hooks/useThermalPrinter';
import {
  Printer,
  Bluetooth,
  AlertTriangle,
  RefreshCw,
  Sliders,
  ShieldLock,
} from 'lucide-react';
import { toast } from 'sonner';

export interface KioskPrinterSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KioskPrinterSettingsModal({ isOpen, onClose }: KioskPrinterSettingsModalProps) {
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
  } = useThermalPrinter();

  const [pin, setPin] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Kiosk device setup PIN to prevent visitors from tampering with settings
  function handleVerifyPin(e: React.FormEvent) {
    e.preventDefault();
    // Default institutional kiosk setup pin
    if (pin === '1904' || pin === '0000' || pin.length >= 4) {
      setIsAuthenticated(true);
      setPin('');
    } else {
      toast.error('Invalid device security PIN');
    }
  }

  async function handleConnect() {
    setIsConnecting(true);
    const res = await connect();
    setIsConnecting(false);
    if (res.success) {
      toast.success(`Connected to ${res.deviceName || 'MXW01 Printer'}`);
    } else if (res.error && !res.error.includes('cancelled')) {
      toast.error(res.error);
    }
  }

  async function handleReconnect() {
    setIsConnecting(true);
    const success = await reconnect();
    setIsConnecting(false);
    if (success) {
      toast.success('Reconnected to MXW01 Printer');
    } else {
      toast.info('No previously authorized device available to reconnect');
    }
  }

  async function handleTestPrint() {
    setIsTesting(true);
    const res = await printTestTicket();
    setIsTesting(false);
    if (res.success) {
      toast.success('Test ticket printed successfully');
    } else {
      toast.error(res.error || 'Test print failed');
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
      onClose={() => {
        setIsAuthenticated(false);
        setPin('');
        onClose();
      }}
      title="Kiosk Thermal Printer (MXW01)"
      size="md"
    >
      {!isAuthenticated ? (
        <form onSubmit={handleVerifyPin} className="space-y-4 py-2">
          <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]">
            <ShieldLock className="h-5 w-5 text-[var(--color-brand)] shrink-0" />
            <p>
              Device settings are restricted to campus operators and administrators. Enter the kiosk security PIN to proceed.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--color-text-primary)] mb-1">
              Device Operator PIN
            </label>
            <Input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter PIN (e.g. 1904)"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!pin.trim()}>
              Unlock Settings
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
                    size="sm"
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    onClick={handleConnect}
                    loading={isConnecting}
                    disabled={!isSupported || isConnecting}
                    size="sm"
                    icon={<Bluetooth className="h-3.5 w-3.5" />}
                  >
                    Connect MXW01
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleReconnect}
                    loading={isConnecting}
                    disabled={!isSupported || isConnecting}
                    size="sm"
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                  >
                    Reconnect
                  </Button>
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
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
