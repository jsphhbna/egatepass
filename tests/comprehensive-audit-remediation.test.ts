import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  createEmailVerificationProofToken,
  verifyEmailVerificationProofToken,
} from '../server/lib/office.js';

describe('Comprehensive Audit, Security Hardening & Bug Remediation Tests', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OFFICE_VISIT_HMAC_SECRET = 'test_office_visit_hmac_secret_32_chars_min!';
    process.env.VITE_TURNSTILE_SITE_KEY = '0x4AAAAAAFeETebgPENH6hgH';
    process.env.PASS_TOKEN_SECRET = 'test-pass-token-secret-at-least-32-chars!';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('1. Email Verification Proof Token Hardening (server/lib/office.ts & issue.ts)', () => {
    it('rejects arbitrary forged 64-character hex strings in verifyEmailVerificationProofToken', () => {
      const forgedHex = 'a'.repeat(64);
      const forgedRandom = createHash('sha256').update('attacker-forged').digest('hex');

      expect(verifyEmailVerificationProofToken(forgedHex, 'victim@earist.edu.ph', '11111111-1111-4111-8111-111111111111')).toBe(false);
      expect(verifyEmailVerificationProofToken(forgedRandom, 'victim@earist.edu.ph', '11111111-1111-4111-8111-111111111111')).toBe(false);
    });

    it('accepts valid HMAC v_email proof tokens bound to exact email and actorId', () => {
      const email = 'visitor@earist.edu.ph';
      const actorId = '11111111-1111-4111-8111-111111111111';
      const validToken = createEmailVerificationProofToken(email, actorId, 300);

      expect(verifyEmailVerificationProofToken(validToken, email, actorId)).toBe(true);
      expect(verifyEmailVerificationProofToken(validToken, 'other@earist.edu.ph', actorId)).toBe(false);
      expect(verifyEmailVerificationProofToken(validToken, email, '22222222-2222-4222-8222-222222222222')).toBe(false);
    });

    it('rejects forged 64-hex opaque proof tokens inside POST /api/passes/issue against office_visit_verification_proofs', async () => {
      const actorId = '11111111-1111-4111-8111-111111111111';
      const supabaseMod = await import('../server/supabase.js');
      const actorsMod = await import('../server/actors.js');

      vi.spyOn(actorsMod, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: actorId, is_anonymous: true, email: '' } as any,
        isAnonymous: true,
        isRecoverySession: false,
      });

      const mockAdmin: any = {
        from: vi.fn((table: string) => {
          if (table === 'office_visit_verification_proofs') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          };
        }),
      };
      vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const { default: issueHandler } = await import('../server/routes/passes/issue.js');
      const req = new Request('https://egatepass.tech/api/passes/issue', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer visitor-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'portal',
          registrationMode: 'new',
          requestId: '33333333-3333-4333-8333-333333333333',
          arrivalMode: 'no_vehicle',
          photoIntentId: '44444444-4444-4444-8444-444444444444',
          idIntentId: '55555555-5555-4555-8555-555555555555',
          emailVerificationToken: 'f'.repeat(64),
          visitor: {
            firstName: 'Juan',
            lastName: 'Dela Cruz',
            contactNumber: '09171234567',
            email: 'forged@example.com',
            purpose: 'Registrar Document Request',
            visitDate: '2026-11-26',
          },
          psgc: {
            version: '2026-q3',
            regionCode: '1300000000',
            cityCode: '1380600000',
            barangayCode: '1380606014',
          },
        }),
      });

      const res = await issueHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('email_verification_invalid');
    });
  });

  describe('2. Vercel Asset Bundling & Email Delivery Idempotency/Correlation', () => {
    it('bundles public/earist-logo.png in vercel.json functions includeFiles for server branded QR generation', () => {
      const vercelConfig = JSON.parse(readFileSync('vercel.json', 'utf8'));
      const includeFiles: string = vercelConfig.functions?.['api/passes/[...route].ts']?.includeFiles ?? '';
      expect(includeFiles).toContain('public/earist-logo.png');
      expect(includeFiles).toContain('public/fonts/**');
    });

    it('passes idempotencyKey and correlationId in server/routes/passes/email.ts for Resend retries & webhooks', () => {
      const emailRouteSrc = readFileSync('server/routes/passes/email.ts', 'utf8');
      expect(emailRouteSrc).toContain('pass-email-otp-${state.verification_id}-${parsed.data.requestId}');
      expect(emailRouteSrc).toContain('pass-email-dispatch-${verificationId}-${requestId}');
      expect(emailRouteSrc).toContain('correlationId: state.verification_id');
      expect(emailRouteSrc).toContain('correlationId: verificationId');
    });
  });

  describe('3. Emergency Device Query & Case-Insensitive Guard Gate Matching', () => {
    it('does not select nonexistent offices.code column in server/routes/gate/emergency-device.ts', () => {
      const emergencySrc = readFileSync('server/routes/gate/emergency-device.ts', 'utf8');
      expect(emergencySrc).not.toMatch(/\.from\('offices'\)[\s\S]{0,80}\bcode\b/);
      expect(emergencySrc).toContain(".select('id, name, requires_approval_before_pass')");
    });

    it('authorizes Guard Station photo & vehicle_photo evidence case-insensitively across gate casing variations', async () => {
      const actorsMod = await import('../server/actors.js');
      const supabaseMod = await import('../server/supabase.js');
      const evidenceMod = await import('../server/routes/gate/evidence.js');

      vi.spyOn(actorsMod, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'station-1', is_anonymous: false } as any,
        isAnonymous: false,
        isRecoverySession: false,
      });

      const evidenceId = '66666666-6666-4666-8666-666666666666';
      const visitorId = '77777777-7777-4777-8777-777777777777';

      const mockAdmin: any = {
        from: vi.fn((table: string) => {
          if (table === 'staff_profiles') {
            return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
          }
          if (table === 'devices') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { user_id: 'station-1', status: 'active', type: 'guard_station', gate: 'Back Gate' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'visitor_evidence') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      visitor_id: visitorId,
                      bucket_id: 'visitor-photos',
                      object_path: 'portal/photo.jpg',
                      content_type: 'image/jpeg',
                      expires_at: new Date(Date.now() + 86400_000).toISOString(),
                      purged_at: null,
                      kind: 'photo',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { returning_profile_id: null }, error: null }),
                }),
              }),
            };
          }
          if (table === 'passes') {
            return {
              select: () => ({
                in: () => ({
                  eq: () => ({
                    not: () => ({
                      in: async () => ({
                        data: [{ id: 'pass-1', gate: 'back gate' }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        storage: {
          from: () => ({
            download: async () => ({
              data: new Blob(['jpeg-data'], { type: 'image/jpeg' }),
              error: null,
            }),
          }),
        },
      };

      vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const req = new Request(`https://egatepass.tech/api/gate/evidence?id=${evidenceId}`, {
        headers: { Authorization: 'Bearer station-jwt' },
      });
      const res = await evidenceMod.default.fetch(req);
      expect(res.status).toBe(200);
    });

    it('matches Back gate vs Back Gate case-insensitively in guard-station-feed when ilike is supported', async () => {
      const actorsMod = await import('../server/actors.js');
      const supabaseMod = await import('../server/supabase.js');
      const feedMod = await import('../server/routes/gate/guard-station-feed.js');

      vi.spyOn(actorsMod, 'getVerifiedSessionContext').mockResolvedValue({
        user: { id: 'station-bg', is_anonymous: false } as any,
        isAnonymous: false,
        isRecoverySession: false,
      });

      const recordedPasses = [
        {
          id: 'p-1',
          public_reference: 'ref-1',
          status: 'inside',
          source: 'portal',
          entry_scanned_at: new Date().toISOString(),
          time_in: new Date().toISOString(),
          time_out: null,
          visitor_id: 'v-1',
          gate: 'Back gate',
        },
      ];

      const mockAdmin: any = {
        from: vi.fn((table: string) => {
          let rows: any[] = [];
          if (table === 'devices') {
            rows = [{ user_id: 'station-bg', name: 'Station BG', alias: 'BG', type: 'guard_station', gate: 'Back Gate', status: 'active', last_seen_at: null }];
          } else if (table === 'staff_profiles') {
            rows = [];
          } else if (table === 'passes') {
            rows = [...recordedPasses];
          } else if (table === 'visitors') {
            rows = [{ id: 'v-1', full_name: 'Maria Santos', purpose: 'Meeting' }];
          } else if (table === 'visitor_evidence' || table === 'visit_vehicle_declarations' || table === 'office_visits' || table === 'offices') {
            rows = [];
          }

          let headOnly = false;
          const builder: any = {
            select: (_c?: string, opts?: { head?: boolean }) => {
              headOnly = Boolean(opts?.head);
              return builder;
            },
            update: () => builder,
            eq: (col: string, val: any) => {
              rows = rows.filter((r) => r[col] === val);
              return builder;
            },
            ilike: (col: string, pattern: string) => {
              const clean = pattern.replace(/\\([%_\\])/g, '$1').toLowerCase();
              rows = rows.filter((r) => String(r[col] ?? '').toLowerCase() === clean);
              return builder;
            },
            in: (col: string, vals: any[]) => {
              rows = rows.filter((r) => vals.includes(r[col]));
              return builder;
            },
            not: (col: string, op: string, val: any) => {
              if (op === 'is' && val === null) rows = rows.filter((r) => r[col] != null);
              return builder;
            },
            is: (col: string, val: any) => {
              if (val === null) rows = rows.filter((r) => r[col] == null);
              return builder;
            },
            gte: () => builder,
            lte: () => builder,
            or: () => builder,
            order: () => builder,
            limit: (n: number) => {
              rows = rows.slice(0, n);
              return builder;
            },
            maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
            then: (resolve: (val: any) => any) =>
              resolve(headOnly ? { count: rows.length, error: null } : { data: rows, error: null }),
          };
          return builder;
        }),
      };

      vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const res = await feedMod.default.fetch(
        new Request('https://egatepass.tech/api/guard-station-feed', {
          headers: { Authorization: 'Bearer station-jwt' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].gate).toBe('Back gate');
    });
  });

  describe('4. Search, Reports & Accountability Pre-Pagination & Filter Accuracy', () => {
    it('collects matching office_visit and exited_unconfirmed records across batches and excludes completed visits', async () => {
      const actorsMod = await import('../server/actors.js');
      const supabaseMod = await import('../server/supabase.js');
      const accountabilityMod = await import('../server/lib/accountability.js');
      const recordsMod = await import('../server/routes/admin/records.js');

      vi.spyOn(actorsMod, 'requireStaffActor').mockResolvedValue({
        id: 'admin-1',
        role: 'superadmin',
        email: 'superadmin@earist.edu.ph',
      } as any);
      vi.spyOn(accountabilityMod, 'getAccountabilitySummary').mockResolvedValue({ data: null, error: null } as any);

      // Build dataset where row 1 is completed office visit, row 2 is exited_unconfirmed, row 3 has no office
      const dataset = [
        {
          id: 'pass-completed',
          visitor_id: 'v-1',
          source: 'portal',
          status: 'exited',
          valid_from: '2026-11-24T00:00:00Z',
          valid_until: '2026-11-24T09:00:00Z',
          issued_at: '2026-11-24T01:00:00Z',
          entry_scanned_at: '2026-11-24T01:30:00Z',
          decided_at: null,
          time_in: '2026-11-24T01:30:00Z',
          time_out: '2026-11-24T03:00:00Z',
          entry_device_id: null,
          exit_device_id: null,
          decided_by: null,
          rejection_reason: null,
          gate: 'Main Gate',
          accountability_status: 'pending',
          visitors: { full_name: 'Completed Visitor', purpose: 'Visit', visit_date: '2026-11-24', visitor_evidence: [] },
          office_visits: [{ id: 'ov-1', attendance_status: 'completed', visit_type: 'specific_person', approval_status: 'approved', offices: { id: 'o-1', name: 'Registrar' } }],
          visitor_accountability_resolutions: [],
        },
        {
          id: 'pass-no-office',
          visitor_id: 'v-2',
          source: 'portal',
          status: 'exited',
          valid_from: '2026-11-24T00:00:00Z',
          valid_until: '2026-11-24T09:00:00Z',
          issued_at: '2026-11-24T00:50:00Z',
          entry_scanned_at: '2026-11-24T01:10:00Z',
          decided_at: null,
          time_in: '2026-11-24T01:10:00Z',
          time_out: '2026-11-24T02:00:00Z',
          entry_device_id: null,
          exit_device_id: null,
          decided_by: null,
          rejection_reason: null,
          gate: 'Main Gate',
          accountability_status: 'pending',
          visitors: { full_name: 'General Campus Visitor', purpose: 'Inquiry', visit_date: '2026-11-24', visitor_evidence: [] },
          office_visits: [],
          visitor_accountability_resolutions: [],
        },
        {
          id: 'pass-exited-unconfirmed',
          visitor_id: 'v-3',
          source: 'portal',
          status: 'exited',
          valid_from: '2026-11-24T00:00:00Z',
          valid_until: '2026-11-24T09:00:00Z',
          issued_at: '2026-11-24T00:40:00Z',
          entry_scanned_at: '2026-11-24T01:05:00Z',
          decided_at: null,
          time_in: '2026-11-24T01:05:00Z',
          time_out: '2026-11-24T02:15:00Z',
          entry_device_id: null,
          exit_device_id: null,
          decided_by: null,
          rejection_reason: null,
          gate: 'Main Gate',
          accountability_status: 'pending',
          visitors: { full_name: 'Unconfirmed Office Visitor', purpose: 'Records', visit_date: '2026-11-24', visitor_evidence: [] },
          office_visits: [{ id: 'ov-3', attendance_status: 'exited_unconfirmed', visit_type: 'specific_person', approval_status: 'approved', offices: { id: 'o-2', name: 'OSAS' } }],
          visitor_accountability_resolutions: [],
        },
      ];

      const mockAdmin: any = {
        from: vi.fn((table: string) => {
          if (table === 'app_settings') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { working_hours_start: '08:00:00', working_hours_end: '17:00:00', timezone: 'Asia/Manila' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'passes') {
            let rows = [...dataset];
            const builder: any = {
              select: () => builder,
              order: () => builder,
              eq: () => builder,
              in: () => builder,
              gte: () => builder,
              lte: () => builder,
              or: () => builder,
              is: () => builder,
              neq: () => builder,
              not: () => builder,
              lt: () => builder,
              limit: (n: number) => {
                rows = rows.slice(0, n);
                return builder;
              },
              then: (resolve: (val: any) => any) =>
                resolve({ data: rows, count: dataset.length, error: null }),
            };
            return builder;
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      };

      vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const res = await recordsMod.handleRequest(
        new Request('https://egatepass.tech/api/admin/records?category=exited_unconfirmed&pageSize=1', {
          headers: { Authorization: 'Bearer admin-jwt' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.passes).toHaveLength(1);
      expect(body.passes[0].id).toBe('pass-exited-unconfirmed');
      expect(body.totalCount).toBe(1);
    });

    it('sends exited_unconfirmed and specific_unconfirmed categories in AdminRecords.tsx and checks completed status', () => {
      const uiSrc = readFileSync('src/pages/AdminRecords.tsx', 'utf8');
      expect(uiSrc).toContain("'exited_unconfirmed', 'specific_unconfirmed'");
      expect(uiSrc).toContain("p.attendanceStatus !== 'completed'");
    });
  });

  describe('5. Turnstile Supabase Auth Status Reporting & Documentation Consistency', () => {
    it('reports Supabase Auth Attack Protection Turnstile readiness accurately in settings API and UI', async () => {
      const actorsMod = await import('../server/actors.js');
      const supabaseMod = await import('../server/supabase.js');
      const settingsMod = await import('../server/routes/admin/settings.js');

      delete process.env.TURNSTILE_SECRET_KEY;
      vi.spyOn(actorsMod, 'requireStaffActor').mockResolvedValue({ id: 'sa-1', role: 'superadmin' } as any);
      const mockAdmin: any = {
        from: vi.fn(() => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  working_hours_start: '08:00',
                  working_hours_end: '17:00',
                  timezone: 'Asia/Manila',
                  peak_mode: 'off',
                  rejection_reasons: [],
                  visit_purposes: [],
                  visitor_instructions: [],
                  image_retention_days: 7,
                  visitor_retention_days: 30,
                  audit_retention_days: 365,
                  reconciliation_retention_days: 90,
                  scheduling_days_ahead: 14,
                  updated_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        })),
        schema: () => ({
          rpc: async () => ({ data: { isLocked: false, status: 'idle' }, error: null }),
        }),
      };
      vi.spyOn(supabaseMod, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin,
        passwordVerifier: {} as any,
      });

      const res = await settingsMod.GET(
        new Request('https://egatepass.tech/api/admin/settings', {
          headers: { Authorization: 'Bearer sa-jwt' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.security.turnstileSiteKeyConfigured).toBe(true);
      expect(body.security.turnstileVerifierConfigured).toBe(true);
      expect(body.security.turnstileFullyVerified).toBe(true);
    });

    it('keeps docs/DEPLOYMENT.md aligned with supported valid ID upload and live selfie capture', () => {
      const deploymentDoc = readFileSync('docs/DEPLOYMENT.md', 'utf8');
      expect(deploymentDoc).toContain('live selfie (camera-only)');
      expect(deploymentDoc).toContain('JPEG, PNG, or WebP upload');
    });
  });

  describe('6. Database Migration 20261125000100 Behavior & Advisor Contract (PGlite)', () => {
    it('fixes api.scan_pass unconfirmed office exit dual-write, syncs office_visits on recovery, and satisfies RLS/FK indexes', async () => {
      const db = new PGlite();
      await db.exec(`
        create schema if not exists auth;
        create schema if not exists storage;
        create schema if not exists private;
        create schema if not exists api;

        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
        end $$;

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
        create table if not exists auth.mfa_factors (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null,
          factor_type text not null default 'totp',
          status text not null default 'unverified'
        );
        create or replace function auth.uid() returns uuid as $$
          select coalesce(
            nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
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
          select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
        $$ language sql stable;

        create table if not exists storage.buckets (
          id text primary key,
          name text not null,
          public boolean default false,
          file_size_limit bigint,
          allowed_mime_types text[]
        );
        create table if not exists storage.objects (
          id uuid primary key default gen_random_uuid(),
          bucket_id text not null,
          name text not null,
          owner uuid,
          owner_id text,
          created_at timestamptz default now()
        );

        grant usage on schema auth to anon, authenticated, service_role;
        grant execute on function auth.uid() to anon, authenticated, service_role;
        grant execute on function auth.role() to anon, authenticated, service_role;
        grant execute on function auth.jwt() to anon, authenticated, service_role;

        do $$
        begin
          if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
            create publication supabase_realtime;
          end if;
        end
        $$;
      `);

      const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
      const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const sql = readFileSync(join(migrationsDir, file), 'utf8').replace(
          /create extension if not exists pgcrypto[^;]*;/gi,
          '-- pgcrypto no-op',
        );
        await db.exec(sql);
      }

      // 1. Setup test actors, office, pass & office_visit for unconfirmed exit check
      const entryDevId = 'aaaaaaaa-0000-4000-8000-000000000001';
      const exitDevId = 'aaaaaaaa-0000-4000-8000-000000000002';
      const adminId = 'aaaaaaaa-0000-4000-8000-000000000003';
      const visitorOwnerId = 'aaaaaaaa-0000-4000-8000-000000000004';
      const visitorId = 'bbbbbbbb-0000-4000-8000-000000000001';
      const passId = 'bbbbbbbb-0000-4000-8000-000000000002';
      const officeId = 'cccccccc-0000-4000-8000-000000000001';
      const visitId = 'dddddddd-0000-4000-8000-000000000001';
      const rawToken = 'p_' + '12'.repeat(32);
      const tokenDigest = createHash('sha256').update(rawToken).digest('hex');

      await db.exec(`
        insert into auth.users (id, email, email_confirmed_at, is_anonymous) values
          ('${entryDevId}', 'entry@device.local', now(), false),
          ('${exitDevId}', 'exit@device.local', now(), false),
          ('${adminId}', 'admin@earist.edu.ph', now(), false),
          ('${visitorOwnerId}', null, null, true);

        insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at) values
          ('${adminId}', 'Admin Guard', 'superadmin', true, false, now());

        insert into public.devices (user_id, name, alias, type, gate, status) values
          ('${entryDevId}', 'Entry Scanner', 'entry-back-1', 'entry', 'Back Gate', 'active'),
          ('${exitDevId}', 'Exit Scanner', 'exit-back-1', 'exit', 'Back gate', 'active');

        insert into public.offices (id, name, active, publication_status) values
          ('${officeId}', 'Office of Student Affairs', true, 'published');

        insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at) values
          ('${visitorId}', '${visitorOwnerId}', 'portal', 'Test Visitor', '+639171234567', 'Inquiry', current_date, now());

        insert into public.passes (id, visitor_id, source, status, valid_from, valid_until, token_digest, issue_request_id) values
          ('${passId}', '${visitorId}', 'portal', 'issued', now() - interval '1 hour', now() + interval '4 hours', decode('${tokenDigest}', 'hex'), gen_random_uuid());

        insert into public.office_visits (
          id, visit_type, office_id, approval_status, attendance_status,
          visitor_actor_id, visitor_id, pass_id,
          visitor_first_name, visitor_last_name, visitor_display_name, visitor_contact_number,
          purpose, visit_date, request_id
        ) values (
          '${visitId}', 'general', '${officeId}', 'approved', 'awaiting_entry',
          '${visitorOwnerId}', '${visitorId}', '${passId}',
          'Test', 'Visitor', 'Test Visitor', '+639171234567',
          'Inquiry', current_date, gen_random_uuid()
        );
      `);

      // Scan entry
      const entryRes = await db.query<{ ok: boolean; result_status: string }>(`
        select ok, result_status from api.scan_pass('${entryDevId}'::uuid, '${tokenDigest}', 'entry'::public.device_type, gen_random_uuid());
      `);
      expect(entryRes.rows[0]?.ok).toBe(true);
      expect(entryRes.rows[0]?.result_status).toBe('inside');

      // Exit without office confirmation (notice mixed case 'Back gate' vs 'Back Gate'!)
      const exitRes = await db.query<{ ok: boolean; result_status: string; code: string }>(`
        select ok, result_status, code from api.scan_pass('${exitDevId}'::uuid, '${tokenDigest}', 'exit'::public.device_type, gen_random_uuid());
      `);
      expect(exitRes.rows[0]?.ok).toBe(true);
      expect(exitRes.rows[0]?.result_status).toBe('exited');
      expect(exitRes.rows[0]?.code).toBe('office_unconfirmed');

      // CRITICAL ASSERTION: Zero spurious 'invalid_scan' events in visit_events!
      const events = await db.query<{ event: string }>(`
        select event::text as event from public.visit_events where pass_id = '${passId}' order by occurred_at asc;
      `);
      expect(events.rows.map((r) => r.event)).toEqual(['scan_entry', 'scan_exit']);

      const officeVisitAfterExit = await db.query<{ attendance_status: string }>(`
        select attendance_status::text as attendance_status from public.office_visits where id = '${visitId}';
      `);
      expect(officeVisitAfterExit.rows[0]?.attendance_status).toBe('exited_unconfirmed');

      // 2. Test guard_recover_pass_action syncs office_visits on approve_entry & record_exit
      const pass2Id = 'bbbbbbbb-0000-4000-8000-000000000012';
      const visitor2Id = 'bbbbbbbb-0000-4000-8000-000000000011';
      const visit2Id = 'dddddddd-0000-4000-8000-000000000012';
      const token2Digest = createHash('sha256').update('p_' + '34'.repeat(32)).digest('hex');

      await db.exec(`
        insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at) values
          ('${visitor2Id}', '${visitorOwnerId}', 'portal', 'Recovery Visitor', '+639171234568', 'Records', current_date, now());
        insert into public.passes (id, visitor_id, source, status, valid_from, valid_until, token_digest, issue_request_id) values
          ('${pass2Id}', '${visitor2Id}', 'portal', 'issued', now() - interval '1 hour', now() + interval '4 hours', decode('${token2Digest}', 'hex'), gen_random_uuid());
        insert into public.office_visits (
          id, visit_type, office_id, approval_status, attendance_status,
          visitor_actor_id, visitor_id, pass_id,
          visitor_first_name, visitor_last_name, visitor_display_name, visitor_contact_number,
          purpose, visit_date, request_id
        ) values (
          '${visit2Id}', 'general', '${officeId}', 'approved', 'awaiting_entry',
          '${visitorOwnerId}', '${visitor2Id}', '${pass2Id}',
          'Recovery', 'Visitor', 'Recovery Visitor', '+639171234568',
          'Records', current_date, gen_random_uuid()
        );
      `);

      await db.exec(`
        select set_config('request.jwt.claims', '{"sub":"${adminId}","role":"authenticated","aal":"aal1"}', false);
        select set_config('request.jwt.claim.sub', '${adminId}', false);
        select set_config('request.jwt.claim.role', 'authenticated', false);
      `);

      await db.query(`select api.guard_recover_pass_action('${pass2Id}'::uuid, 'approve_entry', 'Scanner offline');`);
      const ovAfterRecoveryEntry = await db.query<{ attendance_status: string }>(`
        select attendance_status::text as attendance_status from public.office_visits where id = '${visit2Id}';
      `);
      expect(ovAfterRecoveryEntry.rows[0]?.attendance_status).toBe('awaiting_office_confirmation');

      await db.query(`select api.guard_recover_pass_action('${pass2Id}'::uuid, 'record_exit', 'Manual exit logged');`);
      const ovAfterRecoveryExit = await db.query<{ attendance_status: string }>(`
        select attendance_status::text as attendance_status from public.office_visits where id = '${visit2Id}';
      `);
      expect(ovAfterRecoveryExit.rows[0]?.attendance_status).toBe('exited_unconfirmed');

      // 3. Verify consolidated RLS policies & FK indexes exist
      await db.exec(`select set_config('request.jwt.claim.role', 'service_role', false);`);
      const policyCheck = await db.query<{ tablename: string; count: string }>(`
        select tablename, count(*)::text as count
        from pg_policies
        where schemaname = 'public'
          and tablename in ('passes', 'visit_events')
          and cmd = 'SELECT'
        group by tablename
        order by tablename;
      `);
      expect(policyCheck.rows).toEqual([
        { tablename: 'passes', count: '1' },
        { tablename: 'visit_events', count: '1' },
      ]);

      const idxCheck = await db.query<{ indexname: string }>(`
        select indexname from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'idx_office_visits_confirmed_by',
            'idx_office_visits_decided_by',
            'idx_passes_accountability_resolved_by',
            'idx_sms_logs_actor_id',
            'idx_var_actor_id'
          );
      `);
      expect(idxCheck.rows).toHaveLength(5);
    }, 60000);
  });
});
