import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { getTrustedClientIp } from '../server/lib/clientIp.js';
import { handleRequest as requestOfficeVisitHandler } from '../server/routes/passes/request-office-visit.js';
import { handleRequest as verifyEmailHandler } from '../server/routes/office/verify-email.js';
import * as officeDeliveryModule from '../server/lib/officeDelivery.js';
import * as emailModule from '../server/email.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

vi.mock('../server/upload-inspection.js', () => ({
  inspectUploadIntent: vi.fn().mockResolvedValue({ bytes: 2048, sha256: 'a'.repeat(64) }),
}));

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

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

    create or replace function auth.jwt() returns jsonb as $$
      select case
        when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
        else current_setting('request.jwt.claims', true)::jsonb
      end
    $$ language sql stable;


    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;
    grant execute on function auth.jwt() to anon, authenticated, service_role;

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

async function applyAllMigrations(db: PGlite) {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    sql = sql.replace(/create extension if not exists "uuid-ossp"[^;]*;/gi, '-- uuid-ossp no-op');
    await db.exec(sql);
  }
}

describe('Workstream 4 / R5: Office Visit Proof Lifecycle, Rate Limits, IP Trust & Resend Deduplication', () => {
  const originalEnv = process.env;
  const mockSecret = 'test-secret-at-least-32-chars-long-for-hmac-keys!';
  const visitorUserId = '11111111-1111-4111-8111-111111111111';
  const otherVisitorUserId = '22222222-2222-4222-8222-222222222222';
  const testOfficeId = '00000000-0000-4000-8000-000000000001';
  const testPersonnelId = '00000000-0000-4000-8000-000000000002';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-secret-key-supabase-admin-service-role',
      PASS_TOKEN_SECRET: mockSecret,
      OFFICE_VISIT_HMAC_SECRET: mockSecret,
      RATE_LIMIT_HMAC_SECRET: mockSecret,
      RETURNING_MATCH_TOKEN_SECRET: mockSecret,
      OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1. Client IP Trust & Spoof Defense (getTrustedClientIp)
  // ===========================================================================
  describe('1. Client IP Extraction Trust & Spoof Defense', () => {
    it('strictly extracts client IP from x-vercel-forwarded-for first hop', () => {
      const request = new Request('https://egatepass.tech/api/test', {
        headers: {
          'x-vercel-forwarded-for': '203.0.113.195, 10.0.0.1',
        },
      });
      expect(getTrustedClientIp(request)).toBe('203.0.113.195');
    });

    it('rejects spoofed X-Real-IP without Vercel forwarding header', () => {
      const request = new Request('https://egatepass.tech/api/test', {
        headers: {
          'x-real-ip': '198.51.100.22',
        },
      });
      expect(getTrustedClientIp(request)).toBeNull();
    });

    it('rejects unverified CF-Connecting-IP without verified Cloudflare proxy', () => {
      const request = new Request('https://egatepass.tech/api/test', {
        headers: {
          'cf-connecting-ip': '198.51.100.33',
        },
      });
      expect(getTrustedClientIp(request)).toBeNull();
    });

    it('ignores spoofed CF-Connecting-IP and X-Real-IP when x-vercel-forwarded-for is present', () => {
      const request = new Request('https://egatepass.tech/api/test', {
        headers: {
          'x-vercel-forwarded-for': '203.0.113.50',
          'cf-connecting-ip': '1.2.3.4',
          'x-real-ip': '5.6.7.8',
        },
      });
      expect(getTrustedClientIp(request)).toBe('203.0.113.50');
    });

    it('rejects invalid or non-IP values in x-vercel-forwarded-for', () => {
      const request = new Request('https://egatepass.tech/api/test', {
        headers: {
          'x-vercel-forwarded-for': 'malicious-domain.com',
        },
      });
      expect(getTrustedClientIp(request)).toBeNull();
    });
  });

  // ===========================================================================
  // 2. Multi-Key Rate Limiting on Visit Creation
  // ===========================================================================
  describe('2. Multi-Key Rate Limiting on Visit Creation', () => {
    function setupMockAdmin(rateLimitOverrides: {
      actorAllowed?: boolean;
      emailAllowed?: boolean;
      netAllowed?: boolean;
      actorRpcError?: any;
    }) {
      const consumedKeys: Array<{ key: string; action: string }> = [];

      const mockAdmin: any = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: table === 'offices'
                    ? { id: testOfficeId, name: 'Registrar', active: true, publication_status: 'published' }
                    : { id: testPersonnelId, name: 'Dr. Santos', active: true, office_id: testOfficeId },
                  error: null,
                }),
              }),
              maybeSingle: async () => ({
                data: table === 'offices'
                  ? { id: testOfficeId, name: 'Registrar', active: true, publication_status: 'published' }
                  : null,
                error: null,
              }),
            }),
          }),
        }),
        schema: (s: string) => ({
          rpc: async (fn: string, params: any) => {
            if (fn === 'consume_rate_limit') {
              consumedKeys.push({ key: params.requested_key_hex, action: params.requested_action });
              if (params.requested_action === 'portal.office_visit_actor') {
                if (rateLimitOverrides.actorRpcError) return { data: null, error: rateLimitOverrides.actorRpcError };
                return { data: rateLimitOverrides.actorAllowed ?? true, error: null };
              }
              if (params.requested_action === 'portal.office_visit_email') {
                return { data: rateLimitOverrides.emailAllowed ?? true, error: null };
              }
              if (params.requested_action === 'portal.office_visit_network') {
                return { data: rateLimitOverrides.netAllowed ?? true, error: null };
              }
            }
            if (fn === 'create_specific_person_visit_request') {
              return {
                data: [{
                  visit_id: '00000000-0000-4000-8000-000000000099',
                  request_id: params.requested_request_id,
                  approval_status: 'pending',
                  attendance_status: 'awaiting_entry',
                  inserted: true,
                }],
                error: null,
              };
            }
            return { data: null, error: null };
          },
        }),
      };

      return { mockAdmin, consumedKeys };
    }

    it('enforces actor rate limit and returns HTTP 429 when exceeded', async () => {
      const { mockAdmin } = setupMockAdmin({ actorAllowed: false });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-vercel-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          requestId: '33333333-3333-4333-8333-333333333333',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'juan@test.local',
            purpose: 'Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          requestedPersonName: 'Dr. Santos',
          specificPurpose: 'Evaluation of credentials',
          emailVerificationToken: 'proof-token-1234567890abcdef',
        }),
      });

      const res = await requestOfficeVisitHandler(request);
      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe('rate_limit_exceeded');
      expect(json.message).toContain('session');
    });

    it('enforces email rate limit and returns HTTP 429 when exceeded', async () => {
      const { mockAdmin } = setupMockAdmin({ actorAllowed: true, emailAllowed: false });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-vercel-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          requestId: '33333333-3333-4333-8333-333333333333',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'juan@test.local',
            purpose: 'Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          requestedPersonName: 'Dr. Santos',
          specificPurpose: 'Evaluation of credentials',
          emailVerificationToken: 'proof-token-1234567890abcdef',
        }),
      });

      const res = await requestOfficeVisitHandler(request);
      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe('rate_limit_exceeded');
      expect(json.message).toContain('email');
    });

    it('enforces network rate limit on trusted IP and returns HTTP 429 when exceeded', async () => {
      const { mockAdmin } = setupMockAdmin({ actorAllowed: true, emailAllowed: true, netAllowed: false });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-vercel-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          requestId: '33333333-3333-4333-8333-333333333333',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'juan@test.local',
            purpose: 'Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          requestedPersonName: 'Dr. Santos',
          specificPurpose: 'Evaluation of credentials',
          emailVerificationToken: 'proof-token-1234567890abcdef',
        }),
      });

      const res = await requestOfficeVisitHandler(request);
      expect(res.status).toBe(429);
      const json = await res.json();
      expect(json.error).toBe('rate_limit_exceeded');
      expect(json.message).toContain('network');
    });

    it('preserves actor and email rate limiting when trusted IP header is missing or spoofed', async () => {
      const { mockAdmin, consumedKeys } = setupMockAdmin({ actorAllowed: true, emailAllowed: true });
      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      // Only spoofed X-Real-IP provided, no Vercel header
      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-real-ip': '1.2.3.4',
        },
        body: JSON.stringify({
          requestId: '33333333-3333-4333-8333-333333333333',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'juan@test.local',
            purpose: 'Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          requestedPersonName: 'Dr. Santos',
          specificPurpose: 'Evaluation of credentials',
          emailVerificationToken: 'proof-token-1234567890abcdef',
        }),
      });

      await requestOfficeVisitHandler(request);

      // Verify actor and email rate limits were consumed, but NOT network rate limit
      const actions = consumedKeys.map((c) => c.action);
      expect(actions).toContain('portal.office_visit_actor');
      expect(actions).toContain('portal.office_visit_email');
      expect(actions).not.toContain('portal.office_visit_network');
    });
  });

  // ===========================================================================
  // 3. Opaque Random Proof Token Generation in verify-email
  // ===========================================================================
  describe('3. Opaque Random Proof Token Generation in verify-email', () => {
    it('generates a 32-byte hex opaque token and stores SHA-256 digest in office_visit_verification_proofs', async () => {
      let insertedProofRecord: any = null;

      const mockAdmin: any = {
        schema: () => ({
          rpc: async (fn: string) => {
            if (fn === 'verify_office_email_challenge') {
              return { data: [{ status: 'verified', attempts_remaining: 3 }], error: null };
            }
            return { data: null, error: null };
          },
        }),
        from: (table: string) => {
          if (table === 'office_visit_verification_proofs') {
            return {
              insert: async (record: any) => {
                insertedProofRecord = record;
                return { error: null };
              },
            };
          }
          return { insert: async () => ({ error: null }) };
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      const request = new Request('https://egatepass.tech/api/office/verify-email', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-bearer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify_code',
          email: 'visitor@test.local',
          code: '123456',
        }),
      });

      const res = await verifyEmailHandler(request);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.ok).toBe(true);
      expect(json.email).toBe('visitor@test.local');
      expect(json.proofToken).toBeDefined();
      expect(typeof json.proofToken).toBe('string');
      // 32-byte random hex token is exactly 64 hex characters
      expect(json.proofToken.length).toBe(64);
      expect(json.emailVerificationToken).toBe(json.proofToken);

      // Verify stored record in database
      expect(insertedProofRecord).not.toBeNull();
      expect(insertedProofRecord.actor_id).toBe(visitorUserId);
      expect(insertedProofRecord.email).toBe('visitor@test.local');
      expect(insertedProofRecord.expires_at).toBeDefined();

      // Verify stored digest matches SHA-256 of the returned opaque token
      const expectedDigest = createHash('sha256').update(json.proofToken).digest('hex');
      expect(insertedProofRecord.proof_digest).toBe(expectedDigest);
    });
  });

  // ===========================================================================
  // 4. Single-Use Proof Database Lifecycle, Replay Protection & Idempotent Retry (PGlite)
  // ===========================================================================
  describe('4. Single-Use Proof Database Lifecycle & Replay Protection (PGlite)', () => {
    let db: PGlite;
    let officeId: string;
    let personnelId: string;

    beforeAll(async () => {
      db = new PGlite();
      await applyAllMigrations(db);

      await db.exec(`
        insert into auth.users (id, email, is_anonymous) values
        ('${visitorUserId}', 'juan@test.local', true),
        ('${otherVisitorUserId}', 'other@test.local', true);
      `);

      const offRes = await db.query<{ id: string }>(`select id from public.offices limit 1;`);
      officeId = offRes.rows[0].id;
      await db.exec(`
        update public.offices
        set publication_status = 'published', active = true, archived_at = null
        where id = '${officeId}';
      `);

      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, title)
        values ('${officeId}', 'Director Garcia', 'Director')
        returning id;
      `);
      personnelId = persRes.rows[0].id;

      await db.exec(`
        insert into public.upload_intents (id, owner_id, kind, source, bucket_id, object_path, content_type, status, expires_at)
        values
          ('11111111-2222-3333-4444-555555555551', '${visitorUserId}', 'photo', 'portal', 'visitor-photos', 'photos/p1.jpg', 'image/jpeg', 'pending', now() + interval '1 day'),
          ('11111111-2222-3333-4444-555555555552', '${visitorUserId}', 'id', 'portal', 'visitor-ids', 'ids/i1.jpg', 'image/jpeg', 'pending', now() + interval '1 day'),
          ('11111111-2222-3333-4444-555555555553', '${visitorUserId}', 'photo', 'portal', 'visitor-photos', 'photos/p2.jpg', 'image/jpeg', 'pending', now() + interval '1 day'),
          ('11111111-2222-3333-4444-555555555554', '${visitorUserId}', 'id', 'portal', 'visitor-ids', 'ids/i2.jpg', 'image/jpeg', 'pending', now() + interval '1 day'),
          ('11111111-2222-3333-4444-555555555555', '${visitorUserId}', 'photo', 'portal', 'visitor-photos', 'photos/p3.jpg', 'image/jpeg', 'pending', now() + interval '1 day'),
          ('11111111-2222-3333-4444-555555555556', '${visitorUserId}', 'id', 'portal', 'visitor-ids', 'ids/i3.jpg', 'image/jpeg', 'pending', now() + interval '1 day');
      `);
    }, 120000);

    it('consumes verification proof atomically on visit creation and creates outbox record', async () => {
      const rawToken = randomBytes(32).toString('hex');
      const proofDigest = createHash('sha256').update(rawToken).digest('hex');
      const reqId1 = 'aaaa1111-0000-4000-8000-000000000001';

      // 1. Insert proof into office_visit_verification_proofs
      await db.exec(`
        insert into public.office_visit_verification_proofs (
          proof_digest, actor_id, email, expires_at
        ) values (
          '${proofDigest}', '${visitorUserId}', 'juan@test.local', now() + interval '1 hour'
        );
      `);

      // 2. Call api.create_specific_person_visit_request
      const visitRes = await db.query<{
        visit_id: string;
        request_id: string;
        approval_status: string;
        attendance_status: string;
        inserted: boolean;
      }>(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => '${reqId1}'::uuid,
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan'::text,
          requested_middle_name => null::text,
          requested_last_name => 'Dela Cruz'::text,
          requested_contact_number => '09171234567'::text,
          requested_email => 'juan@test.local'::text,
          requested_purpose => 'Credentials inquiry'::text,
          requested_visit_date => (current_date + interval '1 day')::date,
          requested_arrival_mode => 'no_vehicle'::text,
          requested_vehicle_details => null::jsonb,
          requested_address_details => null::jsonb,
          requested_photo_intent_id => '11111111-2222-3333-4444-555555555551'::uuid,
          requested_photo_bytes => null::integer,
          requested_photo_sha256 => null::text,
          requested_id_intent_id => '11111111-2222-3333-4444-555555555552'::uuid,
          requested_id_bytes => null::integer,
          requested_id_sha256 => null::text,
          requested_vehicle_photo_intent_id => null::uuid,
          requested_vehicle_photo_bytes => null::integer,
          requested_vehicle_photo_sha256 => null::text,
          requested_registration_mode => 'new'::text,
          requested_returning_profile_id => null::uuid,
          requested_returning_match_token_digest => null::text,
          requested_identity_verification_id => null::uuid,
          requested_returning_attempt_id => null::uuid,
          requested_person_name => 'Director Garcia'::text,
          requested_tracking_token_digest => 'tracking-digest-111'::text,
          requested_tracking_token_expires_at => now() + interval '30 days',
          requested_encrypted_tracking_token => 'encrypted-tracking-111'::text,
          requested_visit_type => 'specific_person'::text,
          requested_source => 'portal'::public.pass_source,
          requested_pass_token_digest => null::text,
          requested_expected_gate => 'Main Gate'::text,
          requested_proof_token_digest => '${proofDigest}'::text
        );
      `);

      expect(visitRes.rows.length).toBe(1);
      expect(visitRes.rows[0].inserted).toBe(true);
      expect(visitRes.rows[0].request_id).toBe(reqId1);

      // 3. Verify proof is consumed by reqId1 in database
      const checkProof = await db.query<{
        consumed_at: string;
        consumed_by_request_id: string;
      }>(`
        select consumed_at, consumed_by_request_id
        from public.office_visit_verification_proofs
        where proof_digest = '${proofDigest}';
      `);
      expect(checkProof.rows[0].consumed_at).not.toBeNull();
      expect(checkProof.rows[0].consumed_by_request_id).toBe(reqId1);

      // 4. Verify outbox record was created
      const checkOutbox = await db.query<{ id: string; delivery_status: string }>(`
        select id, delivery_status
        from public.office_visit_acknowledgement_outbox
        where office_visit_id = '${visitRes.rows[0].visit_id}';
      `);
      expect(checkOutbox.rows.length).toBe(1);
      expect(checkOutbox.rows[0].delivery_status).toBe('pending');
    });

    it('fails closed with HTTP 403 / proof_already_consumed when replaying consumed proof with DIFFERENT request_id', async () => {
      // Create and consume a proof with reqIdOriginal
      const rawToken = randomBytes(32).toString('hex');
      const proofDigest = createHash('sha256').update(rawToken).digest('hex');
      const reqIdOriginal = 'aaaa2222-0000-4000-8000-000000000002';
      const reqIdReplay = 'aaaa3333-0000-4000-8000-000000000003';

      await db.exec(`
        insert into public.office_visit_verification_proofs (
          proof_digest, actor_id, email, expires_at
        ) values (
          '${proofDigest}', '${visitorUserId}', 'juan@test.local', now() + interval '1 hour'
        );
      `);

      // Consume proof with original request ID
      await db.query(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => '${reqIdOriginal}'::uuid,
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan'::text,
          requested_last_name => 'Dela Cruz'::text,
          requested_contact_number => '09171234567'::text,
          requested_email => 'juan@test.local'::text,
          requested_purpose => 'Credentials inquiry'::text,
          requested_visit_date => (current_date + interval '1 day')::date,
          requested_photo_intent_id => '11111111-2222-3333-4444-555555555553'::uuid,
          requested_id_intent_id => '11111111-2222-3333-4444-555555555554'::uuid,
          requested_proof_token_digest => '${proofDigest}'::text
        );
      `);

      // Attempt replay with DIFFERENT request ID -> MUST FAIL CLOSED with proof_already_consumed
      await expect(
        db.query(`
          select * from api.create_specific_person_visit_request(
            requested_actor_id => '${visitorUserId}'::uuid,
            requested_request_id => '${reqIdReplay}'::uuid,
            requested_office_id => '${officeId}'::uuid,
            requested_personnel_id => '${personnelId}'::uuid,
            requested_first_name => 'Juan'::text,
            requested_last_name => 'Dela Cruz'::text,
            requested_contact_number => '09171234567'::text,
            requested_email => 'juan@test.local'::text,
            requested_purpose => 'Malicious replay attempt'::text,
            requested_visit_date => (current_date + interval '1 day')::date,
            requested_proof_token_digest => '${proofDigest}'::text
          );
        `)
      ).rejects.toThrow(/proof_already_consumed/);

      // Verify NO visit was created for reqIdReplay
      const checkVisit = await db.query(`
        select id from public.office_visits where request_id = '${reqIdReplay}'::uuid;
      `);
      expect(checkVisit.rows.length).toBe(0);
    });

    it('succeeds idempotently on retry with SAME request_id without duplicate visit or email outbox', async () => {
      const rawToken = randomBytes(32).toString('hex');
      const proofDigest = createHash('sha256').update(rawToken).digest('hex');
      const reqIdRetry = 'aaaa4444-0000-4000-8000-000000000004';

      await db.exec(`
        insert into public.office_visit_verification_proofs (
          proof_digest, actor_id, email, expires_at
        ) values (
          '${proofDigest}', '${visitorUserId}', 'juan@test.local', now() + interval '1 hour'
        );
      `);

      // First call: creates visit
      const firstRes = await db.query<{ visit_id: string; inserted: boolean }>(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => '${reqIdRetry}'::uuid,
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan'::text,
          requested_last_name => 'Dela Cruz'::text,
          requested_contact_number => '09171234567'::text,
          requested_email => 'juan@test.local'::text,
          requested_purpose => 'Credentials inquiry'::text,
          requested_visit_date => (current_date + interval '1 day')::date,
          requested_photo_intent_id => '11111111-2222-3333-4444-555555555555'::uuid,
          requested_id_intent_id => '11111111-2222-3333-4444-555555555556'::uuid,
          requested_proof_token_digest => '${proofDigest}'::text,
          requested_encrypted_tracking_token => 'tracking-token-first'::text
        );
      `);
      expect(firstRes.rows[0].inserted).toBe(true);
      const visitId = firstRes.rows[0].visit_id;

      // Second call: retry with same request ID and same proof
      const retryRes = await db.query<{ visit_id: string; inserted: boolean; encrypted_tracking_token: string }>(`
        select * from api.create_specific_person_visit_request(
          requested_actor_id => '${visitorUserId}'::uuid,
          requested_request_id => '${reqIdRetry}'::uuid,
          requested_office_id => '${officeId}'::uuid,
          requested_personnel_id => '${personnelId}'::uuid,
          requested_first_name => 'Juan'::text,
          requested_last_name => 'Dela Cruz'::text,
          requested_contact_number => '09171234567'::text,
          requested_email => 'juan@test.local'::text,
          requested_purpose => 'Credentials inquiry'::text,
          requested_visit_date => (current_date + interval '1 day')::date,
          requested_photo_intent_id => '11111111-2222-3333-4444-555555555555'::uuid,
          requested_id_intent_id => '11111111-2222-3333-4444-555555555556'::uuid,
          requested_proof_token_digest => '${proofDigest}'::text,
          requested_encrypted_tracking_token => 'tracking-token-ignored-on-retry'::text
        );
      `);

      // Returns same visit ID, inserted = false, preserving original tracking token
      expect(retryRes.rows[0].visit_id).toBe(visitId);
      expect(retryRes.rows[0].inserted).toBe(false);
      expect(retryRes.rows[0].encrypted_tracking_token).toBe('tracking-token-first');

      // Verify outbox row count is exactly 1 (no duplicate outbox record)
      const outboxCount = await db.query<{ count: string }>(`
        select count(*) as count from public.office_visit_acknowledgement_outbox
        where office_visit_id = '${visitId}';
      `);
      expect(parseInt(outboxCount.rows[0].count, 10)).toBe(1);
    });

    it('route handler fails closed with HTTP 403 and error proof_already_consumed when replaying consumed proof', async () => {
      const mockQuery = (table: string) => {
        const query: any = {
          select: () => query,
          eq: () => query,
          is: () => query,
          not: () => query,
          in: () => query,
          gt: () => query,
          order: () => query,
          limit: () => query,
          maybeSingle: async () => {
            if (table === 'offices') {
              return {
                data: { id: testOfficeId, name: 'Registrar', active: true, publication_status: 'published', requires_approval_before_pass: true, archived_at: null },
                error: null,
              };
            }
            if (table === 'office_personnel') {
              return {
                data: { id: testPersonnelId, name: 'Dr. Santos', active: true, office_id: testOfficeId },
                error: null,
              };
            }
            if (table === 'portal_identity_verification_attempts') {
              return {
                data: {
                  id: '77777777-7777-4777-8777-777777777777',
                  outcome: 'matched',
                  expires_at: new Date(Date.now() + 600000).toISOString(),
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
        };
        return query;
      };

      const mockAdmin: any = {
        from: (table: string) => mockQuery(table),
        schema: () => ({
          rpc: async (fn: string) => {
            if (fn === 'consume_rate_limit') return { data: true, error: null };
            if (fn === 'create_specific_person_visit_request') {
              return {
                data: null,
                error: {
                  code: '42501',
                  message: 'proof_already_consumed',
                },
              };
            }
            return { data: null, error: null };
          },
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({ admin: mockAdmin, anon: mockAdmin } as any);
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: visitorUserId, email: 'visitor@test.local' },
        isAnonymous: true,
        isRecoverySession: false,
      } as any);

      const request = new Request('https://egatepass.tech/api/passes/request-office-visit', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-vercel-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          requestId: '55555555-5555-4555-8555-555555555555',
          source: 'portal',
          registrationMode: 'new',
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'juan@test.local',
            purpose: 'Evaluation',
            visitDate: '2026-11-20',
          },
          officeId: testOfficeId,
          requestedPersonName: 'Dr. Santos',
          specificPurpose: 'Evaluation of credentials',
          emailVerificationToken: 'replayed-proof-token-abcdef123456',
          photoIntentId: '11111111-2222-3333-4444-555555555551',
          idIntentId: '11111111-2222-3333-4444-555555555552',
        }),
      });

      const res = await requestOfficeVisitHandler(request);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('proof_already_consumed');
    });

    it('rejects expired verification proof', async () => {
      const rawToken = randomBytes(32).toString('hex');
      const proofDigest = createHash('sha256').update(rawToken).digest('hex');
      const reqIdExpired = 'aaaa5555-0000-4000-8000-000000000005';

      // Insert expired proof
      await db.exec(`
        insert into public.office_visit_verification_proofs (
          proof_digest, actor_id, email, expires_at
        ) values (
          '${proofDigest}', '${visitorUserId}', 'juan@test.local', now() - interval '1 second'
        );
      `);

      await expect(
        db.query(`
          select * from api.create_specific_person_visit_request(
            requested_actor_id => '${visitorUserId}'::uuid,
            requested_request_id => '${reqIdExpired}'::uuid,
            requested_office_id => '${officeId}'::uuid,
            requested_personnel_id => '${personnelId}'::uuid,
            requested_first_name => 'Juan'::text,
            requested_last_name => 'Dela Cruz'::text,
            requested_contact_number => '09171234567'::text,
            requested_email => 'juan@test.local'::text,
            requested_purpose => 'Credentials inquiry'::text,
            requested_visit_date => (current_date + interval '1 day')::date,
            requested_proof_token_digest => '${proofDigest}'::text
          );
        `)
      ).rejects.toThrow(/proof_expired/);
    });

    it('rejects verification proof when actor or email does not match', async () => {
      const rawToken = randomBytes(32).toString('hex');
      const proofDigest = createHash('sha256').update(rawToken).digest('hex');
      const reqIdMismatch = 'aaaa6666-0000-4000-8000-000000000006';

      await db.exec(`
        insert into public.office_visit_verification_proofs (
          proof_digest, actor_id, email, expires_at
        ) values (
          '${proofDigest}', '${visitorUserId}', 'juan@test.local', now() + interval '1 hour'
        );
      `);

      // Actor mismatch: otherVisitorUserId attempts to consume juan's proof
      await expect(
        db.query(`
          select * from api.create_specific_person_visit_request(
            requested_actor_id => '${otherVisitorUserId}'::uuid,
            requested_request_id => '${reqIdMismatch}'::uuid,
            requested_office_id => '${officeId}'::uuid,
            requested_personnel_id => '${personnelId}'::uuid,
            requested_first_name => 'Juan'::text,
            requested_last_name => 'Dela Cruz'::text,
            requested_contact_number => '09171234567'::text,
            requested_email => 'juan@test.local'::text,
            requested_purpose => 'Credentials inquiry'::text,
            requested_visit_date => (current_date + interval '1 day')::date,
            requested_proof_token_digest => '${proofDigest}'::text
          );
        `)
      ).rejects.toThrow(/proof_actor_mismatch/);

      // Email mismatch: correct actor but different email submitted
      await expect(
        db.query(`
          select * from api.create_specific_person_visit_request(
            requested_actor_id => '${visitorUserId}'::uuid,
            requested_request_id => '${reqIdMismatch}'::uuid,
            requested_office_id => '${officeId}'::uuid,
            requested_personnel_id => '${personnelId}'::uuid,
            requested_first_name => 'Juan'::text,
            requested_last_name => 'Dela Cruz'::text,
            requested_contact_number => '09171234567'::text,
            requested_email => 'imposter@test.local'::text,
            requested_purpose => 'Credentials inquiry'::text,
            requested_visit_date => (current_date + interval '1 day')::date,
            requested_proof_token_digest => '${proofDigest}'::text
          );
        `)
      ).rejects.toThrow(/proof_email_mismatch/);
    });
  });

  // ===========================================================================
  // 5. Resend Outbox Guarantees & 24-Hour Idempotency Window Safety
  // ===========================================================================
  describe('5. Resend Outbox Persistent Deduplication beyond 24-Hour Window', () => {
    it('returns existing sent status without calling Resend on retry of already-sent outbox row', async () => {
      let sendEmailCalled = false;
      vi.spyOn(emailModule, 'sendResendEmail').mockImplementation(async () => {
        sendEmailCalled = true;
        return { id: 'msg_test_dup', provider: 'resend' };
      });

      const mockAdmin: any = {
        schema: () => ({
          rpc: async (fn: string) => {
            if (fn === 'claim_office_visit_acknowledgement_for_delivery') {
              // Row already sent: claim RPC returns 0 rows (empty claim)
              return { data: [], error: null };
            }
            return { data: null, error: null };
          },
        }),
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  delivery_status: 'sent',
                  provider_message_id: 'msg_already_delivered_123',
                },
                error: null,
              }),
            }),
          }),
        }),
      };

      const result = await officeDeliveryModule.deliverOfficeAcknowledgementEmail(mockAdmin, {
        visitId: '00000000-0000-4000-8000-000000000099',
        recipientEmail: 'juan@test.local',
        visitorName: 'Juan Dela Cruz',
        officeName: 'Registrar',
        personnelName: 'Director Garcia',
        visitDate: '2026-11-20',
        trackingUrl: 'https://egatepass.tech/track#t=123',
      });

      // Assert: Status is sent, provider message id is recovered, and Resend was NEVER called
      expect(result.status).toBe('sent');
      expect(result.providerMessageId).toBe('msg_already_delivered_123');
      expect(sendEmailCalled).toBe(false);
    });

    it('marks outbox in explicit reconciliation_required state and refuses blind retry past 24 hours', async () => {
      let sendEmailCalled = false;
      vi.spyOn(emailModule, 'sendResendEmail').mockImplementation(async () => {
        sendEmailCalled = true;
        return { id: 'msg_blind_retry', provider: 'resend' };
      });

      let recordedStatus: string | null = null;
      let recordedError: string | null = null;

      const mockAdmin: any = {
        schema: () => ({
          rpc: async (fn: string, params: any) => {
            if (fn === 'claim_office_visit_acknowledgement_for_delivery') {
              return {
                data: [{
                  outbox_id: 'outbox-uuid-1234',
                  claim_id: 'claim-uuid-5678',
                  recipient_email: 'juan@test.local',
                  encrypted_tracking_token: 'enc-token',
                  idempotency_key: 'office-ack-1234',
                  attempt_count: 2,
                }],
                error: null,
              };
            }
            if (fn === 'record_office_visit_acknowledgement_result') {
              recordedStatus = params.requested_status;
              recordedError = params.requested_error;
              return { data: { ok: true }, error: null };
            }
            return { data: null, error: null };
          },
        }),
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  // Outbox was created 25 hours ago, with an earlier attempt
                  created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
                  last_attempt_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
                  attempt_count: 2,
                },
                error: null,
              }),
            }),
          }),
        }),
      };

      const result = await officeDeliveryModule.deliverOfficeAcknowledgementEmail(mockAdmin, {
        visitId: '00000000-0000-4000-8000-000000000099',
        recipientEmail: 'juan@test.local',
        visitorName: 'Juan Dela Cruz',
        officeName: 'Registrar',
        personnelName: 'Director Garcia',
        visitDate: '2026-11-20',
        trackingUrl: 'https://egatepass.tech/track#t=123',
      });

      // Assert: Marked as reconciliation_required, error recorded, and Resend was NEVER called
      expect(result.status).toBe('reconciliation_required');
      expect(result.reconciliationRequired).toBe(true);
      expect(recordedStatus).toBe('reconciliation_required');
      expect(recordedError).toBe('resend_idempotency_window_expired_reconciliation_required');
      expect(sendEmailCalled).toBe(false);
    });
  });
});
