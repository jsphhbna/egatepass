import {
  ThermalPrinterClient,
  WebBluetoothAdapter,
  type BluetoothAdapter,
  type BluetoothConnection,
  type BluetoothServiceInfo,
  type BluetoothCharacteristic,
  type BluetoothDevice as MXW01BluetoothDevice,
  type PrinterImageData,
} from 'mxw01-thermal-printer';
import type { PassPresentation } from '@/lib/passPresentation';
import type { ThermalTemplateLayout } from '@/types/thermalTemplate';
import { renderThermalPass, renderTestTicket } from '../renderer/thermalRenderer';

export type PrinterConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'printing' | 'error';

export type ReconnectOutcome =
  | 'success'
  | 'unsupported'
  | 'no_authorized_device'
  | 'connection_failed'
  | 'busy';

export interface ReconnectResult {
  outcome: ReconnectOutcome;
  deviceName?: string;
  error?: string;
}

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

export const MXW01_SERVICES = {
  PRIMARY: '0000ae30-0000-1000-8000-00805f9b34fb',
  ALTERNATE: '0000af30-0000-1000-8000-00805f9b34fb',
  CONTROL: '0000ae01-0000-1000-8000-00805f9b34fb',
  NOTIFY: '0000ae02-0000-1000-8000-00805f9b34fb',
  DATA: '0000ae03-0000-1000-8000-00805f9b34fb',
};

class WebBluetoothCharacteristicWrapper implements BluetoothCharacteristic {
  constructor(private characteristic: any) {}

  async writeValueWithoutResponse(data: BufferSource): Promise<void> {
    await this.characteristic.writeValueWithoutResponse(data);
  }

  async startNotifications(): Promise<void> {
    await this.characteristic.startNotifications();
  }

  async stopNotifications(): Promise<void> {
    await this.characteristic.stopNotifications();
  }

  addEventListener(event: string, callback: (event: any) => void): void {
    this.characteristic.addEventListener(event, callback);
  }

  removeEventListener(event: string, callback: (event: any) => void): void {
    this.characteristic.removeEventListener(event, callback);
  }
}

export class PreAuthorizedWebBluetoothAdapter implements BluetoothAdapter {
  private nativeDevice: any;
  private server: any = null;

  constructor(nativeDevice: any) {
    this.nativeDevice = nativeDevice;
  }

  isAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  async requestDevice(): Promise<MXW01BluetoothDevice> {
    return {
      id: this.nativeDevice.id,
      name: this.nativeDevice.name,
    };
  }

  async connect(device: MXW01BluetoothDevice): Promise<BluetoothConnection & BluetoothServiceInfo> {
    if (!this.nativeDevice || this.nativeDevice.id !== device.id) {
      throw new Error('Device not found. Please request device first.');
    }

    const gatt = this.nativeDevice.gatt;
    if (!gatt) {
      throw new Error('GATT not available on device');
    }

    this.server = await gatt.connect();
    if (!this.server) {
      throw new Error('Failed to connect to GATT server');
    }

    let primaryService: any;
    try {
      primaryService = await this.server.getPrimaryService(MXW01_SERVICES.PRIMARY);
    } catch {
      primaryService = await this.server.getPrimaryService(MXW01_SERVICES.ALTERNATE);
    }

    const [controlChar, notifyChar, dataChar] = await Promise.all([
      primaryService.getCharacteristic(MXW01_SERVICES.CONTROL),
      primaryService.getCharacteristic(MXW01_SERVICES.NOTIFY),
      primaryService.getCharacteristic(MXW01_SERVICES.DATA),
    ]);

    return {
      device,
      disconnect: async () => {
        if (this.server?.connected) {
          this.server.disconnect();
        }
        this.server = null;
      },
      controlCharacteristic: new WebBluetoothCharacteristicWrapper(controlChar),
      notifyCharacteristic: new WebBluetoothCharacteristicWrapper(notifyChar),
      dataCharacteristic: new WebBluetoothCharacteristicWrapper(dataChar),
    };
  }
}

export class MXW01Manager {
  private static instance: MXW01Manager | null = null;
  private client: ThermalPrinterClient | null = null;
  private adapter: any | null = null;
  private status: PrinterConnectionStatus = 'disconnected';
  private statusListeners = new Set<(status: PrinterConnectionStatus, error?: string | null) => void>();
  private activeDeviceName: string | null = null;
  private lastError: string | null = null;

  private inFlightConnection: Promise<any> | null = null;
  private activeNativeDevice: any | null = null;
  private nativeDisconnectHandler: (() => void) | null = null;
  private connectionGeneration: number = 0;

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

  public getAdapter(): any | null {
    return this.adapter;
  }

