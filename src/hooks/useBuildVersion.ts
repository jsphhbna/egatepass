import { useEffect, useState, useCallback, useRef } from 'react';

export interface BuildMeta {
  commitSha: string;
  builtAt: string;
  version: string;
}

export function useBuildVersion(checkIntervalMs = 180000) {
  const [currentSha, setCurrentSha] = useState<string | null>(null);
  const [latestSha, setLatestSha] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const initialFetchDone = useRef(false);

  const fetchMeta = useCallback(async (): Promise<BuildMeta | null> => {
    try {
      const res = await fetch(`/build-meta.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return (await res.json()) as BuildMeta;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const meta = await fetchMeta();
      if (!mounted || !meta?.commitSha) return;
      if (!initialFetchDone.current) {
        initialFetchDone.current = true;
        setCurrentSha(meta.commitSha);
      } else if (currentSha && meta.commitSha !== currentSha) {
        setLatestSha(meta.commitSha);
        setUpdateAvailable(true);
      }
    }

    init();

    const interval = setInterval(async () => {
      const meta = await fetchMeta();
      if (!mounted || !meta?.commitSha) return;
      if (currentSha && meta.commitSha !== currentSha) {
        setLatestSha(meta.commitSha);
        setUpdateAvailable(true);
      }
    }, checkIntervalMs);

    const onVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        const meta = await fetchMeta();
        if (!mounted || !meta?.commitSha) return;
        if (currentSha && meta.commitSha !== currentSha) {
          setLatestSha(meta.commitSha);
          setUpdateAvailable(true);
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      mounted = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [currentSha, checkIntervalMs, fetchMeta]);

  const reloadApp = useCallback(() => {
    window.location.reload();
  }, []);

  const dismissUpdate = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    currentSha,
    latestSha,
    updateAvailable: updateAvailable && !dismissed,
    reloadApp,
    dismissUpdate,
  };
}
