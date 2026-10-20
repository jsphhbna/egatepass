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

  it('applies additive QR-email state-machine hardening in 01000', () => {
    const security = readFileSync('supabase/migrations/20261020001000_qr_email_security.sql', 'utf8');
    const pgtap = readFileSync('supabase/tests/007_qr_email_security.test.sql', 'utf8');
    const rpcs = [
      'api.request_email_verification_code',
      'api.finalize_email_verification_code',
      'api.verify_and_claim_email_dispatch',
      'api.finalize_email_dispatch',
    ];
    expect(security).toContain("set search_path = ''");
    expect(security).toContain('for update;');
    expect(security).toContain('request_actor_id');
    expect(security).toContain("'outcome_unknown'");
    expect(security).toContain('pass_email_verifications_pass_created_idx');
    for (const fn of rpcs) {
      expect(security).toMatch(new RegExp(`revoke all on function ${fn.replace('.', '\\.')}[^;]+from public, anon, authenticated;`, 'i'));
      expect(security).toMatch(new RegExp(`grant execute on function ${fn.replace('.', '\\.')}[^;]+to service_role;`, 'i'));
    }
    expect(pgtap).toContain('different send key cannot bypass active claim');
    expect(pgtap).toContain('stale failure cannot overwrite provider acceptance');
    expect(pgtap).toContain('AUTHORED / NOT RUN');
  });

  it('applies additive email security and abuse controls in 01100', () => {
    const migration = readFileSync('supabase/migrations/20261020001100_email_security_and_abuse_controls.sql', 'utf8');
    const pgtap = readFileSync('supabase/tests/008_email_security_and_abuse_controls.test.sql', 'utf8');
    const rpcs = [
      'api.finalize_email_verification_code',
      'api.finalize_email_dispatch',
      'api.request_email_verification_code',
      'api.verify_and_claim_email_dispatch',
      'api.claim_evidence_for_purge',
      'api.finalize_evidence_purge',
    ];

    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('terminal_conflict');
    expect(migration).toContain('already_finalized_same_status');
    expect(migration).toContain('kiosk_device_revoked');
    expect(migration).toContain('too_many_requests_recipient');
    expect(migration).toContain('purge_claim_id');

    for (const fn of rpcs) {
      expect(migration).toMatch(new RegExp(`revoke all on function ${fn.replace('.', '\\.')}[^;]+from public, anon, authenticated;`, 'i'));
      expect(migration).toMatch(new RegExp(`grant execute on function ${fn.replace('.', '\\.')}[^;]+to service_role;`, 'i'));
    }

    expect(pgtap).toContain('conflicting terminal status returns terminal_conflict');
    expect(pgtap).toContain('revoked kiosk device cannot request verification code');
    expect(pgtap).toContain('AUTHORED / NOT RUN');

    // P0-B: Verify 008 test strictly uses canonical public.devices schema columns and valid enums
    expect(pgtap).not.toContain('device_alias');
    expect(pgtap).not.toContain('device_type');
    expect(pgtap).not.toContain('registered_at');
    expect(pgtap).not.toContain('retired_at');
    expect(pgtap).not.toMatch(/status\s*=\s*'retired'/i);
    expect(pgtap).toContain('user_id, alias, name, type, gate, status');
    expect(pgtap).toContain("created_by_device_id");
  });

  it('applies additive concurrency hardening and purge claim contracts in 01200 & pgTAP 009', () => {
    const migration = readFileSync('supabase/migrations/20261020001200_concurrency_and_purge_contract_hardening.sql', 'utf8');
    const pgtap = readFileSync('supabase/tests/009_cross_pass_abuse_concurrency.test.sql', 'utf8');
    const rpcs = [
      'api.claim_evidence_for_purge',
      'api.finalize_evidence_purge',
      'api.request_email_verification_code',
    ];

    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('claim_mismatch');
    expect(migration).toContain('expired_claim');
    expect(migration).toContain('terminal_conflict');
    expect(migration).toContain('match_status');

    for (const fn of rpcs) {
      expect(migration).toMatch(new RegExp(`revoke all on function ${fn.replace('.', '\\.')}[^;]+from public, anon, authenticated;`, 'i'));
      expect(migration).toMatch(new RegExp(`grant execute on function ${fn.replace('.', '\\.')}[^;]+to service_role;`, 'i'));
    }

    expect(pgtap).toContain('cross-pass 6th challenge is rejected by recipient rate limit');
    expect(pgtap).toContain('worker 2 cannot finalize worker 1 claim');
    expect(pgtap).toContain('worker 1 finalizes evidence with matching claim ID');
    expect(pgtap).toContain('claim rejected when visitor has active pass');
    expect(pgtap).toContain('AUTHORED / NOT RUN');
  });

  it('applies additive cross-layer root cause hardening in 01300', () => {
    const migration = readFileSync('supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql', 'utf8');

    // P0-01: RLS operational predicate checks must_change_password and privacy_accepted_at
    expect(migration).toContain('must_change_password = false');
    expect(migration).toContain('privacy_accepted_at is not null');
    expect(migration).toContain('api.acknowledge_privacy');
    expect(migration).toContain('staff_profiles_select');

    // P0-02: Fixes passes join to visitors resolving v.owner_id
    expect(migration).toContain('join public.visitors v on v.id = p.visitor_id');
    expect(migration).toContain('v_pass.owner_id');

    // P0-03: Explicit schema grants
    expect(migration).toContain('grant usage on schema api to authenticated, service_role');
    expect(migration).toContain('grant usage on schema public to anon, authenticated, service_role');
    expect(migration).toContain('revoke all on schema private from public, anon, authenticated');

    // P0-04: Atomic incident hold create & release
    expect(migration).toContain('api.create_incident_hold');
    expect(migration).toContain('api.release_incident_hold');
    expect(migration).toContain('evidence_already_purged');
    expect(migration).toContain('purge_in_progress');

    // HIGH-03: Guard approval expired check
    expect(migration).toContain("pass_has_expired");
    expect(migration).toContain("target.valid_until <= statement_timestamp()");

    // MED-04: Upload intent rate limiting
    expect(migration).toContain('too_many_pending_intents');

    // MED-01: Guard queue pagination & backlog count
    expect(migration).toContain('api.guard_dashboard');
    expect(migration).toContain('requested_limit integer default 50');
    expect(migration).toContain('requested_offset integer default 0');
    expect(migration).toContain('pendingTotal');
    expect(migration).toContain('hasMore');
  });
});
