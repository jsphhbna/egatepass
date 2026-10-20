import { useState, useEffect } from 'react';
import { auth } from '@/lib/firebase';
import { ImageOff } from 'lucide-react';

interface AuthenticatedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  publicId?: string | null;
  fallbackText?: string;
}

export function AuthenticatedImage({ publicId, fallbackText = 'Image unavailable', className = '', ...props }: AuthenticatedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'missing' | 'temporary'>('loading');

  useEffect(() => {
    let active = true;
    let url: string | null = null;
    const controller = new AbortController();

    async function fetchImage() {
      try {
        setLoading(true);
        setState('loading');
        setObjectUrl(null);
        
        const user = auth.currentUser;
        if (!user) {
          throw new Error('User not authenticated');
        }

        const token = await user.getIdToken();
        const response = await fetch(`/api/image?publicId=${encodeURIComponent(publicId || '')}`, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          signal: controller.signal,
        });

        if (response.status === 410) {
          if (active) { setState('expired'); setLoading(false); }
          return;
        }
        if (response.status === 404) {
          if (active) { setState('missing'); setLoading(false); }
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }

        const blob = await response.blob();
        if (!blob.type.toLocaleLowerCase().startsWith('image/')) throw new Error('Image response had an invalid content type');
        
        if (active) {
          url = URL.createObjectURL(blob);
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

    if (publicId) {
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
  }, [publicId]);

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
    const message = state === 'expired' ? 'Image expired' : state === 'missing' ? 'No image available' : 'Image temporarily unavailable';
    return (
      <div 
        className={`flex flex-col items-center justify-center rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-overlay)] p-4 text-center text-[var(--color-text-muted)] ${className}`}
        role="img"
        aria-label={message}
      >
        <ImageOff className="h-6 w-6 mb-2" />
        <span className="text-xs font-semibold">{message}</span>
        {state === 'expired' && <span className="mt-1 text-xs">Removed under the configured image retention policy.</span>}
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
