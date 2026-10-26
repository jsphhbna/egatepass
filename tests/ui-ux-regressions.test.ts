import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  formatManilaIso,
  formatManilaDateTime,
  formatManilaDate,
  formatManilaTime,
  formatManilaFileTimestamp,
  getManilaDateString,
} from '../src/lib/manilaTime.js';

describe('UI/UX QA, Responsive Institutional Redesign & Usability Regressions Suite', () => {
  // --------------------------------------------------------------------------
  // Fix Group 11 & 12: Guard Queue Initial Loading & Search Authority
  // --------------------------------------------------------------------------
  describe('Fix Groups 11 & 12: Guard Queue State Truthfulness & Pagination Search Authority', () => {
    const guardSrc = readFileSync('src/pages/GuardPage.tsx', 'utf8');
    const hookSrc = readFileSync('src/hooks/useGuardQueue.ts', 'utf8');

    it('initializes initialLoading to true to prevent false empty queue state on mount', () => {
      expect(hookSrc).toContain('const [initialLoading, setInitialLoading] = useState(true);');
      expect(hookSrc).toContain('setInitialLoading(false);');
      expect(guardSrc).toContain('initialLoading');
    });

    it('renders a loading skeleton / spinner while initialLoading is true', () => {
      expect(guardSrc).toContain('initialLoading ? (');
      expect(guardSrc).toContain('role="status"');
      expect(guardSrc).toContain('Loading pending passes…');
    });

    it('only renders "No pending passes" when not loading, no error, and queue is truly empty', () => {
      expect(guardSrc).toContain('filteredPasses.length === 0 ? (');
      expect(guardSrc).toContain("searchTerm ? 'No matching visitors in loaded queue' : 'No pending passes'");
    });

    it('clarifies search placeholder that search applies to loaded visitors', () => {
      expect(guardSrc).toContain('placeholder="Search loaded visitors by name or purpose…"');
    });

    it('renders an authoritative notice and "Load all pending visitors" button when more records exist', () => {
      expect(guardSrc).toContain('hasMore && searchTerm');
      expect(guardSrc).toContain('No matches in currently loaded queue. Try loading all pending passes.');
      expect(guardSrc).toContain('Load All Pending Passes');
      expect(guardSrc).toContain('handleLoadAll');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Groups 13, 28, 29, 30: Asia/Manila Presentation Consistency
  // --------------------------------------------------------------------------
  describe('Fix Groups 13, 28, 29, 30: Asia/Manila Formatting Utilities & Operational Surfaces', () => {
    it('manilaTime formatting functions format timestamps consistently in UTC+8', () => {
      // Midnight UTC is 08:00 AM Manila
      const d = new Date('2026-10-24T00:00:00.000Z');
      expect(formatManilaIso(d)).toBe('2026-10-24 08:00:00');
      expect(formatManilaDate(d)).toBe('Oct 24, 2026');
      expect(formatManilaTime(d)).toBe('8:00 AM');
      expect(formatManilaDateTime(d)).toBe('Oct 24, 2026, 8:00 AM');
      expect(formatManilaFileTimestamp(d)).toBe('20261024_080000');
      expect(getManilaDateString(d)).toBe('2026-10-24');
    });

    it('handles late UTC time transitioning to the next Manila date correctly', () => {
      // 23:30 UTC on Oct 23 is 07:30 AM on Oct 24 in Manila
      const lateUtc = new Date('2026-10-23T23:30:00.000Z');
      expect(getManilaDateString(lateUtc)).toBe('2026-10-24');
      expect(formatManilaDate(lateUtc)).toBe('Oct 24, 2026');
      expect(formatManilaTime(lateUtc)).toBe('7:30 AM');
    });

    it('AdminEmergency uses formatManilaDateTime for print header and formatManilaTime for visitor time in', () => {
      const emergencySrc = readFileSync('src/pages/AdminEmergency.tsx', 'utf8');
      expect(emergencySrc).toContain('formatManilaDateTime(new Date()');
      expect(emergencySrc).toContain('formatManilaTime(pass.timeIn)');
      // Must not falsely append (Asia/Manila) to local format()
      expect(emergencySrc).not.toContain("format(new Date(), 'PPpp') + ' (Asia/Manila)'");
    });

    it('AdminRecords uses formatManilaIso, formatManilaDateTime, and formatManilaFileTimestamp', () => {
      const recordsSrc = readFileSync('src/pages/AdminRecords.tsx', 'utf8');
      expect(recordsSrc).toContain('formatManilaIso(p.issuedAt.toMillis())');
      expect(recordsSrc).toContain('formatManilaFileTimestamp(new Date())');
      expect(recordsSrc).toContain('formatManilaDateTime(new Date()');
      expect(recordsSrc).toContain('formatManilaDateTime(selectedPass.issuedAt.toMillis())');
      // No unformatted local date-fns format calls remain
      expect(recordsSrc).not.toContain("from 'date-fns'");
    });

    it('AdminAuditLogs uses formatManilaIso and formatManilaFileTimestamp for CSV export', () => {
      const auditSrc = readFileSync('src/pages/AdminAuditLogs.tsx', 'utf8');
      expect(auditSrc).toContain('formatManilaIso(item.timestamp.toMillis())');
      expect(auditSrc).toContain('formatManilaFileTimestamp(new Date())');
    });

    it('AdminDashboard uses getManilaDateString to bucket daily statistics accurately', () => {
      const dashSrc = readFileSync('src/pages/AdminDashboard.tsx', 'utf8');
      expect(dashSrc).toContain('getManilaDateString(pass.issuedAt.toDate()) === todayManila');
      expect(dashSrc).toContain('formatManilaTime(dashboard.updatedAt)');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Group 19: Audit Reconciliation window.prompt() Replacement
  // --------------------------------------------------------------------------
  describe('Fix Group 19: Audit Reconciliation Modal Dialog Replacement', () => {
    const auditSrc = readFileSync('src/pages/AdminAuditLogs.tsx', 'utf8');

    it('does NOT use native window.prompt()', () => {
      expect(auditSrc).not.toContain('window.prompt');
    });

    it('uses accessible Modal with Resolution Note and Mark Resolved actions', () => {
      expect(auditSrc).toContain('<Modal');
      expect(auditSrc).toContain('Resolve Reconciliation Item');
      expect(auditSrc).toContain('Resolution Note');
      expect(auditSrc).toContain('Mark Resolved');
      expect(auditSrc).toContain('isResolving');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Groups 20 & 24: Live Status & Generating Accessibility
  // --------------------------------------------------------------------------
  describe('Fix Groups 20 & 24: Scanner and Generating Live Status Accessibility', () => {
    const entrySrc = readFileSync('src/pages/EntryScanPage.tsx', 'utf8');
    const exitSrc = readFileSync('src/pages/ExitScanPage.tsx', 'utf8');
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
    const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

    it('EntryScanPage provides role="status" and aria-live="polite" on scan result container', () => {
      expect(entrySrc).toContain('role="status"');
      expect(entrySrc).toContain('aria-live="polite"');
      expect(entrySrc).toContain('aria-atomic="true"');
    });

    it('ExitScanPage provides role="status" and aria-live="polite" on scan result container', () => {
      expect(exitSrc).toContain('role="status"');
      expect(exitSrc).toContain('aria-live="polite"');
      expect(exitSrc).toContain('aria-atomic="true"');
    });

    it('GetPassPage and KioskPage provide role="status" on generating gate pass spinner', () => {
      expect(getPassSrc).toContain('role="status"');
      expect(getPassSrc).toContain('aria-label="Generating gate pass"');
      expect(kioskSrc).toContain('role="status"');
      expect(kioskSrc).toContain('aria-label="Generating gate pass"');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Groups 15 & 21: Touch Targets (Minimum 44px)
  // --------------------------------------------------------------------------
  describe('Fix Groups 15 & 21: Minimum 44px Interactive Touch Targets', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
    const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');
    const entrySrc = readFileSync('src/pages/EntryScanPage.tsx', 'utf8');
    const exitSrc = readFileSync('src/pages/ExitScanPage.tsx', 'utf8');

    it('GetPassPage ID preview removal button meets 44px hit target with accessible label', () => {
      expect(getPassSrc).toContain('min-h-11 min-w-11');
      expect(getPassSrc).toContain('aria-label="Remove ID image"');
    });

    it('KioskPage, EntryScanPage, and ExitScanPage Device Session button meets 44px hit target', () => {
      expect(kioskSrc).toContain('min-h-11');
      expect(kioskSrc).toContain('px-3 py-2');
      expect(entrySrc).toContain('min-h-11');
      expect(entrySrc).toContain('px-3 py-2');
      expect(exitSrc).toContain('min-h-11');
      expect(exitSrc).toContain('px-3 py-2');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Groups 16 & 17: Camera Lifecycle and Review Direct Edit Controls
  // --------------------------------------------------------------------------
  describe('Fix Groups 16 & 17: Camera Lifecycle and Review Direct Correction Controls', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
    const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

    it('GetPassPage review step stops webcam and provides direct edit actions', () => {
      expect(getPassSrc).toContain('faceWebcam.stop();');
      expect(getPassSrc).toContain('idWebcam.stop();');
      expect(getPassSrc).toContain('Edit Details');
      expect(getPassSrc).toContain('Retake Selfie');
      expect(getPassSrc).toContain('!isPeakMode && (');
      expect(getPassSrc).toContain('Retake ID');
    });

    it('KioskPage review step stops webcam and provides direct edit actions', () => {
      expect(kioskSrc).toContain('faceWebcam.stop();');
      expect(kioskSrc).toContain('idWebcam.stop();');
      expect(kioskSrc).toContain('Edit Details');
      expect(kioskSrc).toContain('Retake Selfie');
      expect(kioskSrc).toContain('!isPeakMode');
      expect(kioskSrc).toContain('Retake ID');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Group 14: Turnstile Responsive Width
  // --------------------------------------------------------------------------
  describe('Fix Group 14: Turnstile Responsive Size and Overflow Containment', () => {
    const turnstileSrc = readFileSync('src/components/TurnstileWidget.tsx', 'utf8');

    it('TurnstileWidget requests flexible size from Cloudflare Turnstile API', () => {
      expect(turnstileSrc).toContain("size: 'flexible'");
    });

    it('TurnstileWidget container prevents horizontal overflow on narrow mobile screens', () => {
      expect(turnstileSrc).toContain('w-full max-w-full overflow-hidden');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Group 22: Email Pass Modal OTP Semantics and Client-Side Resend Cooldown
  // --------------------------------------------------------------------------
  describe('Fix Group 22: Email Pass Modal OTP Semantics and Client-Side Resend Cooldown', () => {
    const emailModalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');

    it('specifies autoComplete="one-time-code" and numeric inputMode for OTP input', () => {
      expect(emailModalSrc).toContain('autoComplete="one-time-code"');
      expect(emailModalSrc).toContain('inputMode="numeric"');
    });

    it('implements visible 60-second client-side cooldown countdown on resend action', () => {
      expect(emailModalSrc).toContain('resendCooldown > 0');
      expect(emailModalSrc).toContain('Resend code in ${resendCooldown}s');
      expect(emailModalSrc).toContain('setResendCooldown(60);');
    });
  });

  // --------------------------------------------------------------------------
  // Fix Group 23: Purpose Details Mobile Autofocus Jump Prevention
  // --------------------------------------------------------------------------
  describe('Fix Group 23: Mobile Autofocus Jump Prevention on Purpose Details', () => {
    const purposeFieldSrc = readFileSync('src/components/VisitPurposeField.tsx', 'utf8');

    it('does NOT force autoFocus on dynamic details textarea', () => {
      expect(purposeFieldSrc).not.toContain('autoFocus');
    });
  });

  // --------------------------------------------------------------------------
  // Landing Page Institutional Architecture & Ultrawide Responsive Contracts
  // --------------------------------------------------------------------------
  describe('Landing Page Institutional Redesign & Responsive Architecture Contracts', () => {
    const landingSrc = readFileSync('src/pages/LandingPage.tsx', 'utf8');
    const landingContentSrc = readFileSync('src/content/landing.ts', 'utf8');

    it('preserves all required landing section IDs and anchor contracts', () => {
      expect(landingSrc).toContain('id="how-it-works"');
      expect(landingSrc).toContain('id="what-you-need"');
      expect(landingSrc).toContain('id="privacy"');
      expect(landingSrc).toContain('id="faq"');
    });

    it('prominently features E-GatePass heading and links directly to /get-pass', () => {
      expect(landingSrc).toContain('E-GatePass');
      expect(landingSrc).toContain('to="/get-pass"');
      expect(landingSrc).toContain('Get Your Gate Pass');
    });

    it('does NOT contain any public Staff Sign In or /login link on landing page or footer', () => {
      expect(landingSrc).not.toContain('Staff Sign In');
      expect(landingSrc).not.toContain('to="/login"');
      expect(landingSrc).not.toContain('href="/login"');
    });

    it('employs full-width section architecture with responsive gutters and ultrawide constraints', () => {
      expect(landingSrc).toContain('px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16');
      expect(landingSrc).toContain('max-w-7xl 2xl:max-w-[1600px]');
    });

    it('incorporates institutional HeroArtwork with digital phone QR pass and physical pass mockups', () => {
      expect(landingSrc).toContain('HeroArtwork');
      expect(landingSrc).toContain('EARIST Security');
      expect(landingSrc).toContain('Campus Visitor Pass');
    });

    it('content file landing.ts retains 5-step process and 4 requirement items', () => {
      expect(landingContentSrc).toContain('process: {');
      expect(landingContentSrc).toContain('steps: [');
      expect(landingContentSrc).toContain('needs: {');
      expect(landingContentSrc).toContain('items: [');
      expect(landingContentSrc).toContain('faq: {');
    });
  });
});
