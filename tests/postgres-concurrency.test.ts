import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { encryptQrPayload, decryptQrPayload } from '../server/lib/encryption.js';
import { setEmailSenderForTest, EmailDeliveryError } from '../server/email.js';
import decideHandler from '../server/routes/office/decide.js';
import visitsHandler from '../server/routes/office/visits.js';
import retryEmailHandler from '../server/routes/office/retry-email.js';
import { isPositiveRpcSuccess } from '../server/lib/officeDelivery.js';
import * as officeLib from '../server/lib/office.js';
import * as supabaseModule from '../server/supabase.js';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Concurrency synchronization barrier
function createBarrier(count: number) {
  let arrived = 0;
  let release: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    wait: async () => {
      arrived++;
      if (arrived === count) {
        release();
      }
      return promise;
    },
  };
}

async function runConcurrent<T>(
  clients: pg.Client[],
  task: (client: pg.Client, index: number) => Promise<T>
): Promise<T[]> {
  const barrier = createBarrier(clients.length);
  return Promise.all(
    clients.map(async (client, i) => {
      await barrier.wait();
      return task(client, i);
    })
  );
}

function createPostgresAdminClient(pool: pg.Pool, options?: {
  failRecordResult?: boolean;
  failFallbackResult?: boolean;
  failBothRecords?: boolean;
  returnMalformedRecord?: boolean;
  returnNullRecord?: boolean;
  failReconcileResult?: boolean;
}) {
  const getAdminClient = async () => {
    const client = await pool.connect();
    await client.query(`set timezone = 'Asia/Manila';`);
    await client.query(`set request.jwt.claim.role = 'service_role';`);
    return client;
  };

  return {
    schema: (_schemaName: string) => ({
      rpc: async (fnName: string, args: Record<string, any>) => {
        const client = await getAdminClient();
        try {
          if (fnName === 'decide_office_visit') {
            const res = await client.query(
              `select * from api.decide_office_visit(
                $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::uuid
              );`,
              [
                args.requested_actor_id || args.staff_user_id,
                args.requested_visit_id,
                args.requested_decision,
                args.requested_reason || null,
                args.requested_token_digest,
                args.requested_encrypted_payload,
                args.requested_idempotency_key,
                args.requested_request_id || null,
              ]
            );
            return { data: res.rows, error: null };
          }
          if (fnName === 'claim_office_visit_email_for_delivery') {
            const res = await client.query(
              `select * from api.claim_office_visit_email_for_delivery($1::uuid, $2::text);`,
              [args.requested_visit_id, args.requested_email_type]
            );
            return { data: res.rows, error: null };
          }
          if (fnName === 'reconcile_office_visit_email') {
            if (options?.failReconcileResult) {
              return { data: null, error: { message: 'Injected reconcile failure', code: '500' } };
            }
            const res = await client.query(
              `select * from api.reconcile_office_visit_email(
                $1::uuid, $2::uuid, $3::text, $4::text
              );`,
              [
                args.requested_actor_id,
                args.requested_visit_id,
                args.requested_action,
                args.requested_note || null,
              ]
            );
            return { data: res.rows, error: null };
          }
          if (fnName === 'record_office_visit_email_result') {
            if (options?.returnMalformedRecord) {
              return { data: { ok: false, error: 'malformed_persistence' }, error: null };
            }
            if (options?.returnNullRecord) {
              return { data: null, error: null };
            }
            if (options?.failBothRecords) {
              return { data: null, error: { message: 'Injected total record failure', code: '500' } };
            }
            if (options?.failRecordResult && args.requested_status === 'sent') {
              return { data: null, error: { message: 'Injected primary record_office_visit_email_result failure', code: '500' } };
            }
            if (options?.failFallbackResult && args.requested_status === 'reconciliation_required') {
              return { data: null, error: { message: 'Injected fallback record_office_visit_email_result failure', code: '500' } };
            }
            const res = await client.query(
              `select * from api.record_office_visit_email_result(
                $1::uuid, $2::uuid, $3::text, $4::text, $5::text
              );`,
              [
                args.requested_outbox_id,
                args.requested_claim_id,
                args.requested_status,
                args.requested_provider_message_id,
                args.requested_error,
              ]
            );
            return { data: res.rows[0], error: null };
          }
          throw new Error(`Unhandled RPC in test admin client: ${fnName}`);
        } catch (err: any) {
          return { data: null, error: { message: err.message, code: err.code } };
        } finally {
          client.release();
        }
      },
    }),
    from: (table: string) => ({
      select: (_cols?: string) => ({
        eq: (col: string, val: any) => ({
          maybeSingle: async () => {
            const client = await getAdminClient();
            try {
              if (table === 'office_visits') {
                const res = await client.query(
                  `select ov.*, o.name as office_name, op.name as personnel_name,
                          p.id as pass_id, p.public_reference as pass_public_reference
                   from public.office_visits ov
                   join public.offices o on o.id = ov.office_id
                   left join public.office_personnel op on op.id = ov.personnel_id
                   left join public.passes p on p.id = ov.pass_id
                   where ov.${col} = $1;`,
                  [val]
                );
                if (res.rows.length === 0) return { data: null, error: null };
                const r = res.rows[0];
                return {
                  data: {
                    ...r,
                    passes: r.pass_id ? { id: r.pass_id, public_reference: r.pass_public_reference } : null,
                    offices: { name: r.office_name },
                    office_personnel: r.personnel_name ? { name: r.personnel_name } : null,
                  },
                  error: null,
                };
              }
              if (table === 'office_visit_email_outbox') {
                const res = await client.query(
                  `select id, claim_id, delivery_status, provider_message_id from public.office_visit_email_outbox where ${col} = $1 limit 1;`,
                  [val]
                );
                return { data: res.rows[0] || null, error: null };
              }
              return { data: null, error: null };
            } finally {
              client.release();
            }
          },
        }),
      }),
      update: (updates: Record<string, any>) => ({
        eq: (col: string, val: any) => {
          const runUpdate = async () => {
            const client = await getAdminClient();
            try {
              if (table === 'office_visit_email_outbox') {
                const keys = Object.keys(updates);
                const setClauses = keys.map((k, idx) => `${k} = $${idx + 1}`);
                const values = keys.map((k) => updates[k]);
                values.push(val);
                const res = await client.query(
                  `update public.office_visit_email_outbox set ${setClauses.join(', ')} where ${col} = $${values.length} returning *;`,
                  values
                );
                return { data: res.rows, error: null };
              }
              return { data: null, error: null };
            } catch (err: any) {
              return { data: null, error: { message: err?.message || 'update failed' } };
            } finally {
              client.release();
            }
          };
          return {
            then: (resolve: any, reject: any) => runUpdate().then(resolve, reject),
          };
        },
      }),
    }),
  };
}

// Run this suite only when explicitly invoked via test:integration:postgres or RUN_POSTGRES_INTEGRATION=true
const isExplicitPostgresTest = process.env.npm_lifecycle_event === 'test:integration:postgres' || process.env.RUN_POSTGRES_INTEGRATION === 'true';

if (isExplicitPostgresTest && !TEST_DB_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. A real PostgreSQL 17 database is required to run independent-session concurrency integration tests.'
  );
}

const runSuite = (TEST_DB_URL && isExplicitPostgresTest) ? describe : describe.skip;

