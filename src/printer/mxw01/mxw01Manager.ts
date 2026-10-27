import { ThermalPrinterClient, WebBluetoothAdapter, type PrinterImageData } from 'mxw01-thermal-printer';
import type { PassPresentation } from '@/lib/passPresentation';
import type { ThermalTemplateLayout } from '@/types/thermalTemplate';
import { renderThermalPass, renderTestTicket } from '../renderer/thermalRenderer';

export type PrinterConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'printing' | 'error';

export interface PrinterDeviceTelemetry {
  id?: string;
  name?: string;
  intensity: number;
  autoPrint: boolean;
}

const SETTINGS_STORAGE_KEY = 'egatepass_kiosk_printer_config';

export interface StoredPrinterConfig {
  autoPrint: boolean;
  intensity: number;
  lastDeviceId?: string;
  lastDeviceName?: string;
}

export class MXW01Manager {
  private static instance: MXW01Manager | null = null;
  private client: ThermalPrinterClient | null = null;
  private adapter: WebBluetoothAdapter | null = null;
  private status: PrinterConnectionStatus = 'disconnected';
  private statusListeners = new Set<(status: PrinterConnectionStatus, error?: string | null) => void>();
  private activeDeviceName: string | null = null;
  private lastError: string | null = null;

  private config: StoredPrinterConfig = {
    autoPrint: true,
    intensity: 93,
  };

  private constructor() {
    this.loadConfig();
  }

  public static getInstance(): MXW01Manager {
    if (!MXW01Manager.instance) {
      MXW01Manager.instance = new MXW01Manager();
    }
    return MXW01Manager.instance;
  }

