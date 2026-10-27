import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import reauthenticateHandler from '../server/routes/device/reauthenticate.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { getKioskReauthErrorMessage } from '../src/components/KioskPrinterSettingsModal';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase', 'migrations');

async function setupSupabaseEmulation(db: PGlite) {
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
      end if;
    end
    $$;

    create table if not exists auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      encrypted_password text,
      is_anonymous boolean default false,
      raw_app_meta_data jsonb default '{}'::jsonb,
      raw_user_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create or replace function auth.uid() returns uuid as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
        nullif(current_setting('my.auth.uid', true), '')::uuid,
        '00000000-0000-4000-a000-000000000001'::uuid
      );
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'authenticated'::text
      );
    $$ language sql stable;

    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;

    create table if not exists storage.buckets (
      id text primary key,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );

    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      last_accessed_at timestamptz,
      metadata jsonb
    );

    do $$
    begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end
    $$;
  `);
}

async function applyAllMigrations(db: PGlite): Promise<void> {
  await setupSupabaseEmulation(db);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
}

describe('CL-T01 & CL-T02: Kiosk Device Password Reauthentication & PIN System Elimination', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
    setServerSupabaseClientsForTest(null);
  });

  it('CL-T02: proves obsolete separate PIN tables and RPCs are dropped in migration 31', async () => {
    // Assert table does not exist
    const tableRes = await db.query(`
      select 1 from information_schema.tables
      where table_schema = 'private' and table_name = 'kiosk_operator_config';
    `);
    expect(tableRes.rows.length).toBe(0);

    // Assert verify RPC does not exist
    const verifyRpcRes = await db.query(`
      select 1 from information_schema.routines
      where routine_schema = 'api' and routine_name = 'verify_kiosk_operator_pin';
    `);
    expect(verifyRpcRes.rows.length).toBe(0);

    // Assert set RPC does not exist
    const setRpcRes = await db.query(`
      select 1 from information_schema.routines
      where routine_schema = 'api' and routine_name = 'admin_set_kiosk_operator_pin';
    `);
    expect(setRpcRes.rows.length).toBe(0);
  });

  it('CL-T02: asserts active source/runtime contains no separate PIN artifacts', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const serverDir = path.resolve(process.cwd(), 'server');

    function searchDir(dir: string): string[] {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const item of list) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results = results.concat(searchDir(full));
        } else if (item.endsWith('.ts') || item.endsWith('.tsx')) {
          results.push(full);
        }
      }
      return results;
    }

    const files = [...searchDir(srcDir), ...searchDir(serverDir)];
    const forbiddenPatterns = [
      'verify_kiosk_operator_pin',
      'admin_set_kiosk_operator_pin',
      'kiosk_operator_config',
      'Device Operator PIN',
    ];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(
          content.includes(pattern),
          `Found forbidden PIN artifact "${pattern}" in active source file: ${file}`
        ).toBe(false);
      }
    }
  });

  it('CL-T01: kiosk device password reauthentication endpoint authorizes only matching kiosk device', async () => {
    const KIOSK_ID = '00000000-0000-4000-a000-000000000050';
    const OTHER_KIOSK_ID = '00000000-0000-4000-a000-000000000051';
    const STAFF_ID = '00000000-0000-4000-a000-000000000052';

    // Mock Supabase admin client
    const mockAdmin: any = {
      auth: {
        getUser: async (token: string) => {
          if (token === 'kiosk-token') {
            return {
              data: {
                user: { id: KIOSK_ID, email: 'kiosk-01@devices.egatepass.invalid' },
              },
              error: null,
            };
          }
          if (token === 'other-kiosk-token') {
            return {
              data: {
                user: { id: OTHER_KIOSK_ID, email: 'kiosk-02@devices.egatepass.invalid' },
              },
              error: null,
            };
          }
          if (token === 'staff-token') {
            return {
              data: {
                user: { id: STAFF_ID, email: 'staff@earist.edu.ph' },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error('invalid_token') };
        },
      },
      from: (table: string) => {
        if (table === 'devices') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => {
                  if (val === KIOSK_ID) {
                    return {
                      data: { user_id: KIOSK_ID, type: 'kiosk', status: 'active', alias: 'kiosk-01' },
                      error: null,
                    };
                  }
                  if (val === OTHER_KIOSK_ID) {
                    return {
                      data: { user_id: OTHER_KIOSK_ID, type: 'kiosk', status: 'active', alias: 'kiosk-02' },
                      error: null,
                    };
                  }
                  // Staff ID is not in devices table
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        return {};
      },
    };

    // Mock passwordVerifier client
    const mockVerifier: any = {
      auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          if (email === 'kiosk-01@devices.egatepass.invalid' && password === 'ValidKioskPass123!') {
            return {
              data: { user: { id: KIOSK_ID } },
              error: null,
            };
          }
          if (email === 'kiosk-02@devices.egatepass.invalid' && password === 'OtherKioskPass456!') {
            return {
              data: { user: { id: OTHER_KIOSK_ID } },
              error: null,
            };
          }
          if (email === 'staff@earist.edu.ph' && password === 'StaffPass789!') {
            return {
              data: { user: { id: STAFF_ID } },
              error: null,
            };
          }
          return { data: { user: null }, error: { message: 'Invalid login credentials' } };
        },
        signOut: async () => ({ error: null }),
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      passwordVerifier: mockVerifier,
    });

    // 1. Wrong current device password -> 401
    const wrongPassReq = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'WrongPassword999!' }),
    });
    const wrongPassRes = await reauthenticateHandler.fetch(wrongPassReq);
    expect(wrongPassRes.status).toBe(401);
    const wrongPassBody = await wrongPassRes.json();
    expect(wrongPassBody.error).toBe('invalid_device_password');

    // 2. Staff user calling endpoint -> 403 (kiosk_device_required)
    const staffReq = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({ password: 'StaffPass789!' }),
    });
    const staffRes = await reauthenticateHandler.fetch(staffReq);
    expect(staffRes.status).toBe(403);
    const staffBody = await staffRes.json();
    expect(staffBody.error).toBe('kiosk_device_required');

    // 3. Another kiosk device password supplied to this kiosk session -> 401
    const crossKioskReq = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'OtherKioskPass456!' }),
    });
    const crossKioskRes = await reauthenticateHandler.fetch(crossKioskReq);
    expect(crossKioskRes.status).toBe(401);
    const crossKioskBody = await crossKioskRes.json();
    expect(crossKioskBody.error).toBe('invalid_device_password');

    // 4. Correct password for CURRENT kiosk device identity -> 200 OK
    const correctReq = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });
    const correctRes = await reauthenticateHandler.fetch(correctReq);
    expect(correctRes.status).toBe(200);
    const correctBody = await correctRes.json();
    expect(correctBody.ok).toBe(true);
  });

  it('HOTFIX: regression test: passwordVerifier.auth.signOut({ scope: "local" }) preserves original kiosk session across consecutive reauthentications', async () => {
    const KIOSK_ID = '00000000-0000-4000-a000-000000000050';
    const activeSessions = new Set(['kiosk-token']);

    const mockAdmin: any = {
      auth: {
        getUser: vi.fn(async (token: string) => {
          if (activeSessions.has(token)) {
            return {
              data: {
                user: { id: KIOSK_ID, email: 'kiosk-01@devices.egatepass.invalid' },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error('invalid_token') };
        }),
      },
      from: (table: string) => {
        if (table === 'devices') {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () => {
                  if (val === KIOSK_ID) {
                    return {
                      data: { user_id: KIOSK_ID, type: 'kiosk', status: 'active', alias: 'kiosk-01' },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        return {};
      },
    };

    const signOutCalls: Array<any> = [];
    const mockVerifier: any = {
      auth: {
        signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
          if (email === 'kiosk-01@devices.egatepass.invalid' && password === 'ValidKioskPass123!') {
            return {
              data: { user: { id: KIOSK_ID } },
              error: null,
            };
          }
          return { data: { user: null }, error: { message: 'Invalid login credentials' } };
        }),
        signOut: vi.fn(async (options?: { scope?: string }) => {
          signOutCalls.push(options);
          // If signOut is called WITHOUT { scope: 'local' } (i.e. default global signOut in Supabase),
          // it revokes all active sessions for this user, including the kiosk's active browser bearer!
          if (!options || options.scope !== 'local') {
            activeSessions.clear();
          }
          return { error: null };
        }),
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      passwordVerifier: mockVerifier,
    });

    // Request 1: Kiosk bearer + correct password
    const req1 = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });
    const res1 = await reauthenticateHandler.fetch(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);

    // Assert: passwordVerifier.auth.signOut was called with exactly { scope: 'local' }
    expect(mockVerifier.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(signOutCalls).toEqual([{ scope: 'local' }]);
    // Assert: kiosk session is still active
    expect(activeSessions.has('kiosk-token')).toBe(true);

    // Request 2: Using the SAME original kiosk bearer + same correct password
    const req2 = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });
    const res2 = await reauthenticateHandler.fetch(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.ok).toBe(true);
    expect(mockVerifier.auth.signOut).toHaveBeenCalledTimes(2);
    expect(signOutCalls).toEqual([{ scope: 'local' }, { scope: 'local' }]);
    expect(activeSessions.has('kiosk-token')).toBe(true);
  });

  it('HOTFIX: proves that accidental global signout revokes original kiosk session and causes Request 2 to fail with 401 invalid_session', async () => {
    const KIOSK_ID = '00000000-0000-4000-a000-000000000050';
    const activeSessions = new Set(['kiosk-token']);

    const mockAdmin: any = {
      auth: {
        getUser: vi.fn(async (token: string) => {
          if (activeSessions.has(token)) {
            return {
              data: {
                user: { id: KIOSK_ID, email: 'kiosk-01@devices.egatepass.invalid' },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: new Error('invalid_token') };
        }),
      },
      from: (table: string) => {
        if (table === 'devices') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { user_id: KIOSK_ID, type: 'kiosk', status: 'active', alias: 'kiosk-01' },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    // Simulate buggy global sign-out behavior
    const mockVerifierBuggy: any = {
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: { id: KIOSK_ID } },
          error: null,
        })),
        signOut: vi.fn(async () => {
          // Buggy behavior: global signOut revokes kiosk-token
          activeSessions.clear();
          return { error: null };
        }),
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      passwordVerifier: mockVerifierBuggy,
    });

    // Request 1 passes
    const req1 = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });
    const res1 = await reauthenticateHandler.fetch(req1);
    expect(res1.status).toBe(200);

    // Request 2 immediately fails with 401 invalid_session because kiosk session was globally destroyed!
    const req2 = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });
    const res2 = await reauthenticateHandler.fetch(req2);
    expect(res2.status).toBe(401);
    const body2 = await res2.json();
    expect(body2.error).toBe('invalid_session');
  });

  it('HOTFIX: Section 5: getVerifiedSessionContext failure returns HTTP 401 { error: "invalid_session" } and NOT 500 internal_error', async () => {
    const mockAdmin: any = {
      auth: {
        getUser: vi.fn(async () => {
          return { data: { user: null }, error: new Error('session_expired_or_revoked') };
        }),
      },
      from: () => ({}),
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      passwordVerifier: {} as any,
    });

    const req = new Request('http://localhost/api/device/reauthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer expired-kiosk-token',
      },
      body: JSON.stringify({ password: 'ValidKioskPass123!' }),
    });

    const res = await reauthenticateHandler.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid_session');
    expect(body.error).not.toBe('internal_error');
  });

  it('HOTFIX: Section 5: frontend getKioskReauthErrorMessage truthfully differentiates error codes', () => {
    // 401 invalid_device_password
    expect(getKioskReauthErrorMessage(401, 'invalid_device_password')).toBe(
      'Invalid kiosk device password.'
    );

    // 401 invalid_session
    expect(getKioskReauthErrorMessage(401, 'invalid_session')).toBe(
      'Kiosk session expired. Please sign in to the kiosk again.'
    );

    // 401 authentication_required
    expect(getKioskReauthErrorMessage(401, 'authentication_required')).toBe(
      'Kiosk session expired. Please sign in to the kiosk again.'
    );

    // 403 access_denied / kiosk_device_required
    expect(getKioskReauthErrorMessage(403, 'kiosk_device_required')).toBe(
      'Access denied: Kiosk device account required'
    );

    // 500 internal_error
    expect(getKioskReauthErrorMessage(500, 'internal_error')).toBe(
      'Printer settings could not be unlocked due to a server error.'
    );

    // 502 or other server error
    expect(getKioskReauthErrorMessage(502, 'bad_gateway')).toBe(
      'Printer settings could not be unlocked due to a server error.'
    );
  });
});