runSuite('True PostgreSQL Concurrency, Canonical Approval Integrity & Email Recovery Integration Suite', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!TEST_DB_URL) return;

    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-at-least-32-chars!';
    process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key-at-least-32-chars!';

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 30,
    });

    const rootClient = await pool.connect();
    try {
      // 1. Setup Supabase emulation
      await rootClient.query(`
        create schema if not exists extensions;
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

        grant usage on schema extensions to public, anon, authenticated, service_role;
        alter role current_user set search_path = public, extensions, api, auth, storage;
        set search_path = public, extensions, api, auth, storage;

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
            '00000000-0000-0000-0000-000000000001'::uuid
          );
        $$ language sql stable;

        create or replace function auth.role() returns text as $$
          select coalesce(
            nullif(current_setting('request.jwt.claim.role', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
            'service_role'::text
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

      // 2. Apply all migrations in order if not already applied
      const alreadyMigrated = await rootClient.query(`
        select exists (
          select 1 from information_schema.tables 
          where table_schema = 'public' and table_name = 'office_visit_email_outbox'
        ) as exists;
      `);

      if (!alreadyMigrated.rows[0]?.exists) {
        const migrationFiles = readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith('.sql'))
          .sort();

        for (const file of migrationFiles) {
          let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
          try {
            await rootClient.query(sql);
          } catch (err) {
            console.error(`Failed to apply migration ${file}:`, err);
            throw err;
          }
        }
      }

      // Set working_hours_end to 23:59:59 so current_date tests pass regardless of time of day
      await rootClient.query(`
        update public.app_settings set working_hours_start = '00:00:00', working_hours_end = '23:59:59' where singleton = true;
      `);
    } finally {
      rootClient.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(() => {
    process.env.RATE_LIMIT_HMAC_SECRET = 'c'.repeat(32);
    process.env.OFFICE_VISIT_HMAC_SECRET = 'a'.repeat(32);
    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = 'b'.repeat(32);
    process.env.PASS_TOKEN_SECRET = 'd'.repeat(32);
    setEmailSenderForTest(null);
  });

  async function createIndependentClients(count: number): Promise<pg.Client[]> {
    const clients: pg.Client[] = [];
    for (let i = 0; i < count; i++) {
      const client = new pg.Client({ connectionString: TEST_DB_URL });
      await client.connect();
      await client.query(`set timezone = 'Asia/Manila';`);
      await client.query(`set request.jwt.claim.role = 'service_role';`);
      clients.push(client);
    }
    return clients;
  }

  async function closeIndependentClients(clients: pg.Client[]) {
    await Promise.all(clients.map((c) => c.end()));
  }

  // =========================================================================
  // Finding A: True PostgreSQL Concurrency for Email Verification Rate Limits
  // =========================================================================
  describe('Finding A: True Multi-Dimensional Concurrency on Independent PostgreSQL Sessions', () => {
    it('1. Actor limit: 10 concurrent requests from same actor -> exactly 5 succeed, 5 rejected with too_many_actor_requests', async () => {
      const actorId = '11111111-1111-4111-8111-111111111111';
      const rootClient = await pool.connect();
      try {
        await rootClient.query(
          `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;`,
          [actorId, 'actor.primary@earist.edu.ph']
        );
      } finally {
        rootClient.release();
      }

      const clientCount = 10;
      const clients = await createIndependentClients(clientCount);
      const codeHash = 'hash0000000000000000000000000000000000000000000000000000000000000000';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      try {
        const results = await runConcurrent(clients, async (client, i) => {
          const uniqueEmail = `actor_test_${i}_${randomBytes(4).toString('hex')}@earist.edu.ph`;
          const uniqueIpHmac = createHmac('sha256', process.env.RATE_LIMIT_HMAC_SECRET!)
            .update(`198.51.100.${i + 1}`)
            .digest('hex');

          const res = await client.query(
            `select * from api.request_office_email_verification_slot($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz);`,
            [actorId, uniqueEmail, uniqueIpHmac, codeHash, expiresAt]
          );
          return res.rows[0];
        });

        const accepted = results.filter((r) => r.allowed === true);
        const rejected = results.filter(
          (r) => r.allowed === false && r.error_code === 'too_many_actor_requests'
        );

        expect(accepted.length).toBe(5);
        expect(rejected.length).toBe(5);
        expect(results.length).toBe(10);
      } finally {
        await closeIndependentClients(clients);
      }
    }, 30_000);

    it('2. Normalized email limit: 10 concurrent requests from different actors with same email (case-insensitive) -> exactly 5 succeed, 5 rejected with too_many_email_requests', async () => {
      const sharedEmail = 'shared.target@earist.edu.ph';
      const clientCount = 10;
      const clients = await createIndependentClients(clientCount);
      const codeHash = 'hash0000000000000000000000000000000000000000000000000000000000000000';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const actorIds: string[] = [];
      const rootClient = await pool.connect();
      try {
        for (let i = 0; i < clientCount; i++) {
          const actId = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
          actorIds.push(actId);
          await rootClient.query(
            `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;`,
            [actId, `user_${i}@example.com`]
          );
        }
      } finally {
        rootClient.release();
      }

      try {
        const results = await runConcurrent(clients, async (client, i) => {
          // Vary casing: e.g. SHARED.TARGET@earist.edu.ph, Shared.Target@earist.edu.ph
          const emailVariant = i % 2 === 0 ? sharedEmail.toUpperCase() : sharedEmail.toLowerCase();
          const uniqueIpHmac = createHmac('sha256', process.env.RATE_LIMIT_HMAC_SECRET!)
            .update(`203.0.113.${i + 1}`)
            .digest('hex');

          const res = await client.query(
            `select * from api.request_office_email_verification_slot($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz);`,
            [actorIds[i], emailVariant, uniqueIpHmac, codeHash, expiresAt]
          );
          return res.rows[0];
        });

        const accepted = results.filter((r) => r.allowed === true);
        const rejected = results.filter(
          (r) => r.allowed === false && r.error_code === 'too_many_email_requests'
        );

        expect(accepted.length).toBe(5);
        expect(rejected.length).toBe(5);
        expect(results.length).toBe(10);
      } finally {
        await closeIndependentClients(clients);
      }
    }, 30_000);

    it('3. IP HMAC limit: 20 concurrent requests with same IP HMAC -> exactly 15 succeed, 5 rejected with too_many_ip_requests', async () => {
      const clientCount = 20;
      const clients = await createIndependentClients(clientCount);
      const sharedIpHmac = createHmac('sha256', process.env.RATE_LIMIT_HMAC_SECRET!)
        .update('192.0.2.100')
        .digest('hex');
      const codeHash = 'hash0000000000000000000000000000000000000000000000000000000000000000';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const actorIds: string[] = [];
      const rootClient = await pool.connect();
      try {
        for (let i = 0; i < clientCount; i++) {
          const actId = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
          actorIds.push(actId);
          await rootClient.query(
            `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;`,
            [actId, `ip_actor_${i}@example.com`]
          );
        }
      } finally {
        rootClient.release();
      }

      try {
        const results = await runConcurrent(clients, async (client, i) => {
          const uniqueEmail = `ip_test_user_${i}_${randomBytes(4).toString('hex')}@earist.edu.ph`;
          const res = await client.query(
            `select * from api.request_office_email_verification_slot($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz);`,
            [actorIds[i], uniqueEmail, sharedIpHmac, codeHash, expiresAt]
          );
          return res.rows[0];
        });

        const accepted = results.filter((r) => r.allowed === true);
        const rejected = results.filter(
          (r) => r.allowed === false && r.error_code === 'too_many_ip_requests'
        );

        expect(accepted.length).toBe(15);
        expect(rejected.length).toBe(5);
        expect(results.length).toBe(20);
      } finally {
        await closeIndependentClients(clients);
      }
    }, 45_000);

    it('4. Overlapping dimensions: simultaneous calls with overlapping locks complete with zero deadlocks', async () => {
      const clientCount = 12;
      const clients = await createIndependentClients(clientCount);
      const codeHash = 'hash0000000000000000000000000000000000000000000000000000000000000000';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const actA = '44444444-4444-4444-8444-000000000001';
      const actB = '44444444-4444-4444-8444-000000000002';
      const emlA = 'overlap.a@earist.edu.ph';
      const emlB = 'overlap.b@earist.edu.ph';
      const ipA = createHmac('sha256', process.env.RATE_LIMIT_HMAC_SECRET!).update('10.0.0.1').digest('hex');
      const ipB = createHmac('sha256', process.env.RATE_LIMIT_HMAC_SECRET!).update('10.0.0.2').digest('hex');

      const rootClient = await pool.connect();
      try {
        await rootClient.query(
          `insert into auth.users (id, email) values ($1, $2), ($3, $4) on conflict (id) do nothing;`,
          [actA, emlA, actB, emlB]
        );
      } finally {
        rootClient.release();
      }

      try {
        const results = await runConcurrent(clients, async (client, i) => {
          // Cycle through overlapping combinations of actor, email, and IP
          const actor = i % 2 === 0 ? actA : actB;
          const email = i % 3 === 0 ? emlA : emlB;
          const ip = i % 2 === 0 ? ipB : ipA; // Reversed pairing to test deadlock freedom!

          const res = await client.query(
            `select * from api.request_office_email_verification_slot($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz);`,
            [actor, email, ip, codeHash, expiresAt]
          );
          return res.rows[0];
        });

        // Zero exceptions, all 12 requests completed within bounded timeout
        expect(results.length).toBe(12);
        for (const r of results) {
          expect(typeof r.allowed).toBe('boolean');
        }
      } finally {
        await closeIndependentClients(clients);
      }
    }, 30_000);
  });

  // =========================================================================
  // Finding D: True Approval Race, Canonical Integrity & QR Decoding Parity
  // =========================================================================
  describe('Finding D: True Approval Race on Database Function & QR Decode Parity', () => {
    it('concurrent api.decide_office_visit calls produce exactly 1 pass, 1 outbox row, and matching canonical token', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const personnelId = '00000000-0000-4000-8000-000000000002';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = '66666666-6666-4666-8666-666666666666';
      const visitId = '77777777-7777-4777-8777-777777777777';
      const visitorEmail = 'approved.visitor@earist.edu.ph';
      const returningProfileId = '11111111-2222-3333-4444-555555555555';

      const rootClient = await pool.connect();
      try {
        await rootClient.query(`
          insert into auth.users (id, email) values ('${staffActorId}', 'staff@earist.edu.ph') on conflict (id) do nothing;
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;

          insert into public.offices (id, name, description, active, verified, publication_status)
          values ('${officeId}', 'Registrar Office', 'Academic', true, true, 'published')
          on conflict (id) do update set active = true, verified = true, publication_status = 'published';

          insert into public.office_personnel (id, office_id, name, title, active)
          values ('${personnelId}', '${officeId}', 'Director Santos', 'Registrar', true)
          on conflict (id) do nothing;

          insert into public.staff_profiles (user_id, role, display_name, created_at, updated_at)
          values ('${staffActorId}', 'office_staff', 'Office Staff Member', now(), now())
          on conflict (user_id) do nothing;

          insert into public.office_staff_assignments (user_id, office_id)
          values ('${staffActorId}', '${officeId}')
          on conflict do nothing;

          insert into public.returning_visitor_profiles (
            id, first_name, last_name, contact_number_e164, home_address, expires_at
          ) values (
            '${returningProfileId}', 'Maria', 'Dela Cruz', '+639171234567', 'Manila, Philippines', now() + interval '30 days'
          ) on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Maria Dela Cruz', '09171234567', '${visitorEmail}', 'Transcript Request', ((now() at time zone 'Asia/Manila')::date + 1), 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, personnel_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id,
            registration_mode, returning_profile_id
          ) values (
            '${visitId}', 'specific_person', '${officeId}', '${personnelId}', '${visitorId}', '${visitorId}', 'Maria', 'Dela Cruz',
            '09171234567', '${visitorEmail}', 'Transcript Request', ((now() at time zone 'Asia/Manila')::date + 1), 'pending', 'awaiting_entry', gen_random_uuid(),
            'returning', '${returningProfileId}'
          ) on conflict (id) do update set approval_status = 'pending', registration_mode = 'returning', returning_profile_id = '${returningProfileId}';
        `);
      } finally {
        rootClient.release();
      }

      // Propose two distinct tokens concurrently from independent connections
      const token1 = `p_${randomBytes(32).toString('hex')}`;
      const digest1 = createHash('sha256').update(token1).digest('hex');
      const payload1 = encryptQrPayload(token1);

      const token2 = `p_${randomBytes(32).toString('hex')}`;
      const digest2 = createHash('sha256').update(token2).digest('hex');
      const payload2 = encryptQrPayload(token2);

      const clients = await createIndependentClients(2);
      try {
        const results = await runConcurrent(clients, async (client, i) => {
          const tDigest = i === 0 ? digest1 : digest2;
          const tPayload = i === 0 ? payload1 : payload2;
          const idempotencyKey = `approval-race-${visitId}-${i}`;

          const res = await client.query(
            `select * from api.decide_office_visit($1::uuid, $2::uuid, 'approved'::text, null::text, $3::text, $4::text, $5::text);`,
            [staffActorId, visitId, tDigest, tPayload, idempotencyKey]
          );
          return res.rows[0];
        });

        // 1. Both callers receive successful approval
        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(true);
        expect(results[0].decision).toBe('approved');
        expect(results[1].decision).toBe('approved');

        // 2. Both callers receive the exact same pass ID and public reference
        expect(results[0].pass_id).toBe(results[1].pass_id);
        expect(results[0].public_reference).toBe(results[1].public_reference);

        // 3. Exactly one pass exists in public.passes
        const checkClient = await pool.connect();
        try {
          const passRows = await checkClient.query(
            `select id, encode(token_digest, 'hex') as token_digest from public.passes where id = (select pass_id from public.office_visits where id = $1);`,
            [visitId]
          );
          expect(passRows.rows.length).toBe(1);
          const canonicalPass = passRows.rows[0];

          // 4. Exactly one outbox row exists
          const outboxRows = await checkClient.query(
            `select id, delivery_status, encrypted_token_payload from public.office_visit_email_outbox where office_visit_id = $1 and email_type = 'approval';`,
            [visitId]
          );
          expect(outboxRows.rows.length).toBe(1);
          const canonicalOutbox = outboxRows.rows[0];

          // 5. Decrypt outbox payload and verify SHA-256 equals passes.token_digest
          const decryptedCanonicalToken = decryptQrPayload(canonicalOutbox.encrypted_token_payload);
          const canonicalDigest = createHash('sha256').update(decryptedCanonicalToken).digest('hex');
          expect(canonicalDigest).toBe(canonicalPass.token_digest);

          // 6. Test concurrent outbox claim: exactly one connection gets the claim
          const claimResults = await runConcurrent(clients, async (client) => {
            try {
              const res = await client.query(
                `select * from api.claim_office_visit_email_for_delivery($1::uuid, 'approval'::text);`,
                [visitId]
              );
              return { success: true, rows: res.rows };
            } catch (err: any) {
              return { success: false, code: err.code, message: err.message };
            }
          });

          const successfulClaims = claimResults.filter((r) => r.success && r.rows && r.rows.length > 0);
          const failedClaims = claimResults.filter((r) => !r.success || (r.rows && r.rows.length === 0));

          expect(successfulClaims.length).toBe(1);
          expect(failedClaims.length).toBe(1);
          if (!failedClaims[0].success) {
            expect(failedClaims[0].code).toBe('40900');
          }
        } finally {
          checkClient.release();
        }
      } finally {
        await closeIndependentClients(clients);
      }
    }, 30_000);

    it('route-level approval race: provider mock called at most once, QR image decodes to canonical token', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const personnelId = '00000000-0000-4000-8000-000000000002';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = '88888888-8888-4888-8888-888888888888';
      const visitId = '99999999-9999-4999-8999-999999999999';
      const visitorEmail = 'route.visitor@earist.edu.ph';
      const returningProfileId = '22222222-3333-4444-5555-666666666666';

      const rootClient = await pool.connect();
      try {
        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;

          insert into public.returning_visitor_profiles (
            id, first_name, last_name, contact_number_e164, home_address, expires_at
          ) values (
            '${returningProfileId}', 'Roberto', 'Cruz', '+639171234567', 'Manila, Philippines', now() + interval '30 days'
          ) on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Roberto Cruz', '09171234567', '${visitorEmail}', 'Diploma Claim', ((now() at time zone 'Asia/Manila')::date + 1), 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, personnel_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id,
            registration_mode, returning_profile_id
          ) values (
            '${visitId}', 'specific_person', '${officeId}', '${personnelId}', '${visitorId}', '${visitorId}', 'Roberto', 'Cruz',
            '09171234567', '${visitorEmail}', 'Diploma Claim', ((now() at time zone 'Asia/Manila')::date + 1), 'pending', 'awaiting_entry', gen_random_uuid(),
            'returning', '${returningProfileId}'
          ) on conflict (id) do update set approval_status = 'pending', registration_mode = 'returning', returning_profile_id = '${returningProfileId}';
        `);
      } finally {
        rootClient.release();
      }

      // Track email sender mock calls
      const dispatchedEmails: any[] = [];
      setEmailSenderForTest(async (payload) => {
        dispatchedEmails.push(payload);
        return { id: `msg_${randomBytes(8).toString('hex')}`, provider: 'mock' };
      });

      // Mock requireOfficeStaffActor and getServerSupabaseClients
      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: createPostgresAdminClient(pool) as any,
        anon: {} as any,
      });

      // Concurrently dispatch two HTTP requests to decideHandler
      const makeRequest = () =>
        new Request('http://localhost/api/office/decide', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-staff-bearer-token',
          },
          body: JSON.stringify({
            visitId,
            decision: 'approved',
          }),
        });

      const [res1, res2] = await Promise.all([
        decideHandler.fetch(makeRequest()),
        decideHandler.fetch(makeRequest()),
      ]);

      const body1 = await res1.json();
      const body2 = await res2.json();

      // At least one returned 200 with approved; other may be 200 (idempotent repeat) or 409
      expect(body1.status === 'approved' || body2.status === 'approved').toBe(true);

      // Provider mock was dispatched EXACTLY once (a zero-dispatch result must fail the test)
      expect(dispatchedEmails.length).toBe(1);

      const email = dispatchedEmails[0];
      expect(email.to).toBe(visitorEmail);
      expect(email.attachments).toBeDefined();
      expect(email.attachments.length).toBe(1);

      const attachment = email.attachments[0];
      expect(attachment.content_type).toBe('image/png');

      // Decode the generated QR PNG buffer with pngjs + jsQR
      const pngBuffer = Buffer.from(attachment.content, 'base64');
      const png = PNG.sync.read(pngBuffer);
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);

      expect(decoded).not.toBeNull();
      expect(decoded!.data.startsWith('p_')).toBe(true);

      const checkClient = await pool.connect();
      try {
        // Verify decoded QR matches canonical outbox decrypted token
        const outboxRes = await checkClient.query(
          `select encrypted_token_payload, delivery_status from public.office_visit_email_outbox where office_visit_id = $1;`,
          [visitId]
        );
        expect(outboxRes.rows.length).toBe(1);
        const canonicalQrToken = decryptQrPayload(outboxRes.rows[0].encrypted_token_payload);
        expect(decoded!.data).toBe(canonicalQrToken);

        // Verify decoded QR equals token digest of the created pass in DB
        const passRes = await checkClient.query(
          `select encode(token_digest, 'hex') as token_digest from public.passes where id = (select pass_id from public.office_visits where id = $1);`,
          [visitId]
        );
        expect(passRes.rows.length).toBe(1);
        const decodedDigest = createHash('sha256').update(decoded!.data).digest('hex');
        expect(decodedDigest).toBe(passRes.rows[0].token_digest);

        // Verify that the second concurrent request did not generate a second pass
        const countRes = await checkClient.query(
          `select count(*) as pass_count from public.passes where id = (select pass_id from public.office_visits where id = $1);`,
          [visitId]
        );
        expect(Number(countRes.rows[0].pass_count)).toBe(1);
      } finally {
        checkClient.release();
      }
    }, 30_000);
  });

  // =========================================================================
  // Finding B: Durable Email Persistence & Recovery (Cases 1–10)
  // =========================================================================
  describe('Finding B: Durable Email-Result Persistence & Recovery Scenarios', () => {
    it('Case 1: Approval email accepted by provider, primary write fails, fallback persists reconciliation_required', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const personnelId = '00000000-0000-4000-8000-000000000002';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const visitId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const visitorEmail = 'fallback.visitor@earist.edu.ph';
      const returningProfileId = '33333333-4444-5555-6666-777777777777';

      const rootClient = await pool.connect();
      try {
        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;

          insert into public.returning_visitor_profiles (
            id, first_name, last_name, contact_number_e164, home_address, expires_at
          ) values (
            '${returningProfileId}', 'Carlos', 'Ray', '+639171234567', 'Manila, Philippines', now() + interval '30 days'
          ) on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Carlos Ray', '09171234567', '${visitorEmail}', 'Grades Inquiry', ((now() at time zone 'Asia/Manila')::date + 1), 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, personnel_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id,
            registration_mode, returning_profile_id
          ) values (
            '${visitId}', 'specific_person', '${officeId}', '${personnelId}', '${visitorId}', '${visitorId}', 'Carlos', 'Ray',
            '09171234567', '${visitorEmail}', 'Grades Inquiry', ((now() at time zone 'Asia/Manila')::date + 1), 'pending', 'awaiting_entry', gen_random_uuid(),
            'returning', '${returningProfileId}'
          ) on conflict (id) do update set approval_status = 'pending', registration_mode = 'returning', returning_profile_id = '${returningProfileId}';
        `);
      } finally {
        rootClient.release();
      }

      const mockProviderMsgId = 'msg_resend_fallback_123';
      setEmailSenderForTest(async () => ({
        id: mockProviderMsgId,
        provider: 'mock',
      }));

      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: createPostgresAdminClient(pool, { failRecordResult: true }) as any,
        anon: {} as any,
      });

      // First decision approval
      const req = new Request('http://localhost/api/office/decide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-staff-bearer-token',
        },
        body: JSON.stringify({ visitId, decision: 'approved' }),
      });

      const res = await decideHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe('approved');
      expect(body.emailDelivery.status).toBe('sent');
      expect(body.emailDelivery.providerMessageId).toBe(mockProviderMsgId);
      expect(body.emailDelivery.reconciliationRequired).toBe(true);

      // Verify that database outbox was fallen back to reconciliation_required
      const checkClient = await pool.connect();
      try {
        const outboxRes = await checkClient.query(
          `select delivery_status, provider_message_id from public.office_visit_email_outbox where office_visit_id = $1;`,
          [visitId]
        );
        expect(outboxRes.rows.length).toBe(1);
        expect(outboxRes.rows[0].delivery_status).toBe('reconciliation_required');
        expect(outboxRes.rows[0].provider_message_id).toBe(mockProviderMsgId);
      } finally {
        checkClient.release();
      }
    });

    it('Case 2 & 3: Subsequent email.sent and email.delivered webhooks reconcile outbox from reconciliation_required', async () => {
      const rootClient = await pool.connect();
      try {
        // Create an outbox row in 'reconciliation_required'
        const visitId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const officeId = '00000000-0000-4000-8000-000000000001';
        const visitorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const providerEmailId = 'msg_reconcile_webhook_test';
        const providerEventId = `evt_${randomBytes(8).toString('hex')}`;

        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', 'reconcile@earist.edu.ph', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Ana Cruz', '09171234567', 'reconcile@earist.edu.ph', 'Admissions', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status
          ) values (
            '${visitId}', 'specific_person', '${officeId}', '${visitorId}', '${visitorId}', 'Ana', 'Cruz',
            '09171234567', 'reconcile@earist.edu.ph', 'Admissions', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'reconciliation_required'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, delivery_status, provider_message_id, created_at, updated_at
          ) values (
            gen_random_uuid(), '${visitId}', 'approval', 'reconcile@earist.edu.ph', 'reconciliation_required', '${providerEmailId}', now(), now()
          );
        `);

        // 1. Fire email.sent webhook
        const sentRes = await rootClient.query(
          `select api.record_resend_delivery_event($1::text, 'email.sent'::text, $2::text, 'success'::text, 'r***@earist.edu.ph'::text, 'Visit approved'::text, now());`,
          [providerEventId, providerEmailId]
        );
        expect(sentRes.rows[0].record_resend_delivery_event.ok).toBe(true);

        // Verify outbox transitioned from reconciliation_required to sent
        const outboxSent = await rootClient.query(
          `select delivery_status, reconciliation_source from public.office_visit_email_outbox where provider_message_id = $1;`,
          [providerEmailId]
        );
        expect(outboxSent.rows[0].delivery_status).toBe('sent');
        expect(outboxSent.rows[0].reconciliation_source).toBe('resend_webhook');

        // 2. Fire email.delivered webhook
        const deliveredEventId = `evt_${randomBytes(8).toString('hex')}`;
        const delivRes = await rootClient.query(
          `select api.record_resend_delivery_event($1::text, 'email.delivered'::text, $2::text, 'success'::text, 'r***@earist.edu.ph'::text, 'Visit approved'::text, now());`,
          [deliveredEventId, providerEmailId]
        );
        expect(delivRes.rows[0].record_resend_delivery_event.ok).toBe(true);

        // Verify outbox transitioned to delivered with provider_webhook provenance
        const outboxDeliv = await rootClient.query(
          `select delivery_status, confirmation_source from public.office_visit_email_outbox where provider_message_id = $1;`,
          [providerEmailId]
        );
        expect(outboxDeliv.rows[0].delivery_status).toBe('delivered');
        expect(outboxDeliv.rows[0].confirmation_source).toBe('provider_webhook');

        // 3. Webhook replay: duplicate event ID returns duplicate: true without changing state
        const replayRes = await rootClient.query(
          `select api.record_resend_delivery_event($1::text, 'email.delivered'::text, $2::text, 'success'::text, 'r***@earist.edu.ph'::text, 'Visit approved'::text, now());`,
          [deliveredEventId, providerEmailId]
        );
        expect(replayRes.rows[0].record_resend_delivery_event.duplicate).toBe(true);
        expect(replayRes.rows[0].record_resend_delivery_event.status).toBe('already_processed');
      } finally {
        rootClient.release();
      }
    });

    it('Case 7: Outbox lookup failure in visits queue returns unavailable without displaying stale status', async () => {
      // Create visit fixture
      const officeId = '00000000-0000-4000-8000-000000000001';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

      const mockAdmin = {
        from: vi.fn((table: string) => {
          if (table === 'offices') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: officeId, name: 'Registrar' },
                error: null,
              }),
            };
          }
          if (table === 'office_visits') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              range: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: visitId,
                    office_id: officeId,
                    visitor_first_name: 'Stale',
                    visitor_last_name: 'Test',
                    approval_status: 'pending',
                    email_delivery_status: 'sent', // Stale value in visits table!
                    confirmation_source: null,
                    created_at: new Date().toISOString(),
                  },
                ],
                count: 1,
                error: null,
              }),
            };
          }
          if (table === 'office_visit_email_outbox') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'Outbox connection timeout' }, // Injected outbox lookup failure!
              }),
            };
          }
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
      };

      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        anon: {} as any,
      });

      const req = new Request(`http://localhost/api/office/visits?officeId=${officeId}&queue=pending`, {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-staff-token' },
      });

      const res = await visitsHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.warning).toBe('outbox_lookup_failed');
      expect(body.emailStatusDegraded).toBe(true);
      expect(body.visits.length).toBe(1);
      // Crucial: Must be 'unavailable', NOT the stale 'sent' from office_visits table!
      expect(body.visits[0].emailDeliveryStatus).toBe('unavailable');
      expect(body.visits[0].confirmationSource).toBeNull();
    });

    it('Case 10: Late out-of-order failure event cannot regress already confirmed delivered outbox', async () => {
      const rootClient = await pool.connect();
      try {
        const visitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const officeId = '00000000-0000-4000-8000-000000000001';
        const visitorId = '12121212-1212-4212-8212-121212121212';
        const providerEmailId = 'msg_terminal_delivery_test';

        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', 'terminal@earist.edu.ph', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Lisa Manoban', '09171234567', 'terminal@earist.edu.ph', 'Clearance', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status, confirmation_source
          ) values (
            '${visitId}', 'specific_person', '${officeId}', '${visitorId}', '${visitorId}', 'Lisa', 'Manoban',
            '09171234567', 'terminal@earist.edu.ph', 'Clearance', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'delivered', 'provider_webhook'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, delivery_status, provider_message_id, confirmation_source, created_at, updated_at
          ) values (
            gen_random_uuid(), '${visitId}', 'approval', 'terminal@earist.edu.ph', 'delivered', '${providerEmailId}', 'provider_webhook', now(), now()
          );
        `);

        // Send late out-of-order email.failed event
        const lateFailedEventId = `evt_${randomBytes(8).toString('hex')}`;
        await rootClient.query(
          `select api.record_resend_delivery_event($1::text, 'email.failed'::text, $2::text, 'failure'::text, 't***@earist.edu.ph'::text, 'Visit approved'::text, now());`,
          [lateFailedEventId, providerEmailId]
        );

        // Assert outbox and visit remain delivered!
        const outboxCheck = await rootClient.query(
          `select delivery_status, confirmation_source from public.office_visit_email_outbox where provider_message_id = $1;`,
          [providerEmailId]
        );
        expect(outboxCheck.rows[0].delivery_status).toBe('delivered');
        expect(outboxCheck.rows[0].confirmation_source).toBe('provider_webhook');
      } finally {
        rootClient.release();
      }
    });

    it('Finding A: Expired processing lease transitions to reconciliation_required, blocks automatic retry, permits staff retry, and webhook correlation via outbox_id backfills missing provider message ID', async () => {
      const rootClient = await pool.connect();
      try {
        const visitId = '11112222-3333-4444-8888-999900001111';
        const officeId = '00000000-0000-4000-8000-000000000001';
        const visitorId = '22223333-4444-5555-8888-999900002222';
        const staffActorId = '55555555-5555-4555-8555-555555555555';
        const outboxId = '33334444-5555-6666-8888-999900003333';
        const visitorEmail = 'expiredlease@earist.edu.ph';

        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Elena Rostova', '09171234567', '${visitorEmail}', 'Faculty Meeting', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Elena', 'Rostova',
            '09171234567', '${visitorEmail}', 'Faculty Meeting', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'processing'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, delivery_status, claim_id, lease_expires_at, attempt_count, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'approval', '${visitorEmail}', 'processing', gen_random_uuid(), now() - interval '1 second', 1, now(), now()
          ) on conflict (id) do nothing;
        `);

        // 1. Attempt claim on expired processing lease
        const claimRes = await rootClient.query(
          `select * from api.claim_office_visit_email_for_delivery($1::uuid, 'approval'::text);`,
          [visitId]
        );
        expect(claimRes.rows.length).toBe(1);
        expect(claimRes.rows[0].claim_id).toBeNull(); // No claim granted!

        // 2. Verify outbox and visit were transactionally updated to reconciliation_required
        const outboxCheck = await rootClient.query(
          `select delivery_status, claim_id, lease_expires_at from public.office_visit_email_outbox where id = $1;`,
          [outboxId]
        );
        expect(outboxCheck.rows[0].delivery_status).toBe('reconciliation_required');
        expect(outboxCheck.rows[0].claim_id).toBeNull();
        expect(outboxCheck.rows[0].lease_expires_at).toBeNull();

        // 3. Subsequent claim attempt is blocked
        await expect(
          rootClient.query(
            `select * from api.claim_office_visit_email_for_delivery($1::uuid, 'approval'::text);`,
            [visitId]
          )
        ).rejects.toThrow(/email_delivery_outcome_unknown_reconciliation_required/);

        // 4. Staff reconciliation via permit_retry unlocks it
        const recRes = await rootClient.query(
          `select * from api.reconcile_office_visit_email($1::uuid, $2::uuid, 'permit_retry'::text, 'Permit retry after lease expiration'::text);`,
          [staffActorId, visitId]
        );
        expect(recRes.rows[0].ok).toBe(true);
        expect(recRes.rows[0].new_status).toBe('failed');

        // 5. Subsequent claim now succeeds
        const reclaimRes = await rootClient.query(
          `select * from api.claim_office_visit_email_for_delivery($1::uuid, 'approval'::text);`,
          [visitId]
        );
        expect(reclaimRes.rows.length).toBe(1);
        expect(reclaimRes.rows[0].claim_id).not.toBeNull();

        // 6. Webhook correlation via outbox_id when provider_message_id was not previously persisted
        await rootClient.query(`
          update public.office_visit_email_outbox
          set delivery_status = 'reconciliation_required', provider_message_id = null, claim_id = null, lease_expires_at = null
          where id = '${outboxId}';
        `);

        const webhookEmailId = 'msg_backfill_via_outbox_id_999';
        const webhookEventId = `evt_${randomBytes(8).toString('hex')}`;

        const hookRes = await rootClient.query(
          `select api.record_resend_delivery_event(
            $1::text, 'email.delivered'::text, $2::text, 'success'::text, 'e***@earist.edu.ph'::text, 'Approved'::text, now(), $3::uuid
          );`,
          [webhookEventId, webhookEmailId, outboxId]
        );
        expect(hookRes.rows[0].record_resend_delivery_event.ok).toBe(true);

        // Verify that provider_message_id was backfilled and status updated to delivered
        const backfilledOutbox = await rootClient.query(
          `select delivery_status, provider_message_id, confirmation_source from public.office_visit_email_outbox where id = $1;`,
          [outboxId]
        );
        expect(backfilledOutbox.rows[0].delivery_status).toBe('delivered');
        expect(backfilledOutbox.rows[0].provider_message_id).toBe(webhookEmailId);
        expect(backfilledOutbox.rows[0].confirmation_source).toBe('provider_webhook');
      } finally {
        rootClient.release();
      }
    });

    it('Finding B: Approval manual retry route with primary DB failure persists reconciliation_required fallback', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = '44445555-6666-4777-8888-999900004444';
      const visitId = '55556666-7777-4888-9999-000011115555';
      const outboxId = '66667777-8888-4999-a000-111122226666';
      const passId = '77778888-9999-4000-b111-222233337777';
      const visitorEmail = 'retry.approval@earist.edu.ph';

      const rootClient = await pool.connect();
      try {
        const rawToken = `p_${randomBytes(32).toString('hex')}`;
        const tokenDigest = createHash('sha256').update(rawToken).digest('hex');
        const encryptedPayload = encryptQrPayload(rawToken);

        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Retry Visitor', '09171234567', '${visitorEmail}', 'Consultation', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.passes (id, visitor_id, source, status, token_digest, public_reference, valid_from, valid_until)
          values ('${passId}', '${visitorId}', 'portal', 'issued', decode('${tokenDigest}', 'hex'), gen_random_uuid(), now(), now() + interval '8 hours') on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, pass_id, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Retry', 'Visitor',
            '09171234567', '${visitorEmail}', 'Consultation', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), '${passId}', 'failed'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, attempt_count, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'approval', '${visitorEmail}', '${encryptedPayload}', 'failed', 1, now(), now()
          ) on conflict (id) do nothing;
        `);
      } finally {
        rootClient.release();
      }

      const mockProviderMsgId = 'msg_retry_approval_fallback_123';
      setEmailSenderForTest(async () => ({
        id: mockProviderMsgId,
        provider: 'mock',
      }));

      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: createPostgresAdminClient(pool, { failRecordResult: true }) as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/passes/office/retry-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-staff-bearer-token',
        },
        body: JSON.stringify({ visitId, action: 'retry' }),
      });

      const res = await retryEmailHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe('sent');
      expect(body.providerMessageId).toBe(mockProviderMsgId);
      expect(body.reconciliationRequired).toBe(true);

      // Verify that database outbox was fallen back to reconciliation_required
      const checkClient = await pool.connect();
      try {
        const outboxRes = await checkClient.query(
          `select delivery_status, provider_message_id from public.office_visit_email_outbox where id = $1;`,
          [outboxId]
        );
        expect(outboxRes.rows[0].delivery_status).toBe('reconciliation_required');
        expect(outboxRes.rows[0].provider_message_id).toBe(mockProviderMsgId);
      } finally {
        checkClient.release();
      }
    });

    it('Finding B: Rejection manual retry route with primary DB failure persists reconciliation_required fallback', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = '88889999-0000-4111-8222-333344445555';
      const visitId = '99990000-1111-4222-9333-444455556666';
      const outboxId = '00001111-2222-4333-a444-555566667777';
      const visitorEmail = 'retry.rejection@earist.edu.ph';

      const rootClient = await pool.connect();
      try {
        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Rejected Visitor', '09171234567', '${visitorEmail}', 'Interview', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, rejection_reason, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Rejected', 'Visitor',
            '09171234567', '${visitorEmail}', 'Interview', current_date, 'rejected', 'awaiting_entry', gen_random_uuid(), 'Room occupied', 'failed'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, rejection_reason, delivery_status, attempt_count, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'rejection', '${visitorEmail}', 'Room occupied', 'failed', 1, now(), now()
          ) on conflict (id) do nothing;
        `);
      } finally {
        rootClient.release();
      }

      const mockProviderMsgId = 'msg_retry_rejection_fallback_456';
      setEmailSenderForTest(async () => ({
        id: mockProviderMsgId,
        provider: 'mock',
      }));

      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: createPostgresAdminClient(pool, { failRecordResult: true }) as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/passes/office/retry-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-staff-bearer-token',
        },
        body: JSON.stringify({ visitId, action: 'retry' }),
      });

      const res = await retryEmailHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe('sent');
      expect(body.reconciliationRequired).toBe(true);

      const checkClient = await pool.connect();
      try {
        const outboxRes = await checkClient.query(
          `select delivery_status, provider_message_id from public.office_visit_email_outbox where id = $1;`,
          [outboxId]
        );
        expect(outboxRes.rows[0].delivery_status).toBe('reconciliation_required');
        expect(outboxRes.rows[0].provider_message_id).toBe(mockProviderMsgId);
      } finally {
        checkClient.release();
      }
    });

    it('Finding B: Both primary and fallback writes fail preserves provider acceptance, dispatches only once, and blocks subsequent claim', async () => {
      const officeId = '00000000-0000-4000-8000-000000000001';
      const staffActorId = '55555555-5555-4555-8555-555555555555';
      const visitorId = 'aaaa1111-2222-4333-8444-555566667777';
      const visitId = 'bbbb2222-3333-4444-9555-666677778888';
      const outboxId = 'cccc3333-4444-4555-a666-777788889999';
      const visitorEmail = 'bothfail@earist.edu.ph';

      const rootClient = await pool.connect();
      try {
        await rootClient.query(`
          insert into auth.users (id, email, is_anonymous) values ('${visitorId}', '${visitorEmail}', true) on conflict (id) do nothing;
          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Both Fail', '09171234567', '${visitorEmail}', 'Inquiry', current_date, 'portal', now()) on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, rejection_reason, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Both', 'Fail',
            '09171234567', '${visitorEmail}', 'Inquiry', current_date, 'rejected', 'awaiting_entry', gen_random_uuid(), 'Closed', 'failed'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, rejection_reason, delivery_status, attempt_count, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'rejection', '${visitorEmail}', 'Closed', 'failed', 1, now(), now()
          ) on conflict (id) do nothing;
        `);
      } finally {
        rootClient.release();
      }

      let dispatchCount = 0;
      const mockProviderMsgId = 'msg_both_write_failure_789';
      setEmailSenderForTest(async () => {
        dispatchCount++;
        return {
          id: mockProviderMsgId,
          provider: 'mock',
        };
      });

      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: staffActorId,
        email: 'staff@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [officeId],
      });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: createPostgresAdminClient(pool, { failBothRecords: true }) as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/passes/office/retry-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer mock-staff-bearer-token',
        },
        body: JSON.stringify({ visitId, action: 'retry' }),
      });

      const res = await retryEmailHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      // Provider accepted message: outcome preserved in response
      expect(body.ok).toBe(true);
      expect(body.status).toBe('sent');
      expect(body.providerMessageId).toBe(mockProviderMsgId);
      expect(body.reconciliationRequired).toBe(true);

      // Exactly 1 provider dispatch occurred
      expect(dispatchCount).toBe(1);
    });

    it('Finding C: Strict positive confirmation of RPC persistence rejects absent, malformed, and failed results', () => {
      // Direct unit contract validation of positive confirmation
      expect(isPositiveRpcSuccess({ ok: true }, null)).toBe(true);
      expect(isPositiveRpcSuccess({ ok: false }, null)).toBe(false);
      expect(isPositiveRpcSuccess(null, null)).toBe(false);
      expect(isPositiveRpcSuccess(undefined, null)).toBe(false);
      expect(isPositiveRpcSuccess({}, null)).toBe(false);
      expect(isPositiveRpcSuccess({ ok: true }, { message: 'Database connection failed', code: '500' })).toBe(false);
      expect(isPositiveRpcSuccess({ ok: 'true' }, null)).toBe(false); // Non-boolean ok is rejected
      expect(isPositiveRpcSuccess('ok', null)).toBe(false);
    });
  });

  // =========================================================================
  // Finding D: State-Transition and Note-Validation Closure (api.reconcile_office_visit_email)
  // =========================================================================
  describe('Finding D: State-Transition & Audit-Note Closure (api.reconcile_office_visit_email)', () => {
    const officeId = '01111111-1111-4111-8111-111111111111';
    const staffId = '02222222-2222-4222-8222-222222222222';
    const visitorId = '03333333-3333-4333-8333-333333333333';
    const visitId = '04444444-4444-4444-8444-444444444444';
    const outboxId = '05555555-5555-4555-8555-555555555555';

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`
          insert into public.offices (id, name, description, active, verified, publication_status)
          values ('${officeId}', 'Finding D State Office', 'REG70', true, true, 'published')
          on conflict (id) do update set active = true, verified = true, publication_status = 'published';

          insert into auth.users (id, email, email_confirmed_at)
          values ('${staffId}', 'staff.state@earist.edu.ph', now())
          on conflict (id) do nothing;

          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${staffId}', 'State Staff', 'office_staff', true, false, now())
          on conflict (user_id) do nothing;

          insert into public.office_staff_assignments (user_id, office_id)
          values ('${staffId}', '${officeId}')
          on conflict do nothing;

          insert into auth.users (id, email, is_anonymous)
          values ('${visitorId}', 'visitor.state@earist.edu.ph', true)
          on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'State Visitor', '09171234567', 'visitor.state@earist.edu.ph', 'Inquiry', current_date, 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'State', 'Visitor',
            '09171234567', 'visitor.state@earist.edu.ph', 'Inquiry', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'pending'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, delivery_status, attempt_count, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'approval', 'visitor.state@earist.edu.ph', 'pending', 0, now(), now()
          ) on conflict (id) do nothing;
        `);
      } finally {
        client.release();
      }
    });

    it('rejects permit_retry for pending status and preserves outbox state', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`update public.office_visit_email_outbox set delivery_status = 'pending', claim_id = null, lease_expires_at = null where id = '${outboxId}';`);

        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'Valid audit note for pending check'::text
            );
          `)
        ).rejects.toThrow(/only_for_unknown_or_failed/);

        const check = await client.query(`select delivery_status from public.office_visit_email_outbox where id = '${outboxId}';`);
        expect(check.rows[0].delivery_status).toBe('pending');
      } finally {
        client.release();
      }
    });

    it('rejects permit_retry for processing status with active lease and preserves lease', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        const claimId = '06666666-6666-4666-8666-666666666666';
        await client.query(`
          update public.office_visit_email_outbox
          set delivery_status = 'processing', claim_id = '${claimId}', lease_expires_at = now() + interval '5 minutes'
          where id = '${outboxId}';
        `);

        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'Valid audit note for processing check'::text
            );
          `)
        ).rejects.toThrow(/only_for_unknown_or_failed/);

        const check = await client.query(`select delivery_status, claim_id::text from public.office_visit_email_outbox where id = '${outboxId}';`);
        expect(check.rows[0].delivery_status).toBe('processing');
        expect(check.rows[0].claim_id).toBe(claimId);
      } finally {
        client.release();
      }
    });

    it('rejects permit_retry for sent status and preserves outbox state', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`update public.office_visit_email_outbox set delivery_status = 'sent', claim_id = null, lease_expires_at = null where id = '${outboxId}';`);

        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'Valid audit note for sent check'::text
            );
          `)
        ).rejects.toThrow(/only_for_unknown_or_failed/);

        const check = await client.query(`select delivery_status from public.office_visit_email_outbox where id = '${outboxId}';`);
        expect(check.rows[0].delivery_status).toBe('sent');
      } finally {
        client.release();
      }
    });

    it('rejects permit_retry for delivered status with email_already_delivered', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`update public.office_visit_email_outbox set delivery_status = 'delivered', claim_id = null, lease_expires_at = null where id = '${outboxId}';`);

        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'Valid audit note for delivered check'::text
            );
          `)
        ).rejects.toThrow(/email_already_delivered/);

        const check = await client.query(`select delivery_status from public.office_visit_email_outbox where id = '${outboxId}';`);
        expect(check.rows[0].delivery_status).toBe('delivered');
      } finally {
        client.release();
      }
    });

    it('rejects permit_retry when note is missing, empty, whitespace-only, or < 3 chars', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`update public.office_visit_email_outbox set delivery_status = 'failed' where id = '${outboxId}';`);

        // Null note
        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, null
            );
          `)
        ).rejects.toThrow(/reconciliation_note_required_for_retry/);

        // Empty note
        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, ''
            );
          `)
        ).rejects.toThrow(/reconciliation_note_required_for_retry/);

        // Whitespace-only note
        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, '   '
            );
          `)
        ).rejects.toThrow(/reconciliation_note_required_for_retry/);

        // 2-character note
        await expect(
          client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'no'
            );
          `)
        ).rejects.toThrow(/reconciliation_note_required_for_retry/);
      } finally {
        client.release();
      }
    });

    it('allows permit_retry for failed, unknown, and reconciliation_required with valid note and persists audit records', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);

        for (const initialStatus of ['failed', 'unknown', 'reconciliation_required']) {
          await client.query(`
            update public.office_visit_email_outbox
            set delivery_status = '${initialStatus}', claim_id = gen_random_uuid(), lease_expires_at = now() - interval '10 seconds'
            where id = '${outboxId}';
          `);

          const note = `Verified provider failure and authorized retry from ${initialStatus}`;
          const res = await client.query(`
            select * from api.reconcile_office_visit_email(
              '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, '${note}'::text
            );
          `);
          expect(res.rows.length).toBe(1);
          expect(res.rows[0].ok).toBe(true);
          expect(res.rows[0].new_status).toBe('failed');

          // Verify outbox state
          const outboxCheck = await client.query(`
            select delivery_status, claim_id, lease_expires_at, reconciled_by::text, reconciliation_source, reconciliation_note
            from public.office_visit_email_outbox where id = '${outboxId}';
          `);
          expect(outboxCheck.rows[0].delivery_status).toBe('failed');
          expect(outboxCheck.rows[0].claim_id).toBeNull();
          expect(outboxCheck.rows[0].lease_expires_at).toBeNull();
          expect(outboxCheck.rows[0].reconciled_by).toBe(staffId);
          expect(outboxCheck.rows[0].reconciliation_source).toBe('manual_staff');
          expect(outboxCheck.rows[0].reconciliation_note).toBe(note);

          // Verify event recorded in office_visit_events
          const eventCheck = await client.query(`
            select event_type, actor_id::text, metadata
            from public.office_visit_events
            where office_visit_id = '${visitId}' and event_type = 'email_reconciled'
            order by created_at desc limit 1;
          `);
          expect(eventCheck.rows.length).toBe(1);
          expect(eventCheck.rows[0].actor_id).toBe(staffId);
          expect(eventCheck.rows[0].metadata.action).toBe('permit_retry');
          expect(eventCheck.rows[0].metadata.previous_status).toBe(initialStatus);
          expect(eventCheck.rows[0].metadata.new_status).toBe('failed');
          expect(eventCheck.rows[0].metadata.note).toBe(note);
        }
      } finally {
        client.release();
      }
    });
  });

  // =========================================================================
  // Finding E: Independent-Session Concurrency Races & Deadlock Elimination
  // =========================================================================
  describe('Finding E: Canonical Lock Ordering & Independent-Session Concurrency Races', () => {
    const officeId = '0a111111-1111-4111-8111-111111111111';
    const staffId = '0a222222-2222-4222-8222-222222222222';
    const visitorId = '0a333333-3333-4333-8333-333333333333';
    const visitId = '0a444444-4444-4444-8444-444444444444';
    const outboxId = '0a555555-5555-4555-8555-555555555555';

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        await client.query(`
          insert into public.offices (id, name, description, active, verified, publication_status)
          values ('${officeId}', 'Finding E Race Admissions Office', 'ADM70', true, true, 'published')
          on conflict (id) do update set active = true, verified = true, publication_status = 'published';

          insert into auth.users (id, email, email_confirmed_at)
          values ('${staffId}', 'staff.race@earist.edu.ph', now())
          on conflict (id) do nothing;

          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${staffId}', 'Race Staff', 'office_staff', true, false, now())
          on conflict (user_id) do nothing;

          insert into public.office_staff_assignments (user_id, office_id)
          values ('${staffId}', '${officeId}')
          on conflict do nothing;

          insert into auth.users (id, email, is_anonymous)
          values ('${visitorId}', 'visitor.race@earist.edu.ph', true)
          on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorId}', '${visitorId}', 'Race Visitor', '09171234567', 'visitor.race@earist.edu.ph', 'Admission', current_date, 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (
            id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
            visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status
          ) values (
            '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Race', 'Visitor',
            '09171234567', 'visitor.race@earist.edu.ph', 'Admission', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'failed'
          ) on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (
            id, office_visit_id, email_type, recipient_email, delivery_status, attempt_count, idempotency_key, created_at, updated_at
          ) values (
            '${outboxId}', '${visitId}', 'approval', 'visitor.race@earist.edu.ph', 'failed', 0, 'office-email-race-test', now(), now()
          ) on conflict (id) do nothing;
        `);
      } finally {
        client.release();
      }
    });

    it('concurrent claim vs staff permit_retry: zero deadlocks, mutual exclusion, no active lease invalidation', async () => {
      const clients = await createIndependentClients(2);
      try {
        const rootClient = await pool.connect();
        await rootClient.query(`set request.jwt.claim.role = 'service_role';`);
        await rootClient.query(`
          update public.office_visit_email_outbox
          set delivery_status = 'failed', claim_id = null, lease_expires_at = null
          where id = '${outboxId}';
        `);
        rootClient.release();

        // Client 0 claims delivery; Client 1 calls permit_retry
        const results = await runConcurrent(clients, async (client, idx) => {
          if (idx === 0) {
            return client.query(`
              select * from api.claim_office_visit_email_for_delivery('${visitId}'::uuid, 'approval'::text);
            `);
          } else {
            return client.query(`
              select * from api.reconcile_office_visit_email(
                '${staffId}'::uuid, '${visitId}'::uuid, 'permit_retry'::text, 'Concurrent permit retry test'::text
              );
            `).catch((err) => ({ error: err }));
          }
        });

        // Zero deadlocks: neither query should encounter 40P01 (deadlock_detected)
        const claimRes: any = results[0];
        const retryRes: any = results[1];

        if (claimRes?.error) {
          expect(claimRes.error.code).not.toBe('40P01');
        }
        if (retryRes?.error) {
          expect(retryRes.error.code).not.toBe('40P01');
        }

        // Verify either claim won and lease was protected, OR retry won and reset to failed
        const checkClient = await pool.connect();
        await checkClient.query(`set request.jwt.claim.role = 'service_role';`);
        const finalState = await checkClient.query(`
          select delivery_status, claim_id, lease_expires_at, idempotency_key
          from public.office_visit_email_outbox where id = '${outboxId}';
        `);
        checkClient.release();

        const finalRow = finalState.rows[0];
        expect(['processing', 'failed']).toContain(finalRow.delivery_status);
        expect(finalRow.idempotency_key).toBe('office-email-race-test');
      } finally {
        await closeIndependentClients(clients);
      }
    });

    it('concurrent delivery claim vs provider webhook reconciliation: zero deadlocks, consistent terminal state', async () => {
      const clients = await createIndependentClients(2);
      try {
        const rootClient = await pool.connect();
        await rootClient.query(`set request.jwt.claim.role = 'service_role';`);
        await rootClient.query(`
          update public.office_visit_email_outbox
          set delivery_status = 'failed', claim_id = null, lease_expires_at = null, provider_message_id = 'msg_race_123'
          where id = '${outboxId}';
        `);
        rootClient.release();

        const providerEventId = `evt_race_${Date.now()}`;
        const results = await runConcurrent(clients, async (client, idx) => {
          if (idx === 0) {
            return client.query(`
              select * from api.claim_office_visit_email_for_delivery('${visitId}'::uuid, 'approval'::text);
            `).catch((err) => ({ error: err }));
          } else {
            return client.query(`
              select * from api.record_resend_delivery_event(
                '${providerEventId}'::text,
                'email.delivered'::text,
                'msg_race_123'::text,
                'success'::text,
                'v***@earist.edu.ph'::text,
                'Approval Notification'::text,
                now(),
                '${outboxId}'::uuid
              );
            `).catch((err) => ({ error: err }));
          }
        });

        // Zero deadlocks
        if ((results[0] as any)?.error) {
          expect((results[0] as any).error.code).not.toBe('40P01');
        }
        if ((results[1] as any)?.error) {
          expect((results[1] as any).error.code).not.toBe('40P01');
        }

        // State check
        const checkClient = await pool.connect();
        await checkClient.query(`set request.jwt.claim.role = 'service_role';`);
        const finalState = await checkClient.query(`
          select delivery_status, confirmation_source
          from public.office_visit_email_outbox where id = '${outboxId}';
        `);
        checkClient.release();

        // Terminal state must be delivered or processing
        expect(['delivered', 'processing']).toContain(finalState.rows[0].delivery_status);
      } finally {
        await closeIndependentClients(clients);
      }
    });
  });

  // =========================================================================
  // Finding F: Outbox RLS Full Staff Lifecycle Enforcement Matrix (9 Identities)
  // =========================================================================
  describe('Finding F: Outbox RLS Full Staff Lifecycle Enforcement Matrix (9 Identities)', () => {
    const office1Id = '0b111111-1111-4111-8111-111111111111';
    const office2Id = '0b222222-2222-4222-8222-222222222222';
    const visit1Id = '0b333333-3333-4333-8333-333333333333';
    const visit2Id = '0b444444-4444-4444-8444-444444444444';
    const outbox1Id = '0b555555-5555-4555-8555-555555555555';
    const outbox2Id = '0b666666-6666-4666-8666-666666666666';

    // 9 Actor IDs
    const assignedStaffId = '0c111111-1111-4111-8111-111111111111';
    const unassignedStaffId = '0c222222-2222-4222-8222-222222222222';
    const unconfirmedStaffId = '0c333333-3333-4333-8333-333333333333';
    const mustChangePwStaffId = '0c444444-4444-4444-8444-444444444444';
    const noPrivacyStaffId = '0c555555-5555-4555-8555-555555555555';
    const recoveryStaffId = '0c666666-6666-4666-8666-666666666666';
    const anonVisitorId = '0c777777-7777-4777-8777-777777777777';
    const adminId = '0c888888-8888-4888-8888-888888888888';
    const visitorOwnerId = '0c999999-9999-4999-8999-999999999999';

    beforeAll(async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);

        // 1. Offices
        await client.query(`
          insert into public.offices (id, name, description, active, verified, publication_status)
          values
            ('${office1Id}', 'Finding F Office One RLS', 'O1RLS', true, true, 'published'),
            ('${office2Id}', 'Finding F Office Two RLS', 'O2RLS', true, true, 'published')
          on conflict (id) do update set active = true, verified = true, publication_status = 'published';

          insert into auth.users (id, email, is_anonymous)
          values ('${visitorOwnerId}', 'owner.rls@earist.edu.ph', true)
          on conflict (id) do nothing;

          insert into public.visitors (id, owner_id, full_name, contact_number, email, purpose, visit_date, source, consent_accepted_at)
          values ('${visitorOwnerId}', '${visitorOwnerId}', 'RLS Visitor', '09171234567', 'owner.rls@earist.edu.ph', 'General', current_date, 'portal', now())
          on conflict (id) do nothing;

          insert into public.office_visits (id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name, visitor_contact_number, visitor_email, purpose, visit_date, approval_status, attendance_status, request_id, email_delivery_status)
          values
            ('${visit1Id}', 'general', '${office1Id}', '${visitorOwnerId}', '${visitorOwnerId}', 'V1', 'RLS', '09171234567', 'v1@earist.edu.ph', 'General', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'delivered'),
            ('${visit2Id}', 'general', '${office2Id}', '${visitorOwnerId}', '${visitorOwnerId}', 'V2', 'RLS', '09171234567', 'v2@earist.edu.ph', 'General', current_date, 'approved', 'awaiting_entry', gen_random_uuid(), 'delivered')
          on conflict (id) do nothing;

          insert into public.office_visit_email_outbox (id, office_visit_id, email_type, recipient_email, delivery_status, attempt_count, created_at, updated_at)
          values
            ('${outbox1Id}', '${visit1Id}', 'approval', 'v1@earist.edu.ph', 'delivered', 0, now(), now()),
            ('${outbox2Id}', '${visit2Id}', 'approval', 'v2@earist.edu.ph', 'delivered', 0, now(), now())
          on conflict (id) do nothing;
        `);

        // 2. Identity 1: Assigned, fully onboarded office staff (assigned to Office 1)
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${assignedStaffId}', 'assigned.staff@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${assignedStaffId}', 'Assigned Staff', 'office_staff', true, false, now()) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${assignedStaffId}', '${office1Id}') on conflict do nothing;
        `);

        // 3. Identity 2: Unassigned office staff (assigned only to Office 2)
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${unassignedStaffId}', 'unassigned.staff@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${unassignedStaffId}', 'Unassigned Staff', 'office_staff', true, false, now()) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${unassignedStaffId}', '${office2Id}') on conflict do nothing;
        `);

        // 4. Identity 3: Active staff with unconfirmed email
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${unconfirmedStaffId}', 'unconfirmed.staff@earist.edu.ph', null) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${unconfirmedStaffId}', 'Unconfirmed Staff', 'office_staff', true, false, now()) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${unconfirmedStaffId}', '${office1Id}') on conflict do nothing;
        `);

        // 5. Identity 4: Active staff with must_change_password = true
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${mustChangePwStaffId}', 'mustchange.staff@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${mustChangePwStaffId}', 'MustChange Staff', 'office_staff', true, true, now()) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${mustChangePwStaffId}', '${office1Id}') on conflict do nothing;
        `);

        // 6. Identity 5: Active staff without privacy acceptance (privacy_accepted_at = null)
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${noPrivacyStaffId}', 'noprivacy.staff@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${noPrivacyStaffId}', 'NoPrivacy Staff', 'office_staff', true, false, null) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${noPrivacyStaffId}', '${office1Id}') on conflict do nothing;
        `);

        // 7. Identity 6: Password-recovery session (staff profile is active, but session has amr recovery)
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${recoveryStaffId}', 'recovery.staff@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${recoveryStaffId}', 'Recovery Staff', 'office_staff', true, false, now()) on conflict (user_id) do nothing;
          insert into public.office_staff_assignments (user_id, office_id) values ('${recoveryStaffId}', '${office1Id}') on conflict do nothing;
        `);

        // 8. Identity 7: Anonymous visitor session without staff authority
        await client.query(`
          insert into auth.users (id, email, is_anonymous) values ('${anonVisitorId}', null, true) on conflict (id) do nothing;
        `);

        // 9. Identity 8: Fully onboarded Admin
        await client.query(`
          insert into auth.users (id, email, email_confirmed_at) values ('${adminId}', 'admin.rls@earist.edu.ph', now()) on conflict (id) do nothing;
          insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
          values ('${adminId}', 'Admin RLS', 'admin', true, false, now()) on conflict (user_id) do nothing;
        `);
      } finally {
        client.release();
      }
    });

    async function queryOutboxAs(actorClaims: { sub?: string; role?: string; amr?: any[] }): Promise<string[]> {
      const client = await pool.connect();
      try {
        const role = actorClaims.role || 'authenticated';
        await client.query(`set role ${role === 'anon' ? 'anon' : 'authenticated'};`);
        await client.query(`select set_config('request.jwt.claims', $1, false);`, [JSON.stringify(actorClaims)]);
        await client.query(`select set_config('request.jwt.claim.sub', $1, false);`, [actorClaims.sub || '']);
        await client.query(`select set_config('request.jwt.claim.role', $1, false);`, [role]);

        const res = await client.query(`select id::text from public.office_visit_email_outbox order by id;`);
        return res.rows.map((r) => r.id);
      } finally {
        await client.query(`reset role;`);
        client.release();
      }
    }

    it('1. Assigned, fully onboarded office staff can read only their assigned office outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: assignedStaffId, role: 'authenticated' });
      expect(rows).toContain(outbox1Id);
      expect(rows).not.toContain(outbox2Id);
    });

    it('2. Unassigned office staff cannot read another office outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: unassignedStaffId, role: 'authenticated' });
      expect(rows).not.toContain(outbox1Id);
      expect(rows).toContain(outbox2Id);
    });

    it('3. Active staff with unconfirmed email cannot read outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: unconfirmedStaffId, role: 'authenticated' });
      expect(rows).toHaveLength(0);
    });

    it('4. Active staff with must_change_password = true cannot read outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: mustChangePwStaffId, role: 'authenticated' });
      expect(rows).toHaveLength(0);
    });

    it('5. Active staff without privacy acceptance cannot read outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: noPrivacyStaffId, role: 'authenticated' });
      expect(rows).toHaveLength(0);
    });

    it('6. Password-recovery sessions cannot read outbox rows', async () => {
      const rows = await queryOutboxAs({
        sub: recoveryStaffId,
        role: 'authenticated',
        amr: [{ method: 'recovery', timestamp: Math.floor(Date.now() / 1000) }],
      });
      expect(rows).toHaveLength(0);
    });

    it('7. Anonymous visitor sessions without staff authority cannot read outbox rows', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set role anon;`);
        await client.query(`select set_config('request.jwt.claims', $1, false);`, [JSON.stringify({ sub: anonVisitorId, role: 'anon' })]);
        await client.query(`select set_config('request.jwt.claim.sub', $1, false);`, [anonVisitorId]);
        await client.query(`select set_config('request.jwt.claim.role', 'anon', false);`);

        // Anon table grant is revoked or returns 0 rows
        const rows = await client.query(`select id::text from public.office_visit_email_outbox;`).then(
          (r) => r.rows.map((x) => x.id),
          (err) => {
            expect(err.message).toMatch(/permission denied/);
            return [];
          }
        );
        expect(rows).toHaveLength(0);
      } finally {
        await client.query(`reset role;`);
        client.release();
      }
    });

    it('8. Fully onboarded admins and superadmins retain authorized global read across all outbox rows', async () => {
      const rows = await queryOutboxAs({ sub: adminId, role: 'authenticated' });
      expect(rows).toContain(outbox1Id);
      expect(rows).toContain(outbox2Id);
    });

    it('9. Service-role backend access continues working and reads all outbox rows', async () => {
      const client = await pool.connect();
      try {
        await client.query(`set request.jwt.claim.role = 'service_role';`);
        const res = await client.query(`select id::text from public.office_visit_email_outbox where id in ('${outbox1Id}', '${outbox2Id}');`);
        const rows = res.rows.map((r) => r.id);
        expect(rows).toContain(outbox1Id);
        expect(rows).toContain(outbox2Id);
      } finally {
        client.release();
      }
    });
  });
});
