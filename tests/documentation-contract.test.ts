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
    const mojibakeRegex = /(\uFFFD|â€™|â€œ|â€|â€“|â€”|Â)/;
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
});
