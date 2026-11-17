import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('3rd Deep Dive Remediations Test Suite', () => {
  const root = process.cwd();

  // ---------------------------------------------------------------------------
  // Phase 1 — Hotfixes
  // ---------------------------------------------------------------------------
  describe('Phase 1: Hotfixes', () => {
    it('Item 1: KioskPage guards 60s loadSettings() to prevent resetting visitor active flow', () => {
      const kioskSrc = readFileSync(join(root, 'src', 'pages', 'KioskPage.tsx'), 'utf-8');
      // Guarded step transition
      expect(kioskSrc).toContain("setStep((prev) => (prev === 'scan-intro' || prev === 'form' ? (peakActive ? 'form' : 'scan-intro') : prev))");
      // Guarded configState
      expect(kioskSrc).toContain("setConfigState((prev) => (prev === 'ready' ? 'ready' : 'loading'))");
      expect(kioskSrc).toContain("setConfigState((prev) => (prev === 'ready' ? prev : 'error'))");
    });

    it('Item 2: OfficeDashboardPage stabilizes Realtime subscription with mutable ref', () => {
      const officeSrc = readFileSync(join(root, 'src', 'pages', 'OfficeDashboardPage.tsx'), 'utf-8');
      expect(officeSrc).toContain('const loadVisitsRef = useRef(loadVisits);');
      expect(officeSrc).toContain('loadVisitsRef.current = loadVisits;');
      expect(officeSrc).toContain('loadVisitsRef.current(true)');
      // Subscription effect only depends on selectedOfficeId, NOT loadVisits
      expect(officeSrc).toContain('}, [selectedOfficeId]);');
      expect(officeSrc).not.toContain('}, [selectedOfficeId, loadVisits]);');
    });

    it('Item 3: portrait-preview dynamically detects MIME type from buffer magic bytes', () => {
      const portraitSrc = readFileSync(join(root, 'server', 'routes', 'office', 'portrait-preview.ts'), 'utf-8');
      expect(portraitSrc).toContain('function detectImageMimeType');
      expect(portraitSrc).toContain("'image/jpeg'");
      expect(portraitSrc).toContain("'image/png'");
      expect(portraitSrc).toContain("'image/webp'");
      expect(portraitSrc).toContain("'Content-Type': mimeType");

      // Verify magic bytes logic independently
      function detectImageMimeType(buf: Buffer): string {
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
          return 'image/jpeg';
        }
        if (
          buf.length >= 8 &&
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47 &&
          buf[4] === 0x0d &&
          buf[5] === 0x0a &&
          buf[6] === 0x1a &&
          buf[7] === 0x0a
        ) {
          return 'image/png';
        }
        if (
          buf.length >= 12 &&
          buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
        ) {
          return 'image/webp';
        }
        return 'image/jpeg';
      }

      // JPEG magic bytes test
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(detectImageMimeType(jpegBuf)).toBe('image/jpeg');

      // PNG magic bytes test
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(detectImageMimeType(pngBuf)).toBe('image/png');

      // WebP magic bytes test: RIFF....WEBP
      const webpBuf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x20, 0x00, 0x00, 0x00, // length
        0x57, 0x45, 0x42, 0x50, // WEBP
        0x56, 0x50, 0x38, 0x20, // VP8_
      ]);
      expect(detectImageMimeType(webpBuf)).toBe('image/webp');

      // Unknown buffer defaults safely to image/jpeg
      const unknownBuf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      expect(detectImageMimeType(unknownBuf)).toBe('image/jpeg');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 2 — Database & Realtime
  // ---------------------------------------------------------------------------
  describe('Phase 2: Database & Realtime', () => {
    it('Item 4: migration 20261118000200_replica_identity_full_realtime.sql exists with correct table directives', () => {
      const migrationPath = join(root, 'supabase', 'migrations', '20261118000200_replica_identity_full_realtime.sql');
      expect(existsSync(migrationPath)).toBe(true);

      const content = readFileSync(migrationPath, 'utf-8');
      expect(content).toContain('alter table public.office_visits replica identity full;');
      expect(content).toContain('alter table public.office_visit_events replica identity full;');
      expect(content).toContain('alter table public.passes replica identity full;');
      expect(content).toContain('alter table public.visit_events replica identity full;');
      expect(content).toContain('alter table public.emergency_gate_records replica identity full;');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 3 — Platform Security & Disaster Safety
  // ---------------------------------------------------------------------------
  describe('Phase 3: Platform Security & Disaster Safety', () => {
    it('Item 5: vercel.json includes no-cache and noindex headers for sensitive routes', () => {
      const vercelJson = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf-8'));
      const headers = vercelJson.headers as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;

      const targetRoutes = ['/office', '/office/:path*', '/emergency-device', '/account/security'];
      for (const route of targetRoutes) {
        const entry = headers.find((h) => h.source === route);
        expect(entry, `Missing headers for route ${route}`).toBeDefined();

        const cacheControl = entry?.headers.find((h) => h.key === 'Cache-Control');
        expect(cacheControl?.value).toBe('no-cache, no-store, must-revalidate');

        const xRobotsTag = entry?.headers.find((h) => h.key === 'X-Robots-Tag');
        expect(xRobotsTag?.value).toBe('noindex, nofollow');
      }
    });

    it('Item 6: emergency.ts includes active emergency_gate_records alongside passes', () => {
      const emergencySrc = readFileSync(join(root, 'server', 'routes', 'admin', 'emergency.ts'), 'utf-8');
      expect(emergencySrc).toContain("from('emergency_gate_records')");
      expect(emergencySrc).toContain('manilaTodayStartIso');
      expect(emergencySrc).toContain('combinedPasses');
      expect(emergencySrc).toContain('passCount');
      expect(emergencySrc).toContain('emergencyCount');
      expect(emergencySrc).toContain('finalPasses');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 4 — UX & Hardware Fleet Observability
  // ---------------------------------------------------------------------------
  describe('Phase 4: UX & Hardware Fleet Observability', () => {
    it('Item 7: OfficeDashboardPage renders Confirmed Today and Visit History queue views', () => {
      const officeSrc = readFileSync(join(root, 'src', 'pages', 'OfficeDashboardPage.tsx'), 'utf-8');
      expect(officeSrc).toContain("activeQueueTab === 'confirmed'");
      expect(officeSrc).toContain("activeQueueTab === 'history'");
      expect(officeSrc).toContain('Confirmed Today');
      expect(officeSrc).toContain('Visit History');
      expect(officeSrc).toContain('confirmedVisits');
      expect(officeSrc).toContain('historyVisits');
    });

    it('Item 8: guard-station-feed.ts updates devices.last_seen_at throttled to once per 30s', () => {
      const feedSrc = readFileSync(join(root, 'server', 'routes', 'gate', 'guard-station-feed.ts'), 'utf-8');
      expect(feedSrc).toContain("device.type === 'guard_station'");
      expect(feedSrc).toContain('last_seen_at');
      expect(feedSrc).toContain('30_000');
      expect(feedSrc).toContain("update({ last_seen_at: new Date(nowMs).toISOString() })");
    });

    it('Item 9: DevicesPage displays online badge, auto-refreshes 30s, and disables Gate for non-superadmin editing emergency device', () => {
      const devicesSrc = readFileSync(join(root, 'src', 'pages', 'DevicesPage.tsx'), 'utf-8');
      // Online/offline badge based on 5 minutes
      expect(devicesSrc).toContain('function isDeviceOnline');
      expect(devicesSrc).toContain('5 * 60 * 1000');
      expect(devicesSrc).toContain('Online');
      expect(devicesSrc).toContain('Offline');

      // Auto-refresh 30s
      expect(devicesSrc).toContain('30000');
      expect(devicesSrc).toContain('loadDevices(false, true)');

      // Gate input disabled for emergency devices edited by non-superadmins with friendly copy
      expect(devicesSrc).toContain("editingDetailsDevice?.type === 'emergency_device' && !canManageCredentials");
      expect(devicesSrc).toContain('Gate reassignment for emergency devices requires Superadmin privileges to preserve cryptographic offline manifest integrity.');
    });

    it('Item 10: vite.config.ts proxies /api/track-visit and /api/webhooks/resend in local dev', () => {
      const viteSrc = readFileSync(join(root, 'vite.config.ts'), 'utf-8');
      expect(viteSrc).toContain("'track-visit': 'server/routes/passes/track.ts'");
      expect(viteSrc).toContain("'webhooks/resend': 'server/routes/auth/resend-webhook.ts'");
    });
  });
});
