import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

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
    sql = sql.replace(/create extension if not exists "uuid-ossp"[^;]*;/gi, '-- uuid-ossp no-op');
    await db.exec(sql);
  }
}

describe('Office Visit Email Outbox Leases, Idempotency and Webhook Reconciliation (PGlite)', () => {
  const visitorUserId = '11111111-1111-4111-8111-111111111111';
  const staffUserId = '22222222-2222-4222-8222-222222222222';

  let db: PGlite;
  let officeId: string;
  let personnelId: string;
  let visitId: string;
  let outboxId: string;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    await db.exec(`
      insert into auth.users (id, email, is_anonymous) values
      ('${visitorUserId}', 'visitor@test.local', true),
      ('${staffUserId}', 'staff@earist.edu.ph', false);

      insert into public.staff_profiles (user_id, display_name, role)
      values ('${staffUserId}', 'Admin Staff', 'superadmin');
    `);

    const officeRes = await db.query<{ id: string }>(`select id from public.offices limit 1;`);
    officeId = officeRes.rows[0].id;

    const persRes = await db.query<{ id: string }>(`
      insert into public.office_personnel (office_id, name, title)
      values ('${officeId}', 'Dean Outbox', 'Dean')
      returning id;
    `);
    personnelId = persRes.rows[0].id;

    // Create an approved office visit
    const insertVisit = await db.query<{ id: string }>(`
      insert into public.office_visits (
        request_id, visit_type, office_id, personnel_id, approval_status, attendance_status,
        visitor_actor_id, visitor_first_name, visitor_last_name,
        visitor_contact_number, visitor_email, purpose, visit_date, arrival_mode,
        email_delivery_status
      ) values (
        gen_random_uuid(), 'specific_person', '${officeId}', '${personnelId}', 'approved', 'awaiting_entry',
        '${visitorUserId}', 'Juan', 'Dela Cruz',
        '09171234567', 'visitor@test.local', 'Consultation', current_date, 'no_vehicle',
        'pending'
      ) returning id;
    `);
    visitId = insertVisit.rows[0].id;

    // Insert outbox entry
    const insertOutbox = await db.query<{ id: string }>(`
      insert into public.office_visit_email_outbox (
        office_visit_id, email_type, recipient_email, delivery_status, idempotency_key
      ) values (
        '${visitId}', 'approval', 'visitor@test.local', 'pending', 'idempotency-test-key-1'
      ) returning id;
    `);
    outboxId = insertOutbox.rows[0].id;
  }, 120000);

  it('1. Claims bounded 5-minute lease and sets processing status atomically', async () => {
    const claimRes = await db.query<{
      outbox_id: string;
      office_visit_id: string;
      claim_id: string;
      lease_expires_at: string;
      retry_count: number;
      idempotency_key: string;
    }>(`
      select * from api.claim_office_visit_email_for_delivery(
        requested_visit_id => '${visitId}'::uuid,
        requested_email_type => 'approval'
      );
    `);

    expect(claimRes.rows.length).toBe(1);
    expect(claimRes.rows[0].outbox_id).toBe(outboxId);
    expect(claimRes.rows[0].claim_id).not.toBeNull();
    expect(claimRes.rows[0].attempt_count).toBe(1);
    expect(claimRes.rows[0].idempotency_key).toBe('idempotency-test-key-1');

    // Verify row state in outbox table
    const checkRow = await db.query<{
      delivery_status: string;
      claim_id: string;
      lease_expires_at: string;
    }>(`
      select delivery_status, claim_id, lease_expires_at
      from public.office_visit_email_outbox
      where id = '${outboxId}';
    `);
    expect(checkRow.rows[0].delivery_status).toBe('processing');
    expect(checkRow.rows[0].claim_id).toBe(claimRes.rows[0].claim_id);
    expect(new Date(checkRow.rows[0].lease_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('2. Prevents concurrent claiming while lease is active and unexpired', async () => {
    await expect(
      db.query(`
        select * from api.claim_office_visit_email_for_delivery(
          requested_visit_id => '${visitId}'::uuid,
          requested_email_type => 'approval'
        );
      `)
    ).rejects.toThrow(/email_lease_active_in_progress/);
  });

  it('3. Refuses automatic redelivery claim when status is unknown (requires reconciliation)', async () => {
    await db.exec(`
      update public.office_visit_email_outbox
      set delivery_status = 'unknown', lease_expires_at = null, claim_id = null
      where id = '${outboxId}';
    `);

    await expect(
      db.query(`
        select * from api.claim_office_visit_email_for_delivery(
          requested_visit_id => '${visitId}'::uuid,
          requested_email_type => 'approval'
        );
      `)
    ).rejects.toThrow(/email_delivery_outcome_unknown_reconciliation_required/);
  });

  it('4. Successfully claims expired lease and increments retry count', async () => {
    // Reset status to processing with expired lease
    await db.exec(`
      update public.office_visit_email_outbox
      set delivery_status = 'processing',
          lease_expires_at = now() - interval '1 second'
      where id = '${outboxId}';
    `);

    const reclaimRes = await db.query<{
      claim_id: string;
      attempt_count: number;
    }>(`
      select * from api.claim_office_visit_email_for_delivery(
        requested_visit_id => '${visitId}'::uuid,
        requested_email_type => 'approval'
      );
    `);

    expect(reclaimRes.rows.length).toBe(1);
    expect(reclaimRes.rows[0].attempt_count).toBe(2);
  });

  it('5. Records delivery result, updates status to sent, and stores provider message ID', async () => {
    // Get current claim_id
    const currentClaim = await db.query<{ claim_id: string }>(`
      select claim_id from public.office_visit_email_outbox where id = '${outboxId}';
    `);
    const claimId = currentClaim.rows[0].claim_id;
    expect(claimId).not.toBeNull();

    await db.query(`
      select api.record_office_visit_email_result(
        requested_outbox_id => '${outboxId}'::uuid,
        requested_claim_id => '${claimId}'::uuid,
        requested_status => 'sent',
        requested_provider_message_id => 'msg_resend_mock_12345',
        requested_error => null
      );
    `);

    const checkOutbox = await db.query<{
      delivery_status: string;
      provider_message_id: string;
      claim_id: string;
      lease_expires_at: string;
    }>(`
      select delivery_status, provider_message_id, claim_id, lease_expires_at
      from public.office_visit_email_outbox
      where id = '${outboxId}';
    `);
    expect(checkOutbox.rows[0].delivery_status).toBe('sent');
    expect(checkOutbox.rows[0].provider_message_id).toBe('msg_resend_mock_12345');
    expect(checkOutbox.rows[0].claim_id).toBeNull();
    expect(checkOutbox.rows[0].lease_expires_at).toBeNull();
  });

  it('6. Reconciles Resend email.delivered webhook event and updates outbox & visit to delivered', async () => {
    const webhookRes = await db.query<{
      result: {
        ok: boolean;
        status: string;
      };
    }>(`
      select api.record_resend_delivery_event(
        requested_provider_event_id => 'evt_test_12345',
        requested_event_type => 'email.delivered',
        requested_email_id => 'msg_resend_mock_12345',
        requested_outcome => 'delivered',
        requested_recipient_masked => 'v***@test.local',
        requested_subject_sanitized => 'Office Pass Approval',
        requested_occurred_at => now()
      ) as result;
    `);

    expect(webhookRes.rows.length).toBe(1);
    expect(webhookRes.rows[0].result.ok).toBe(true);

    // Verify outbox state promoted to delivered
    const checkOutbox = await db.query<{ delivery_status: string; delivered_at: string }>(`
      select delivery_status, delivered_at
      from public.office_visit_email_outbox
      where id = '${outboxId}';
    `);
    expect(checkOutbox.rows[0].delivery_status).toBe('delivered');
    expect(checkOutbox.rows[0].delivered_at).not.toBeNull();

    // Verify office_visits table promoted to delivered
    const checkVisit = await db.query<{ email_delivery_status: string }>(`
      select email_delivery_status from public.office_visits where id = '${visitId}';
    `);
    expect(checkVisit.rows[0].email_delivery_status).toBe('delivered');
  });

  it('7. Prevents regression of terminal delivered state when an out-of-order email.sent event arrives', async () => {
    await db.query(`
      select api.record_resend_delivery_event(
        requested_provider_event_id => 'evt_test_67890',
        requested_event_type => 'email.sent',
        requested_email_id => 'msg_resend_mock_12345',
        requested_outcome => 'sent',
        requested_recipient_masked => 'v***@test.local',
        requested_subject_sanitized => 'Office Pass Approval',
        requested_occurred_at => now()
      );
    `);

    // Must remain delivered
    const checkOutbox = await db.query<{ delivery_status: string }>(`
      select delivery_status from public.office_visit_email_outbox where id = '${outboxId}';
    `);
    expect(checkOutbox.rows[0].delivery_status).toBe('delivered');

    const checkVisit = await db.query<{ email_delivery_status: string }>(`
      select email_delivery_status from public.office_visits where id = '${visitId}';
    `);
    expect(checkVisit.rows[0].email_delivery_status).toBe('delivered');
  });
});
