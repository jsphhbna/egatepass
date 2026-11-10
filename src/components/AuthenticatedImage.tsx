import { useState, useEffect } from 'react';
import { getAccessToken } from '@/services/auth';
import { ImageOff, RefreshCw } from 'lucide-react';

interface AuthenticatedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  publicId?: string | null;
  srcUrl?: string | null;
  authToken?: string | null;
  blob?: Blob | null;
  fallbackText?: string;
}

export function AuthenticatedImage({
  publicId,
  srcUrl,
  authToken,
  blob,
  fallbackText = 'Image unavailable',
  className = '',
  ...props
}: AuthenticatedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'missing' | 'temporary'>('loading');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    const controller = new AbortController();

    async function fetchImage() {
      try {
        setLoading(true);
        setState('loading');
        setObjectUrl(null);

        if (blob) {
          url = URL.createObjectURL(blob);
          if (active) {
            setObjectUrl(url);
            setLoading(false);
            setState('ready');
          }
          return;
        }

        let targetUrl: string;
        if (srcUrl) {
          targetUrl = srcUrl;
        } else if (publicId) {
          targetUrl = `/api/evidence?id=${encodeURIComponent(publicId || '')}`;
        } else {
          if (active) {
            setState('missing');
            setLoading(false);
          }
          return;
        }

        let token = authToken;
        if (!token) {
          try {
            token = await getAccessToken();
          } catch {
            try {
              const { requirePortalSupabase } = await import('@/lib/supabase');
              const { data: pData } = await requirePortalSupabase().auth.getSession();
              token = pData.session?.access_token || undefined;
            } catch {
              // Token lookup failed
            }
          }
        }

        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(targetUrl, {
          headers,
          signal: controller.signal,
        });

        if (response.status === 410) {
          if (active) {
            setState('expired');
            setLoading(false);
          }
          return;
        }
        if (response.status === 404) {
          if (active) {
            setState('missing');
            setLoading(false);
          }
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }

        const fetchedBlob = await response.blob();
        if (!fetchedBlob.type.toLowerCase().startsWith('image/')) {
          throw new Error('Image response had an invalid content type');
        }

        if (active) {
          url = URL.createObjectURL(fetchedBlob);
          setObjectUrl(url);
          setLoading(false);
          setState('ready');
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error('Failed to load authenticated image:', err);
        if (active && !controller.signal.aborted) {
          setState('temporary');
          setLoading(false);
        }
      }
    }

    if (blob || publicId || srcUrl) {
      fetchImage();
    } else {
      setLoading(false);
      setState('missing');
    }

    return () => {
      active = false;
      controller.abort();
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [publicId, srcUrl, authToken, blob, retryCount]);

  if (loading) {
    return (
      <div
        className={`flex animate-pulse items-center justify-center bg-[var(--color-overlay)] ${className}`}
        role="img"
        aria-label="Loading image..."
      />
    );
  }

  if (state !== 'ready' || !objectUrl) {
    const isTemporary = state === 'temporary';
    const message = state === 'expired'
      ? 'Image expired'
      : state === 'missing'
      ? (fallbackText || 'Image unavailable')
      : isTemporary
      ? 'Unable to load photo'
      : fallbackText;

    return (
      <div
        className={`flex flex-col items-center justify-center rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-overlay)] p-4 text-center text-[var(--color-text-muted)] ${className}`}
        role="img"
        aria-label={message}
      >
        <ImageOff className="h-6 w-6 mb-2" />
        <span className="text-xs font-semibold">{message}</span>
        {state === 'expired' && (
          <span className="mt-1 text-xs">Removed under the configured image retention policy.</span>
        )}
        {isTemporary && (
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
            className="mt-2 inline-flex items-center gap-1 rounded bg-white px-2.5 py-1 text-[11px] font-semibold text-[#7A0A0A] border border-[var(--color-border)] shadow-xs hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <img
      src={objectUrl}
      className={className}
      {...props}
    />
  );
}
