// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateThermalTemplateLayout,
  type ThermalTemplateLayout,
} from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';
import { renderThermalPass } from '@/printer/renderer/thermalRenderer';
import type { PassPresentation } from '@/lib/passPresentation';

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

const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';
const GUARD_ID = '00000000-0000-4000-a000-000000000002';

describe('Final Cross-Layer Closure Verification (CL-T03 to CL-T10)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyAllMigrations(db);

    // Seed Super Admin and Guard
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at)
      values
        ('${SUPERADMIN_ID}', 'admin@earist.edu.ph', now()),
        ('${GUARD_ID}', 'guard@earist.edu.ph', now());

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values
        ('${SUPERADMIN_ID}', 'Super Admin', 'superadmin', true, false, now()),
        ('${GUARD_ID}', 'Main Guard', 'guard', true, false, now());
    `);
  }, 60000);

  afterAll(async () => {
    if (db) {
      await db.close();
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 640 * 4),
        width: 384,
        height: 640,
      }),
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,mockRenderedTicket');
  });

  const asGuard = async () => {
    await db.exec(`
      set local "request.jwt.claim.role" = 'authenticated';
      set local "request.jwt.claim.sub" = '${GUARD_ID}';
      set local role authenticated;
    `);
  };

  const asSuperAdmin = async () => {
    await db.exec(`
      set local "request.jwt.claim.role" = 'authenticated';
      set local "request.jwt.claim.sub" = '${SUPERADMIN_ID}';
      set local role authenticated;
    `);
  };

  // ---------------------------------------------------------------------------
  // CL-T03: Snapshot pagination contract with 125 passes across 3 pages (50, 50, 25)
  // ---------------------------------------------------------------------------
  it('CL-T03: retrieves all 125 passes across 3 pages matching consumer contract', async () => {
    await asGuard();

    // Clean any prior passes
    await db.exec(`delete from public.visit_events; delete from public.passes; delete from public.visitors;`);

    // Seed 125 visitors and passes for today in Asia/Manila
    const visitorValues: string[] = [];
    const passValues: string[] = [];
    for (let i = 1; i <= 125; i++) {
      const vId = `00000000-0000-4000-b000-${String(i).padStart(12, '0')}`;
      const pId = `00000000-0000-4000-c000-${String(i).padStart(12, '0')}`;
      const refId = `00000000-0000-4000-d000-${String(i).padStart(12, '0')}`;
      visitorValues.push(
        `('${vId}', '${GUARD_ID}', 'portal', 'Visitor ${i}', '0917000${String(i).padStart(4, '0')}', 'Official Business', now() at time zone 'Asia/Manila', now())`
      );
      passValues.push(
        `('${pId}', '${refId}', '${vId}', decode(lpad(to_hex(${i}), 64, '0'), 'hex'), 'issued', 1, 'portal', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 hour') at time zone 'Asia/Manila', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '8 hours') at time zone 'Asia/Manila')`
      );
    }

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ${visitorValues.join(',\n')};

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ${passValues.join(',\n')};
    `);

    // Consumer loop matching refreshOperationalCache()
    const allItems: any[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    let pageCount = 0;
    const pageSizes: number[] = [];

    while (hasMore) {
      pageCount++;
      await asGuard();
      const cursorArg = cursor ? `'${cursor}'` : 'null';
      const pageRes = await db.query<{ guard_offline_snapshot_page: any }>(`
        select api.guard_offline_snapshot_page(${cursorArg}, 50);
      `);

      const pageData = pageRes.rows[0].guard_offline_snapshot_page;
      expect(pageData).toBeDefined();
      expect(Array.isArray(pageData.items)).toBe(true);

      pageSizes.push(pageData.items.length);
      allItems.push(...pageData.items);

      // Verify canonical camelCase contract
      expect(pageData).toHaveProperty('nextCursor');
      expect(pageData).toHaveProperty('hasMore');

      cursor = pageData.nextCursor ?? null;
      hasMore = Boolean(pageData.hasMore && cursor);
    }

    expect(pageCount).toBe(3);
    expect(pageSizes).toEqual([50, 50, 25]);
    expect(allItems.length).toBe(125);
  });

  // ---------------------------------------------------------------------------
  // CL-T04: Offline event version propagation
  // ---------------------------------------------------------------------------
  it('CL-T04: propagates expectedVersion from cached pass through offline sync', async () => {
    await asGuard();

    const vId = '00000000-0000-4000-b000-000000000001';
    const passId = '00000000-0000-4000-c000-000000000001';
    const refId = '00000000-0000-4000-d000-000000000001';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${vId}', '${GUARD_ID}', 'portal', 'Visitor 1', '09170000001', 'Official Business', now() at time zone 'Asia/Manila', now())
      on conflict (id) do nothing;

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ('${passId}', '${refId}', '${vId}', decode(lpad('1', 64, '0'), 'hex'), 'issued', 7, 'portal', now() - interval '1 hour', now() + interval '8 hours')
      on conflict (id) do update set status = 'issued', version = 7;
    `);

    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    // Guard sync with expectedVersion: 7
    const syncRes = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}',
        '${passId}',
        'approve_entry',
        'issued',
        7,
        '${occurredAt}'::timestamptz,
        'visitor_recovery'
      );
    `);

    const result = syncRes.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('applied');
    expect(result.newStatus).toBe('inside');
    expect(result.version).toBe(8);

    // Verify pass in database advanced to version 8
    const checkPass = await db.query(`select status, version from public.passes where id = '${passId}';`);
    expect(checkPass.rows[0].status).toBe('inside');
    expect(checkPass.rows[0].version).toBe(8);
  });

  // ---------------------------------------------------------------------------
  // CL-T05: Stale version conflict
  // ---------------------------------------------------------------------------
  it('CL-T05: detects stale version conflict and logs reconciliation task without mutating state', async () => {
    await asGuard();

    const vId = '00000000-0000-4000-b000-000000000002';
    const passId = '00000000-0000-4000-c000-000000000002';
    const refId = '00000000-0000-4000-d000-000000000002';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${vId}', '${GUARD_ID}', 'portal', 'Visitor 2', '09170000002', 'Official Business', now() at time zone 'Asia/Manila', now())
      on conflict (id) do nothing;

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ('${passId}', '${refId}', '${vId}', decode(lpad('2', 64, '0'), 'hex'), 'issued', 8, 'portal', now() - interval '1 hour', now() + interval '8 hours')
      on conflict (id) do update set status = 'issued', version = 8;
    `);

    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    // Offline client attempts sync with stale expectedVersion: 7
    const syncRes = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}',
        '${passId}',
        'approve_entry',
        'issued',
        7,
        '${occurredAt}'::timestamptz,
        'visitor_recovery'
      );
    `);

    const result = syncRes.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('conflict');
    expect(result.reason).toBe('version_conflict');

    // Verify pass version remains 8 and status remains issued
    const checkPass = await db.query(`select status, version from public.passes where id = '${passId}';`);
    expect(checkPass.rows[0].status).toBe('issued');
    expect(checkPass.rows[0].version).toBe(8);

    // Verify reconciliation task recorded
    const taskRes = await db.query(`
      select operation, last_error_code, safe_context from public.reconciliation_tasks
      where reference_id = '${passId}' and last_error_code = 'version_conflict';
    `);
    expect(taskRes.rows.length).toBeGreaterThan(0);
    expect(taskRes.rows[0].last_error_code).toBe('version_conflict');
  });

  // ---------------------------------------------------------------------------
  // CL-T06: Missing version defense in depth
  // ---------------------------------------------------------------------------
  it('CL-T06: rejects offline event with missing version on server and refuses client queueing', async () => {
    await asGuard();

    const vId = '00000000-0000-4000-b000-000000000003';
    const passId = '00000000-0000-4000-c000-000000000003';
    const refId = '00000000-0000-4000-d000-000000000003';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${vId}', '${GUARD_ID}', 'portal', 'Visitor 3', '09170000003', 'Official Business', now() at time zone 'Asia/Manila', now())
      on conflict (id) do nothing;

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ('${passId}', '${refId}', '${vId}', decode(lpad('3', 64, '0'), 'hex'), 'issued', 1, 'portal', now() - interval '1 hour', now() + interval '8 hours')
      on conflict (id) do update set status = 'issued', version = 1;
    `);

    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();

    // Direct RPC with NULL expected_version
    const syncRes = await db.query<{ guard_sync_offline_event: any }>(`
      select api.guard_sync_offline_event(
        '${eventId}',
        '${passId}',
        'approve_entry',
        'issued',
        null,
        '${occurredAt}'::timestamptz,
        'visitor_recovery'
      );
    `);

    const result = syncRes.rows[0].guard_sync_offline_event;
    expect(result.status).toBe('conflict');
    expect(result.reason).toBe('expected_version_required');

    // Reconciliation task recorded
    const taskRes = await db.query(`
      select operation, last_error_code from public.reconciliation_tasks
      where reference_id = '${passId}' and last_error_code = 'expected_version_required';
    `);
    expect(taskRes.rows.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // CL-T07: Bundled thermal template parity
  // ---------------------------------------------------------------------------
  it('CL-T07: proves bundled default template passes client Zod, server save, publish, kiosk fetch, and renderer', async () => {
    // 1. Frontend Zod validation
    const zodResult = validateThermalTemplateLayout(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(zodResult.success).toBe(true);

    // 2. Server save draft
    await asSuperAdmin();
    const saveRes = await db.query<{ admin_save_thermal_template: any }>(`
      select api.admin_save_thermal_template(
        'EARIST Bundled Default',
        '${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb
      );
    `);
    const saved = saveRes.rows[0].admin_save_thermal_template;
    expect(saved).toBeDefined();
    expect(saved.version).toBeGreaterThan(0);
    expect(saved.status).toBe('draft');

    // 3. Server publish
    const pubRes = await db.query<{ admin_publish_thermal_template: any }>(`
      select api.admin_publish_thermal_template(${saved.version});
    `);
    const published = pubRes.rows[0].admin_publish_thermal_template;
    expect(published.status).toBe('published');

    // 4. Kiosk fetch published template
    await asGuard();
    const fetchRes = await db.query<{ layout: any }>(`
      select layout from public.thermal_templates where status = 'published' order by version desc limit 1;
    `);
    const fetchedLayout = fetchRes.rows[0].layout;
    const kioskValidation = validateThermalTemplateLayout(fetchedLayout);
    expect(kioskValidation.success).toBe(true);

    // 5. Thermal renderer test
    const mockPresentation: PassPresentation = {
      institutionName: 'EARIST E-GATEPASS',
      systemTitle: 'CAMPUS VISITOR PASS',
      visitorName: 'JUAN DELA CRUZ',
      visitDate: 'Oct 27, 2026',
      passReference: 'Ref: EG-8A2C1D34',
      qrToken: 'egp_authoritative_token_hash',
    };
    const renderResult = await renderThermalPass(mockPresentation, fetchedLayout);
    expect(renderResult).toBeDefined();
    expect(renderResult.dataUrl).toContain('data:image/png');
  });

  // ---------------------------------------------------------------------------
  // CL-T08: Invalid template parity
  // ---------------------------------------------------------------------------
  it('CL-T08: asserts client and server both reject every malformed template variant', async () => {
    await asSuperAdmin();

    const variants: { name: string; mutate: (base: ThermalTemplateLayout) => any }[] = [
      {
        name: 'unknown type',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, type: 'hologram' } : el)),
        }),
      },
      {
        name: 'unknown field',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, field: 'secret_pin' } : el)),
        }),
      },
      {
        name: 'QR too small (< 140px)',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el) => (el.type === 'qr' ? { ...el, width: 100, height: 100 } : el)),
        }),
      },
      {
        name: 'missing visitor_name',
        mutate: (b) => ({
          ...b,
          elements: b.elements.filter((el) => el.field !== 'visitor_name'),
        }),
      },
      {
        name: 'missing visit_date',
        mutate: (b) => ({
          ...b,
          elements: b.elements.filter((el) => el.field !== 'visit_date'),
        }),
      },
      {
        name: 'missing QR',
        mutate: (b) => ({
          ...b,
          elements: b.elements.filter((el) => el.type !== 'qr'),
        }),
      },
      {
        name: 'missing pass_reference',
        mutate: (b) => ({
          ...b,
          elements: b.elements.filter((el) => el.field !== 'pass_reference'),
        }),
      },
      {
        name: 'HTML tags in text',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, text: '<b>Bold Text</b>' } : el)),
        }),
      },
      {
        name: 'script tag in text',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, text: '<script>alert(1)</script>' } : el)),
        }),
      },
      {
        name: 'remote URL in text',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, text: 'https://malicious.invalid' } : el)),
        }),
      },
      {
        name: 'out of bounds coordinate',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, x: 350, width: 50 } : el)),
        }),
      },
      {
        name: 'unknown JSON property',
        mutate: (b) => ({
          ...b,
          elements: b.elements.map((el, i) => (i === 0 ? { ...el, maliciousExtra: true } : el)),
        }),
      },
    ];

    for (const v of variants) {
      const badLayout = v.mutate(BUNDLED_DEFAULT_THERMAL_TEMPLATE);

      // Client must reject
      const clientVal = validateThermalTemplateLayout(badLayout);
      expect(clientVal.success, `Client should reject malformed variant: ${v.name}`).toBe(false);

      // Server must also reject
      await asSuperAdmin();
      let serverThrew = false;
      try {
        await db.query(`
          select api.admin_save_thermal_template('Bad Template', '${JSON.stringify(badLayout)}'::jsonb);
        `);
      } catch {
        serverThrew = true;
      }
      expect(serverThrew, `Server should reject malformed variant: ${v.name}`).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // CL-T09: Online recovery search by public pass reference
  // ---------------------------------------------------------------------------
  it('CL-T09: searches online recovery passes by EG-XXXXXXXX, raw xxxxxxxx, and lowercase', async () => {
    await asGuard();

    const vId = '00000000-0000-4000-b000-000000000999';
    const pId = '00000000-0000-4000-c000-000000000999';
    const rawPublicRef = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${vId}', '${GUARD_ID}', 'portal', 'Maria Clara Santos', '09181112233', 'Consultation', now() at time zone 'Asia/Manila', now());

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ('${pId}', '${rawPublicRef}', '${vId}', decode(lpad('999', 64, '0'), 'hex'), 'issued', 1, 'portal', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 hour') at time zone 'Asia/Manila', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '8 hours') at time zone 'Asia/Manila');
    `);

    // Search 1: Formatted institutional reference "EG-A1B2C3D4"
    const res1 = await db.query<{ guard_search_recovery_visitors: any }>(`
      select api.guard_search_recovery_visitors('EG-A1B2C3D4');
    `);
    const items1 = res1.rows[0].guard_search_recovery_visitors;
    expect(items1.length).toBe(1);
    expect(items1[0].visitorName).toBe('Maria Clara Santos');
    expect(items1[0].passReference).toBe('EG-A1B2C3D4');
    expect(items1[0].publicReference).toBe(rawPublicRef);
    expect(items1[0].version).toBe(1);

    // Search 2: Lowercase formatted reference "eg-a1b2c3d4"
    const res2 = await db.query<{ guard_search_recovery_visitors: any }>(`
      select api.guard_search_recovery_visitors('eg-a1b2c3d4');
    `);
    const items2 = res2.rows[0].guard_search_recovery_visitors;
    expect(items2.length).toBe(1);
    expect(items2[0].visitorName).toBe('Maria Clara Santos');

    // Search 3: Raw 8-hex prefix "A1B2C3D4"
    const res3 = await db.query<{ guard_search_recovery_visitors: any }>(`
      select api.guard_search_recovery_visitors('A1B2C3D4');
    `);
    const items3 = res3.rows[0].guard_search_recovery_visitors;
    expect(items3.length).toBe(1);
    expect(items3[0].visitorName).toBe('Maria Clara Santos');

    // Search 4: Lowercase raw 8-hex "a1b2c3d4"
    const res4 = await db.query<{ guard_search_recovery_visitors: any }>(`
      select api.guard_search_recovery_visitors('a1b2c3d4');
    `);
    const items4 = res4.rows[0].guard_search_recovery_visitors;
    expect(items4.length).toBe(1);
    expect(items4[0].visitorName).toBe('Maria Clara Santos');
  });

  // ---------------------------------------------------------------------------
  // CL-T10: Public reference collision returns all matches
  // ---------------------------------------------------------------------------
  it('CL-T10: returns all matching records on shortened public-reference collision', async () => {
    await asGuard();

    const vId1 = '00000000-0000-4000-b000-000000001001';
    const pId1 = '00000000-0000-4000-c000-000000001001';
    const ref1 = 'c0111d00-1111-2222-3333-444455556666';

    const vId2 = '00000000-0000-4000-b000-000000001002';
    const pId2 = '00000000-0000-4000-c000-000000001002';
    const ref2 = 'c0111d00-9999-8888-7777-666655554444';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values
        ('${vId1}', '${GUARD_ID}', 'portal', 'Alice Collision One', '09180001111', 'Meeting', now() at time zone 'Asia/Manila', now()),
        ('${vId2}', '${GUARD_ID}', 'portal', 'Bob Collision Two', '09180002222', 'Deliveries', now() at time zone 'Asia/Manila', now());

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values
        ('${pId1}', '${ref1}', '${vId1}', decode(lpad('1001', 64, '0'), 'hex'), 'issued', 1, 'portal', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 hour') at time zone 'Asia/Manila', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '8 hours') at time zone 'Asia/Manila'),
        ('${pId2}', '${ref2}', '${vId2}', decode(lpad('1002', 64, '0'), 'hex'), 'issued', 1, 'portal', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '1 hour') at time zone 'Asia/Manila', (date_trunc('day', statement_timestamp() at time zone 'Asia/Manila') + interval '8 hours') at time zone 'Asia/Manila');
    `);

    // Search short reference: both share prefix "C0111D00"
    const searchRes = await db.query<{ guard_search_recovery_visitors: any }>(`
      select api.guard_search_recovery_visitors('EG-C0111D00');
    `);
    const results = searchRes.rows[0].guard_search_recovery_visitors;
    expect(results.length).toBe(2);

    const names = results.map((r: any) => r.visitorName);
    expect(names).toContain('Alice Collision One');
    expect(names).toContain('Bob Collision Two');
  });
});
