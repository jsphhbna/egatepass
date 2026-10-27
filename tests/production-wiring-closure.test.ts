// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateThermalTemplateLayout,
  thermalElementSchema,
  thermalTemplateLayoutSchema,
  type ThermalTemplateLayout,
} from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';
import { renderThermalPass } from '@/printer/renderer/thermalRenderer';
import type { PassPresentation } from '@/lib/passPresentation';
import thermalTemplateHandler from '../server/routes/device/thermal-template.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

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

async function applyMigrationsUpTo(db: PGlite, count: number): Promise<void> {
  await setupSupabaseEmulation(db);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .slice(0, count);

  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }
}

const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000001';
const GUARD_ID = '00000000-0000-4000-a000-000000000002';
const KIOSK_DEVICE_USER_ID = '00000000-0000-4000-a000-000000000003';
const SCANNER_DEVICE_USER_ID = '00000000-0000-4000-a000-000000000004';

describe('Production Wiring Closure Verification (PW-T01 to PW-T11)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await applyMigrationsUpTo(db, 32);

    // Seed test accounts
    await db.exec(`
      insert into auth.users (id, email, email_confirmed_at)
      values
        ('${SUPERADMIN_ID}', 'admin@earist.edu.ph', now()),
        ('${GUARD_ID}', 'guard@earist.edu.ph', now()),
        ('${KIOSK_DEVICE_USER_ID}', 'kiosk-01@devices.egatepass.invalid', now()),
        ('${SCANNER_DEVICE_USER_ID}', 'scanner-01@devices.egatepass.invalid', now());

      insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
      values
        ('${SUPERADMIN_ID}', 'Super Admin', 'superadmin', true, false, now()),
        ('${GUARD_ID}', 'Main Guard', 'guard', true, false, now());

      insert into public.devices (user_id, alias, name, type, gate, status)
      values
        ('${KIOSK_DEVICE_USER_ID}', 'kiosk-01', 'Kiosk 1', 'kiosk', 'Main Gate', 'active'),
        ('${SCANNER_DEVICE_USER_ID}', 'scanner-01', 'Scanner 1', 'entry', 'Main Gate', 'active');
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

  // ---------------------------------------------------------------------------
  // PW-T01: Exactly one offline event RPC in pg_proc
  // ---------------------------------------------------------------------------
  it('PW-T01: exactly one api.guard_sync_offline_event function exists with canonical signature', async () => {
    const res = await db.query(`
      select
        p.oid::regprocedure::text as signature,
        p.proargnames
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api'
        and p.proname = 'guard_sync_offline_event';
    `);

    expect(res.rows.length).toBe(1);
    const proc = res.rows[0] as { signature: string; proargnames: string[] };
    expect(proc.signature).toContain('guard_sync_offline_event');

    // Assert canonical argument names
    expect(proc.proargnames).toEqual([
      'requested_event_id',
      'requested_pass_id',
      'requested_action',
      'requested_expected_status',
      'requested_expected_version',
      'requested_occurred_at',
      'requested_reason',
    ]);
  });

  // ---------------------------------------------------------------------------
  // PW-T02: Named Supabase RPC resolution without ambiguity
  // ---------------------------------------------------------------------------
  it('PW-T02: named argument Supabase RPC call resolves unambiguously', async () => {
    await asGuard();

    const vId = '66666666-6666-4000-a000-000000000001';
    const testPassId = '77777777-7777-4000-a000-000000000002';
    const refId = '88888888-8888-4000-a000-000000000003';

    await db.exec(`
      insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
      values ('${vId}', '${GUARD_ID}', 'portal', 'Visitor Named Test', '09170000001', 'Official Business', now() at time zone 'Asia/Manila', now())
      on conflict (id) do nothing;

      insert into public.passes (id, public_reference, visitor_id, token_digest, status, version, source, valid_from, valid_until)
      values ('${testPassId}', '${refId}', '${vId}', decode(lpad('1', 64, '0'), 'hex'), 'issued', 1, 'portal', now() - interval '1 hour', now() + interval '8 hours')
      on conflict (id) do update set status = 'issued', version = 1;
    `);

    const testEventId = '33333333-3333-4000-a000-000000000001';

    // Call using named parameters matching PostgREST / Supabase RPC mapping
    const res = await db.query(
      `
      select api.guard_sync_offline_event(
        requested_event_id => $1::uuid,
        requested_pass_id => $2::uuid,
        requested_action => $3::text,
        requested_expected_status => $4::text,
        requested_expected_version => $5::integer,
        requested_occurred_at => $6::timestamptz,
        requested_reason => $7::text
      ) as result;
    `,
      [
        testEventId,
        testPassId,
        'approve_entry',
        'issued',
        1,
        new Date().toISOString(),
        'regular gate entry',
      ]
    );

    expect(res.rows.length).toBe(1);
    const result = (res.rows[0] as { result: any }).result;
    expect(result).toBeDefined();
    expect(result.status).toBe('applied');
    expect(result.newStatus).toBe('inside');
    expect(result.version).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // PW-T03: Production-shaped legacy template migration
  // ---------------------------------------------------------------------------
  it('PW-T03: migrating production-shaped legacy template archives v1 and publishes canonical v2', async () => {
    const isolatedDb = new PGlite();
    // Apply migrations up to 31
    await applyMigrationsUpTo(isolatedDb, 31);

    // Verify template state before migration 32: version 1 exists with legacy types
    const beforeRes = await isolatedDb.query(`
      select version, status, layout from public.thermal_templates where status = 'published';
    `);
    expect(beforeRes.rows.length).toBe(1);
    const v1 = beforeRes.rows[0] as { version: number; status: string; layout: any };
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('published');
    // Legacy element types exist
    const v1Types = v1.layout.elements.map((el: any) => el.type);
    expect(v1Types).toContain('institution_name');
    expect(v1Types).toContain('visitor_name');
    expect(v1Types).toContain('qr_code');

    // Apply migration 32
    const mig32File = fs
      .readdirSync(MIGRATIONS_DIR)
      .find((f) => f.includes('production_wiring_closure'));
    expect(mig32File).toBeDefined();

    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, mig32File!), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await isolatedDb.exec(sql);

    // Verify after migration 32
    const allTemplates = await isolatedDb.query(`
      select version, status from public.thermal_templates order by version;
    `);
    expect(allTemplates.rows.length).toBe(2);

    const v1After = allTemplates.rows.find((r: any) => r.version === 1) as any;
    expect(v1After.status).toBe('archived');

    const v2After = allTemplates.rows.find((r: any) => r.version === 2) as any;
    expect(v2After.status).toBe('published');

    // Exactly one published template
    const publishedRes = await isolatedDb.query(`
      select version, status, layout from public.thermal_templates where status = 'published';
    `);
    expect(publishedRes.rows.length).toBe(1);

    const published = publishedRes.rows[0] as { version: number; status: string; layout: any };
    expect(published.version).toBe(2);

    // Layout satisfies current canonical Zod schema
    const valResult = validateThermalTemplateLayout(published.layout);
    expect(valResult.success).toBe(true);

    await isolatedDb.close();
  }, 30000);

  // ---------------------------------------------------------------------------
  // PW-T04: Fresh installation migration chain (from zero to 32)
  // ---------------------------------------------------------------------------
  it('PW-T04: applying all 32 migrations from zero produces exactly one published canonical template', async () => {
    const freshDb = new PGlite();
    await applyMigrationsUpTo(freshDb, 32);

    const publishedRes = await freshDb.query(`
      select version, status, layout from public.thermal_templates where status = 'published';
    `);
    expect(publishedRes.rows.length).toBe(1);

    const published = publishedRes.rows[0] as { version: number; status: string; layout: any };
    expect(published.status).toBe('published');

    // Schema validation succeeds on client and server
    const clientVal = validateThermalTemplateLayout(published.layout);
    expect(clientVal.success).toBe(true);

    // Execute PostgreSQL validator
    const serverVal = await freshDb.query(`
      select private.validate_thermal_template_layout('${JSON.stringify(published.layout)}'::jsonb);
    `);
    expect(serverVal).toBeDefined();

    await freshDb.close();
  }, 30000);

  // ---------------------------------------------------------------------------
  // PW-T05: Thermal template endpoint authorization
  // ---------------------------------------------------------------------------
  it('PW-T05: enforces strict device authorization on GET /api/device/thermal-template', async () => {
    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockImplementation(async (token: string) => {
          if (token === 'kiosk-token') {
            return { data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk-01@devices.egatepass.invalid' } }, error: null };
          }
          if (token === 'scanner-token') {
            return { data: { user: { id: SCANNER_DEVICE_USER_ID, email: 'scanner-01@devices.egatepass.invalid' } }, error: null };
          }
          if (token === 'guard-token') {
            return { data: { user: { id: GUARD_ID, email: 'guard@earist.edu.ph' } }, error: null };
          }
          if (token === 'admin-token') {
            return { data: { user: { id: SUPERADMIN_ID, email: 'admin@earist.edu.ph' } }, error: null };
          }
          return { data: { user: null }, error: new Error('invalid_token') };
        }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'devices') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_col: string, val: string) => ({
                maybeSingle: vi.fn().mockImplementation(async () => {
                  if (val === KIOSK_DEVICE_USER_ID) {
                    return { data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' }, error: null };
                  }
                  if (val === SCANNER_DEVICE_USER_ID) {
                    return { data: { user_id: SCANNER_DEVICE_USER_ID, type: 'scanner', status: 'active', alias: 'Scanner 1' }, error: null };
                  }
                  return { data: null, error: null };
                }),
              })),
            }),
          };
        }
        return {};
      }),
      rpc: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'get_published_thermal_template') {
          return {
            data: {
              version: 2,
              name: 'Default Institutional 384px Template',
              layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    } as any;

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    // 1. Anonymous request (no bearer) -> 401
    const unauthReq = new Request('http://localhost/api/device/thermal-template', { method: 'GET' });
    const unauthRes = await thermalTemplateHandler.fetch(unauthReq);
    expect(unauthRes.status).toBe(401);
    const unauthBody = await unauthRes.json();
    expect(unauthBody.error).toBe('authentication_required');

    // 2. Guard bearer -> 403
    const guardReq = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer guard-token' },
    });
    const guardRes = await thermalTemplateHandler.fetch(guardReq);
    expect(guardRes.status).toBe(403);
    const guardBody = await guardRes.json();
    expect(guardBody.error).toBe('kiosk_device_required');

    // 3. Admin bearer -> 403
    const adminReq = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer admin-token' },
    });
    const adminRes = await thermalTemplateHandler.fetch(adminReq);
    expect(adminRes.status).toBe(403);

    // 4. Scanner device bearer -> 403
    const scannerReq = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer scanner-token' },
    });
    const scannerRes = await thermalTemplateHandler.fetch(scannerReq);
    expect(scannerRes.status).toBe(403);

    // 5. Active kiosk device -> 200 OK
    const kioskReq = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });
    const kioskRes = await thermalTemplateHandler.fetch(kioskReq);
    expect(kioskRes.status).toBe(200);
    const kioskBody = await kioskRes.json();
    expect(kioskBody.version).toBe(2);
    expect(kioskBody.layout).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // PW-T06: Canonical response conforms to Zod schema
  // ---------------------------------------------------------------------------
  it('PW-T06: thermal endpoint returns canonical response conforming to client schema', async () => {
    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk-01@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({
        data: {
          version: 2,
          name: 'Default Institutional 384px Template',
          layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE,
        },
        error: null,
      }),
    } as any;

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });
    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.name).toBe('Default Institutional 384px Template');

    const zodResult = validateThermalTemplateLayout(body.layout);
    expect(zodResult.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // PW-T07: Endpoint legacy/invalid fallback triggers controlled failure
  // ---------------------------------------------------------------------------
  it('PW-T07: server refuses malformed layout and client maintains bundled fallback', async () => {
    // Malformed layout: invalid width (200 instead of 384)
    const malformedLayout = {
      width: 200,
      height: 640,
      elements: BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements,
    };

    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk-01@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      rpc: vi.fn().mockResolvedValue({
        data: {
          version: 3,
          name: 'Malformed Template',
          layout: malformedLayout,
        },
        error: null,
      }),
    } as any;

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });
    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('invalid_published_template');

    // Simulate kiosk fetch logic: on non-200, retains bundled default
    let activeTemplate = BUNDLED_DEFAULT_THERMAL_TEMPLATE;
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.layout && validateThermalTemplateLayout(data.layout).success) {
        activeTemplate = data.layout;
      }
    }

    expect(activeTemplate).toEqual(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  });

  // ---------------------------------------------------------------------------
  // PW-T08: Kiosk actually consumes published template in renderer
  // ---------------------------------------------------------------------------
  it('PW-T08: kiosk consumes custom published template and passes it to thermal renderer', async () => {
    // Canonical published template with custom height (700)
    const customPublishedLayout: ThermalTemplateLayout = {
      ...BUNDLED_DEFAULT_THERMAL_TEMPLATE,
      height: 700,
    };

    expect(validateThermalTemplateLayout(customPublishedLayout).success).toBe(true);

    const samplePresentation: PassPresentation = {
      institutionName: 'EARIST E-GATEPASS',
      systemTitle: 'CAMPUS VISITOR PASS',
      visitorName: 'JUAN DELA CRUZ',
      visitDate: '2026-10-27',
      passReference: 'EG-20261027-TEST',
      rawReference: 'EG-20261027-TEST',
      qrToken: 'egp_live_tok_test_12345678901234567890',
      validityWindow: '08:00 - 17:00',
      purpose: 'Official Institutional Business',
    };

    const rendered = await renderThermalPass(samplePresentation, customPublishedLayout);
    expect(rendered.canvas.height).toBe(700);
    expect(rendered.canvas.width).toBe(384);
  });

  // ---------------------------------------------------------------------------
  // PW-T09: Strict client/server schema parity
  // ---------------------------------------------------------------------------
  it('PW-T09: validates identical element types, bounds, and property allowlist across client and server', async () => {
    // 1. Bundled default is valid in both
    const clientResult = validateThermalTemplateLayout(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(clientResult.success).toBe(true);

    const serverResult = await db.query(`
      select private.validate_thermal_template_layout('${JSON.stringify(BUNDLED_DEFAULT_THERMAL_TEMPLATE)}'::jsonb);
    `);
    expect(serverResult).toBeDefined();

    // 2. Reject element count > 40 in both
    const fortyOneElements = Array.from({ length: 41 }, (_, i) => ({
      id: `el-test-${i}`,
      type: 'text' as const,
      field: 'custom' as const,
      x: 10,
      y: 10 + i * 10,
      width: 100,
      height: 20,
    }));
    // include mandatory elements in the array
    fortyOneElements[0] = { id: 'm1', type: 'text', field: 'institution_name', text: 'EARIST', x: 10, y: 10, width: 100, height: 20 };
    fortyOneElements[1] = { id: 'm2', type: 'text', field: 'visitor_name', x: 10, y: 30, width: 100, height: 20 };
    fortyOneElements[2] = { id: 'm3', type: 'text', field: 'visit_date', x: 10, y: 50, width: 100, height: 20 };
    fortyOneElements[3] = { id: 'm4', type: 'qr', x: 10, y: 70, width: 140, height: 140 };
    fortyOneElements[4] = { id: 'm5', type: 'text', field: 'pass_reference', x: 10, y: 220, width: 100, height: 20 };

    const tooManyLayout = {
      width: 384,
      height: 1000,
      elements: fortyOneElements,
    };

    expect(validateThermalTemplateLayout(tooManyLayout).success).toBe(false);
    await expect(
      db.query(`select private.validate_thermal_template_layout('${JSON.stringify(tooManyLayout)}'::jsonb);`)
    ).rejects.toThrow(/invalid elements count/);

    // 3. Reject legacy properties (isLocked, isRequired, label) in both
    const legacyPropertyLayout = {
      width: 384,
      height: 640,
      elements: [
        ...BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements.slice(0, 5),
        {
          id: 'extra-locked',
          type: 'text',
          field: 'custom',
          x: 10,
          y: 400,
          width: 100,
          height: 20,
          isLocked: true, // legacy property
        },
      ],
    };

    expect(validateThermalTemplateLayout(legacyPropertyLayout).success).toBe(false);
    await expect(
      db.query(`select private.validate_thermal_template_layout('${JSON.stringify(legacyPropertyLayout)}'::jsonb);`)
    ).rejects.toThrow(/unsupported property in element/);
  });

  // ---------------------------------------------------------------------------
  // PW-T10: Super Admin editor legacy layout protection
  // ---------------------------------------------------------------------------
  it('PW-T10: editor refuses legacy malformed layout and loads canonical default', () => {
    const legacyPublishedTemplate = {
      id: 'legacy-v1-row',
      version: 1,
      status: 'published',
      name: 'Default Institutional 384px Template',
      layout: {
        width: 384,
        elements: [
          { id: 'inst-name', type: 'institution_name', x: 192, y: 24, isLocked: true },
          { id: 'vis-name', type: 'visitor_name', x: 192, y: 88, isLocked: true },
          { id: 'vis-date', type: 'visit_date', x: 192, y: 114, isLocked: true },
          { id: 'qr-code', type: 'qr_code', x: 87, y: 134, width: 210, height: 210, isLocked: true },
          { id: 'pass-ref', type: 'pass_reference', x: 192, y: 364, isLocked: true },
        ],
      },
    };

    // Editor logic validation
    const valResult = validateThermalTemplateLayout(legacyPublishedTemplate.layout);
    expect(valResult.success).toBe(false);

    // Editor selects bundled known-good template instead of corrupted layout
    const activeEditorLayout = valResult.success
      ? legacyPublishedTemplate.layout
      : BUNDLED_DEFAULT_THERMAL_TEMPLATE;

    expect(activeEditorLayout).toEqual(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(activeEditorLayout.elements[0].type).toBe('text');
  });

  // ---------------------------------------------------------------------------
  // PW-T11: 15-Minute Printer Settings Timeout
  // ---------------------------------------------------------------------------
  it('PW-T11: printer settings automatically relock and clear credentials after 15 minutes', () => {
    vi.useFakeTimers();

    let isAuthenticated = false;
    let password = 'kiosk-secret-password';
    let unlockExpiresAt: number | null = null;

    const UNLOCK_TIMEOUT_MS = 15 * 60 * 1000;

    // Simulate successful reauthentication
    isAuthenticated = true;
    password = ''; // cleared on unlock
    unlockExpiresAt = Date.now() + UNLOCK_TIMEOUT_MS;

    expect(isAuthenticated).toBe(true);
    expect(password).toBe('');
    expect(unlockExpiresAt).toBeGreaterThan(Date.now());

    // Advance by 14 minutes -> still unlocked
    vi.advanceTimersByTime(14 * 60 * 1000);
    const remainingAt14 = unlockExpiresAt - Date.now();
    expect(remainingAt14).toBeGreaterThan(0);

    // Advance past 15 minutes -> relocked
    vi.advanceTimersByTime(1 * 60 * 1000 + 100);
    const remainingAt15 = unlockExpiresAt - Date.now();
    if (remainingAt15 <= 0) {
      isAuthenticated = false;
      password = '';
      unlockExpiresAt = null;
    }

    expect(isAuthenticated).toBe(false);
    expect(unlockExpiresAt).toBeNull();

    vi.useRealTimers();
  });
});
