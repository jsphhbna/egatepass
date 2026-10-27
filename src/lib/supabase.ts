import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browserRuntimeConfig } from '@/lib/runtimeConfig';

let browserClient: SupabaseClient | null = null;
let portalClient: SupabaseClient | null = null;
let recoveryClient: SupabaseClient | null = null;

if (browserRuntimeConfig.ok) {
  try {
    browserClient = createClient(
      browserRuntimeConfig.config.supabaseUrl,
      browserRuntimeConfig.config.supabasePublishableKey,
      {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: typeof window !== 'undefined' ? !window.location.pathname.startsWith('/reset-password') : true,
          storageKey: 'egatepass-operator-auth',
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

/**
 * Executes an application RPC explicitly within the 'api' schema.
 * Supabase client defaults to 'public', but all application RPCs reside in 'api'.
 */
export function apiRpc(
  client: SupabaseClient,
  fn: string,
  args?: Record<string, unknown>
) {
  return client.schema('api').rpc(fn, args);
}

export function requirePortalSupabase(): SupabaseClient {
  if (!browserRuntimeConfig.ok) {
    throw new Error('E-GatePass visitor services are not configured.');
  }
  portalClient ??= createClient(
    browserRuntimeConfig.config.supabaseUrl,
    browserRuntimeConfig.config.supabasePublishableKey,
    {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'egatepass-portal-auth',
      },
    },
  );
  return portalClient;
}

export function requireRecoverySupabase(): SupabaseClient {
  if (!browserRuntimeConfig.ok) {
    throw new Error('E-GatePass recovery services are not configured.');
  }
  recoveryClient ??= createClient(
    browserRuntimeConfig.config.supabaseUrl,
    browserRuntimeConfig.config.supabasePublishableKey,
    {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: true,
        storageKey: 'egatepass-recovery-auth',
      },
    },
  );
  return recoveryClient;
}

export function getSupabaseAvailabilityMessage(): string | null {
  if (!browserRuntimeConfig.ok) return browserRuntimeConfig.message;
  if (!supabase) return 'The visitor portal is available, but staff and device services could not start.';
  return null;
}