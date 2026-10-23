import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Documentation Truthfulness & Formatting Contract', () => {
  const activeDocFiles = [
    'README.md',
    ...fs.readdirSync('docs')
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.join('docs', file)),
  ];

  it('ensures all active documents have zero UTF-8 Byte Order Marks (BOM)', () => {
    for (const filePath of activeDocFiles) {
      const buffer = fs.readFileSync(filePath);
      const hasBom = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
      expect(hasBom, 'Accidental UTF-8 BOM detected in ' + filePath).toBe(false);
    }
  });

  it('ensures all active documents have zero unexpected ASCII control characters', () => {
    const controlCharRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    for (const filePath of activeDocFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(controlCharRegex);
      expect(match, 'Found ASCII control character in ' + filePath).toBeNull();
    }
  });

  it('ensures all active documents have zero encoding corruption or mojibake', () => {
    const mojibakeRegex = new RegExp('(\\uFFFD|\\u00C2|\\u00E2\\u20AC\\u2122|\\u00E2\\u20AC\\u0153|\\u00E2\\u20AC|\\u00E2\\u20AC\\u2013|\\u00E2\\u20AC\\u2014)');
    for (const filePath of activeDocFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const match = content.match(mojibakeRegex);
      expect(match, 'Found encoding corruption/mojibake in ' + filePath).toBeNull();
    }
  });

  it('ensures all active documents have zero malformed single-backtick mermaid blocks', () => {
    const singleBacktickMermaidRegex = /^\x60mermaid/;
    for (const filePath of activeDocFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        expect(line, 'Found single-backtick mermaid block at ' + filePath + ':' + (index + 1)).not.toMatch(singleBacktickMermaidRegex);
      });
    }
  });

  it('ensures active documents do not present retired or invented architecture terms as current implementation', () => {
    const forbiddenPatterns = [
      { pattern: /visit_logs/i, label: 'visit_logs (should be visit_events)' },
      { pattern: /audit_logs/i, label: 'audit_logs (should be audit_events)' },
      { pattern: /gate_passes/i, label: 'gate_passes (should be passes)' },
      { pattern: /visitor-evidence/i, label: 'visitor-evidence bucket (should be visitor-photos / visitor-ids)' },
      { pattern: /visitor-id-documents/i, label: 'visitor-id-documents (should be visitor-ids)' },
      { pattern: /\/api\/passes\/scan/i, label: '/api/passes/scan (should be /api/scan-pass)' },
      { pattern: /\/api\/passes\/decide/i, label: '/api/passes/decide (should be /api/decide-visit)' },
      { pattern: /\/api\/guard\/pending/i, label: '/api/guard/pending (should be api.guard_dashboard RPC)' },
      { pattern: /\/api\/cron\/retention-maintenance/i, label: '/api/cron/retention-maintenance (should be /api/admin/retention-maintenance)' },
      { pattern: /\/api\/passes\/email\/request-code/i, label: '/api/passes/email/request-code (should be /api/passes/email with action request_code)' },
      { pattern: /\/api\/passes\/email\/verify-and-send/i, label: '/api/passes/email/verify-and-send (should be /api/passes/email with action verify_and_send)' },
      { pattern: /TURNSTILE_SECRET_KEY/i, label: 'TURNSTILE_SECRET_KEY in Vercel (Supabase Bot Protection handles Turnstile secret)' },
      { pattern: /\bpending_review\b/i, label: 'pending_review status (database pass status is pending)' },
      { pattern: /PostgreSQL 15/i, label: 'PostgreSQL 15 (should be Supabase PostgreSQL / 17.x)' },
      { pattern: /permanently logged and audited/i, label: 'permanently logged and audited (retention policy governs audit logs)' },
    ];

    for (const filePath of activeDocFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const { pattern, label } of forbiddenPatterns) {
        expect(content, 'Forbidden term found in ' + filePath + ': ' + label).not.toMatch(pattern);
      }
    }
  });

  it('ensures core architecture claims agree with production configuration', () => {
    const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    expect(vercelConfig.crons).toBeDefined();
    expect(vercelConfig.crons.some((c: any) => c.path === '/api/admin/retention-maintenance')).toBe(true);

    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readme).toContain('Asia/Manila');
    expect(readme).toContain('Supabase');
    expect(readme).toContain('Vercel');
    expect(readme).toContain('Resend');
    expect(readme).toContain('Turnstile');
  });

  it('ensures webhook schema documentation in docs/ARCHITECTURE.md reflects real live UUID PK schema', () => {
    const arch = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(arch).toContain('resend_webhook_events');
    expect(arch).toContain('uuid id PK');
    expect(arch).toContain('text provider_event_id UK');
    expect(arch).toContain('event_type text');
    expect(arch).toContain('email_id text');
    expect(arch).toContain('created_at timestamptz');
    expect(arch).not.toMatch(/resend_webhook_events\s*\{\s*bigint id PK/);
  });

  it('ensures authoritative DNS is documented as get.tech / Orderbox with Cloudflare as Turnstile-only', () => {
    const deployment = fs.readFileSync('docs/DEPLOYMENT.md', 'utf8');
    const handoff = fs.readFileSync('docs/CLEAN_DATA_HANDOFF.md', 'utf8');
    const readme = fs.readFileSync('README.md', 'utf8');
    
    expect(deployment).toContain('get.tech');
    expect(deployment).toContain('Orderbox');
    expect(deployment).toContain('Turnstile');
    expect(handoff).toContain('get.tech');
    expect(handoff).toContain('Orderbox');
    expect(readme).toContain('get.tech / Orderbox');

    // Forbidden: Cloudflare managing authoritative DNS
    expect(handoff).not.toContain('Ensure Cloudflare DNS records');
    expect(deployment).not.toContain('Cloudflare managing authoritative DNS');
  });

  it('ensures no unproven exact Node.js patch version claims exist in docs/ENVIRONMENT.md', () => {
    const envDoc = fs.readFileSync('docs/ENVIRONMENT.md', 'utf8');
    expect(envDoc).not.toContain('24.22.1');
    expect(envDoc).toContain('Production runtime policy: Node.js 24.x.');
  });

  it('ensures Supabase publishable browser key uses modern sb_publishable_ format without requiring legacy eyJ format', () => {
    const envDoc = fs.readFileSync('docs/ENVIRONMENT.md', 'utf8');
    const deployDoc = fs.readFileSync('docs/DEPLOYMENT.md', 'utf8');
    const secDoc = fs.readFileSync('docs/SECURITY.md', 'utf8');

    expect(envDoc).not.toContain('eyJhbGciOiJIUzI1Ni');
    expect(envDoc).toContain('sb_publishable_');
    expect(deployDoc).toContain('sb_publishable_');
    expect(secDoc).toContain('sb_publishable_');
  });

  it('ensures optional hardening labels use clean em-dash without malformed question mark encoding drift', () => {
    for (const filePath of activeDocFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content, 'Malformed optional hardening typo in ' + filePath).not.toMatch(/OPTIONAL HARDENING\s*\?/i);
    }
  });

  it('ensures transactional webhook RPC status is truthfully qualified and does not claim premature live verification', () => {
    const deployment = fs.readFileSync('docs/DEPLOYMENT.md', 'utf8');
    const ops = fs.readFileSync('docs/OPERATIONS.md', 'utf8');

    expect(deployment).toContain('Awaiting first legitimate post-deployment provider event');
    expect(ops).toContain('Awaiting first legitimate post-deployment provider event');
    expect(deployment).not.toContain('transactional idempotency fully live-verified');
  });

  it('ensures documentation states canonical route counts matching route-map matrix', () => {
    const arch = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(arch).toContain('All 27 endpoints');
    expect(arch).toContain('Auth Router (4 routes');
    expect(arch).not.toContain('Auth Router (3 routes');
  });
});
