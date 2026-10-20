import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261020000600_gate_lifecycle.sql', 'utf8');
const scanEndpoint = readFileSync('api/scan-pass.ts', 'utf8');
const decisionEndpoint = readFileSync('api/decide-visit.ts', 'utf8');
const evidenceEndpoint = readFileSync('api/evidence.ts', 'utf8');
const guardPage = readFileSync('src/pages/GuardPage.tsx', 'utf8');
const pgtap = readFileSync('supabase/tests/005_gate_lifecycle.test.sql', 'utf8');

describe('gate lifecycle migration contracts', () => {
  it('stores and compares only QR digests', () => {
    expect(scanEndpoint.includes('getVerifiedSessionContext(admin, token)') || scanEndpoint.includes('admin.auth.getUser(token)')).toBe(true);
    expect(migration).toContain("p.token_digest = decode(requested_token_digest, 'hex')");
    expect(migration).not.toMatch(/passToken|qrToken/);
  });

  it('binds scan mode and gate to active device rows', () => {
    expect(migration).toContain("d.user_id = requested_actor_id and d.status = 'active'");
    expect(migration).toContain('scanner.type <> requested_mode');
    expect(migration).toContain('target.gate is distinct from scanner.gate');
  });

  it('keeps entry, decision, and exit as locked database transitions', () => {
    expect(migration).toMatch(/from public\.passes p[\s\S]*for update/);
    expect(migration).toContain("status = 'pending'");
    expect(migration).toContain("then 'inside'::public.pass_status");
    expect(migration).toContain("status = 'exited'");
    expect(migration).toContain('version = version + 1');
  });

  it('requires server-authenticated identities for mutation endpoints', () => {
    expect(scanEndpoint.includes('getVerifiedSessionContext(admin, token)') || scanEndpoint.includes('admin.auth.getUser(token)')).toBe(true);
    expect(decisionEndpoint.includes('requireStaffActor(admin, token') || decisionEndpoint.includes('admin.auth.getUser(token)')).toBe(true);
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain('to service_role');
  });

  it('authorizes each private evidence read and fails expired evidence closed', () => {
    expect(evidenceEndpoint.includes('requireStaffActor(admin, token') || evidenceEndpoint.includes('.select(')).toBe(true);
    expect(evidenceEndpoint).toContain(".eq('status', 'pending')");
    expect(evidenceEndpoint).toContain('return jsonResponse(410');
    expect(evidenceEndpoint).toContain("'Cache-Control': 'private, no-store'");
  });

  it('removes Firestore from the Guard runtime and authors executable lifecycle checks', () => {
    expect(guardPage).not.toMatch(/firebase|firestore/i);
    expect(guardPage).toContain('fetchGuardDashboard');
    expect(pgtap).toContain('select extensions.plan(14)');
    expect(pgtap).toContain('wrong-gate exit is denied');
    expect(pgtap).toContain('select * from extensions.finish()');
  });
});
