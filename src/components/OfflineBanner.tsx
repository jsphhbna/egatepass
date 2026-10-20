import { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    function handleOnline() {
      setIsOffline(false);
    }
    function handleOffline() {
      setIsOffline(true);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className="fixed left-0 right-0 top-0 z-[200] flex items-center justify-center gap-2 bg-[var(--color-danger)] px-4 py-2 text-center text-sm font-semibold text-white shadow-md motion-safe:animate-in motion-safe:slide-in-from-top" role="status" aria-live="polite">
      <WifiOff className="h-4 w-4" />
      You are currently offline. Changes will be saved locally and synced when connection is restored.
    </div>
  );
}
