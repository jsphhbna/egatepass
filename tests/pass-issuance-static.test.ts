import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('supabase/migrations/20261020000500_pass_issuance.sql', 'utf8');
const endpoint = readFileSync('api/passes/issue.ts', 'utf8');
const service = readFileSync('src/services/visitorRegistration.ts', 'utf8');
const supabaseClient = readFileSync('src/lib/supabase.ts', 'utf8');
const pgtap = readFileSync('supabase/tests/004_pass_issuance.test.sql', 'utf8');

describe('pass issuance migration contracts', () => {
  it('isolates portal and operator sessions', () => {
    expect(supabaseClient).toContain("storageKey: 'egatepass-operator-auth'");
    expect(supabaseClient).toContain("storageKey: 'egatepass-portal-auth'");
    expect(service).toContain('client.auth.signInAnonymously()');
  });

  it('uses owner-bound private upload intents instead of provider identifiers', () => {
    expect(service).toContain("rpc('create_upload_intent'");
    expect(service).toContain("client.storage.from(data.bucket_id).upload(data.object_path");
    expect(service).not.toMatch(/cloudinary|firebase|firestore/i);
  });

  it('validates actual object bytes before invoking the issuance transaction', () => {
    expect(endpoint).toContain('.download(data.object_path)');
    expect(endpoint).toContain('validMagic(bytes, data.content_type)');
    expect(endpoint).toContain("createHash('sha256').update(bytes)");
    expect(endpoint).toContain("admin.schema('api').rpc('issue_pass'");
  });

  it('keeps the QR bearer secret out of the database', () => {
    expect(endpoint).toContain("createHmac('sha256', secret)");
    expect(endpoint).toContain('requested_token_digest: tokenDigest');
    expect(migration).toContain("decode(requested_token_digest, 'hex')");
    expect(migration).not.toMatch(/insert into public\.passes[\s\S]*qrToken/i);
  });

  it('does not expire evidence before a future pass validity buffer', () => {
    expect(migration).toContain("ends_at + interval '1 day'");
    expect(migration).toContain('make_interval(days => settings.image_retention_days)');
  });

  it('makes issuance service-only, actor-checked, intent-locked, and idempotent', () => {
    expect(migration).toContain("if auth.role() <> 'service_role'");
    expect(migration).toContain('coalesce(u.is_anonymous, false)');
    expect(migration).toContain("d.type = 'kiosk'::public.device_type");
    expect(migration).toContain('where id = requested_photo_intent_id for update');
    expect(migration).toContain('passes_issue_request_unique');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('grant execute on function api.issue_pass');
    expect(migration).toContain('to service_role');
  });

  it('authors executable transaction and source-forgery checks without claiming they ran', () => {
    expect(pgtap).toContain('select extensions.plan(10)');
    expect(pgtap).toContain('the same request id is idempotent');
    expect(pgtap).toContain('a portal identity cannot forge kiosk issuance');
    expect(pgtap).toContain('select * from extensions.finish()');
  });
});
