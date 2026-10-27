import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MXW01Manager,
  type PrinterConnectionStatus,
  type StoredPrinterConfig,
  type ReconnectResult,
} from '../mxw01/mxw01Manager';
import type { PassPresentation } from '@/lib/passPresentation';
import { validateThermalTemplateLayout, type ThermalTemplateLayout } from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '../templates/bundledDefaultTemplate';
import { requireSupabase } from '@/lib/supabase';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';

export function useThermalPrinter() {
  const managerRef = useRef(MXW01Manager.getInstance());
  const manager = managerRef.current;

  const [status, setStatus] = useState<PrinterConnectionStatus>(manager.getStatus());
  const [deviceName, setDeviceName] = useState<string | null>(manager.getDeviceName());
  const [lastError, setLastError] = useState<string | null>(manager.getLastError());
  const [config, setConfig] = useState<StoredPrinterConfig>(manager.getConfig());
  const [publishedTemplate, setPublishedTemplate] = useState<ThermalTemplateLayout>(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  const [isPrintBusy, setIsPrintBusy] = useState(false);

  const publishedTemplateRef = useRef<ThermalTemplateLayout>(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  const lastTemplateFetchAtRef = useRef<number>(0);
  const inFlightRefreshPromiseRef = useRef<Promise<ThermalTemplateLayout> | null>(null);
  const isPrintBusyRef = useRef(false);

  const isSupported = manager.isSupported();

  const refreshPublishedTemplate = useCallback(async (): Promise<ThermalTemplateLayout> => {
    if (inFlightRefreshPromiseRef.current) {
      return inFlightRefreshPromiseRef.current;
    }

    const refreshPromise = (async (): Promise<ThermalTemplateLayout> => {
      try {
        const client = requireSupabase();
        const sessionRes = await client.auth.getSession();
        const token = sessionRes.data.session?.access_token;
        if (!token) {
          return publishedTemplateRef.current;
        }

        const res = await fetchWithTimeout(
          '/api/device/thermal-template',
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          5000
        );

        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.layout) {
            const validation = validateThermalTemplateLayout(data.layout);
            if (validation.success) {
              publishedTemplateRef.current = validation.data;
              setPublishedTemplate(validation.data);
              lastTemplateFetchAtRef.current = Date.now();
              return validation.data;
            } else {
              console.warn('[MXW01] Fetched thermal template failed validation; preserving in-memory template');
            }
          }
        } else {
          console.warn('[MXW01] Template fetch failed with status', res.status);
        }
      } catch {
        console.warn('[MXW01] Template delivery network error; preserving in-memory template');
      } finally {
        inFlightRefreshPromiseRef.current = null;
      }
      return publishedTemplateRef.current;
    })();

    inFlightRefreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, []);

  useEffect(() => {
    const unsubscribe = manager.subscribe((newStatus, error) => {
      setStatus(newStatus);
      setDeviceName(manager.getDeviceName());
      setLastError(error ?? null);
      setConfig(manager.getConfig());
    });

    // Attempt safe background reconnection on initial mount if supported
    if (isSupported && manager.getStatus() === 'disconnected') {
      void manager.reconnect();
    }

    void refreshPublishedTemplate();

    const handleFocus = () => {
      if (Date.now() - lastTemplateFetchAtRef.current > 60_000) {
        void refreshPublishedTemplate();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastTemplateFetchAtRef.current > 60_000) {
        void refreshPublishedTemplate();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [manager, isSupported, refreshPublishedTemplate]);

  const connect = useCallback(async () => {
    return await manager.connect();
  }, [manager]);

  const reconnect = useCallback(async (): Promise<ReconnectResult> => {
    return await manager.reconnect();
  }, [manager]);

  const disconnect = useCallback(async () => {
    await manager.disconnect();
  }, [manager]);

  const updateConfig = useCallback(
    (partial: Partial<StoredPrinterConfig>) => {
      manager.updateConfig(partial);
      setConfig(manager.getConfig());
    },
    [manager]
  );

  const printPass = useCallback(
    async (presentation: PassPresentation, customLayout?: ThermalTemplateLayout) => {
      if (isPrintBusyRef.current) {
        console.warn('[MXW01] Print already in progress, ignoring duplicate print call');
        return { success: false, error: 'print_in_progress' };
      }

      isPrintBusyRef.current = true;
      setIsPrintBusy(true);

      try {
        await refreshPublishedTemplate();
        const layoutToUse = customLayout ?? publishedTemplateRef.current;
        const result = await manager.printPass(presentation, layoutToUse);
        if (!result.success) {
          throw new Error(result.error || 'Direct thermal print failed');
        }
        return result;
      } finally {
        isPrintBusyRef.current = false;
        setIsPrintBusy(false);
      }
    },
    [manager, refreshPublishedTemplate]
  );

  const printTestTicket = useCallback(async () => {
    const result = await manager.printTestTicket();
    if (!result.success) {
      throw new Error(result.error || 'Test ticket print failed');
    }
    return result;
  }, [manager]);

  return {
    isSupported,
    status,
    deviceName,
    lastError,
    config,
    publishedTemplate,
    isPrintBusy,
    connect,
    reconnect,
    disconnect,
    updateConfig,
    printPass,
    printTestTicket,
    refreshPublishedTemplate,
  };
}

export type ThermalPrinterController = ReturnType<typeof useThermalPrinter>;
