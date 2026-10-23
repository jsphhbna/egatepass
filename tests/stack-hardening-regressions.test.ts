import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { evaluateTurnstilePolicy } from '../src/services/visitorRegistration';
import { evaluateAuthTurnstilePolicy } from '../src/services/auth';
import issuePassHandler, { getClientNetworkIdentifier } from '../server/routes/passes/issue';
import { handleRequest as handleResendWebhook } from '../server/routes/auth/resend-webhook';
import { setServerSupabaseClientsForTest } from '../server/supabase';

const TEST_WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-webhook-secret-key-32-chars-long!').toString('base64');

describe('Stack Hardening & Recurring-Issue Regressions Suite', () => {
  describe('1. Dependency & Runtime Policy Contract', () => {
    it('pins Vite to a safe, non-vulnerable version (>= 8.3.3)', () => {
      const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
      const viteVersion = lock.packages?.['node_modules/vite']?.version || lock.dependencies?.vite?.version;
      expect(viteVersion).toBeDefined();

      const [major, minor, patch] = viteVersion.split('.').map(Number);
      expect(major).toBe(8);
      expect(minor).toBe(3);
      expect(patch).toBeGreaterThanOrEqual(3);
      expect(viteVersion).not.toMatch(/^8\.3\.[0-2]$/);
    });

    it('prohibits react-server-dom-* packages from entire dependency tree', () => {
      const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
      const allPkgs = Object.keys(lock.packages || {});
      const rscPkgs = allPkgs.filter((pkg) => pkg.includes('react-server-dom'));
      expect(rscPkgs).toHaveLength(0);
    });

    it('enforces Node 24.x production runtime policy in package.json engines', () => {
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
      expect(manifest.engines).toBeDefined();
      expect(manifest.engines.node).toMatch(/24/);
    });
  });

  describe('2. Turnstile Environment Isolation & Policy Enforcement', () => {
    it('fails closed in production portal issuance if Turnstile token is missing', () => {
      const result = evaluateTurnstilePolicy('portal', true, '0x4AAAAAAFeETebgPENH6hgH', null);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('Verification challenge required');
    });

    it('fails closed in production if Turnstile site key is missing or blank', () => {
      const result = evaluateTurnstilePolicy('portal', true, '', null);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('missing security configuration');
    });

    it('permits portal issuance in production when Turnstile token is present', () => {
      const result = evaluateTurnstilePolicy('portal', true, '0x4AAAAAAFeETebgPENH6hgH', 'valid-cf-token');
      expect(result.allowed).toBe(true);
    });

    it('bypasses Turnstile challenge gracefully for non-portal kiosk registrations', () => {
      const result = evaluateTurnstilePolicy('kiosk', true, '0x4AAAAAAFeETebgPENH6hgH', null);
      expect(result.allowed).toBe(true);
    });

    it('bypasses Turnstile in preview/dev environments where isProd is false', () => {
      const result = evaluateTurnstilePolicy('portal', false, undefined, null);
      expect(result.allowed).toBe(true);
    });

    it('fails closed in production auth (login/forgot-password) if Turnstile token is missing', () => {
      const result = evaluateAuthTurnstilePolicy(true, '0x4AAAAAAFeETebgPENH6hgH', null);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('security challenge');
    });

    it('fails closed in production auth if Turnstile site key is missing or blank', () => {
      const result = evaluateAuthTurnstilePolicy(true, '', null);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain('missing security configuration');
    });

    it('permits auth in production when Turnstile token is present', () => {
      const result = evaluateAuthTurnstilePolicy(true, '0x4AAAAAAFeETebgPENH6hgH', 'valid-cf-token');
      expect(result.allowed).toBe(true);
    });

    it('bypasses Turnstile auth challenge in preview/dev environments where isProd is false', () => {
      const result = evaluateAuthTurnstilePolicy(false, undefined, null);
      expect(result.allowed).toBe(true);
    });

  });

  describe('3. Resend Delivery Observability Webhook Contract', () => {
    let insertedAudits: any[] = [];
    let claimedEvents: Set<string> = new Set();
    let simulateAuditFailure = false;

    beforeEach(() => {
      process.env.RESEND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
      insertedAudits = [];
      claimedEvents = new Set();
      simulateAuditFailure = false;

      const mockClients = {
        admin: {
          schema: (schemaName: string) => ({
            rpc: async (fnName: string, params: any) => {
              if (schemaName === 'api' && fnName === 'record_resend_delivery_event') {
                const {
                  requested_provider_event_id,
                  requested_event_type,
                  requested_email_id,
                  requested_outcome,
                  requested_recipient_masked,
                  requested_subject_sanitized,
                  requested_occurred_at,
                } = params;

                if (claimedEvents.has(requested_provider_event_id)) {
                  return {
                    data: {
                      ok: true,
                      status: 'already_processed',
                      duplicate: true,
                      provider_event_id: requested_provider_event_id,
                      event_type: requested_event_type,
                      email_id: requested_email_id,
                    },
                    error: null,
                  };
                }

                // If audit failure is simulated, the database transaction rolls back,
                // so provider_event_id is NOT permanently consumed.
                if (simulateAuditFailure) {
                  return {
                    data: null,
                    error: {
                      message: 'simulated audit_events insertion error (rolled back)',
                      code: '23502',
                    },
                  };
                }

                claimedEvents.add(requested_provider_event_id);
                const auditRecord = {
                  action: 'resend.delivery_event',
                  actor_kind: 'system',
                  actor_role: 'webhook',
                  target_type: 'email',
                  target_id: requested_email_id,
                  outcome: requested_outcome,
                  after_state: {
                    eventType: requested_event_type,
                    emailId: requested_email_id,
                    providerEventId: requested_provider_event_id,
                    recipientMasked: requested_recipient_masked,
                    subjectSanitized: requested_subject_sanitized,
                    timestamp: requested_occurred_at || new Date().toISOString(),
                  },
                  occurred_at: requested_occurred_at || new Date().toISOString(),
                };
                insertedAudits.push(auditRecord);

                return {
                  data: {
                    ok: true,
                    status: 'processed',
                    duplicate: false,
                    provider_event_id: requested_provider_event_id,
                    event_id: 'mock-event-uuid-1',
                    audit_id: 1001,
                    email_id: requested_email_id,
                    event_type: requested_event_type,
                    outcome: requested_outcome,
                  },
                  error: null,
                };
              }
              return { data: null, error: { message: 'unknown_rpc', code: '42883' } };
            },
          }),
        },
      };

      setServerSupabaseClientsForTest(mockClients as any);
    });

    afterEach(() => {
      setServerSupabaseClientsForTest(null as any);
    });

    it('rejects non-POST HTTP methods with 405 Method Not Allowed', async () => {
      const req = new Request('http://localhost/api/webhooks/resend', { method: 'GET' });
      const res = await handleResendWebhook(req);
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.error).toBe('method_not_allowed');
    });

    it('rejects requests missing Svix/Webhook signature headers with 400', async () => {
      const req = new Request('http://localhost/api/webhooks/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email.delivered' }),
      });
      const res = await handleResendWebhook(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_signature');
    });

    it('rejects invalid or tampered webhook signatures with 400', async () => {
      const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'test_123' } });
      const req = new Request('http://localhost/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_test',
          'svix-timestamp': Math.floor(Date.now() / 1000).toString(),
          'svix-signature': 'v1,invalid_signature_hex_or_base64',
        },
        body: payload,
      });
      const res = await handleResendWebhook(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_signature');
    });

    it('successfully processes valid signed Resend delivery events and masks recipient email', async () => {
      const wh = new Webhook(TEST_WEBHOOK_SECRET);
      const payload = JSON.stringify({
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: {
          email_id: 'email_abc_123',
          from: 'notifications@egatepass.tech',
          to: ['visitor@earist.edu.ph'],
          subject: 'Your Gate Pass Confirmation',
        },
      });
      const timestamp = new Date();
      const sig = wh.sign('msg_valid_1', timestamp, payload);

      const req = new Request('http://localhost/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_valid_1',
          'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
          'svix-signature': sig,
        },
        body: payload,
      });

      const res = await handleResendWebhook(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.status).toBe('processed');
      expect(body.emailId).toBe('email_abc_123');
      expect(body.eventType).toBe('email.delivered');

      expect(insertedAudits).toHaveLength(1);
      const audit = insertedAudits[0];
      expect(audit.action).toBe('resend.delivery_event');
      expect(audit.outcome).toBe('success');
      expect(audit.after_state.recipientMasked).toBe('v***r@earist.edu.ph');
    });

    it('idempotently handles duplicate delivery events returning 200 already_processed with exactly one audit record', async () => {
      const wh = new Webhook(TEST_WEBHOOK_SECRET);
      const payload = JSON.stringify({
        type: 'email.delivered',
        data: { email_id: 'email_duplicate_123', to: ['test@domain.com'] },
      });
      const timestamp = new Date();
      const sig = wh.sign('msg_dup_1', timestamp, payload);

      const reqInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_dup_1',
          'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
          'svix-signature': sig,
        },
        body: payload,
      };

      // First delivery: processes successfully
      const res1 = await handleResendWebhook(new Request('http://localhost/api/webhooks/resend', reqInit));
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.ok).toBe(true);
      expect(body1.status).toBe('processed');
      expect(insertedAudits).toHaveLength(1);

      // Replayed delivery with exact same provider_event_id: returns 200 already_processed, no duplicate audit
      const res2 = await handleResendWebhook(new Request('http://localhost/api/webhooks/resend', reqInit));
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.ok).toBe(true);
      expect(body2.status).toBe('already_processed');
      expect(body2.duplicate).toBe(true);
      expect(body2.providerEventId).toBe('msg_dup_1');
      expect(insertedAudits).toHaveLength(1); // exactly one audit record
    });

    it('transactionally rolls back provider event claim when audit logging fails, allowing subsequent retry to succeed', async () => {
      const wh = new Webhook(TEST_WEBHOOK_SECRET);
      const payload = JSON.stringify({
        type: 'email.sent',
        data: { email_id: 'email_retry_test', to: ['retry@domain.com'], subject: 'Test' },
      });
      const timestamp = new Date();
      const sig = wh.sign('msg_retry_100', timestamp, payload);

      const reqInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': 'msg_retry_100',
          'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
          'svix-signature': sig,
        },
        body: payload,
      };

      // 1. Simulate failure during audit insertion
      simulateAuditFailure = true;
      const failRes = await handleResendWebhook(new Request('http://localhost/api/webhooks/resend', reqInit));
      expect(failRes.status).toBe(500);
      const failBody = await failRes.json();
      expect(failBody.error).toBe('delivery_recording_failed');
      // Verify rollback: provider ID is NOT permanently claimed
      expect(claimedEvents.has('msg_retry_100')).toBe(false);
      expect(insertedAudits).toHaveLength(0);

      // 2. Resend retries after transient failure resolves
      simulateAuditFailure = false;
      const retryRes = await handleResendWebhook(new Request('http://localhost/api/webhooks/resend', reqInit));
      expect(retryRes.status).toBe(200);
      const retryBody = await retryRes.json();
      expect(retryBody.ok).toBe(true);
      expect(retryBody.status).toBe('processed');
      expect(claimedEvents.has('msg_retry_100')).toBe(true);
      expect(insertedAudits).toHaveLength(1);
    });
  });

  describe('4. Cryptographic Key Separation & Forward Migration Verification', () => {
    it('verifies forward migration 20261023020000 defines foreign key covering indexes', () => {
      const migrationPath = join('supabase', 'migrations', '20261023020000_performance_covering_indexes.sql');
      expect(existsSync(migrationPath)).toBe(true);
      const content = readFileSync(migrationPath, 'utf8');

      // Passes covering indexes
      expect(content).toContain('passes_decided_by_idx');
      expect(content).toContain('passes_entry_device_id_idx');
      expect(content).toContain('passes_exit_device_id_idx');

      // Visit events covering indexes
      expect(content).toContain('visit_events_visitor_id_idx');
      expect(content).toContain('visit_events_guard_id_idx');
      expect(content).toContain('visit_events_device_id_idx');

      // Upload intents & holds covering indexes
      expect(content).toContain('upload_intents_visitor_id_idx');
      expect(content).toContain('incident_holds_created_by_idx');
      expect(content).toContain('incident_holds_released_by_idx');
      expect(content).toContain('visitors_created_by_device_id_idx');
    });

    it('verifies server rate-limit identifier uses dedicated RATE_LIMIT_HMAC_SECRET', () => {
      const issueRoute = readFileSync('server/routes/passes/issue.ts', 'utf8');
      expect(issueRoute).toContain('RATE_LIMIT_HMAC_SECRET');
      expect(issueRoute).not.toContain("'egatepass-rate-limit-secret'");
      expect(issueRoute).not.toContain('fallbackSecret');
    });

    it('behaviorally proves production pass issuance rate limiting fails closed with 503 if RATE_LIMIT_HMAC_SECRET is missing, even when PASS_TOKEN_SECRET is present', () => {
      const savedVercelEnv = process.env.VERCEL_ENV;
      const savedHmacSecret = process.env.RATE_LIMIT_HMAC_SECRET;
      const savedPassSecret = process.env.PASS_TOKEN_SECRET;

      try {
        process.env.VERCEL_ENV = 'production';
        process.env.PASS_TOKEN_SECRET = 'this-is-a-valid-pass-token-secret-at-least-32-chars!';
        delete process.env.RATE_LIMIT_HMAC_SECRET;

        const req = new Request('http://localhost/api/passes/issue', {
          headers: { 'x-real-ip': '203.0.113.195' },
        });

        expect(() => getClientNetworkIdentifier(req)).toThrowError();
        try {
          getClientNetworkIdentifier(req);
        } catch (err: any) {
          expect(err.status).toBe(503);
          expect(err.code).toBe('abuse_control_unavailable');
        }
      } finally {
        process.env.VERCEL_ENV = savedVercelEnv;
        process.env.RATE_LIMIT_HMAC_SECRET = savedHmacSecret;
        process.env.PASS_TOKEN_SECRET = savedPassSecret;
      }
    });

    it('verifies forward migration 20261023140000 defines resend_webhook_events table with unique provider_event_id', () => {
      const migrationPath = join('supabase', 'migrations', '20261023140000_resend_webhook_idempotency.sql');
      expect(existsSync(migrationPath)).toBe(true);
      const content = readFileSync(migrationPath, 'utf8');
      expect(content).toContain('resend_webhook_events');
      expect(content).toContain('provider_event_id');
      expect(content).toContain('resend_webhook_events_provider_id_unique UNIQUE (provider_event_id)');
    });


    it('verifies forward migration 20261023160000 defines transactional api.record_resend_delivery_event RPC', () => {
      const migrationPath = join('supabase', 'migrations', '20261023160000_resend_webhook_transactional_rpc.sql');
      expect(existsSync(migrationPath)).toBe(true);
      const content = readFileSync(migrationPath, 'utf8');
      expect(content).toContain('CREATE OR REPLACE FUNCTION api.record_resend_delivery_event');
      expect(content).toContain('resend_webhook_events');
      expect(content).toContain('audit_events');
      expect(content).toContain('SECURITY DEFINER');
      expect(content).toContain('GRANT EXECUTE ON FUNCTION api.record_resend_delivery_event');
    });

    it('verifies visitor photos and visitor IDs buckets remain private and restricted', () => {
      const storageMigration = readFileSync('supabase/migrations/20261020000200_rls_and_storage.sql', 'utf8');
      expect(storageMigration).toContain("('visitor-photos', 'visitor-photos', false");
      expect(storageMigration).toContain("('visitor-ids', 'visitor-ids', false");
      expect(storageMigration).toContain('5242880'); // 5 MiB
    });
  });
});
