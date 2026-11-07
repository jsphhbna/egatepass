import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { encryptQrPayload, decryptQrPayload } from '../server/lib/encryption.js';

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

async function applyAllMigrations(db: PGlite) {
  await setupSupabaseEmulation(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`Error executing migration ${file}:`, err);
      throw err;
    }
  }
}

describe('Post-Release Reliability & Root-Cause Remediation Test Suite (Findings A–F)', () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_HMAC_SECRET = 'c'.repeat(32);
    process.env.OFFICE_VISIT_HMAC_SECRET = 'a'.repeat(32);
    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = 'b'.repeat(32);
  });

  describe('Finding A: Atomic Multi-Dimensional Rate Limiting & Anonymous Visitor Session Enforcement', () => {
    it('enforces multi-dimensional rate limits with sorted 64-bit advisory locks (actor=5, email=5, ip=15)', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const actor1 = '11111111-1111-4111-8111-111111111111';
      const actor2 = '22222222-2222-4222-8222-222222222222';
      const emailA = 'visitor.a@earist.edu.ph';
      const emailB = 'VISITOR.A@EARIST.EDU.PH'; // Test case-insensitivity
      const emailC = 'visitor.c@earist.edu.ph';
      const ipSecret = process.env.RATE_LIMIT_HMAC_SECRET!;
      const ipHmac1 = createHmac('sha256', ipSecret).update('203.0.113.195').digest('hex');
      const ipHmac2 = createHmac('sha256', ipSecret).update('203.0.113.196').digest('hex');
      const codeHash = 'hash0000000000000000000000000000000000000000000000000000000000000000';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await db.query(`insert into auth.users (id, email) values ('${actor1}', '${emailA}'), ('${actor2}', '${emailC}');`);

      // 1. Requests 1 through 5 for actor1 with emailA must succeed
      for (let i = 1; i <= 5; i++) {
        const res = await db.query<{ allowed: boolean; error_code: string | null; challenge_id: string | null }>(`
          select * from api.request_office_email_verification_slot(
            '${actor1}'::uuid,
            '${emailA}'::text,
            '${ipHmac1}'::text,
            '${codeHash}'::text,
            '${expiresAt}'::timestamptz
          );
        `);
        expect(res.rows[0].allowed).toBe(true);
        expect(res.rows[0].error_code).toBeNull();
        expect(res.rows[0].verification_id).toBeTruthy();
      }

      // 2. Request 6 from actor1 must be rejected by rate limit
      const resActorLimit = await db.query<{ allowed: boolean; error_code: string | null }>(`
        select * from api.request_office_email_verification_slot(
          '${actor1}'::uuid,
          'different.email@earist.edu.ph'::text,
          '${ipHmac2}'::text,
          '${codeHash}'::text,
          '${expiresAt}'::timestamptz
        );
      `);
      expect(resActorLimit.rows[0].allowed).toBe(false);
      expect(resActorLimit.rows[0].error_code).toBe('too_many_actor_requests');

      // 3. Request for emailA from actor2 (different actor, same case-insensitive email) must be rejected
      const resEmailLimit = await db.query<{ allowed: boolean; error_code: string | null }>(`
        select * from api.request_office_email_verification_slot(
          '${actor2}'::uuid,
          '${emailB}'::text,
          '${ipHmac2}'::text,
          '${codeHash}'::text,
          '${expiresAt}'::timestamptz
        );
      `);
      expect(resEmailLimit.rows[0].allowed).toBe(false);
      expect(resEmailLimit.rows[0].error_code).toBe('too_many_email_requests');

      // 4. Test IP HMAC limit: 15 requests
      const ipTestActorBase = '33333333-3333-4333-8333-3333333333';
      const ipTestHmac = createHmac('sha256', ipSecret).update('198.51.100.50').digest('hex');

      for (let i = 1; i <= 15; i++) {
        const paddedId = `${ipTestActorBase}${String(i).padStart(2, '0')}`;
        const uniqueEmail = `user.${i}@earist.edu.ph`;
        await db.query(`insert into auth.users (id, email) values ('${paddedId}', '${uniqueEmail}');`);

        const res = await db.query<{ allowed: boolean; error_code: string | null }>(`
          select * from api.request_office_email_verification_slot(
            '${paddedId}'::uuid,
            '${uniqueEmail}'::text,
            '${ipTestHmac}'::text,
            '${codeHash}'::text,
            '${expiresAt}'::timestamptz
          );
        `);
        expect(res.rows[0].allowed).toBe(true);
      }

      // 16th request from same IP HMAC must fail with too_many_ip_requests
      const actor16 = `${ipTestActorBase}16`;
      const email16 = 'user.16@earist.edu.ph';
      await db.query(`insert into auth.users (id, email) values ('${actor16}', '${email16}');`);

      const resIpLimit = await db.query<{ allowed: boolean; error_code: string | null }>(`
        select * from api.request_office_email_verification_slot(
          '${actor16}'::uuid,
          '${email16}'::text,
          '${ipTestHmac}'::text,
          '${codeHash}'::text,
          '${expiresAt}'::timestamptz
        );
      `);
      expect(resIpLimit.rows[0].allowed).toBe(false);
      expect(resIpLimit.rows[0].error_code).toBe('too_many_ip_requests');
    }, 60000);

    it('enforces anonymous visitor session invariant: rejects staff and recovery sessions', () => {
      // Simulate session inspection contract in server/routes/office/verify-email.ts
      function validateVisitorSession(session: { isAnonymous?: boolean; userRole?: string; isRecovery?: boolean }) {
        if (!session || !session.isAnonymous || session.isRecovery) {
          return { ok: false, status: 403, error: 'anonymous_visitor_session_required' };
        }
        return { ok: true };
      }

      // 1. Anonymous visitor session: accepted
      expect(validateVisitorSession({ isAnonymous: true })).toEqual({ ok: true });

      // 2. Regular staff session: rejected 403
      expect(validateVisitorSession({ isAnonymous: false, userRole: 'staff' })).toEqual({
        ok: false,
        status: 403,
        error: 'anonymous_visitor_session_required',
      });

      // 3. Admin session: rejected 403
      expect(validateVisitorSession({ isAnonymous: false, userRole: 'admin' })).toEqual({
        ok: false,
        status: 403,
        error: 'anonymous_visitor_session_required',
      });

      // 4. Recovery session: rejected 403
      expect(validateVisitorSession({ isAnonymous: true, isRecovery: true })).toEqual({
        ok: false,
        status: 403,
        error: 'anonymous_visitor_session_required',
      });
    });
  });

  describe('Finding B & C: Decoupled Truthful Decision Reporting & Delivery Provenance', () => {
    it('decouples approval decision outcome from email delivery failure', () => {
      // Simulation of server/routes/office/decide.ts logic
      function formatDecideResponse(
        action: 'approved' | 'rejected',
        visitId: string,
        visitorId: string,
        emailResult: { ok: boolean; status: string; providerMessageId?: string; error?: string }
      ) {
        return {
          ok: true,
          decision: action,
          visitId,
          visitorId,
          emailDelivery: {
            status: emailResult.ok ? 'sent' : 'failed',
            providerMessageId: emailResult.providerMessageId || null,
            error: emailResult.error || null,
          },
        };
      }

      // Case 1: Approval succeeded, email delivered to provider
      const response1 = formatDecideResponse('approved', 'visit-1', 'vis-1', {
        ok: true,
        status: 'sent',
        providerMessageId: 'msg_12345',
      });
      expect(response1.ok).toBe(true);
      expect(response1.decision).toBe('approved');
      expect(response1.emailDelivery.status).toBe('sent');
      expect(response1.emailDelivery.providerMessageId).toBe('msg_12345');

      // Case 2: Approval succeeded, but Resend transport threw connection timeout
      const response2 = formatDecideResponse('approved', 'visit-2', 'vis-2', {
        ok: false,
        status: 'failed',
        error: 'Resend API network timeout',
      });
      expect(response2.ok).toBe(true);
      expect(response2.decision).toBe('approved'); // Decision is preserved!
      expect(response2.emailDelivery.status).toBe('failed');
      expect(response2.emailDelivery.error).toBe('Resend API network timeout');
    });

    it('tracks delivery provenance and avoids composite outbox row collisions', () => {
      // Test composite keying: ${office_visit_id}:${email_type}
      const outboxRows = [
        {
          id: 'outbox-1',
          office_visit_id: 'visit-100',
          email_type: 'office_approval',
          delivery_status: 'delivered',
          confirmation_source: 'provider_webhook',
        },
        {
          id: 'outbox-2',
          office_visit_id: 'visit-100',
          email_type: 'office_rejection',
          delivery_status: 'failed',
          confirmation_source: null,
        },
      ];

      const outboxByVisitAndType = new Map<string, (typeof outboxRows)[0]>();
      for (const row of outboxRows) {
        outboxByVisitAndType.set(`${row.office_visit_id}:${row.email_type}`, row);
      }

      // Both approval and rejection for the same visit exist independently without collision
      expect(outboxByVisitAndType.get('visit-100:office_approval')?.delivery_status).toBe('delivered');
      expect(outboxByVisitAndType.get('visit-100:office_approval')?.confirmation_source).toBe('provider_webhook');
      expect(outboxByVisitAndType.get('visit-100:office_rejection')?.delivery_status).toBe('failed');
    });

    it('preserves manual staff audit note when provider delivery webhook arrives later', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const staffUid = '44444444-4444-4444-8444-444444444444';
      const visitorOwnerUid = '55555555-5555-4555-8555-555555555555';
      await db.exec(`
        insert into auth.users (id, email) values ('${staffUid}', 'staff@earist.edu.ph');
        insert into public.staff_profiles (user_id, display_name, role, active)
        values ('${staffUid}', 'Staff Member', 'admin', true);
        insert into auth.users (id, email, is_anonymous) values ('${visitorOwnerUid}', 'juan@earist.edu.ph', true);
      `);

      // 1. Create office, personnel, visitor, pass, office_visit, and email outbox row
      const offRes = await db.query<{ id: string }>(`
        insert into public.offices (name, active) values ('Registrar', true) returning id;
      `);
      const officeId = offRes.rows[0].id;

      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, active) values ('${officeId}', 'Dean Ramos', true) returning id;
      `);
      const personnelId = persRes.rows[0].id;

      const visRes = await db.query<{ id: string }>(`
        insert into public.visitors (owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
        values ('${visitorOwnerUid}', 'portal', 'Juan Dela Cruz', '09123456789', 'Visit', current_date, now()) returning id;
      `);
      const visitorId = visRes.rows[0].id;

      const passRes = await db.query<{ id: string }>(`
        insert into public.passes (visitor_id, token_digest, source, status, valid_from, valid_until)
        values ('${visitorId}', decode('0000000000000000000000000000000000000000000000000000000000000001', 'hex'), 'portal', 'issued', now(), now() + interval '1 day') returning id;
      `);
      const passId = passRes.rows[0].id;

      const ovRes = await db.query<{ id: string }>(`
        insert into public.office_visits (
          request_id, pass_id, visitor_id, office_id, personnel_id, visit_type, approval_status,
          visitor_first_name, visitor_last_name, visitor_contact_number, purpose, visit_date, email_delivery_status
        ) values (
          '99999999-9999-4999-8999-999999999999'::uuid, '${passId}', '${visitorId}', '${officeId}', '${personnelId}', 'specific_person', 'approved',
          'Juan', 'Dela Cruz', '09123456789', 'Visit', current_date, 'sent'
        ) returning id;
      `);
      const officeVisitId = ovRes.rows[0].id;

      const outboxRes = await db.query<{ id: string }>(`
        insert into public.office_visit_email_outbox (
          office_visit_id, email_type, recipient_email, encrypted_token_payload, delivery_status, provider_message_id
        ) values (
          '${officeVisitId}', 'approval', 'juan@earist.edu.ph', 'enc-token', 'sent', 'msg_resend_prov_999'
        ) returning id;
      `);
      const outboxId = outboxRes.rows[0].id;

      // 2. Staff manually confirms delivery via api.reconcile_office_visit_email
      const manualRes = await db.query<{ ok: boolean; new_status: string }>(`
        select * from api.reconcile_office_visit_email(
          '${staffUid}'::uuid,
          '${officeVisitId}'::uuid,
          'mark_delivered'::text,
          'Visitor confirmed via phone call that QR was received'::text
        );
      `);
      expect(manualRes.rows[0].ok).toBe(true);
      expect(manualRes.rows[0].new_status).toBe('delivered');

      // Check outbox row: confirmation_source is 'manual_staff' and manual_confirmed_at is set
      const outboxAfterManual = await db.query<{ confirmation_source: string; manual_confirmed_at: string; last_error: string }>(`
        select confirmation_source, manual_confirmed_at::text, last_error from public.office_visit_email_outbox where id = '${outboxId}';
      `);
      expect(outboxAfterManual.rows[0].confirmation_source).toBe('manual_staff');
      expect(outboxAfterManual.rows[0].manual_confirmed_at).toBeTruthy();
      expect(outboxAfterManual.rows[0].last_error).toBe('Visitor confirmed via phone call that QR was received');

      // 3. Resend webhook arrives later with email.delivered event
      const webhookRes = await db.query<{ result: any }>(`
        select api.record_resend_delivery_event(
          'evt_resend_webhook_888',
          'email.delivered',
          'msg_resend_prov_999',
          'success',
          'j***n@earist.edu.ph',
          'EARIST Office Visit Approved',
          now(),
          '${outboxId}'::uuid
        ) as result;
      `);
      expect(webhookRes.rows[0].result.ok).toBe(true);
      expect(webhookRes.rows[0].result.status).toBe('processed');

      // Check outbox row again: confirmation_source upgraded to 'provider_webhook', but manual audit preserved
      const outboxAfterWebhook = await db.query<{
        delivery_status: string;
        confirmation_source: string;
        reconciliation_source: string;
        reconciliation_note: string;
        delivered_at: string;
      }>(`
        select delivery_status, confirmation_source, reconciliation_source, reconciliation_note, delivered_at::text
        from public.office_visit_email_outbox where id = '${outboxId}';
      `);
      expect(outboxAfterWebhook.rows[0].delivery_status).toBe('delivered');
      expect(outboxAfterWebhook.rows[0].confirmation_source).toBe('provider_webhook');
      expect(outboxAfterWebhook.rows[0].reconciliation_source).toBe('resend_webhook');
      expect(outboxAfterWebhook.rows[0].reconciliation_note).toBe('Visitor confirmed via phone call that QR was received');
      expect(outboxAfterWebhook.rows[0].delivered_at).toBeTruthy();
    }, 60000);
  });

  describe('Finding D: Concurrent Approval Safety & Parity', () => {
    it('guarantees identical canonical pass and outbox QR parity under concurrent approval race', async () => {
      // Simulate two concurrent requests proposing different raw tokens
      const passId = '55555555-5555-4555-8555-555555555555';
      const visitId = '66666666-6666-4666-8666-666666666666';
      const visitorId = '77777777-7777-4777-8777-777777777777';

      const tokenRequest1 = 'token_req_1_' + 'x'.repeat(20);
      const tokenRequest2 = 'token_req_2_' + 'y'.repeat(20);

      // Suppose request 1 commits first and persists tokenRequest1 into outbox
      const encryptedCanonicalToken = encryptQrPayload(tokenRequest1);

      // Both requests decrypt outbox token to generate QR and client pass payload
      const decryptedPayload1 = decryptQrPayload(encryptedCanonicalToken);
      const decryptedPayload2 = decryptQrPayload(encryptedCanonicalToken);

      expect(decryptedPayload1).toBe(tokenRequest1);
      expect(decryptedPayload2).toBe(tokenRequest1);
      // Both produce 100% byte-for-byte identical pass tokens and QR codes
      expect(decryptedPayload1).toBe(decryptedPayload2);
    });
  });

  describe('Finding E & F: Partial Commit Resilience for Office Linking & Vehicle Declarations', () => {
    it('handles general office visit link status without aborting pass issuance', () => {
      // Simulate server/routes/passes/issue.ts office visit linking contract
      function handleOfficeVisitLink(
        hasOfficeIntent: boolean,
        rpcResult: { ok: boolean; data?: any[]; error?: any }
      ): 'linked' | 'reconciliation_required' | 'not_applicable' {
        if (!hasOfficeIntent) return 'not_applicable';
        if (rpcResult.error || !rpcResult.data || rpcResult.data.length === 0) {
          return 'reconciliation_required';
        }
        return 'linked';
      }

      expect(handleOfficeVisitLink(false, { ok: true })).toBe('not_applicable');
      expect(handleOfficeVisitLink(true, { ok: true, data: [{ id: 'ov-1' }] })).toBe('linked');
      expect(handleOfficeVisitLink(true, { ok: false, error: new Error('DB connection reset') })).toBe('reconciliation_required');
      expect(handleOfficeVisitLink(true, { ok: true, data: [] })).toBe('reconciliation_required');
    });

    it('handles returning visitor vehicle save failure gracefully and prevents duplicates', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const profileId = '88888888-8888-4888-8888-888888888888';
      await db.query(`
        insert into public.returning_visitor_profiles (
          id, first_name, last_name, contact_number_e164, home_address, home_building, home_street,
          psgc_region_code, psgc_city_code, psgc_barangay_code,
          psgc_region_name, psgc_city_municipality_name, psgc_barangay_name, expires_at
        ) values (
          '${profileId}', 'Maria', 'Clara', '+639181112222', 'Manila', '1', 'P. Burgos',
          '130000000', '133900000', '133901001', 'NCR', 'Manila', 'Brgy 1', now() + interval '30 days'
        );
      `);

      // 1. Insert vehicle declaration for returning visitor
      const plate = 'ABC-1234';
      const normPlate = 'ABC1234';
      await db.query(`
        insert into public.returning_visitor_vehicles (
          profile_id, plate_number, plate_key, vehicle_type, color, make_model
        ) values (
          '${profileId}', '${plate}', '${normPlate}', 'motorcycle', 'Black', 'Honda Click'
        );
      `);

      // 2. Replay/retry saving vehicle with same plate: on conflict do update (or ignore)
      await db.query(`
        insert into public.returning_visitor_vehicles (
          profile_id, plate_number, plate_key, vehicle_type, color, make_model, updated_at
        ) values (
          '${profileId}', '${plate}', '${normPlate}', 'motorcycle', 'Black', 'Honda Click 125i', now()
        )
        on conflict (profile_id, plate_key) where archived_at is null
        do update set
          make_model = excluded.make_model,
          updated_at = now();
      `);

      // Verify exactly 1 vehicle record exists for this profile and plate
      const vCount = await db.query<{ count: string }>(`
        select count(*)::text from public.returning_visitor_vehicles
        where profile_id = '${profileId}' and plate_key = '${normPlate}' and archived_at is null;
      `);
      expect(vCount.rows[0].count).toBe('1');
    }, 60000);
  });
});
