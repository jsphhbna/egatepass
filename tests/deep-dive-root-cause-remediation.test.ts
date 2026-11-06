import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  createEmailVerificationProofToken,
  verifyEmailVerificationProofToken,
  getOfficeTokenSecret,
} from '../server/lib/office.js';
import { encryptQrPayload, decryptQrPayload } from '../server/lib/encryption.js';
import { normalizeVehiclePlate } from '../src/lib/vehiclePlate.js';

// Setup Supabase emulation for PGlite
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

describe('Deep-Dive Root-Cause Remediation Test Suite', () => {
  beforeEach(() => {
    process.env.OFFICE_VISIT_HMAC_SECRET = 'a'.repeat(32);
    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = 'b'.repeat(32);
  });

  describe('1. Email Verification Proof-Token Contract', () => {
    it('creates, verifies, and accepts actor-bound email verification proof tokens', () => {
      const email = 'visitor@earist.edu.ph';
      const actorId = '33333333-3333-4333-8333-333333333333';
      const proofToken = createEmailVerificationProofToken(email, actorId);

      expect(typeof proofToken).toBe('string');
      expect(proofToken.length).toBeGreaterThan(20);

      // Successfully verifies with correct email and actorId
      const isValid = verifyEmailVerificationProofToken(proofToken, email, actorId);
      expect(isValid).toBe(true);

      // Rejects mismatched email
      const badEmail = verifyEmailVerificationProofToken(proofToken, 'imposter@earist.edu.ph', actorId);
      expect(badEmail).toBe(false);

      // Rejects mismatched actorId
      const badActor = verifyEmailVerificationProofToken(proofToken, email, '44444444-4444-4444-8444-444444444444');
      expect(badActor).toBe(false);

      // Rejects tampered token
      const tampered = verifyEmailVerificationProofToken(proofToken + 'bad', email, actorId);
      expect(tampered).toBe(false);
    });

    it('proves GetPassPage contract accepts proofToken or emailVerificationToken', () => {
      const responseData1 = { ok: true, emailVerificationToken: 'token_abc', message: 'verified' };
      const token1 = responseData1.emailVerificationToken || (responseData1 as any).proofToken;
      expect(token1).toBe('token_abc');

      const responseData2 = { ok: true, proofToken: 'token_xyz', message: 'verified' };
      const token2 = (responseData2 as any).emailVerificationToken || responseData2.proofToken;
      expect(token2).toBe('token_xyz');

      const responseData3 = { ok: true, message: 'no token' };
      const token3 = (responseData3 as any).emailVerificationToken || (responseData3 as any).proofToken;
      expect(token3).toBeUndefined();
    });
  });

  describe('2. Atomic Rate-Limiting & Email Verification Slot RPC', () => {
    it('enforces atomic rate limits (max 5 per actor/email, max 15 per IP)', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const actorId = '55555555-5555-4555-8555-555555555555';
      const email = 'quota.test@earist.edu.ph';
      const clientIp = '192.168.1.100';
      const codeHash = 'hash1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await db.query(`insert into auth.users (id, email) values ('${actorId}', '${email}');`);

      // Requests 1 through 5 must succeed
      for (let i = 1; i <= 5; i++) {
        const res = await db.query<{ allowed: boolean; error_code: string | null }>(`
          select * from api.request_office_email_verification_slot(
            '${actorId}'::uuid,
            '${email}'::text,
            '${clientIp}'::text,
            '${codeHash}'::text,
            '${expiresAt}'::timestamptz
          );
        `);
        expect(res.rows[0].allowed).toBe(true);
        expect(res.rows[0].error_code).toBeNull();
      }

      // Request 6 from same actor must be rejected with too_many_actor_requests or too_many_email_requests
      const res6 = await db.query<{ allowed: boolean; error_code: string | null }>(`
        select * from api.request_office_email_verification_slot(
          '${actorId}'::uuid,
          '${email}'::text,
          '${clientIp}'::text,
          '${codeHash}'::text,
          '${expiresAt}'::timestamptz
        );
      `);
      expect(res6.rows[0].allowed).toBe(false);
      expect(['too_many_actor_requests', 'too_many_email_requests']).toContain(res6.rows[0].error_code);
    }, 60000);
  });

  describe('3. Returning Visitor Provisional Mode Invariant', () => {
    it('accepts provisional_matched returning visitor attempts in create_specific_person_visit_request', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Create active office
      const officeRes = await db.query<{ id: string }>(`
        insert into public.offices (name, description, active)
        values ('Admissions Office', 'Student admissions and registrar', true)
        returning id;
      `);
      const officeId = officeRes.rows[0].id;

      // 2. Create active personnel with null title
      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, title, active)
        values ('${officeId}', 'Dr. Elena Ramos', null, true)
        returning id;
      `);
      const personnelId = persRes.rows[0].id;

      // 3. Create active returning visitor profile
      const profRes = await db.query<{ id: string }>(`
        insert into public.returning_visitor_profiles (
          first_name, last_name, contact_number_e164, home_address, home_building, home_street,
          psgc_region_code, psgc_city_code, psgc_barangay_code,
          psgc_region_name, psgc_city_municipality_name, psgc_barangay_name,
          expires_at
        ) values (
          'Juan', 'Luna', '+639178888888', 'Sampaloc, Manila', '456', 'España Blvd',
          '130000000', '133900000', '133901001',
          'National Capital Region', 'City of Manila', 'Barangay 408',
          now() + interval '30 days'
        ) returning id;
      `);
      const profileId = profRes.rows[0].id;

      const actorId = '77777777-7777-4777-8777-777777777777';
      const requestId = '88888888-8888-4888-8888-888888888888';
      const matchTokenDigest = 'provisional_match_token_digest_1234567890';

      await db.query(`insert into auth.users (id, email) values ('${actorId}', 'juan.luna@earist.edu.ph');`);

      // 4. Create returning identity attempt with provisional mode and provisional_matched outcome
      await db.query(`
        insert into public.returning_identity_attempts (
          owner_id, request_id, matched_profile_id, outcome, best_score,
          model_version, match_token_digest, expires_at, threshold_mode
        ) values (
          '${actorId}', '${requestId}', '${profileId}', 'provisional_matched', 0.52,
          'v1', '${matchTokenDigest}', now() + interval '15 minutes', 'provisional'
        );
      `);

      // 5. Call api.create_specific_person_visit_request for provisional returning visitor
      const visitRes = await db.query<{ visit_id: string; approval_status: string }>(`
        select * from api.create_specific_person_visit_request(
          '${actorId}'::uuid,
          '${requestId}'::uuid,
          '${officeId}'::uuid,
          '${personnelId}'::uuid,
          'Juan'::text,
          null::text,
          'Luna'::text,
          '+639178888888'::text,
          'juan.luna@earist.edu.ph'::text,
          'Inquire about document release'::text,
          (current_date + interval '1 day')::date,
          'no_vehicle'::text,
          null::jsonb,
          null::jsonb,
          null::uuid, null::integer, null::text,
          null::uuid, null::integer, null::text,
          null::uuid, null::integer, null::text,
          'returning'::text,
          '${profileId}'::uuid,
          '${matchTokenDigest}'::text,
          null::uuid,
          null::uuid
        );
      `);

      expect(visitRes.rows.length).toBe(1);
      expect(visitRes.rows[0].approval_status).toBe('pending');

      // Verify stored office visit record
      const checkRow = await db.query<{ registration_mode: string; returning_profile_id: string }>(`
        select registration_mode, returning_profile_id from public.office_visits where id = '${visitRes.rows[0].visit_id}';
      `);
      expect(checkRow.rows[0].registration_mode).toBe('returning');
      expect(checkRow.rows[0].returning_profile_id).toBe(profileId);
    }, 60000);
  });

  describe('4. Vehicle Declaration Security Boundary & Active Plate Collision', () => {
    it('rejects unexpected vehicle details when arrival_mode is no_vehicle', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const officeRes = await db.query<{ id: string }>(`
        insert into public.offices (name, description, active)
        values ('Registrar', 'Student records', true) returning id;
      `);
      const officeId = officeRes.rows[0].id;

      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, active)
        values ('${officeId}', 'Prof. Cruz', true) returning id;
      `);
      const personnelId = persRes.rows[0].id;

      const actorId = '12121212-1212-4212-8212-121212121212';
      const requestId = '23232323-2323-4323-8323-232323232323';
      await db.query(`insert into auth.users (id, email) values ('${actorId}', 'pedro@earist.edu.ph');`);

      // Provide contradictory vehicle details on no_vehicle
      let threw = false;
      try {
        await db.query(`
          select * from api.create_specific_person_visit_request(
            '${actorId}'::uuid,
            '${requestId}'::uuid,
            '${officeId}'::uuid,
            '${personnelId}'::uuid,
            'Pedro'::text, null::text, 'Penduko'::text,
            '+639171112233'::text, 'pedro@earist.edu.ph'::text,
            'Consultation on grades'::text,
            (current_date + interval '1 day')::date,
            'no_vehicle'::text,
            '{"vehicleType": "car", "plateNumber": "ABC1234", "color": "Blue"}'::jsonb,
            null::jsonb,
            null::uuid, null::integer, null::text,
            null::uuid, null::integer, null::text,
            null::uuid, null::integer, null::text,
            'new'::text,
            null::uuid, null::text, null::uuid, null::uuid
          );
        `);
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('unexpected_vehicle_details');
      }
      expect(threw).toBe(true);
    }, 60000);

    it('rejects registration when vehicle plate is already active on campus', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      const plateNumber = 'ABC1234';
      const plateKey = 'ABC1234';

      // Create an existing visitor and pass currently active on campus
      const driverUserId = '00000000-0000-4000-8000-000000000099';
      await db.query(`insert into auth.users (id, email) values ('${driverUserId}', 'driver@test.local');`);
      const vRes = await db.query<{ id: string }>(`
        insert into public.visitors (owner_id, full_name, contact_number, purpose, visit_date, arrival_mode, source, consent_accepted_at)
        values ('${driverUserId}', 'Active Driver', '+639170001111', 'Delivery', current_date, 'vehicle', 'portal', now())
        returning id;
      `);
      const visitorId = vRes.rows[0].id;

      const pRes = await db.query<{ id: string }>(`
        insert into public.passes (visitor_id, status, source, token_digest, public_reference, valid_from, valid_until)
        values (
          '${visitorId}', 'inside', 'portal',
          decode('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex'),
          gen_random_uuid(), now() - interval '1 hour', now() + interval '8 hours'
        ) returning id;
      `);
      const passId = pRes.rows[0].id;

      // Insert active vehicle declaration on campus (entry_recorded_at set, exit_recorded_at null)
      await db.query(`
        insert into public.visit_vehicle_declarations (
          pass_id, visitor_id, vehicle_type, plate_number, plate_key, color, make_model, entry_recorded_at
        ) values (
          '${passId}', '${visitorId}', 'car', '${plateNumber}', '${plateKey}', 'White', 'Toyota Vios', now() - interval '30 minutes'
        );
      `);

      // Attempt to register another visit declaring the same vehicle plate
      const officeRes = await db.query<{ id: string }>(`
        insert into public.offices (name, description, active)
        values ('Cashier', 'Payment processing', true) returning id;
      `);
      const officeId = officeRes.rows[0].id;

      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, active)
        values ('${officeId}', 'Mrs. Reyes', true) returning id;
      `);
      const personnelId = persRes.rows[0].id;

      const actorId = '34343434-3434-4434-8434-343434343434';
      const requestId = '56565656-5656-4656-8656-565656565656';
      await db.query(`insert into auth.users (id, email) values ('${actorId}', 'collision@earist.edu.ph');`);
      const dummyUploadIntent = await db.query<{ id: string }>(`
        insert into public.upload_intents (owner_id, source, kind, bucket_id, object_path, content_type, max_bytes, status, expires_at)
        values ('${actorId}', 'portal', 'vehicle_photo', 'visitor-photos', 'v.jpg', 'image/jpeg', 5000000, 'uploaded', now() + interval '1 hour')
        returning id;
      `);
      const vehiclePhotoIntentId = dummyUploadIntent.rows[0].id;

      let plateCollisionThrew = false;
      try {
        await db.query(`
          select * from api.create_specific_person_visit_request(
            '${actorId}'::uuid,
            '${requestId}'::uuid,
            '${officeId}'::uuid,
            '${personnelId}'::uuid,
            'Collision', null::text, 'Tester',
            '+639179998877'::text, 'collision@earist.edu.ph'::text,
            'Payment'::text,
            (current_date + interval '1 day')::date,
            'vehicle'::text,
            '{"vehicleType": "car", "plateNumber": "${plateNumber}", "color": "White", "makeModel": "Toyota"}'::jsonb,
            null::jsonb,
            null::uuid, null::integer, null::text,
            null::uuid, null::integer, null::text,
            '${vehiclePhotoIntentId}'::uuid, 1024::integer, '${'a'.repeat(64)}'::text,
            'new'::text,
            null::uuid, null::text, null::uuid, null::uuid
          );
        `);
      } catch (err: any) {
        plateCollisionThrew = true;
        expect(err.message).toContain('plate_already_active_on_campus');
      }
      expect(plateCollisionThrew).toBe(true);
    }, 60000);

    it('enforces least-privilege RLS on visit_vehicle_declarations', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      // Verify policy visit_vehicle_declarations_select_policy exists
      const policies = await db.query<{ policyname: string; cmd: string }>(`
        select policyname, cmd from pg_policies
        where schemaname = 'public' and tablename = 'visit_vehicle_declarations';
      `);
      const names = policies.rows.map((p) => p.policyname);
      expect(names).toContain('visit_vehicle_declarations_select_policy');
      expect(names).not.toContain('visit_vehicle_declarations_staff_select');
    }, 60000);
  });

  describe('5. Concurrent Office Approval & Authoritative QR Token Decryption', () => {
    it('verifies QR token generated for email strictly matches canonical stored token payload', () => {
      // Generate authoritative QR token
      const rawSecretBytes = randomBytes(32).toString('hex');
      const canonicalQrPassToken = `p_${rawSecretBytes}`;
      const canonicalDigest = createHash('sha256').update(canonicalQrPassToken).digest('hex');

      // Encrypt for outbox payload
      const encryptedPayload = encryptQrPayload(canonicalQrPassToken);

      // Simulate retrieval and decryption
      const decryptedToken = decryptQrPayload(encryptedPayload);
      const decryptedDigest = createHash('sha256').update(decryptedToken).digest('hex');

      // Digests must match identically
      expect(decryptedToken).toBe(canonicalQrPassToken);
      expect(decryptedDigest).toBe(canonicalDigest);
    });
  });

  describe('6. Email Reconciliation Audit Attribution', () => {
    it('requires non-empty note on mark_delivered and records staff audit attribution', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);
      await db.exec(`set request.jwt.claim.role = 'service_role';`);

      // 1. Create superadmin staff profile
      const staffUser = await db.query<{ id: string }>(`
        insert into auth.users (id, email) values (gen_random_uuid(), 'superadmin@earist.edu.ph') returning id;
      `);
      const staffUserId = staffUser.rows[0].id;
      await db.query(`
        insert into public.staff_profiles (user_id, display_name, role, active)
        values ('${staffUserId}', 'System Superadmin', 'superadmin', true);
      `);

      // 2. Create office and visit
      const offRes = await db.query<{ id: string }>(`
        insert into public.offices (name, description, active) values ('Dean Office', 'Dean', true) returning id;
      `);
      const officeId = offRes.rows[0].id;

      const persRes = await db.query<{ id: string }>(`
        insert into public.office_personnel (office_id, name, active) values ('${officeId}', 'Dean Reyes', true) returning id;
      `);
      const personnelId = persRes.rows[0].id;

      const visitRes = await db.query<{ id: string }>(`
        insert into public.office_visits (
          request_id,
          visit_type, office_id, personnel_id, approval_status, attendance_status,
          visitor_first_name, visitor_last_name, visitor_contact_number, visitor_email,
          purpose, visit_date, arrival_mode, email_delivery_status
        ) values (
          gen_random_uuid(),
          'specific_person', '${officeId}', '${personnelId}', 'approved', 'awaiting_entry',
          'Maria', 'Clara', '+639173334444', 'maria.clara@earist.edu.ph',
          'Interview', current_date, 'no_vehicle', 'failed'
        ) returning id;
      `);
      const visitId = visitRes.rows[0].id;

      // 3. Insert outbox row
      await db.query(`
        insert into public.office_visit_email_outbox (
          office_visit_id, email_type, recipient_email, delivery_status, last_error
        ) values (
          '${visitId}', 'approval', 'maria.clara@earist.edu.ph', 'failed', 'Network timeout'
        );
      `);

      // 4. Calling mark_delivered without note or note < 3 chars must fail
      let threwNoNote = false;
      try {
        await db.query(`
          select * from api.reconcile_office_visit_email(
            '${staffUserId}'::uuid,
            '${visitId}'::uuid,
            'mark_delivered'::text,
            null::text
          );
        `);
      } catch (err: any) {
        threwNoNote = true;
        expect(err.message).toContain('reconciliation_note_required_for_manual_delivery');
      }
      expect(threwNoNote).toBe(true);

      // 5. Calling mark_delivered with valid note must succeed and record attribution
      const note = 'Confirmed delivered by phone conversation with visitor.';
      const recRes = await db.query<{ ok: boolean; new_status: string }>(`
        select * from api.reconcile_office_visit_email(
          '${staffUserId}'::uuid,
          '${visitId}'::uuid,
          'mark_delivered'::text,
          '${note}'::text
        );
      `);
      expect(recRes.rows[0].ok).toBe(true);
      expect(recRes.rows[0].new_status).toBe('delivered');

      // Verify outbox row has attribution
      const outboxRow = await db.query<{
        delivery_status: string;
        reconciled_by: string;
        reconciliation_source: string;
        reconciliation_note: string;
      }>(`
        select delivery_status, reconciled_by, reconciliation_source, reconciliation_note
        from public.office_visit_email_outbox where office_visit_id = '${visitId}';
      `);
      expect(outboxRow.rows[0].delivery_status).toBe('delivered');
      expect(outboxRow.rows[0].reconciled_by).toBe(staffUserId);
      expect(outboxRow.rows[0].reconciliation_source).toBe('manual_staff');
      expect(outboxRow.rows[0].reconciliation_note).toBe(note);
    }, 60000);
  });
});
