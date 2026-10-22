import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Pure lifecycle manager for a single object URL.
 * Handles creation, replacement, clearance, and disposal (unmount),
 * ensuring previous URLs are reliably revoked without leaking memory.
 */
export class ObjectUrlLifecycle {
  private currentUrl: string | null = null;
  private revoker: (url: string) => void;

  constructor(revoker: (url: string) => void = (url) => URL.revokeObjectURL(url)) {
    this.revoker = revoker;
  }

  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  set(newUrl: string | null): void {
    if (this.currentUrl && this.currentUrl !== newUrl) {
      this.revoker(this.currentUrl);
    }
    this.currentUrl = newUrl;
  }

  createFromBlob(
    blob: Blob | null,
    creator: (b: Blob) => string = (b) => URL.createObjectURL(b)
  ): string | null {
    if (this.currentUrl) {
      this.revoker(this.currentUrl);
      this.currentUrl = null;
    }
    if (blob) {
      const url = creator(blob);
      this.currentUrl = url;
      return url;
    }
    return null;
  }

  clear(): void {
    if (this.currentUrl) {
      this.revoker(this.currentUrl);
      this.currentUrl = null;
    }
  }

  dispose(): void {
    this.clear();
  }
}

export interface UseObjectUrlReturn {
  url: string | null;
  setUrl: (newUrl: string | null) => void;
  setFromBlob: (blob: Blob | null) => string | null;
  clear: () => void;
  lifecycle: ObjectUrlLifecycle;
}

/**
 * React hook that manages an Object URL's complete lifecycle.
 * - Automatically revokes the previous URL when a new Blob / URL is set.
 * - Automatically revokes the URL on explicit clear().
 * - Automatically revokes whatever current URL remains when unmounted,
 *   avoiding stale-closure leaks.
 */
export function useObjectUrl(initialUrl: string | null = null): UseObjectUrlReturn {
  const [url, setUrlState] = useState<string | null>(initialUrl);
  const lifecycleRef = useRef<ObjectUrlLifecycle | null>(null);

  if (!lifecycleRef.current) {
    lifecycleRef.current = new ObjectUrlLifecycle();
    if (initialUrl) {
      lifecycleRef.current.set(initialUrl);
    }
  }

  const lifecycle = lifecycleRef.current;

  const setUrl = useCallback((newUrl: string | null) => {
    lifecycle.set(newUrl);
    setUrlState(newUrl);
  }, [lifecycle]);

  const setFromBlob = useCallback((blob: Blob | null) => {
    const newUrl = lifecycle.createFromBlob(blob);
    setUrlState(newUrl);
    return newUrl;
  }, [lifecycle]);

  const clear = useCallback(() => {
    lifecycle.clear();
    setUrlState(null);
  }, [lifecycle]);

  useEffect(() => {
    return () => {
      lifecycle.dispose();
    };
  }, [lifecycle]);

  return {
    url,
    setUrl,
    setFromBlob,
    clear,
    lifecycle,
  };
}
