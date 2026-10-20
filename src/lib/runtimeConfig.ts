export interface BrowserRuntimeConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export type BrowserRuntimeConfigResult =
  | { ok: true; config: BrowserRuntimeConfig }
  | { ok: false; message: string };

function isAllowedSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function validateBrowserRuntimeConfig(
  values: Record<string, string | undefined>,
): BrowserRuntimeConfigResult {
  const supabaseUrl = values.VITE_SUPABASE_URL?.trim() ?? '';
  const supabasePublishableKey = values.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

  if (!supabaseUrl || !supabasePublishableKey) {
    return {
      ok: false,
      message: 'The visitor portal is available, but staff and device services are not configured.',
    };
  }

  if (!isAllowedSupabaseUrl(supabaseUrl)) {
    return {
      ok: false,
      message: 'The visitor portal is available, but the service configuration is invalid.',
    };
  }

  return {
    ok: true,
    config: { supabaseUrl, supabasePublishableKey },
  };
}

export const browserRuntimeConfig = validateBrowserRuntimeConfig(import.meta.env);