  public getActiveNativeDevice(): any | null {
    return this.activeNativeDevice;
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

  private setupPhysicalDisconnectListener(nativeDevice: any): void {
    this.teardownPhysicalDisconnectListener();

    const currentGen = ++this.connectionGeneration;
    this.activeNativeDevice = nativeDevice;

    const onGattDisconnected = () => {
      if (this.connectionGeneration !== currentGen) return;

      console.warn('[MXW01] Physical Bluetooth disconnect detected (gattserverdisconnected)');
      this.cleanupConnection();
      this.notify('disconnected');
    };

    if (typeof nativeDevice?.addEventListener === 'function') {
      nativeDevice.addEventListener('gattserverdisconnected', onGattDisconnected);
      this.nativeDisconnectHandler = () => {
        try {
          nativeDevice.removeEventListener('gattserverdisconnected', onGattDisconnected);
        } catch {
          // Safe ignore
        }
      };
    }
  }

  private teardownPhysicalDisconnectListener(): void {
    this.connectionGeneration++;
    if (this.nativeDisconnectHandler) {
      this.nativeDisconnectHandler();
      this.nativeDisconnectHandler = null;
    }
    this.activeNativeDevice = null;
  }

  private cleanupConnection(): void {
    this.activeDeviceName = null;
    const clientToDispose = this.client;
    this.client = null;
    this.adapter = null;
    this.activeNativeDevice = null;
    if (clientToDispose) {
      try {
        clientToDispose.dispose();
      } catch {
        // Safe ignore
      }
    }
  }

  /**
   * User-initiated Bluetooth device picker connection (Phase 2.4).
   */
  public async connect(): Promise<{ success: boolean; deviceName?: string; error?: string }> {
    if (this.inFlightConnection) {
      return { success: false, error: 'Connection already in progress.' };
    }
    if (!this.isSupported()) {
      const err = 'Web Bluetooth is not supported on this browser or platform.';
      this.notify('error', err);
      return { success: false, error: err };
    }

    const task = (async () => {
      this.notify('connecting');

      try {
        const adapter = new WebBluetoothAdapter();
        const client = new ThermalPrinterClient(adapter);

        await client.connect();

        const nativeDevice = (adapter as any).device;
        this.adapter = adapter;
        this.client = client;
        this.activeDeviceName = nativeDevice?.name || 'MXW01 Thermal Printer';

        this.updateConfig({
          lastDeviceId: nativeDevice?.id,
          lastDeviceName: this.activeDeviceName || undefined,
        });

        if (nativeDevice) {
          this.setupPhysicalDisconnectListener(nativeDevice);
        }
        this.registerClientLifecycle(this.client);

        this.notify('connected');
        return { success: true, deviceName: this.activeDeviceName || undefined };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.cleanupConnection();
        this.notify('disconnected', errMsg.includes('User cancelled') ? null : errMsg);
        return { success: false, error: errMsg };
      }
    })();

    this.inFlightConnection = task;
    try {
      return await task;
    } finally {
      this.inFlightConnection = null;
    }
  }

  private registerClientLifecycle(client: ThermalPrinterClient | null): void {
    if (!client) return;
    client.on('disconnected', () => {
      if (this.client === client) {
        this.cleanupConnection();
        this.notify('disconnected');
      }
    });
  }

  /**
   * Safe reconnection using navigator.bluetooth.getDevices() (Requirement 9 & 11).
   */
  public async reconnect(): Promise<ReconnectResult> {
    if (this.inFlightConnection) {
      return { outcome: 'busy', error: 'Connection already in progress.' };
    }
    if (!this.isSupported()) {
      return { outcome: 'unsupported', error: 'Web Bluetooth is not supported on this browser or platform.' };
    }
    if (this.status === 'connected') {
      return { outcome: 'success', deviceName: this.activeDeviceName || undefined };
    }

    const task = (async (): Promise<ReconnectResult> => {
      if (typeof (navigator as any).bluetooth?.getDevices !== 'function') {
        return { outcome: 'unsupported', error: 'Browser does not support device enumeration.' };
      }

      if (!this.config.lastDeviceId) {
        return { outcome: 'no_authorized_device', error: 'Previously authorized MXW01 was not found. Choose the printer again.' };
      }

      let devices: any[] = [];
      try {
        devices = await (navigator as any).bluetooth.getDevices();
      } catch (e: any) {
        return { outcome: 'connection_failed', error: e?.message || 'Failed to enumerate Bluetooth devices.' };
      }

      const target = Array.isArray(devices) ? devices.find((d: any) => d.id === this.config.lastDeviceId) : null;
      if (!target) {
        return { outcome: 'no_authorized_device', error: 'Previously authorized MXW01 was not found. Choose the printer again.' };
      }

      this.notify('connecting');

      try {
        const adapter = new PreAuthorizedWebBluetoothAdapter(target);
        const client = new ThermalPrinterClient(adapter);
        await client.connect();

        this.adapter = adapter as any;
        this.client = client;
        this.activeDeviceName = target.name || 'MXW01 Printer';

        this.setupPhysicalDisconnectListener(target);
        this.registerClientLifecycle(this.client);

        this.notify('connected');
        return { outcome: 'success', deviceName: this.activeDeviceName || undefined };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.cleanupConnection();
        this.notify('disconnected', errMsg);
        return {
          outcome: 'connection_failed',
          error: 'MXW01 was found, but connection failed. Make sure the printer is powered on and nearby.',
        };
      }
    })();

    this.inFlightConnection = task;
    try {
      return await task;
    } finally {
      this.inFlightConnection = null;
    }
  }

  public async disconnect(): Promise<void> {
    this.teardownPhysicalDisconnectListener();
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // Safe disconnect ignore
      }
    }
    this.cleanupConnection();
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
