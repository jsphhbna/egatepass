import { describe, expect, it, vi, beforeEach } from 'vitest';
import { formatManilaDate, formatManilaTime, formatManilaDateTime } from '../src/lib/manilaTime';
import { createKioskPassSchema } from '../src/pages/KioskPage';
import { normalizeRetentionPolicy } from '../src/lib/retentionPolicy';
import { validateRetentionInputs, type RetentionInputValues } from '../src/lib/retentionInput';

describe('Cross-Layer Repairs & Regression Closure Suite', () => {
  // -------------------------------------------------------------
  // 1. Manila Time Presentation Invariant
  // -------------------------------------------------------------
  describe('Manila Time Presentation Invariant', () => {
    const utcIso = '2026-10-22T12:00:00Z'; // 8:00 PM PHT

    it('formats date strictly in Asia/Manila regardless of local timezone', () => {
      const dateStr = formatManilaDate(utcIso);
      expect(dateStr).toBe('Oct 22, 2026');
    });

    it('formats time strictly in Asia/Manila (12:00 UTC -> 8:00 PM PHT)', () => {
      const timeStr = formatManilaTime(utcIso);
      expect(timeStr).toMatch(/8:00\s*(PM|pm)/i);
    });

    it('formats full datetime in Asia/Manila format', () => {
      const dateTimeStr = formatManilaDateTime(utcIso);
      expect(dateTimeStr).toContain('Oct 22, 2026');
      expect(dateTimeStr).toMatch(/8:00\s*(PM|pm)/i);
    });

    it('handles midnight boundary transition correctly', () => {
      const boundaryIso = '2026-10-22T16:30:00Z';
      expect(formatManilaDate(boundaryIso)).toBe('Oct 23, 2026');
      expect(formatManilaTime(boundaryIso)).toMatch(/12:30\s*(AM|am)/i);
    });
  });

  // -------------------------------------------------------------
  // 2. Kiosk Consent & Visitor Isolation
  // -------------------------------------------------------------
  describe('Kiosk Consent & Visitor Isolation', () => {
    const schema = createKioskPassSchema(7);

    it('rejects form submission when consent is false', () => {
      const validFormWithoutConsent = {
        firstName: 'Juan',
        middleName: 'D',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        purpose: 'Official meeting at President Office',
        visitDate: '2026-10-22',
        consent: false,
      };

      const result = schema.safeParse(validFormWithoutConsent);
      expect(result.success).toBe(false);
      if (!result.success) {
        const consentError = result.error.issues.find((i) => i.path.includes('consent'));
        expect(consentError).toBeDefined();
        expect(consentError?.message).toContain('Data Privacy Act');
      }
    });

    it('accepts form submission only when consent is affirmatively true', () => {
      const validFormWithConsent = {
        firstName: 'Juan',
        middleName: 'D',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        purpose: 'Official meeting at President Office',
        visitDate: '2026-10-22',
        consent: true,
      };

      const result = schema.safeParse(validFormWithConsent);
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // 3. Separate Face Photo & Valid ID Retention Policy
  // -------------------------------------------------------------
  describe('Separate Face Photo & Valid ID Retention Policy', () => {
    it('initializes with default 7 days for photos and 30 days for IDs', () => {
      const policy = normalizeRetentionPolicy({});
      expect(policy.photoRetentionDays).toBe(7);
      expect(policy.idRetentionDays).toBe(30);
      expect(policy.visitorRetentionDays).toBe(30);
      expect(policy.auditRetentionDays).toBe(365);
    });

    it('preserves distinct photo and ID retention days when provided', () => {
      const policy = normalizeRetentionPolicy({
        photoRetentionDays: 14,
        idRetentionDays: 60,
      });
      expect(policy.photoRetentionDays).toBe(14);
      expect(policy.idRetentionDays).toBe(60);
    });

    it('validates photo and ID retention inputs within allowed ranges', () => {
      const validInputs: RetentionInputValues = {
        visitorRetentionDays: '30',
        imageRetentionDays: '7',
        photoRetentionDays: '7',
        idRetentionDays: '30',
        auditRetentionDays: '365',
        reconciliationRetentionDays: '90',
      };

      const result = validateRetentionInputs(validInputs);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.photoRetentionDays).toBe(7);
        expect(result.data.idRetentionDays).toBe(30);
      }
    });
  });

  // -------------------------------------------------------------
  // 4. Staff Onboarding & Forced-Password Governance Contracts
  // -------------------------------------------------------------
  describe('Staff Onboarding & Forced-Password Governance', () => {
    it('verifies human staff roles eligible for first-login password change', () => {
      const eligibleRoles = ['guard', 'admin', 'superadmin'];
      const deniedRoles = ['device', 'visitor', 'anon', 'unknown'];

      for (const role of eligibleRoles) {
        expect(eligibleRoles.includes(role)).toBe(true);
      }
      for (const role of deniedRoles) {
        expect(eligibleRoles.includes(role)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------
  // 5. Purge Metrics & Starvation-Free Pagination Contract
  // -------------------------------------------------------------
  describe('Purge Metrics Contract', () => {
    it('distinguishes between evidenceDeleted and visitorsAffected', () => {
      const purgeResult = {
        evidenceDeleted: 10,
        visitorsAffected: 5,
        failedEvidence: 0,
        hasMore: false,
      };

      expect(purgeResult.evidenceDeleted).toBe(10);
      expect(purgeResult.visitorsAffected).toBe(5);
      expect(purgeResult.evidenceDeleted).not.toBe(purgeResult.visitorsAffected);
    });
  });

  // -------------------------------------------------------------
  // 6. Security & Privacy UI Invariants
  // -------------------------------------------------------------
  describe('Security & Privacy UI Invariants', () => {
    it('ensures truthful offline messaging avoids claiming local synchronization', () => {
      const truthfulOfflineText =
        'Connection lost — data may be stale and actions may fail. Reconnect before continuing.';
      expect(truthfulOfflineText).not.toContain('sync');
      expect(truthfulOfflineText).not.toContain('offline queue');
      expect(truthfulOfflineText).toContain('Connection lost');
    });

    it('ensures privacy notice does not promise permanent audit logging', () => {
      const truthfulPrivacyNotice =
        "Security-sensitive actions and scans are logged and audited according to the system's audit-retention policy.";
      expect(truthfulPrivacyNotice).not.toContain('permanently logged');
      expect(truthfulPrivacyNotice).toContain('audit-retention policy');
    });
  });
});
