import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PASSWORD_POLICY_HELPER_TEXT } from '@/lib/passwordPolicy';

describe('UI Regressions & Accessibility Invariants (Requirement 31)', () => {
  const root = process.cwd();

  it('ForcePasswordChange renders canonical PASSWORD_POLICY_HELPER_TEXT and required fields', () => {
    const file = readFileSync(join(root, 'src', 'components', 'ForcePasswordChange.tsx'), 'utf-8');
    expect(file).toContain('PASSWORD_POLICY_HELPER_TEXT');
    expect(file).not.toContain('Use at least 12 characters with a letter and a number');
    expect(file).toContain('{PASSWORD_POLICY_HELPER_TEXT}');

    // Form fields have requirement="required" and inputs have aria-required="true"
    expect(file).toContain('<FormField label="Current Password" id="current-password" requirement="required">');
    expect(file).toContain('<FormField label="New Password" id="new-password" requirement="required">');
    expect(file).toContain('<FormField label="Confirm Password" id="confirm-password" requirement="required">');
    expect(file).toContain('id="current-password"');
    expect(file).toContain('id="new-password"');
    expect(file).toContain('id="confirm-password"');
  });

  it('LoginPage, ForgotPasswordPage, and ResetPasswordPage enforce required field presentation', () => {
    const login = readFileSync(join(root, 'src', 'pages', 'LoginPage.tsx'), 'utf-8');
    expect(login).toContain('<FormField label="Email or Device Username" id="login-email" requirement="required">');
    expect(login).toContain('aria-required="true"');
    expect(login).toContain('<FormField label="Password" id="login-password" requirement="required">');

    const forgot = readFileSync(join(root, 'src', 'pages', 'ForgotPasswordPage.tsx'), 'utf-8');
    expect(forgot).toContain('<FormField label="Email" id="reset-email" requirement="required">');
    expect(forgot).toContain('aria-required="true"');

    const reset = readFileSync(join(root, 'src', 'pages', 'ResetPasswordPage.tsx'), 'utf-8');
    expect(reset).toContain('<FormField label="New Password" id="reset-new-password" requirement="required">');
    expect(reset).toContain('<FormField label="Confirm Password" id="reset-confirm-password" requirement="required">');
  });

  it('EmailPassModal enforces required field indicators and aria-required', () => {
    const emailModal = readFileSync(join(root, 'src', 'components', 'EmailPassModal.tsx'), 'utf-8');
    expect(emailModal).toContain('requirement="required"');
    expect(emailModal).toContain('aria-required="true"');
    expect(emailModal).toContain('I consent to receive my EARIST gate pass QR code');
    expect(emailModal).toContain('*');
  });

  it('DevicesPage enforces required field indicators on registration but leaves edit optional', () => {
    const devices = readFileSync(join(root, 'src', 'pages', 'DevicesPage.tsx'), 'utf-8');
    // Register modal
    expect(devices).toContain('<FormField label="Device Name" id="device-name" requirement="required"');
    expect(devices).toContain('<FormField label="Type" id="device-type" requirement="required"');
    expect(devices).toContain('<FormField label="Gate / Location" id="device-gate" requirement="required"');
    expect(devices).toContain('label="Device Username / Alias"\n              id="device-username"\n              requirement="required"');
    expect(devices).toContain('<FormField label="Device Password" id="device-password" requirement="required"');

    // Edit modal remains optional
    expect(devices).toContain('<FormField label="Device Username / Alias" hint="Example: maingate-entry');
    expect(devices).not.toContain('<FormField label="Device Username / Alias" requirement="required" hint="Example: maingate-entry');
    expect(devices).toContain('<FormField label="New Password">');
  });

  it('AdminAuditLogs reconciliation table has 6 columns and accessible tablist with panels', () => {
    const audit = readFileSync(join(root, 'src', 'pages', 'AdminAuditLogs.tsx'), 'utf-8');
    // Reconciliation colSpan=6
    expect(audit).toContain('<LoadingRow label="Loading reconciliation items" columns={6} />');
    expect(audit).toContain('<EmptyRow message={reconciliation.error} columns={6} />');
    expect(audit).toContain('<EmptyRow message="No unresolved reconciliation items." columns={6} />');

    // Tab keyboard navigation and ARIA attributes
    expect(audit).toContain('role="tablist"');
    expect(audit).toContain('onKeyDown={handleTabKeyDown}');
    expect(audit).toContain('role="tabpanel"');
    expect(audit).toContain('id="audit-tabpanel-visitor"');
    expect(audit).toContain('id="audit-tabpanel-administrative"');
    expect(audit).toContain('id="audit-tabpanel-reconciliation"');

    // Resolution note required
    expect(audit).toContain('<FormField id="resolution-note" label="Resolution Note" requirement="required">');
  });

  it('GuardVisitorRecoveryTab renders accessible button thumbnails with focus ring and aria labels', () => {
    const recovery = readFileSync(join(root, 'src', 'components', 'guard', 'GuardVisitorRecoveryTab.tsx'), 'utf-8');
    expect(recovery).toContain('<button');
    expect(recovery).toContain('type="button"');
    expect(recovery).toContain('aria-label="Open visitor selfie"');
    expect(recovery).toContain('aria-label="Open presented ID"');
    expect(recovery).toContain('focus:ring-2');
  });

  it('GuardOfflineRegistrationTab uses shared Modal and indicates required ID for approved entry', () => {
    const offlineReg = readFileSync(join(root, 'src', 'components', 'guard', 'GuardOfflineRegistrationTab.tsx'), 'utf-8');
    expect(offlineReg).toContain('<Modal');
    expect(offlineReg).toContain('title="Reject Offline Visitor"');
    expect(offlineReg).toContain('Presented Valid ID — Required for approval');
  });
});
