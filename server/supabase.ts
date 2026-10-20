import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface ServerSupabaseClients {
  admin: SupabaseClient;
  passwordVerifier: SupabaseClient;
}

let adminClient: SupabaseClient | null = null;

function requireServerValue(name: 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

export function getServerSupabaseClients(): ServerSupabaseClients {
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