  public isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'bluetooth' in navigator &&
      typeof (navigator as any).bluetooth?.requestDevice === 'function'
    );
  }

  public getStatus(): PrinterConnectionStatus {
    return this.status;
  }

  public getDeviceName(): string | null {
    return this.activeDeviceName;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getConfig(): StoredPrinterConfig {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<StoredPrinterConfig>) {
    this.config = { ...this.config, ...partial };
    this.saveConfig();
  }

  public isConnected(): boolean {
    return this.status === 'connected';
  }

  public isAutoPrintEnabled(): boolean {
    return this.config.autoPrint;
  }

  public setAutoPrint(enabled: boolean) {
    this.updateConfig({ autoPrint: enabled });
  }

  public getPrintIntensity(): number {
    return this.config.intensity;
  }

  public setPrintIntensity(val: number) {
    this.updateConfig({ intensity: Math.min(100, Math.max(1, val)) });
  }

  public subscribe(listener: (status: PrinterConnectionStatus, error?: string | null) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.lastError);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notify(status: PrinterConnectionStatus, error: string | null = null) {
    this.status = status;
    this.lastError = error;
    this.statusListeners.forEach((l) => l(status, error));
  }

  private loadConfig() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.config = {
          autoPrint: typeof parsed.autoPrint === 'boolean' ? parsed.autoPrint : true,
          intensity: typeof parsed.intensity === 'number' ? parsed.intensity : 93,
          lastDeviceId: parsed.lastDeviceId,
          lastDeviceName: parsed.lastDeviceName,
        };
      }
    } catch {
      // Fallback to defaults
    }
  }

  private saveConfig() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.config));
    } catch {
      // Ignore storage write issues
    }
  }

  /**
   * User-initiated Bluetooth device picker connection (Phase 2.4).
   */
  public async connect(): Promise<{ success: boolean; deviceName?: string; error?: string }> {
    if (!this.isSupported()) {
      const err = 'Web Bluetooth is not supported on this browser or platform.';
      this.notify('error', err);
      return { success: false, error: err };
    }

    this.notify('connecting');

    try {
      this.adapter = new WebBluetoothAdapter();
      this.client = new ThermalPrinterClient(this.adapter);

      await this.client.connect();

      this.activeDeviceName = (this.adapter as any).device?.name || 'MXW01 Thermal Printer';
      this.updateConfig({
        lastDeviceId: (this.adapter as any).device?.id,
        lastDeviceName: this.activeDeviceName || undefined,
      });

      this.registerClientLifecycle(this.client);

      this.notify('connected');
      return { success: true, deviceName: this.activeDeviceName || undefined };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.notify('disconnected', errMsg.includes('User cancelled') ? null : errMsg);
      return { success: false, error: errMsg };
    }
  }

  private registerClientLifecycle(client: ThermalPrinterClient): void {
    client.on('disconnected', () => {
      this.activeDeviceName = null;
      this.client = null;
      this.adapter = null;
      this.notify('disconnected');
    });
  }

  /**
   * Safe reconnection using navigator.bluetooth.getDevices() if supported (Phase 2.4).
   */
  public async reconnect(): Promise<boolean> {
    if (!this.isSupported()) return false;
    if (this.status === 'connected') return true;

    // Check if browser supports getDevices()
    if (typeof (navigator as any).bluetooth?.getDevices === 'function') {
      try {
        const devices = await (navigator as any).bluetooth.getDevices();
        if (Array.isArray(devices) && devices.length > 0) {
          const target = this.config.lastDeviceId
            ? devices.find((d: any) => d.id === this.config.lastDeviceId)
            : devices[0];

          if (target) {
            this.notify('connecting');
            this.adapter = new WebBluetoothAdapter();
            (this.adapter as any).device = target;
            this.client = new ThermalPrinterClient(this.adapter);
            await this.client.connect();
            this.registerClientLifecycle(this.client);
            this.activeDeviceName = target.name || 'MXW01 Printer';
            this.notify('connected');
            return true;
          }
        }
      } catch {
        // Fall back to clean disconnected state
      }
    }

    return false;
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // Safe disconnect ignore
      }
      this.client = null;
      this.adapter = null;
    }
    this.activeDeviceName = null;
    this.notify('disconnected');
  }

  /**
   * Print an authoritative pass to MXW01 (Phase 2.6 & 2.7).
   * Critical Invariant: Printer failure must never roll back pass issuance.
   */
  public async printPass(
    presentation: PassPresentation,
    layout?: ThermalTemplateLayout
  ): Promise<{ success: boolean; error?: string; fallbackNeeded?: boolean }> {
    if (this.status !== 'connected' || !this.client) {
      return {
        success: false,
        error: 'MXW01 printer is not connected. Use browser print or connect printer.',
        fallbackNeeded: true,
      };
    }

    this.notify('printing');

    try {
      const { imageData } = await renderThermalPass(presentation, layout);

      const printerImageData: PrinterImageData = {
        data: imageData.data,
        width: imageData.width,
        height: imageData.height,
      };

      await this.client.print(printerImageData, {
        dither: 'threshold', // Hard black/white for crisp QR readability
        brightness: 128,
        intensity: this.config.intensity,
      });

      this.notify('connected');
      return { success: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Printing failed.';
      this.notify('error', errMsg);
      return { success: false, error: errMsg, fallbackNeeded: true };
    }
  }

  /**
   * Prints hardware self-test ticket.
   */
  public async printTestTicket(): Promise<{ success: boolean; error?: string }> {
    if (this.status !== 'connected' || !this.client) {
      return { success: false, error: 'Printer is not connected.' };
    }

    this.notify('printing');

    try {
      const { imageData } = await renderTestTicket(this.activeDeviceName || 'MXW01');

      const printerImageData: PrinterImageData = {
        data: imageData.data,
        width: imageData.width,
        height: imageData.height,
      };

      await this.client.print(printerImageData, {
        dither: 'threshold',
        brightness: 128,
        intensity: this.config.intensity,
      });

      this.notify('connected');
      return { success: true };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Test print failed.';
      this.notify('error', errMsg);
      return { success: false, error: errMsg };
    }
  }
}

export const mxw01PrinterManager = MXW01Manager.getInstance();
