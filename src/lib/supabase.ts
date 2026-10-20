import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browserRuntimeConfig } from '@/lib/runtimeConfig';

let browserClient: SupabaseClient | null = null;

if (browserRuntimeConfig.ok) {
  try {
    browserClient = createClient(
      browserRuntimeConfig.config.supabaseUrl,
      browserRuntimeConfig.config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  } catch (error) {
    console.error('Unable to initialize the application service.', error);
  }
}

export const supabase = browserClient;

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error('E-GatePass services are unavailable because browser configuration is missing or invalid.');
  }
  return supabase;
}

export function getSupabaseAvailabilityMessage(): string | null {
  if (!browserRuntimeConfig.ok) return browserRuntimeConfig.message;
  if (!supabase) return 'The visitor portal is available, but staff and device services could not start.';
  return null;
}
