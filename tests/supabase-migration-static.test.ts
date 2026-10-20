import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const core = readFileSync('supabase/migrations/20261020000100_core_schema.sql', 'utf8');
const rls = readFileSync('supabase/migrations/20261020000200_rls_and_storage.sql', 'utf8');
const rpc = readFileSync('supabase/migrations/20261020000300_core_rpc.sql', 'utf8');
const sql = `${core}\n${rls}\n${rpc}`;

describe('Supabase migration static safety contract', () => {
  it('enables RLS for every application table and revokes broad client grants', () => {
    const tables = [
      'staff_profiles', 'devices', 'app_settings', 'visitors', 'upload_intents',
      'visitor_evidence', 'passes', 'visit_events', 'audit_events',
      'reconciliation_tasks', 'incident_holds', 'rate_limit_buckets', 'maintenance_state',
    ];

    for (const table of tables) {
      expect(rls).toContain(`alter table public.${table} enable row level security;`);
    }
    expect(rls).toContain('revoke all on all tables in schema public from anon, authenticated;');
  });

  it('locks down definer functions and does not grant anonymous RPC execution', () => {
    const definers = [...sql.matchAll(/security definer/gi)];
    const lockedPaths = [...sql.matchAll(/set search_path = ''/gi)];
    expect(definers.length).toBeGreaterThan(0);
    expect(lockedPaths.length).toBeGreaterThanOrEqual(definers.length);
    expect(rpc).toContain('revoke all on function api.create_upload_intent');
    expect(rpc).not.toMatch(/grant execute[^;]+\bto\s+anon\b/i);
  });

  it('keeps evidence buckets private and omits client update/delete policies', () => {
    expect(rls).toMatch(/'visitor-photos'.+false, 5242880/s);
    expect(rls).toMatch(/'visitor-ids'.+false, 5242880/s);
    expect(rls).not.toMatch(/create policy[^;]+on storage\.objects for (update|delete)/i);
  });

  it('contains no permissive pass or event policy', () => {
    expect(rls).not.toMatch(/on public\.passes[\s\S]{0,120}using\s*\(\s*true\s*\)/i);
    expect(rls).not.toMatch(/on public\.(visit_events|audit_events)[\s\S]{0,120}for insert/i);
  });

  it('prevents shared kiosk ownership from becoming history access', () => {
    expect(rls).toContain("v.source = 'portal'::public.pass_source");
    expect(rls).toContain('and (select private.is_portal_actor())');
    expect(rls).toContain("and ui.status in ('pending'::public.upload_intent_status, 'uploaded'::public.upload_intent_status)");
  });

  it('secures pass_email_verifications with RLS and locks down idempotency RPCs (00800 & 00900)', () => {
    const hardening = readFileSync('supabase/migrations/20261020000800_admin_hardening.sql', 'utf8');
    const idempotency = readFileSync('supabase/migrations/20261020000900_qr_email_idempotency.sql', 'utf8');

    expect(hardening).toContain('alter table public.pass_email_verifications enable row level security;');
    expect(hardening).toContain('revoke all on public.pass_email_verifications from public, anon, authenticated;');
    expect(hardening).toContain('grant select, insert, update on public.pass_email_verifications to service_role;');

    // Verify partial unique indexes for idempotency
    expect(idempotency).toContain('create unique index if not exists pass_email_verifications_request_id_idx');
    expect(idempotency).toContain('create unique index if not exists pass_email_verifications_send_request_id_idx');

    // Verify RPC security definer and service-role-only grants
    const rpcs = [
      'api.request_email_verification_code',
      'api.verify_and_claim_email_dispatch',
      'api.finalize_email_dispatch',
    ];

    for (const fn of rpcs) {
      expect(idempotency).toContain(fn);
      expect(idempotency).toMatch(new RegExp(`revoke all on function ${fn.replace('.', '\\.')}[^;]+from public, anon, authenticated;`, 'i'));
      expect(idempotency).toMatch(new RegExp(`grant execute on function ${fn.replace('.', '\\.')}[^;]+to service_role;`, 'i'));
    }
  });
});
