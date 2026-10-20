import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261020000400_identity_rpcs.sql', 'utf8');
const endpoint = readFileSync('api/auth/complete-password-change.ts', 'utf8');
const pgtap = readFileSync('supabase/tests/003_identity_lifecycle.test.sql', 'utf8');

describe('identity migration contracts', () => {
  it('keeps privacy acknowledgement caller-bound and server-audited', () => {
    expect(migration).toContain('caller_id uuid := (select auth.uid())');
    expect(migration).toMatch(/where user_id = caller_id and active/);
    expect(migration).toContain("'privacy.acknowledged'");
    expect(migration).toContain('grant execute on function api.acknowledge_privacy() to authenticated');
  });

  it('exposes password finalization only to the service role', () => {
    expect(migration).toContain("if (select auth.role()) <> 'service_role'");
    expect(migration).toContain('revoke all on function api.finalize_guard_password_change(uuid) from public, anon, authenticated');
    expect(migration).toContain('grant execute on function api.finalize_guard_password_change(uuid) to service_role');
  });

  it('requires bearer identity, current-password verification, eligible Guard state, and reconciliation', () => {
    expect(endpoint).toContain('admin.auth.getUser(token)');
    expect(endpoint).toContain("profile.role !== 'guard'");
    expect(endpoint).toContain('passwordVerifier.auth.signInWithPassword');
    expect(endpoint).toContain('admin.auth.admin.updateUserById');
    expect(endpoint).toContain("rpc('finalize_guard_password_change'");
    expect(endpoint).toContain("'guard.password_change_finalize'");
    expect(endpoint).toContain('recordReconciliation');
    expect(endpoint).not.toMatch(/console\.(?:log|error)\([^\n]*(?:currentPassword|newPassword)/);
  });

  it('authors executable pgTAP coverage without treating it as executed evidence', () => {
    expect(pgtap).toContain('select extensions.plan(8)');
    expect(pgtap).toContain("set_config('request.jwt.claim.sub'");
    expect(pgtap).toContain('not has_function_privilege');
    expect(pgtap).toContain('select * from extensions.finish()');
  });
});
