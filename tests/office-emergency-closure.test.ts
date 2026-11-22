import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { maskPhoneNumber } from '../server/sms.js';

describe('Office Emergency Closure and Full Parity Verification', () => {
  const rootDir = path.resolve(__dirname, '..');

  describe('1. Privacy-Safe Phone Masking for Emergency SMS', () => {
    it('masks standard 11-digit Philippine mobile numbers', () => {
      expect(maskPhoneNumber('09171234567')).toBe('0917 ••• 4567');
      expect(maskPhoneNumber('09289876543')).toBe('0928 ••• 6543');
    });

    it('masks E.164 Philippine mobile numbers with country code', () => {
      expect(maskPhoneNumber('+639171234567')).toBe('+63917 ••• 4567');
    });

    it('handles formatted numbers with spaces and dashes', () => {
      expect(maskPhoneNumber('0917-555-1234')).toBe('0917 ••• 1234');
      expect(maskPhoneNumber('+63 917 555 1234')).toBe('+63917 ••• 1234');
    });
  });

  describe('2. Database Migrations & Security Contract', () => {
    it('proves migration 20261123000100_office_emergency_closure.sql exists with audited RPCs', () => {
      const migrationFile = path.join(rootDir, 'supabase/migrations/20261123000100_office_emergency_closure.sql');
      expect(existsSync(migrationFile)).toBe(true);
      const sql = readFileSync(migrationFile, 'utf8');

      expect(sql).toContain('closure_status text not null default \'open\'');
      expect(sql).toContain('closure_reason text');
      expect(sql).toContain('create or replace function api.set_office_emergency_closure');
      expect(sql).toContain('create or replace function api.get_office_closure_affected_visitors');
      expect(sql).toContain('security definer');
      expect(sql).toContain('set search_path = public, pg_catalog');
    });

    it('proves migration 20261123000200_office_closure_least_privilege.sql enforces least privilege', () => {
      const migrationFile = path.join(rootDir, 'supabase/migrations/20261123000200_office_closure_least_privilege.sql');
      expect(existsSync(migrationFile)).toBe(true);
      const sql = readFileSync(migrationFile, 'utf8');

      expect(sql).toContain('revoke all on function api.set_office_emergency_closure');
      expect(sql).toContain('revoke all on function api.get_office_closure_affected_visitors');
      expect(sql).toContain('grant execute on function api.set_office_emergency_closure(uuid, text, text) to service_role');
      expect(sql).toContain('grant execute on function api.get_office_closure_affected_visitors(uuid) to service_role');
    });
  });

  describe('3. Kiosk 1-to-6 Step Alignment & Parity Contract', () => {
    const kioskSrc = readFileSync(path.join(rootDir, 'src/pages/KioskPage.tsx'), 'utf8');

    it('defines 6 distinct numbered stepper steps in KioskPage', () => {
      expect(kioskSrc).toContain("title: '1. Personal'");
      expect(kioskSrc).toContain("title: '2. Visit'");
      expect(kioskSrc).toContain("title: '3. Live Face'");
      expect(kioskSrc).toContain("title: '4. Valid ID'");
      expect(kioskSrc).toContain("title: '5. Verify'");
      expect(kioskSrc).toContain("title: '6. Review'");
    });

    it('integrates StructuredAddressField in KioskPage Step 1', () => {
      expect(kioskSrc).toContain('import { StructuredAddressField }');
      expect(kioskSrc).toContain('<StructuredAddressField');
      expect(kioskSrc).toContain('selectedPsgc');
      expect(kioskSrc).toContain('setGender');
    });

    it('implements destination office selection with emergency closure alert in KioskPage Step 2', () => {
      expect(kioskSrc).toContain('destination-office');
      expect(kioskSrc).toContain('Office Temporarily Closed');
      expect(kioskSrc).toContain('closure_status === \'closed\'');
      expect(kioskSrc).toContain('closure_reason');
    });

    it('implements live face selfie capture with oval guide in KioskPage Step 3', () => {
      expect(kioskSrc).toContain('faceWebcam');
      expect(kioskSrc).toContain('SELFIE_OVAL_WIDTH_PERCENT');
      expect(kioskSrc).toContain('SELFIE_OVAL_HEIGHT_PERCENT');
      expect(kioskSrc).toContain('Capture Photo');
    });

    it('implements valid ID capture and dual OCR with threshold 60 in KioskPage Step 4', () => {
      expect(kioskSrc).toContain('recognizeIdImage');
      expect(kioskSrc).toContain('CONFIDENCE_THRESHOLD = 60');
      expect(kioskSrc).toContain('getNextOcrJobId');
      expect(kioskSrc).toContain('normalizeIdentityDocumentImage');
    });

    it('implements identity verification visual comparison in KioskPage Step 5', () => {
      expect(kioskSrc).toContain("step === 'verify'");
      expect(kioskSrc).toContain('Identity Verification');
      expect(kioskSrc).toContain('Live Face');
      expect(kioskSrc).toContain('Valid ID');
    });

    it('embeds InstitutionalPrivacyNoticeModal in KioskPage Step 6', () => {
      expect(kioskSrc).toContain('import { InstitutionalPrivacyNoticeModal }');
      expect(kioskSrc).toContain('<InstitutionalPrivacyNoticeModal');
      expect(kioskSrc).toContain('Republic Act No. 10173');
      expect(kioskSrc).toContain('showPrivacyModal');
    });
  });

  describe('4. Pre-Registration (GetPassPage) Office Emergency Closure Parity', () => {
    const getPassSrc = readFileSync(path.join(rootDir, 'src/pages/GetPassPage.tsx'), 'utf8');

    it('displays [Temporarily Closed] on closed offices and alerts visitor with reason', () => {
      expect(getPassSrc).toContain("[Temporarily Closed]");
      expect(getPassSrc).toContain('Office Temporarily Closed');
      expect(getPassSrc).toContain('selectedOffice.closure_reason');
    });

    it('uses shared InstitutionalPrivacyNoticeModal in GetPassPage', () => {
      expect(getPassSrc).toContain('import { InstitutionalPrivacyNoticeModal }');
      expect(getPassSrc).toContain('<InstitutionalPrivacyNoticeModal');
    });
  });

  describe('5. Admin & Office Staff Emergency Closure Controls', () => {
    const adminUsersSrc = readFileSync(path.join(rootDir, 'src/pages/AdminUsers.tsx'), 'utf8');
    const officeDashSrc = readFileSync(path.join(rootDir, 'src/pages/OfficeDashboardPage.tsx'), 'utf8');
    const emergencySrc = readFileSync(path.join(rootDir, 'src/pages/AdminEmergency.tsx'), 'utf8');

    it('provides Office Emergency Closure modal in AdminUsers for Superadmin / Admin', () => {
      expect(adminUsersSrc).toContain('Emergency Close Office');
      expect(adminUsersSrc).toContain('closure-reason-input');
      expect(adminUsersSrc).toContain('notify-visitors-closure');
      expect(adminUsersSrc).toContain('handleSaveOfficeClosure');
    });

    it('provides Emergency Closure modal in OfficeDashboardPage for Office Staff', () => {
      expect(officeDashSrc).toContain('Immediate Availability Control');
      expect(officeDashSrc).toContain('office-closure-reason');
      expect(officeDashSrc).toContain('Notify registered visitors via SMS text and Email');
      expect(officeDashSrc).toContain('handleToggleClosure');
    });

    it('features prominent emergency mass text broadcast in AdminEmergency', () => {
      expect(emergencySrc).toContain('Text Everyone Inside');
      expect(emergencySrc).toContain('Android SMS Gateway SIM');
    });
  });
});
