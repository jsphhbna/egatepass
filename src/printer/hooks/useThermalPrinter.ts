import { useState, useEffect, useCallback, useRef } from 'react';
import {
  MXW01Manager,
  type PrinterConnectionStatus,
  type StoredPrinterConfig,
} from '../mxw01/mxw01Manager';
import type { PassPresentation } from '@/lib/passPresentation';
import { validateThermalTemplateLayout, type ThermalTemplateLayout } from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '../templates/bundledDefaultTemplate';
import { requireSupabase } from '@/lib/supabase';

export function useThermalPrinter() {
  const managerRef = useRef(MXW01Manager.getInstance());
  const manager = managerRef.current;

  const [status, setStatus] = useState<PrinterConnectionStatus>(manager.getStatus());
  const [deviceName, setDeviceName] = useState<string | null>(manager.getDeviceName());
  const [lastError, setLastError] = useState<string | null>(manager.getLastError());
  const [config, setConfig] = useState<StoredPrinterConfig>(manager.getConfig());
  const [publishedTemplate, setPublishedTemplate] = useState<ThermalTemplateLayout>(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  const isSupported = manager.isSupported();

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

    // Fetch latest published thermal template from API (Phase 3.5), fallback to bundled default
    async function loadTemplate() {
      try {
        const client = requireSupabase();
        const sessionRes = await client.auth.getSession();
        const token = sessionRes.data.session?.access_token;
        if (!token) {
          setPublishedTemplate(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
          return;
        }

        const res = await fetch('/api/device/thermal-template', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.layout) {
            const validation = validateThermalTemplateLayout(data.layout);
            if (validation.success) {
              setPublishedTemplate(validation.data);
              return;
            } else {
              console.warn('[MXW01] Fetched thermal template failed validation; using bundled fallback');
            }
          }
        } else {
          console.warn('[MXW01] Template fetch failed with status', res.status);
        }
        setPublishedTemplate(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
      } catch {
        // Fallback to bundled known-good default template without interrupting printing
        console.warn('[MXW01] Template delivery network error; using bundled fallback');
        setPublishedTemplate(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
      }
    }
    void loadTemplate();

    return () => {
      unsubscribe();
    };
  }, [manager, isSupported]);

  const connect = useCallback(async () => {
    return await manager.connect();
  }, [manager]);

  const reconnect = useCallback(async () => {
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
      const layoutToUse = customLayout ?? publishedTemplate;
      return await manager.printPass(presentation, layoutToUse);
    },
    [manager, publishedTemplate]
  );

  const printTestTicket = useCallback(async () => {
    return await manager.printTestTicket();
  }, [manager]);

  return {
    isSupported,
    status,
    deviceName,
    lastError,
    config,
    publishedTemplate,
    connect,
    reconnect,
    disconnect,
    updateConfig,
    printPass,
    printTestTicket,
  };
}
