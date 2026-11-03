import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ServerSupabaseClients {
  admin: SupabaseClient;
  passwordVerifier: SupabaseClient;
}

let adminClient: SupabaseClient | null = null;
let overrideClients: ServerSupabaseClients | null = null;
let visitorClientFactoryForTest: ((token: string) => SupabaseClient) | null = null;

export function setServerSupabaseClientsForTest(clients: ServerSupabaseClients | null): void {
  overrideClients = clients;
}

export function setVisitorClientFactoryForTest(factory: ((token: string) => SupabaseClient) | null): void {
  visitorClientFactoryForTest = factory;
}

function requireServerValue(name: 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

function getPublishableKey(): string {
  const value = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY
  )?.trim();
  if (!value) throw new Error('Missing required server configuration: SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY');
  return value;
}

export function createVisitorScopedSupabaseClient(visitorToken: string): SupabaseClient {
  if (visitorClientFactoryForTest) {
    return visitorClientFactoryForTest(visitorToken);
  }
  const url = requireServerValue('SUPABASE_URL');
  const publishableKey = getPublishableKey();
  return createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${visitorToken}`,
      },
    },
  });
}

export function getServerSupabaseClients(): ServerSupabaseClients {
  if (overrideClients) return overrideClients;
  const url = requireServerValue('SUPABASE_URL');
  const secretKey = requireServerValue('SUPABASE_SECRET_KEY');
  const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

  adminClient ??= createClient(url, secretKey, { auth });
  return {
    admin: adminClient,
    // Password verification creates a user session, so it must never reuse the
    // privileged client or survive into another invocation.
    passwordVerifier: createClient(url, secretKey, { auth }),
  };
}
