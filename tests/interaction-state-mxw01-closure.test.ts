// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import reauthenticateHandler from '../server/routes/device/reauthenticate.js';
import completePasswordChangeHandler from '../server/routes/auth/complete-password-change.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { mxw01PrinterManager, MXW01Manager } from '../src/printer/mxw01/mxw01Manager';
import { ThermalPrinterClient } from 'mxw01-thermal-printer';

describe('Interaction-State & MXW01 Hidden-Bug Closure Pass — Comprehensive Regression Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Auth & Session Scoping (Section 1, 2, 3)
  // =========================================================================
  describe('1. Auth & Session Scoping (Isolated Verifier Local Scope)', () => {
    const KIOSK_ID = '00000000-0000-4000-a000-000000000099';

    it('1.1. reauthenticate uses passwordVerifier.auth.signOut({ scope: "local" }) and preserves session across repeated calls', async () => {
      const activeSessions = new Set(['kiosk-valid-token']);
      const signOutSpy = vi.fn(async (options?: { scope?: string }) => {
        // With scope: 'local', activeSessions is NOT cleared!
        if (options?.scope !== 'local') {
          activeSessions.clear();
        }
        return { error: null };
      });

      const mockAdmin: any = {
        auth: {
          getUser: vi.fn(async (token: string) => {
            if (activeSessions.has(token)) {
              return {
                data: { user: { id: KIOSK_ID, email: 'kiosk-01@devices.egatepass.invalid' } },
                error: null,
              };
            }
            return { data: { user: null }, error: new Error('invalid_token') };
          }),
        },
        from: (table: string) => {
          if (table === 'devices') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { user_id: KIOSK_ID, type: 'kiosk', status: 'active', alias: 'kiosk-01' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const mockVerifier: any = {
        auth: {
          signInWithPassword: vi.fn(async () => ({
            data: { user: { id: KIOSK_ID } },
            error: null,
          })),
          signOut: signOutSpy,
        },
      };

      setServerSupabaseClientsForTest({
        admin: mockAdmin,
        passwordVerifier: mockVerifier,
      });

      // Request 1: First reauthentication succeeds
      const req1 = new Request('http://localhost/api/device/reauthenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer kiosk-valid-token',
        },
        body: JSON.stringify({ password: 'ValidKioskPassword123!' }),
      });
      const res1 = await reauthenticateHandler.fetch(req1);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.ok).toBe(true);
      expect(signOutSpy).toHaveBeenCalledWith({ scope: 'local' });

      // Request 2: A second reauthentication using the SAME original kiosk session also succeeds!
      const req2 = new Request('http://localhost/api/device/reauthenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer kiosk-valid-token',
        },
        body: JSON.stringify({ password: 'ValidKioskPassword123!' }),
      });
      const res2 = await reauthenticateHandler.fetch(req2);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);
      expect(activeSessions.has('kiosk-valid-token')).toBe(true);
    });

    it('1.2. invalid or revoked bearer returns HTTP 401 { error: "invalid_session" } and NOT 500 internal_error', async () => {
      const mockAdmin: any = {
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: null },
            error: new Error('session_revoked'),
          })),
        },
        from: () => ({}),
      };

      setServerSupabaseClientsForTest({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const req = new Request('http://localhost/api/device/reauthenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer expired-token',
        },
        body: JSON.stringify({ password: 'Password123!' }),
      });

      const res = await reauthenticateHandler.fetch(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('invalid_session');
      expect(body.error).not.toBe('internal_error');
    });

    it('1.3. staff forced-password verification cleans only isolated local verifier session via { scope: "local" }', async () => {
      const STAFF_ID = '00000000-0000-4000-a000-000000000088';
      const signOutSpy = vi.fn(async () => ({ error: null }));

      const mockAdmin: any = {
        auth: {
          getUser: vi.fn(async (token: string) => {
            if (token === 'staff-valid-token') {
              return {
                data: {
                  user: {
                    id: STAFF_ID,
                    email: 'staff@earist.ph',
                    app_metadata: {},
                    user_metadata: {},
                  },
                },
                error: null,
              };
            }
            return { data: { user: null }, error: new Error('invalid') };
          }),
          admin: {
            updateUserById: vi.fn(async () => ({ data: { user: { id: STAFF_ID } }, error: null })),
          },
        },
        from: (table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { user_id: STAFF_ID, role: 'guard', active: true, must_change_password: true },
                    error: null,
                  }),
                }),
              }),
              update: () => ({
                eq: async () => ({ error: null }),
              }),
            };
          }
          if (table === 'audit_logs') {
            return {
              insert: async () => ({ error: null }),
            };
          }
          return {};
        },
        schema: () => ({
          rpc: vi.fn(async () => ({ error: null })),
        }),
      };

      const mockVerifier: any = {
        auth: {
          signInWithPassword: vi.fn(async () => ({
            data: { user: { id: STAFF_ID } },
            error: null,
          })),
          signOut: signOutSpy,
        },
      };

      setServerSupabaseClientsForTest({
        admin: mockAdmin,
        passwordVerifier: mockVerifier,
      });

      const req = new Request('http://localhost/api/auth/complete-password-change', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-valid-token',
        },
        body: JSON.stringify({
          currentPassword: 'CurrentPassword123!',
          newPassword: 'NewSecurePassword456!',
        }),
      });

      const res = await completePasswordChangeHandler.fetch(req);
      expect(res.status).toBe(200);
      expect(signOutSpy).toHaveBeenCalledWith({ scope: 'local' });
    });
  });

  // =========================================================================
  // 2. Printer Settings Modal Race & Generation Fencing (Section 4)
  // =========================================================================
  describe('2. Printer Settings Modal Race & Request Generation Fencing', () => {
    it('2.1. request generation fencing ensures a late 200 response from a closed modal does not unlock reopened modal', async () => {
      let reauthGeneration = 0;
      let isAuthenticated = false;
      let unlockExpiresAt: number | null = null;
      let activeAbortController: AbortController | null = null;

      const openModal = () => {
        reauthGeneration++;
        activeAbortController?.abort();
        activeAbortController = null;
        isAuthenticated = false;
        unlockExpiresAt = null;
      };

      const closeModal = () => {
        reauthGeneration++;
        activeAbortController?.abort();
        activeAbortController = null;
        isAuthenticated = false;
        unlockExpiresAt = null;
      };

      // 1. Open modal
      openModal();
      expect(isAuthenticated).toBe(false);

      // 2. Start reauthentication request
      const currentGen = ++reauthGeneration;
      const controller = new AbortController();
      activeAbortController = controller;

      let delayedResolve: (value: any) => void;
      const delayedFetch = new Promise((resolve) => {
        delayedResolve = resolve;
      });

      const executeReauth = async () => {
        await delayedFetch;
        // The fence check:
        if (currentGen !== reauthGeneration || controller.signal.aborted) {
          return;
        }
        isAuthenticated = true;
        unlockExpiresAt = Date.now() + 15 * 60 * 1000;
      };

      const reauthPromise = executeReauth();

      // 3. User closes modal before response arrives
      closeModal();
      expect(controller.signal.aborted).toBe(true);
      expect(isAuthenticated).toBe(false);

      // 4. Server returns HTTP 200 late
      delayedResolve!({ status: 200 });
      await reauthPromise;

      // Modal must remain locked
      expect(isAuthenticated).toBe(false);
      expect(unlockExpiresAt).toBeNull();

      // 5. Reopen modal: must STILL be locked!
      openModal();
      expect(isAuthenticated).toBe(false);
      expect(unlockExpiresAt).toBeNull();
    });

    it('2.2. KioskPrinterSettingsModal source enforces generation check and abort controller on modal close', () => {
      const modalSrc = readFileSync('src/components/KioskPrinterSettingsModal.tsx', 'utf8');
      expect(modalSrc).toContain('reauthGenerationRef.current += 1;');
      expect(modalSrc).toContain('abortControllerRef.current.abort();');
      expect(modalSrc).toContain('fetchWithTimeout');
      expect(modalSrc).toContain('if (generation !== reauthGenerationRef.current');
    });
  });

  // =========================================================================
  // 3. Password Visibility Controls & CSS Scoping (Section 5 & 6)
  // =========================================================================
  describe('3. Password Visibility Controls & CSS Scoping', () => {
    const indexCss = readFileSync('src/index.css', 'utf8');
    const loginPageSrc = readFileSync('src/pages/LoginPage.tsx', 'utf8');
    const forcePasswordSrc = readFileSync('src/components/ForcePasswordChange.tsx', 'utf8');
    const devicesPageSrc = readFileSync('src/pages/DevicesPage.tsx', 'utf8');
    const kioskSettingsSrc = readFileSync('src/components/KioskPrinterSettingsModal.tsx', 'utf8');

    it('3.1. index.css suppresses Edge-native reveal ONLY on .app-password-toggle-input', () => {
      expect(indexCss).toContain('.app-password-toggle-input::-ms-reveal');
      expect(indexCss).toContain('.app-password-toggle-input::-ms-clear');
      expect(indexCss).toContain('display: none;');

      // Global suppression must NOT exist
      expect(indexCss).not.toMatch(/input\[type=['"]password['"]\]::-ms-reveal/);
    });

    it('3.2. custom-toggle password inputs include app-password-toggle-input class', () => {
      expect(loginPageSrc).toContain('app-password-toggle-input');
      expect(forcePasswordSrc).toContain('app-password-toggle-input');
      expect(devicesPageSrc).toContain('app-password-toggle-input');
    });

    it('3.3. password inputs without custom eye toggles retain browser-native behavior (no app-password-toggle-input)', () => {
      expect(kioskSettingsSrc).not.toContain('app-password-toggle-input');
    });

    it('3.4. ForcePasswordChange operates three independent visibility states', () => {
      expect(forcePasswordSrc).toContain('showCurrentPassword');
      expect(forcePasswordSrc).toContain('showNewPassword');
      expect(forcePasswordSrc).toContain('showConfirmPassword');
      expect(forcePasswordSrc).not.toContain('const [showPasswords, setShowPasswords]');
      expect(forcePasswordSrc).toContain('Show current password');
      expect(forcePasswordSrc).toContain('Hide current password');
      expect(forcePasswordSrc).toContain('Show new password');
      expect(forcePasswordSrc).toContain('Hide new password');
      expect(forcePasswordSrc).toContain('Show confirm password');
      expect(forcePasswordSrc).toContain('Hide confirm password');
    });
  });

  // =========================================================================
  // 4. Single Printer Controller Ownership (Section 7)
  // =========================================================================
  describe('4. Single Printer Controller Ownership', () => {
    const kioskPageSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');
    const modalSrc = readFileSync('src/components/KioskPrinterSettingsModal.tsx', 'utf8');

    it('4.1. KioskPage owns useThermalPrinter and passes it down to KioskPrinterSettingsModal', () => {
      expect(kioskPageSrc).toContain('const printer = useThermalPrinter();');
      expect(kioskPageSrc).toContain('<KioskPrinterSettingsModal');
      expect(kioskPageSrc).toContain('printer={printer}');
    });

    it('4.2. KioskPrinterSettingsModal does NOT call useThermalPrinter() independently', () => {
      expect(modalSrc).not.toContain('useThermalPrinter()');
      expect(modalSrc).toContain('printer: ThermalPrinterController');
    });

    it('4.3. changing Auto-Print via manager/controller updates the authoritative config', () => {
      mxw01PrinterManager.setAutoPrint(true);
      expect(mxw01PrinterManager.getConfig().autoPrint).toBe(true);

      mxw01PrinterManager.setAutoPrint(false);
      expect(mxw01PrinterManager.getConfig().autoPrint).toBe(false);
    });
  });

  // =========================================================================
  // 5. Template Refresh Coalescing & Visibility Filtering (Section 8)
  // =========================================================================
  describe('5. Template Refresh Coalescing & Visibility Filtering', () => {
    const hookSrc = readFileSync('src/printer/hooks/useThermalPrinter.ts', 'utf8');

    it('5.1. useThermalPrinter coalesces in-flight template refresh requests', () => {
      expect(hookSrc).toContain('inFlightRefreshPromiseRef');
      expect(hookSrc).toContain('if (inFlightRefreshPromiseRef.current)');
      expect(hookSrc).toContain('return inFlightRefreshPromiseRef.current;');
    });

    it('5.2. visibilitychange event only refreshes when document.visibilityState is "visible"', () => {
      expect(hookSrc).toContain("document.visibilityState === 'visible'");
      expect(hookSrc).toContain('handleVisibilityChange');
    });

    it('5.3. preserves 60-second freshness policy', () => {
      expect(hookSrc).toContain('Date.now() - lastTemplateFetchAtRef.current > 60_000');
    });
  });

  // =========================================================================
  // 6. Connect vs Reconnect Lifecycle (Section 9, 10, 11)
  // =========================================================================
  describe('6. Connect vs Reconnect Lifecycle (Pre-Authorized Adapter & Single Flight)', () => {
    let mockBluetooth: any;
    let mockDevice: any;
    let mockGattServer: any;

    beforeEach(() => {
      // Mock getStatus on ThermalPrinterClient to resolve immediately without 5000ms Bluetooth status wait
      vi.spyOn(ThermalPrinterClient.prototype, 'getStatus').mockResolvedValue({ isConnected: true } as any);

      const makeChar = (uuid: string) => ({
        uuid,
        startNotifications: vi.fn(async () => {}),
        stopNotifications: vi.fn(async () => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        writeValue: vi.fn(async () => {}),
        writeValueWithoutResponse: vi.fn(async () => {}),
      });

      mockGattServer = {
        connected: false,
        connect: vi.fn(async () => {
          mockGattServer.connected = true;
          return mockGattServer;
        }),
        disconnect: vi.fn(() => {
          mockGattServer.connected = false;
        }),
        getPrimaryService: vi.fn(async (uuid: string) => ({
          uuid,
          getCharacteristic: vi.fn(async (charUuid: string) => makeChar(charUuid)),
        })),
      };

      mockDevice = {
        id: 'mxw01-device-id-12345',
        name: 'MXW01_BT_PRINTER',
        gatt: mockGattServer,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      mockBluetooth = {
        requestDevice: vi.fn(async () => mockDevice),
        getDevices: vi.fn(async () => [mockDevice]),
      };

      Object.defineProperty(navigator, 'bluetooth', {
        value: mockBluetooth,
        configurable: true,
        writable: true,
      });
    });

    it('6.1. interactive connect() calls navigator.bluetooth.requestDevice() and saves lastDeviceId', async () => {
      const manager = new MXW01Manager();
      const res = await manager.connect();

      expect(res.success).toBe(true);
      expect(mockBluetooth.requestDevice).toHaveBeenCalledTimes(1);
      expect(manager.getStatus()).toBe('connected');
      expect(manager.getDeviceName()).toBe('MXW01_BT_PRINTER');
      expect(manager.getConfig().lastDeviceId).toBe('mxw01-device-id-12345');
      manager.disconnect();
    });

    it('6.2. reconnect() uses getDevices(), matches saved lastDeviceId, and does NOT call requestDevice()', async () => {
      const manager = new MXW01Manager();
      manager.updateConfig({
        lastDeviceId: 'mxw01-device-id-12345',
        lastDeviceName: 'MXW01_BT_PRINTER',
      });

      const result = await manager.reconnect();

      expect(result.outcome).toBe('success');
      expect(mockBluetooth.getDevices).toHaveBeenCalledTimes(1);
      expect(mockBluetooth.requestDevice).not.toHaveBeenCalled();
      expect(manager.getStatus()).toBe('connected');
      expect(manager.getDeviceName()).toBe('MXW01_BT_PRINTER');
      manager.disconnect();
    });

    it('6.3. reconnect() returns outcome "no_authorized_device" when stored device is absent', async () => {
      const manager = new MXW01Manager();
      manager.updateConfig({
        lastDeviceId: 'different-unauthorized-id',
      });
      const result = await manager.reconnect();

      expect(result.outcome).toBe('no_authorized_device');
      expect(mockBluetooth.requestDevice).not.toHaveBeenCalled();
      expect(manager.getStatus()).toBe('disconnected');
    });

    it('6.4. reconnect() returns outcome "connection_failed" when GATT connection throws', async () => {
      const manager = new MXW01Manager();
      manager.updateConfig({
        lastDeviceId: 'mxw01-device-id-12345',
      });
      mockGattServer.connect = vi.fn(async () => {
        throw new Error('GATT connection failed (device powered off or out of range)');
      });

      const result = await manager.reconnect();

      expect(result.outcome).toBe('connection_failed');
      expect(result.error).toContain('MXW01 was found, but connection failed');
      expect(['disconnected', 'error']).toContain(manager.getStatus());
      expect(manager.getStatus()).not.toBe('connecting');
    });

    it('6.5. connection single-flight guard: concurrent connect/reconnect returns busy outcome', async () => {
      const manager = new MXW01Manager();
      let resolveFirst: any;
      mockGattServer.connect = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      );

      // Start connect
      const firstConnectPromise = manager.connect();

      // Attempt second connect concurrently
      const secondConnect = await manager.connect();
      expect(secondConnect.success).toBe(false);
      expect(secondConnect.error).toContain('Connection already in progress');

      // Attempt reconnect concurrently
      const reconnectResult = await manager.reconnect();
      expect(reconnectResult.outcome).toBe('busy');

      resolveFirst(mockGattServer);
      await firstConnectPromise;
      manager.disconnect();
    });
  });

  // =========================================================================
  // 7. Physical Bluetooth Disconnection Detection (Section 12)
  // =========================================================================
  describe('7. Physical Bluetooth Disconnection Detection (gattserverdisconnected)', () => {
    let mockBluetooth: any;
    let mockDevice: any;
    let disconnectListeners: ((e: Event) => void)[] = [];

    beforeEach(() => {
      vi.spyOn(ThermalPrinterClient.prototype, 'getStatus').mockResolvedValue({ isConnected: true } as any);
      disconnectListeners = [];

      const makeChar = (uuid: string) => ({
        uuid,
        startNotifications: vi.fn(async () => {}),
        stopNotifications: vi.fn(async () => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        writeValue: vi.fn(async () => {}),
        writeValueWithoutResponse: vi.fn(async () => {}),
      });

      const mockGattServer = {
        connected: true,
        connect: vi.fn(async () => mockGattServer),
        disconnect: vi.fn(() => {}),
        getPrimaryService: vi.fn(async (uuid: string) => ({
          uuid,
          getCharacteristic: vi.fn(async (charUuid: string) => makeChar(charUuid)),
        })),
      };

      mockDevice = {
        id: 'mxw01-physical-test-id',
        name: 'MXW01_BT_PRINTER',
        gatt: mockGattServer,
        addEventListener: vi.fn((event: string, listener: any) => {
          if (event === 'gattserverdisconnected') {
            disconnectListeners.push(listener);
          }
        }),
        removeEventListener: vi.fn((event: string, listener: any) => {
          if (event === 'gattserverdisconnected') {
            disconnectListeners = disconnectListeners.filter((l) => l !== listener);
          }
        }),
      };

      mockBluetooth = {
        requestDevice: vi.fn(async () => mockDevice),
        getDevices: vi.fn(async () => [mockDevice]),
      };

      Object.defineProperty(navigator, 'bluetooth', {
        value: mockBluetooth,
        configurable: true,
        writable: true,
      });
    });

    it('7.1. native gattserverdisconnected event transitions manager to disconnected and clears active device', async () => {
      const manager = new MXW01Manager();
      await manager.connect();

      expect(manager.getStatus()).toBe('connected');
      expect(manager.getDeviceName()).toBe('MXW01_BT_PRINTER');
      expect(disconnectListeners.length).toBeGreaterThan(0);

      // Simulate physical power off
      const disconnectEvent = new Event('gattserverdisconnected');
      for (const listener of disconnectListeners) {
        listener(disconnectEvent);
      }

      expect(manager.getStatus()).toBe('disconnected');
      expect(manager.getDeviceName()).toBeNull();
      expect(manager.isConnected()).toBe(false);
    });

    it('7.2. stale disconnect event from an OLD connection generation does NOT clear a newer connection', async () => {
      const manager = new MXW01Manager();
      await manager.connect();
      expect(manager.getStatus()).toBe('connected');

      // Grab the listener for generation 1
      const gen1Listener = disconnectListeners[0];

      // Reconnect / establish generation 2
      await manager.connect();
      expect(manager.getStatus()).toBe('connected');

      // Trigger the stale generation 1 listener
      gen1Listener(new Event('gattserverdisconnected'));

      // Manager must STILL be connected because generation 2 is active!
      expect(manager.getStatus()).toBe('connected');
      expect(manager.getDeviceName()).toBe('MXW01_BT_PRINTER');
      manager.disconnect();
    });
  });

  // =========================================================================
  // 8. UI Action States & Error Recovery (Section 13, 14, 15)
  // =========================================================================
  describe('8. UI Action States & Error Recovery in KioskPrinterSettingsModal', () => {
    const modalSrc = readFileSync('src/components/KioskPrinterSettingsModal.tsx', 'utf8');

    it('8.1. separates Connect and Reconnect loading states using ConnectionAction', () => {
      expect(modalSrc).toContain("const [connectionAction, setConnectionAction] = useState<'connect' | 'reconnect' | null>(null);");
      expect(modalSrc).toContain("loading={connectionAction === 'connect'}");
      expect(modalSrc).toContain("loading={connectionAction === 'reconnect'}");
    });

    it('8.2. disables connection actions while connecting or printing', () => {
      expect(modalSrc).toContain("disabled={!isSupported || isConnecting}");
      expect(modalSrc).toContain("status === 'printing'");
      expect(modalSrc).toContain('Printing…');
      expect(modalSrc).toContain("status === 'connecting'");
      expect(modalSrc).toContain('Connecting…');
    });

    it('8.3. test-print error is handled in try-catch-finally, resetting loading state', () => {
      expect(modalSrc).toContain('setIsTesting(true);');
      expect(modalSrc).toContain('try {');
      expect(modalSrc).toContain('await printTestTicket();');
      expect(modalSrc).toContain('} catch (err) {');
      expect(modalSrc).toContain('} finally {');
      expect(modalSrc).toContain('setIsTesting(false);');
    });
  });

  // =========================================================================
  // 9. Print Single-Flight & Next Visitor Race Guard (Section 16 & 17)
  // =========================================================================
  describe('9. Print Single-Flight & Next Visitor Race Guard', () => {
    const hookSrc = readFileSync('src/printer/hooks/useThermalPrinter.ts', 'utf8');
    const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

    it('9.1. useThermalPrinter enforces isPrintBusy during entire print operation', () => {
      expect(hookSrc).toContain('const [isPrintBusy, setIsPrintBusy] = useState(false);');
      expect(hookSrc).toContain('const isPrintBusyRef = useRef(false);');
      expect(hookSrc).toContain('if (isPrintBusyRef.current) {');
      expect(hookSrc).toContain("return { success: false, error: 'print_in_progress' };");
    });

    it('9.2. KioskPage disables "Next Visitor" while print is busy or in progress', () => {
      expect(kioskSrc).toContain('disabled={isPrintBusy || isPrinting}');
    });

    it('9.3. KioskPage isolates visitor generation so late print callback does not mutate subsequent visitor', () => {
      expect(kioskSrc).toContain('visitorSessionGenerationRef');
      expect(kioskSrc).toContain('const sessionGen = visitorSessionGenerationRef.current;');
      expect(kioskSrc).toContain('if (sessionGen === visitorSessionGenerationRef.current)');
    });
  });

  // =========================================================================
  // 10. Truthful Status Wording & Fallback Buttons (Section 18 & 19)
  // =========================================================================
  describe('10. Truthful Status Wording & Fallback Buttons', () => {
    const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

    it('10.1. sidebar printer status maps all states truthfully (Ready, Connecting, Printing, Error, Offline)', () => {
      expect(kioskSrc).toContain("printerStatus === 'connected'");
      expect(kioskSrc).toContain("? 'Ready'");
      expect(kioskSrc).toContain("printerStatus === 'connecting'");
      expect(kioskSrc).toContain("? 'Connecting'");
      expect(kioskSrc).toContain("printerStatus === 'printing'");
      expect(kioskSrc).toContain("? 'Printing'");
      expect(kioskSrc).toContain("printerStatus === 'error'");
      expect(kioskSrc).toContain("? 'Error'");
      expect(kioskSrc).toContain(": 'Offline'");
    });

    it('10.2. main print button label truthfully reflects printer state', () => {
      expect(kioskSrc).toContain("isPrintBusy || isPrinting");
      expect(kioskSrc).toContain("? 'Printing…'");
      expect(kioskSrc).toContain("printerStatus === 'connected'");
      expect(kioskSrc).toContain("? 'Print Pass (MXW01)'");
      expect(kioskSrc).toContain(": 'Browser Print'");
    });

    it('10.3. print failure banner only shows "Print Again" when printerStatus is connected', () => {
      expect(kioskSrc).toContain("printerStatus === 'connected' ? (");
      expect(kioskSrc).toContain('Print Again');
      expect(kioskSrc).toContain('Printer Settings');
      expect(kioskSrc).toContain('Browser Print');
    });
  });

  // =========================================================================
  // 11. Thermal Template Editor Fail-Safety (Section 20)
  // =========================================================================
  describe('11. Thermal Template Editor Fail-Safety', () => {
    const editorSrc = readFileSync('src/pages/AdminPrintTemplatesPage.tsx', 'utf8');

    it('11.1. initial load failure renders error state and blocks Save/Publish', () => {
      expect(editorSrc).toContain('const [hasLoadedCanonical, setHasLoadedCanonical] = useState(false);');
      expect(editorSrc).toContain('const [loadError, setLoadError] = useState<string | null>(null);');
      expect(editorSrc).toContain('Unable to load thermal templates');
      expect(editorSrc).toMatch(/disabled=\{(?:activeMutation !== null|saving \|\| publishing) \|\| !hasLoadedCanonical\}/);
    });

    it('11.2. refresh failure after prior load preserves last-known-good editor state and displays warning toast', () => {
      expect(editorSrc).toContain('if (hasLoadedCanonical)');
      expect(editorSrc).toContain("toast.warning('Failed to refresh thermal templates. Keeping current editor state.');");
    });

    it('11.3. zero templates from server loads bundled default as unsaved local draft', () => {
      expect(editorSrc).toContain('setCurrentVersion(null);');
      expect(editorSrc).toContain("setCurrentStatus('draft');");
      expect(editorSrc).toContain('BUNDLED_DEFAULT_THERMAL_TEMPLATE');
    });
  });

  // =========================================================================
  // 12. Email Pass Modal Single-Flight (Section 21)
  // =========================================================================
  describe('12. Email Pass Modal Single-Flight & Delivery Gate Guard', () => {
    const emailModalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');

    it('12.1. handleSkip early-returns if loading is active', () => {
      expect(emailModalSrc).toContain('function handleSkip() {');
      expect(emailModalSrc).toContain('if (loading) return;');
    });

    it('12.2. disables skip button and link when loading', () => {
      expect(emailModalSrc).toContain('disabled={loading}');
      expect(emailModalSrc).toContain('Continue without email');
    });
  });

  // =========================================================================
  // 13. Per-Target Reactivation Single-Flight (Section 22 & 23)
  // =========================================================================
  describe('13. Per-Target Reactivation Single-Flight Guards', () => {
    const adminUsersSrc = readFileSync('src/pages/AdminUsers.tsx', 'utf8');
    const devicesPageSrc = readFileSync('src/pages/DevicesPage.tsx', 'utf8');

    it('13.1. AdminUsers protects staff reactivation with reactivatingUserId guard', () => {
      expect(adminUsersSrc).toContain('const [reactivatingUserId, setReactivatingUserId] = useState<string | null>(null);');
      expect(adminUsersSrc).toContain('if (reactivatingUserId === user.uid) return;');
      expect(adminUsersSrc).toContain('setReactivatingUserId(user.uid);');
      expect(adminUsersSrc).toContain('disabled={reactivatingUserId === user.uid}');
      expect(adminUsersSrc).toContain('reactivatingUserId === user.uid');
      expect(adminUsersSrc).toContain('Reactivating…');
      expect(adminUsersSrc).toContain('setReactivatingUserId(null);');
    });

    it('13.2. DevicesPage protects device reactivation with reactivatingDeviceId guard', () => {
      expect(devicesPageSrc).toContain('const [reactivatingDeviceId, setReactivatingDeviceId] = useState<string | null>(null);');
      expect(devicesPageSrc).toContain('if (reactivatingDeviceId === device.id) return;');
      expect(devicesPageSrc).toContain('setReactivatingDeviceId(device.id);');
      expect(devicesPageSrc).toContain('disabled={reactivatingDeviceId === device.id}');
      expect(devicesPageSrc).toContain('reactivatingDeviceId === device.id');
      expect(devicesPageSrc).toContain('Reactivating…');
      expect(devicesPageSrc).toContain('setReactivatingDeviceId(null);');
    });
  });
});
