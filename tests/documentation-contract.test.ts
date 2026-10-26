import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GlobalWindow } from 'happy-dom';

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

  it('ensures no active documents use single-backtick mermaid fences', () => {
    const singleBacktickMermaidRegex = /^`mermaid\s*$/;
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
      { pattern: /api.promote_to_superadmin/i, label: 'api.promote_to_superadmin (promotions use POST /api/update-user calling api.update_staff_profile)' },
      { pattern: /\bsystem_settings\b/i, label: 'system_settings table (should be public.app_settings)' },
      { pattern: /Active Super Admin already exists\. Bootstrap procedure locked\./i, label: 'stale bootstrap lock claim (lock occurs when ANY row exists in public.staff_profiles)' },
      { pattern: /Success: User .* bootstrapped as Super Admin\./i, label: 'fabricated bootstrap return output (function returns void)' },
      { pattern: /Auto-Invoke Thermal Print Receipt/i, label: 'Auto-Invoke Thermal Print Receipt (kiosk printing uses manual Print Pass control)' },
      { pattern: /The repository does NOT currently configure an automatic schedule in vercel\.json/i, label: 'stale cron unconfigured claim (vercel.json configures daily retention maintenance)' },
      { pattern: /opens automatically with thermal receipt layout/i, label: 'automatic thermal print dialog opening (kiosk printing is user-invoked via Print Pass)' },
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

    expect(deployment).toContain('production-verified with signed delivery events');
    expect(ops).toContain('production-verified with signed delivery events');
    expect(deployment).toContain('email.sent');
    expect(deployment).toContain('email.delivered');
    expect(deployment).not.toContain('Awaiting first legitimate post-deployment provider event');
    expect(ops).not.toContain('Awaiting first legitimate post-deployment provider event');
  });

  it('ensures documentation states canonical route counts matching route-map matrix', () => {
    const arch = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
    expect(arch).toContain('All 27 endpoints');
    expect(arch).toContain('Auth Router (4 routes');
    expect(arch).not.toContain('Auth Router (3 routes');
  });

  it('ensures docs/SUPER_ADMIN_BOOTSTRAP.md truthfully documents bootstrap invariants, verified SQL, and decommissioning', () => {
    const bootstrapDoc = fs.readFileSync('docs/SUPER_ADMIN_BOOTSTRAP.md', 'utf8');

    // Invariant truths
    expect(bootstrapDoc).toContain('bootstrap is allowed only before the first staff profile');
    expect(bootstrapDoc).toMatch(/confirmed human/i);
    expect(bootstrapDoc).toContain('email_confirmed_at IS NOT NULL');
    expect(bootstrapDoc).toContain('@devices.egatepass.invalid');
    expect(bootstrapDoc).toContain('superadmin.bootstrap');

    // Verification SQL truths
    expect(bootstrapDoc).toContain('SELECT');
    expect(bootstrapDoc).toContain('user_id');
    expect(bootstrapDoc).toContain('display_name');
    expect(bootstrapDoc).toContain('role');
    expect(bootstrapDoc).toContain('active');
    expect(bootstrapDoc).toContain('must_change_password');
    expect(bootstrapDoc).toContain('public.staff_profiles');

    // Decommissioning truth
    expect(bootstrapDoc).toContain('ON DELETE RESTRICT');
    expect(bootstrapDoc).toContain('POST /api/update-user');
    expect(bootstrapDoc).not.toContain('Success: User');
  });

  it('ensures docs/SECURITY.md truthfully documents staff eligibility, promotion path, and bootstrap lock', () => {
    const secDoc = fs.readFileSync('docs/SECURITY.md', 'utf8');

    // Promotion path
    expect(secDoc).toContain('POST /api/update-user');
    expect(secDoc).toContain('api.update_staff_profile');
    expect(secDoc).not.toContain('api.promote_to_superadmin');

    // Full staff eligibility
    expect(secDoc).toContain('email_confirmed_at IS NOT NULL');
    expect(secDoc).toContain('must_change_password = false');
    expect(secDoc).toContain('privacy_accepted_at IS NOT NULL');

    // Bootstrap lock
    expect(secDoc).toMatch(/bootstrap is allowed only before the FIRST staff profile exists/i);

    // Last Super Admin protection layers
    expect(secDoc).toContain('private.protect_last_superadmin');
    expect(secDoc).toContain('cannot_remove_last_superadmin');
  });

  it('ensures docs/MANUAL_QA_RUNBOOK.md reflects public.app_settings, friendly last-superadmin handling, and isolated bootstrap QA', () => {
    const qaDoc = fs.readFileSync('docs/MANUAL_QA_RUNBOOK.md', 'utf8');

    expect(qaDoc).toContain('public.app_settings');
    expect(qaDoc).not.toContain('system_settings');

    // Last Super Admin API and UI layers
    expect(qaDoc).toContain('cannot_remove_last_superadmin');
    expect(qaDoc).toContain('Cannot demote or deactivate the last remaining Super Admin.');

    // Isolated database warning and scenarios
    expect(qaDoc).toContain('Never test destructive or one-time bootstrap failure scenarios against an established production database');
    expect(qaDoc).toContain('superadmin.bootstrap');
  });

  it('ensures vercel.json cron schedule is truthfully documented as active in docs/ENVIRONMENT_AND_CRON.md', () => {
    const cronDoc = fs.readFileSync('docs/ENVIRONMENT_AND_CRON.md', 'utf8');
    const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

    // Assert vercel.json configuration
    const retentionCron = vercelConfig.crons.find((c: any) => c.path === '/api/admin/retention-maintenance');
    expect(retentionCron).toBeDefined();
    expect(retentionCron.schedule).toBe('0 18 * * *');

    // Assert docs reflect active configuration
    expect(cronDoc).toContain('0 18 * * *');
    expect(cronDoc).toMatch(/18:00 UTC/i);
    expect(cronDoc).toMatch(/02:00 AM Asia\/Manila/i);
    expect(cronDoc).toMatch(/configured and active/i);
    expect(cronDoc).not.toContain('does NOT currently configure an automatic schedule in vercel.json');
  });

  it('ensures kiosk printing reflects current manual browser print behavior and thermal integration is marked planned', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const kioskHardware = fs.readFileSync('docs/KIOSK_HARDWARE.md', 'utf8');
    const qaDoc = fs.readFileSync('docs/MANUAL_QA_RUNBOOK.md', 'utf8');
    const kioskSource = fs.readFileSync('src/pages/KioskPage.tsx', 'utf8');

    // Verify source code reality
    expect(kioskSource).toContain('window.print()');
    expect(kioskSource).toContain('Print Pass');

    // Verify documentation truthfulness
    expect(readme).toContain('Invoke Browser Print Flow via Print Pass');
    expect(readme).toContain('Thermal printer device integration is a planned hardware enhancement');
    expect(kioskHardware).toContain('Print Pass');
    expect(kioskHardware).toContain('window.print()');
    expect(kioskHardware).toContain('NOT YET IMPLEMENTED');
    expect(qaDoc).toContain('Print Pass');
    expect(qaDoc).not.toContain('Auto-Invoke Thermal Print');
    expect(qaDoc).not.toContain('opens automatically with thermal receipt layout');
  });

  it('ensures docs/INSTITUTIONAL_DEPLOYMENT.md truthfully documents deep Supabase coupling and non-trivial migration reality', () => {
    const instDoc = fs.readFileSync('docs/INSTITUTIONAL_DEPLOYMENT.md', 'utf8');

    expect(instDoc).toContain('THIS IS NOT A HOSTING-ONLY MIGRATION');
    expect(instDoc).toContain('@supabase/supabase-js');
    expect(instDoc).toContain('Supabase Auth');
    expect(instDoc).toContain('Supabase Storage');
    expect(instDoc).toContain("schema('api').rpc");
    expect(instDoc).toContain('FOLLOW-UP ENGINEERING REQUIRED');

    // Prohibits claiming plain PostgreSQL replaces Supabase without engineering changes
    expect(instDoc).not.toMatch(/plain postgresql can replace supabase without (code|engineering) changes/i);
  });

  it('ensures docs/BACKUP_AND_RECOVERY.md distinguishes database dumps from private storage objects', () => {
    const backupDoc = fs.readFileSync('docs/BACKUP_AND_RECOVERY.md', 'utf8');

    // Assert 4 asset classes are distinguished
    expect(backupDoc).toContain('PostgreSQL Relational Database');
    expect(backupDoc).toContain('Private Object Storage Buckets');
    expect(backupDoc).toContain('Identity & Authentication State');
    expect(backupDoc).toContain('External Provider Configurations');

    // Invariant: DB dump does not include binary storage files
    expect(backupDoc).toMatch(/Database dumps contain ONLY metadata records for visitor evidence/i);
    expect(backupDoc).toContain('visitor-photos');
    expect(backupDoc).toContain('visitor-ids');
    expect(backupDoc).toContain('public = false');
    expect(backupDoc).toContain('INSTITUTIONAL POLICY REQUIRED');
  });

  it('ensures documentation truthfully states no dedicated /api/health endpoint currently exists', () => {
    const instDoc = fs.readFileSync('docs/INSTITUTIONAL_DEPLOYMENT.md', 'utf8');
    
    expect(instDoc).toContain('No dedicated production health check endpoint');
    expect(instDoc).toContain('/api/health');
    expect(instDoc).toContain('FOLLOW-UP ENGINEERING REQUIRED');

    // Confirm no /api/health source file was accidentally created
    expect(fs.existsSync('api/health.ts')).toBe(false);
    expect(fs.existsSync('server/routes/health.ts')).toBe(false);
  });

  it('ensures APP_BASE_URL is documented as the canonical origin for email branding in ENVIRONMENT.md and DEPLOYMENT.md', () => {
    const envDoc = fs.readFileSync('docs/ENVIRONMENT.md', 'utf8');
    const deployDoc = fs.readFileSync('docs/DEPLOYMENT.md', 'utf8');
    const instDoc = fs.readFileSync('docs/INSTITUTIONAL_DEPLOYMENT.md', 'utf8');
    const envExample = fs.readFileSync('.env.example', 'utf8');

    expect(envDoc).toContain('`APP_BASE_URL`');
    expect(deployDoc).toContain('`APP_BASE_URL`');
    expect(instDoc).toContain('APP_BASE_URL');
    expect(envExample).toMatch(/^APP_BASE_URL=/m);
  });

  it('ensures reverse proxy security header and client-IP trust requirements are documented for non-Vercel deployments', () => {
    const instDoc = fs.readFileSync('docs/INSTITUTIONAL_DEPLOYMENT.md', 'utf8');

    // Headers do not carry over automatically
    expect(instDoc).toMatch(/Vercel security headers do NOT automatically transfer/i);
    expect(instDoc).toContain('Content-Security-Policy');
    expect(instDoc).toContain('Strict-Transport-Security');
    expect(instDoc).toContain('X-Content-Type-Options');
    expect(instDoc).toContain('X-Frame-Options');
    expect(instDoc).not.toContain("'unsafe-eval'");

    // Client-IP spoofing protection on reverse proxy
    expect(instDoc).toMatch(/client-supplied forwarding headers MUST NOT be trusted directly/i);
    expect(instDoc).toContain('X-Forwarded-For');
    expect(instDoc).toContain('FOLLOW-UP ENGINEERING/DEPLOYMENT VALIDATION REQUIRED');
  });

  it('ensures docs/MANUAL_QA_RUNBOOK.md reflects authoritative 5 MB evidence limit and contains no 10MB claims', () => {
    const qaDoc = fs.readFileSync('docs/MANUAL_QA_RUNBOOK.md', 'utf8');
    expect(qaDoc).not.toContain('10MB');
    expect(qaDoc).not.toContain('10 MB');
    expect(qaDoc).toContain('5 MB');
    expect(qaDoc).toContain('compressed to WebP');
  });
});

describe('Mermaid Rendering & Documentation Truthfulness Contract', () => {
  interface MermaidBlock {
    filePath: string;
    blockIndex: number;
    startLine: number;
    code: string;
  }

  function findMarkdownFiles(dir: string, excludeDirs: string[] = []): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = fullPath.replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!excludeDirs.some((ex) => relPath.includes(ex))) {
          results = results.concat(findMarkdownFiles(fullPath, excludeDirs));
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relPath);
      }
    }
    return results.sort();
  }

  const activeFiles = [
    'README.md',
    ...findMarkdownFiles('docs', ['docs/archive']),
    ...findMarkdownFiles('supabase'),
  ].sort();

  const archiveFiles = findMarkdownFiles('docs/archive');

  function getMermaidBlocks(filePath: string): MermaidBlock[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const blocks: MermaidBlock[] = [];
    const lines = content.split(/\r?\n/);
    let inMermaid = false;
    let currentCode: string[] = [];
    let blockStartLine = 0;
    let blockIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inMermaid && line.trim() === '```mermaid') {
        inMermaid = true;
        currentCode = [];
        blockStartLine = i + 1;
        blockIndex++;
      } else if (inMermaid && line.trim() === '```') {
        inMermaid = false;
        blocks.push({
          filePath,
          blockIndex,
          startLine: blockStartLine,
          code: currentCode.join('\n'),
        });
      } else if (inMermaid) {
        currentCode.push(line);
      }
    }
    return blocks;
  }

  const allActiveBlocks: MermaidBlock[] = activeFiles.flatMap(getMermaidBlocks);
  const allArchiveBlocks: MermaidBlock[] = archiveFiles.flatMap(getMermaidBlocks);
  const filesWithMermaid = activeFiles.filter((file) => getMermaidBlocks(file).length > 0);

  let mermaid: any;

  beforeAll(async () => {
    if (typeof globalThis.window === 'undefined') {
      const window = new GlobalWindow();
      globalThis.window = window as unknown as Window & typeof globalThis;
      globalThis.document = window.document as unknown as Document;
    }
    const mermaidModule = await import('mermaid');
    mermaid = mermaidModule.default || mermaidModule;
    mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true });
  });

  it('verifies exact inventory of active markdown files, files containing mermaid, and active mermaid blocks', () => {
    expect(activeFiles.length, 'Expected exactly 19 active Markdown files').toBe(19);
    expect(archiveFiles.length, 'Expected exactly 12 archive Markdown files').toBe(12);
    expect(filesWithMermaid.length, 'Expected exactly 15 active Markdown files with Mermaid').toBe(15);
    expect(allActiveBlocks.length, 'Expected exactly 50 active Mermaid blocks').toBe(50);
    expect(allArchiveBlocks.length, 'Expected 0 archive Mermaid blocks').toBe(0);
  });

  it('parses and validates every active Mermaid block with the real Mermaid compiler', async () => {
    expect(allActiveBlocks.length).toBe(50);

    for (const block of allActiveBlocks) {
      try {
        const result = await mermaid.parse(block.code);
        expect(result, `Mermaid block failed validation: ${block.filePath} block #${block.blockIndex}`).toBeTruthy();
      } catch (err: any) {
        const diagnostic = [
          'Mermaid parse failed:',
          `  File: ${block.filePath}`,
          `  Block: #${block.blockIndex}`,
          `  Line: around line ${block.startLine}`,
          `  Error: ${err?.message || String(err)}`,
        ].join('\n');
        throw new Error(diagnostic);
      }
    }
  });

  it('enforces static guard against malformed joined node declarations with raw HTML tags', () => {
    // Guards against patterns like OCR[...]<br/> ID[...] where a raw break tag joins two declarations outside quotes
    const joinedTagRegex = /\]\s*<br\s*\/?>\s*[A-Za-z0-9_]+\[/i;

    for (const block of allActiveBlocks) {
      const lines = block.code.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const match = line.match(joinedTagRegex);
        expect(
          match,
          `Malformed joined node declaration with raw HTML break at ${block.filePath}:${block.startLine + idx + 1}: "${line}"`
        ).toBeNull();
      });
    }
  });

  it('enforces static guard against pseudo-HTML angle-bracket placeholders inside Mermaid blocks', () => {
    // Inside Mermaid, angle-bracket placeholders like <uuid>, <evidence_id>, etc. cause renderer ambiguity.
    // They must use neutral braces like {uuid}, {evidence_id}, {staff_jwt}, {device_jwt}.
    const forbiddenPlaceholders = [
      /<uuid>/i,
      /<evidence_id>/i,
      /<evidence_uuid>/i,
      /<staff_jwt>/i,
      /<device_jwt>/i,
    ];

    const generalPlaceholderRegex = /<[a-z0-9_]{3,}>/i;

    for (const block of allActiveBlocks) {
      const lines = block.code.split(/\r?\n/);
      lines.forEach((line, idx) => {
        // Strip legitimate HTML tags like <br> or <br/> from consideration
        const lineWithoutHtml = line.replace(/<br\s*\/?>/gi, '');

        for (const pattern of forbiddenPlaceholders) {
          expect(
            line,
            `Forbidden pseudo-HTML placeholder found in Mermaid at ${block.filePath}:${block.startLine + idx + 1}: "${line}"`
          ).not.toMatch(pattern);
        }

        expect(
          lineWithoutHtml,
          `Pseudo-HTML angle-bracket placeholder found in Mermaid at ${block.filePath}:${block.startLine + idx + 1}: "${line}"`
        ).not.toMatch(generalPlaceholderRegex);
      });
    }
  });

  it('enforces static guard for Mermaid fence integrity across all active Markdown files', () => {
    for (const filePath of activeFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      let inFence = false;
      let openLine = 0;

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '```mermaid') {
          expect(
            inFence,
            `Nested Mermaid fence detected at ${filePath}:${index + 1} (opened at line ${openLine})`
          ).toBe(false);
          inFence = true;
          openLine = index + 1;
        } else if (trimmed === '```' && inFence) {
          inFence = false;
        }
      });

      expect(inFence, `Unterminated Mermaid fence in ${filePath} opened at line ${openLine}`).toBe(false);
    }
  });

  it('ensures README.md visitor registration flow connects the optional OCR node truthfully to the actual flow', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const visitorFlowMatch = readme.match(/### 3\.1 Visitor Registration Portal Flow[\s\S]*?```mermaid([\s\S]*?)```/);
    expect(visitorFlowMatch, 'Visitor Registration flow diagram must be present in README.md').not.toBeNull();
    const diagramCode = visitorFlowMatch![1];

    // Assert OCR node exists and is connected
    expect(diagramCode).toContain('OCR["Optional Browser OCR Autofill');
    expect(diagramCode).toContain('Details -.->|Optional Autofill| OCR');
    expect(diagramCode).toContain('OCR -.->|Prefill Names & Stage ID| Details');
    expect(diagramCode).not.toMatch(/OCR\[.*?\]\s*<br\s*\/?>/);
  });

  it('ensures README.md kiosk OCR flow truthfully documents extraction of visitor name fields only', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const kioskFlowMatch = readme.match(/### 3\.2 Walk-in Kiosk ID OCR Flow[\s\S]*?```mermaid([\s\S]*?)```/);
    expect(kioskFlowMatch, 'Kiosk OCR flow diagram must be present in README.md').not.toBeNull();
    const diagramCode = kioskFlowMatch![1];

    // Assert truthful extraction wording
    expect(diagramCode).toContain('Extract["Extract Visitor Name Fields"]');
    expect(diagramCode).toContain('Review["Visitor Reviews and Completes Remaining Information"]');

    // Reject false overclaims in diagram
    expect(diagramCode).not.toContain('Extract Name, ID Type, and ID Number');
  });
});

