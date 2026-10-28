import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadRegistrationSettings } from '@/services/visitorRegistration';
import * as supabaseModule from '@/lib/supabase';

const updateSettingsInstructionSchema = z
  .array(
    z
      .string()
      .trim()
      .min(3, 'Instruction must be at least 3 characters')
      .max(180, 'Instruction must not exceed 180 characters')
  )
  .min(1, 'At least 1 instruction is required')
  .max(8, 'Maximum 8 instructions allowed');

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
    await db.exec(sql);
  }
}

describe('Group E: Configurable Visitor Instructions & Public Settings Access Contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Validation Schema Contracts', () => {
    it('accepts valid 1-8 instructions array of 3-180 characters', () => {
      const validInstructions = [
        'Follow the EARIST visitor dress code and campus policies.',
        'Bring a valid ID for identity verification at the gate.',
        'Keep your E-GatePass ready before approaching the entrance.',
      ];
      const parsed = updateSettingsInstructionSchema.safeParse(validInstructions);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.length).toBe(3);
      }
    });

    it('rejects an empty instructions array (< 1 instruction)', () => {
      const emptyList: string[] = [];
      const parsed = updateSettingsInstructionSchema.safeParse(emptyList);
      expect(parsed.success).toBe(false);
    });

    it('rejects an array with more than 8 instructions', () => {
      const excessiveList = [
        'Instruction 1',
        'Instruction 2',
        'Instruction 3',
        'Instruction 4',
        'Instruction 5',
        'Instruction 6',
        'Instruction 7',
        'Instruction 8',
        'Instruction 9',
      ];
      const parsed = updateSettingsInstructionSchema.safeParse(excessiveList);
      expect(parsed.success).toBe(false);
    });

    it('rejects an instruction shorter than 3 characters or only whitespace', () => {
      const shortList = ['OK'];
      const whitespaceList = ['   '];
      expect(updateSettingsInstructionSchema.safeParse(shortList).success).toBe(false);
      expect(updateSettingsInstructionSchema.safeParse(whitespaceList).success).toBe(false);
    });

    it('rejects an instruction longer than 180 characters', () => {
      const tooLong = 'A'.repeat(181);
      const parsed = updateSettingsInstructionSchema.safeParse([tooLong]);
      expect(parsed.success).toBe(false);
    });
  });

  describe('Real Migration Chain Column Privileges (anon & authenticated)', () => {
    it('proves anon can SELECT safe columns and CANNOT select sensitive columns', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      await db.exec('set role anon;');

      // Can SELECT public safe columns
      const res = await db.query<{
        visitor_instructions: any;
        image_retention_days: number;
        visitor_retention_days: number;
      }>(`
        select visitor_instructions, image_retention_days, visitor_retention_days
        from public.app_settings;
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].visitor_instructions).toBeDefined();
      expect(res.rows[0].image_retention_days).toBeDefined();
      expect(res.rows[0].visitor_retention_days).toBeDefined();

      // CANNOT SELECT unapproved sensitive columns
      await expect(
        db.query('select automatic_cleanup_enabled from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await expect(
        db.query('select reconciliation_retention_days from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await expect(
        db.query('select audit_retention_days from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await expect(
        db.query('select * from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await db.exec('reset role;');
    }, 30000);

    it('proves authenticated can SELECT safe columns and CANNOT select sensitive columns', async () => {
      const db = new PGlite();
      await applyAllMigrations(db);

      await db.exec('set role authenticated;');

      // Can SELECT public safe columns (e.g. Kiosk device or signed-in visitor)
      const res = await db.query<{
        visitor_instructions: any;
        image_retention_days: number;
        visitor_retention_days: number;
      }>(`
        select visitor_instructions, image_retention_days, visitor_retention_days
        from public.app_settings;
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].visitor_instructions).toBeDefined();
      expect(res.rows[0].image_retention_days).toBeDefined();
      expect(res.rows[0].visitor_retention_days).toBeDefined();

      // CANNOT SELECT unapproved sensitive columns
      await expect(
        db.query('select automatic_cleanup_enabled from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await expect(
        db.query('select audit_retention_days from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await expect(
        db.query('select * from public.app_settings;')
      ).rejects.toThrow(/permission denied/);

      await db.exec('reset role;');
    }, 30000);
  });

  describe('Behavioral Settings Loading Contract (Portal & Kiosk)', () => {
    it('loadRegistrationSettings returns real configured retention values (11, 45) for Portal, not 7/30', async () => {
      const mockSettingsRow = {
        working_hours_start: '07:00',
        working_hours_end: '18:00',
        timezone: 'Asia/Manila',
        scheduling_days_ahead: 7,
        peak_mode: 'normal',
        visit_purposes: ['Inquiry', 'Admission'],
        visitor_instructions: ['Dress appropriately.'],
        image_retention_days: 11,
        visitor_retention_days: 45,
      };

      const mockFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: mockSettingsRow, error: null }),
        }),
      });

      vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue({
        from: mockFrom,
      } as any);

      const portalSettings = await loadRegistrationSettings('portal');
      expect(portalSettings.image_retention_days).toBe(11);
      expect(portalSettings.visitor_retention_days).toBe(45);
      expect(portalSettings.image_retention_days).not.toBe(7);
      expect(portalSettings.visitor_retention_days).not.toBe(30);
    });

    it('loadRegistrationSettings returns real configured retention values (11, 45) for Kiosk, not 7/30', async () => {
      const mockSettingsRow = {
        working_hours_start: '07:00',
        working_hours_end: '18:00',
        timezone: 'Asia/Manila',
        scheduling_days_ahead: 7,
        peak_mode: 'normal',
        visit_purposes: ['Inquiry', 'Admission'],
        visitor_instructions: ['Dress appropriately.'],
        image_retention_days: 11,
        visitor_retention_days: 45,
      };

      const mockFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: mockSettingsRow, error: null }),
        }),
      });

      vi.spyOn(supabaseModule, 'requireSupabase').mockReturnValue({
        from: mockFrom,
      } as any);

      const kioskSettings = await loadRegistrationSettings('kiosk');
      expect(kioskSettings.image_retention_days).toBe(11);
      expect(kioskSettings.visitor_retention_days).toBe(45);
      expect(kioskSettings.image_retention_days).not.toBe(7);
      expect(kioskSettings.visitor_retention_days).not.toBe(30);
    });

    it('normalizes missing/unreadable retention values to null (never invented defaults)', async () => {
      const mockSettingsRowWithoutRetention = {
        working_hours_start: '07:00',
        working_hours_end: '18:00',
        timezone: 'Asia/Manila',
        scheduling_days_ahead: 7,
        peak_mode: 'normal',
        visit_purposes: ['Inquiry'],
        visitor_instructions: null,
        image_retention_days: null,
        visitor_retention_days: null,
      };

      const mockFrom = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: mockSettingsRowWithoutRetention, error: null }),
        }),
      });

      vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue({
        from: mockFrom,
      } as any);

      const settings = await loadRegistrationSettings('portal');
      expect(settings.image_retention_days).toBeNull();
      expect(settings.visitor_retention_days).toBeNull();
    });
  });
});
