import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@react-email/render';
import {
  VerificationCodeEmail,
  PassIssuedEmail,
  SignupConfirmationEmail,
  PasswordResetEmail,
  StaffInviteEmail,
  EmailChangeEmail,
  MagicLinkEmail,
  ReauthenticationEmail,
  SecurityNotificationEmail,
  EARIST_LOGO_URL,
  renderSignupConfirmationEmail,
  renderPasswordResetEmail,
  renderStaffInviteEmail,
  renderEmailChangeEmail,
  renderMagicLinkEmail,
  renderReauthenticationEmail,
  renderSecurityNotificationEmail,
  renderVerificationCodeEmail,
  renderPassIssuedEmail,
} from '../server/templates/index.js';

describe('EMAIL-ARCH-01: React Email Templates', () => {
  it('renders VerificationCodeEmail with EARIST branding, 6-digit code, and expiry text', async () => {
    const html = await render(
      React.createElement(VerificationCodeEmail, {
        fullName: 'Juan Dela Cruz',
        code: '849201',
        expiresInMinutes: 10,
      })
    );

    expect(html).toContain('EARIST E-GatePass');
    expect(html).toContain('Juan Dela Cruz');
    expect(html).toContain('849201');
    expect(html).toContain('10 minutes');
    expect(html).toContain('#800000'); // Maroon branding
  });

  it('escapes malicious markup in visitor name in VerificationCodeEmail', async () => {
    const html = await render(
      React.createElement(VerificationCodeEmail, {
        fullName: '<script>alert("xss")</script> & Juan',
        code: '123456',
      })
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders PassIssuedEmail with visitor details and security notice', async () => {
    const html = await render(
      React.createElement(PassIssuedEmail, {
        fullName: 'Maria Santos',
        visitDate: '2026-10-20',
        purpose: 'Registrar Transcript Request',
        publicReference: '10000000-0000-4000-a000-000000000888',
      })
    );

    expect(html).toContain('EARIST E-GatePass');
    expect(html).toContain('Maria Santos');
    expect(html).toContain('10000000-0000-4000-a000-000000000888');
    expect(html).toContain('2026-10-20');
    expect(html).toContain('Registrar Transcript Request');
    expect(html).toContain('earist-gate-pass-qr.png');
    expect(html).toContain('Security Notice');
  });

  it('escapes malicious markup in purpose in PassIssuedEmail', async () => {
    const html = await render(
      React.createElement(PassIssuedEmail, {
        fullName: 'Maria Santos',
        visitDate: '2026-10-20',
        purpose: '<img src=x onerror=alert(1)>',
        publicReference: '10000000-0000-4000-a000-000000000888',
      })
    );

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  describe('Fix Group D: Canonical EARIST branding & seal across every template', () => {
    const sampleTemplates = [
      {
        name: 'SignupConfirmationEmail',
        component: SignupConfirmationEmail,
        props: { confirmationUrl: 'https://supabase.co/verify?token=123', email: 'guard@earist.edu.ph', displayName: 'Guard Reyes' },
      },
      {
        name: 'PasswordResetEmail',
        component: PasswordResetEmail,
        props: { resetUrl: 'https://supabase.co/verify?token=456', email: 'admin@earist.edu.ph', displayName: 'Admin Cruz' },
      },
      {
        name: 'StaffInviteEmail',
        component: StaffInviteEmail,
        props: { inviteUrl: 'https://supabase.co/verify?token=789', email: 'invited@earist.edu.ph' },
      },
      {
        name: 'EmailChangeEmail',
        component: EmailChangeEmail,
        props: { currentEmail: 'current@earist.edu.ph', newEmail: 'new@earist.edu.ph', changeUrl: 'https://supabase.co/verify?token=abc', targetAddress: 'new', displayName: 'Staff Cruz' },
      },
      {
        name: 'VerificationCodeEmail',
        component: VerificationCodeEmail,
        props: { fullName: 'Pedro Santos', code: '123456', expiresInMinutes: 10 },
      },
      {
        name: 'PassIssuedEmail',
        component: PassIssuedEmail,
        props: { fullName: 'Pedro Santos', visitDate: '2026-10-22', purpose: 'Campus Visit', publicReference: 'ref-123' },
      },
      {
        name: 'MagicLinkEmail',
        component: MagicLinkEmail,
        props: { magicUrl: 'https://supabase.co/verify?token=def', email: 'staff@earist.edu.ph' },
      },
      {
        name: 'ReauthenticationEmail',
        component: ReauthenticationEmail,
        props: { reauthUrl: 'https://supabase.co/verify?token=ghi', email: 'staff@earist.edu.ph' },
      },
      {
        name: 'SecurityNotificationEmail',
        component: SecurityNotificationEmail,
        props: {
          email: 'staff@earist.edu.ph',
          actionType: 'password_changed_notification',
          title: 'Security Alert: Password Changed',
          description: 'Your account password has been changed.',
        },
      },
    ];

    it.each(sampleTemplates)('renders $name with EARIST E-GatePass, absolute seal URL, and alt="EARIST seal"', async ({ component, props }) => {
      const html = await render(React.createElement(component as any, props));
      expect(html).toContain('EARIST E-GatePass');
      expect(html).toContain('https://egatepass.tech/earist-logo-email.png');
      expect(html).toContain('https://egatepass.tech/earist-building-email-header.jpg');
      expect(html).toContain('alt="EARIST seal"');
      expect(html).not.toContain('src="/earist-logo.png"');
      expect(html).not.toContain('https://egatepass.tech/earist-logo.png'); // Never old oversized logo
    });
  });

  describe('Fix Group E: Manual Supabase invite truthfulness', () => {
    it('with no role metadata: does not render AUTHORIZED STAFF, does not claim Guard/Admin/Super Admin, and disclaims application permissions', async () => {
      const html = await render(
        React.createElement(StaffInviteEmail, {
          inviteUrl: 'https://supabase.co/verify?token=test_invite',
          email: 'invited.user@earist.edu.ph',
        })
      );

      expect(html).not.toContain('AUTHORIZED STAFF');
      expect(html).not.toContain('GUARD');
      expect(html).not.toContain('ADMIN');
      expect(html).not.toContain('SUPER ADMIN');
      expect(html).toContain('Accept E-GatePass Invitation');
      expect(html).toContain('does not by itself assign Guard, Admin, or Super Admin access');
    });

    it('with malicious metadata: escapes raw HTML injection', async () => {
      const html = await render(
        React.createElement(StaffInviteEmail, {
          inviteUrl: 'https://supabase.co/verify?token=test_invite',
          email: 'invited.user@earist.edu.ph',
          displayName: '<script>alert("xss")</script><img src=x onerror=alert(1)>',
        })
      );

      expect(html).not.toContain('<script>alert("xss")</script>');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('Fix Group G1: Magic Link semantics', () => {
    it('says sign-in, does NOT say registered/signup, does NOT say password reset', async () => {
      const html = await render(
        React.createElement(MagicLinkEmail, {
          magicUrl: 'https://supabase.co/verify?token=magic123',
          email: 'staff@earist.edu.ph',
          displayName: 'Juan Staff',
        })
      );

      expect(html).toContain('Sign in to EARIST E-GatePass');
      expect(html).toContain('Sign In to E-GatePass');
      expect(html).not.toContain('A staff account has been registered');
      expect(html).not.toContain('Confirm Staff Account');
      expect(html).not.toContain('Reset your password');
    });
  });

  describe('Fix Group G2: Reauthentication semantics', () => {
    it('says identity confirmation, does NOT say password reset', async () => {
      const html = await render(
        React.createElement(ReauthenticationEmail, {
          reauthUrl: 'https://supabase.co/verify?token=reauth123',
          email: 'staff@earist.edu.ph',
          displayName: 'Admin User',
        })
      );

      expect(html).toContain('Confirm your identity to continue this sensitive E-GatePass action');
      expect(html).toContain('Confirm My Identity');
      expect(html).not.toContain('Reset your password');
      expect(html).not.toContain('Reset Password');
    });
  });

  describe('Fix Group G3 & H: Security Notifications & Raw HTML elimination', () => {
    const securityActions = [
      'password_changed_notification',
      'email_changed_notification',
      'phone_changed_notification',
      'mfa_factor_enrolled_notification',
      'mfa_factor_unenrolled_notification',
      'identity_linked_notification',
      'identity_unlinked_notification',
      'email',
    ];

    it.each(securityActions)('renders security notification for action %s via React Email with auto-escaping', async (action) => {
      const html = await render(
        React.createElement(SecurityNotificationEmail, {
          email: 'victim@earist.edu.ph',
          displayName: '<script>malicious()</script>',
          actionType: action,
          title: `Alert: ${action}`,
          description: `Description for ${action}`,
          details: '<b onmouseover=alert(1)>Malicious detail</b>',
        })
      );

      expect(html).toContain('EARIST E-GatePass');
      expect(html).toContain('alt="EARIST seal"');
      expect(html).not.toContain('<script>malicious()</script>');
      expect(html).not.toContain('<b onmouseover=alert(1)>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
  describe('Fix Group M: Shared Template Index Render Helpers', () => {
    it('renders all 9 email templates through exported render functions without unexpected errors', async () => {
      const signupHtml = await renderSignupConfirmationEmail({
        email: 'user@earist.edu.ph',
        confirmationUrl: 'https://supabase.co/verify?token=1',
        displayName: 'Staff Juan',
      });
      expect(signupHtml).toContain('EARIST E-GatePass');
      expect(signupHtml).toContain('https://egatepass.tech/earist-logo-email.png');
      expect(signupHtml).toContain('https://egatepass.tech/earist-building-email-header.jpg');

      const resetHtml = await renderPasswordResetEmail({
        email: 'user@earist.edu.ph',
        resetUrl: 'https://supabase.co/verify?token=2',
        displayName: 'Staff Maria',
      });
      expect(resetHtml).toContain('Reset My Password');

      const inviteHtml = await renderStaffInviteEmail({
        email: 'invited@earist.edu.ph',
        inviteUrl: 'https://supabase.co/verify?token=3',
        displayName: 'Prof Santos',
      });
      expect(inviteHtml).toContain('Account Invitation');
      expect(inviteHtml).toContain('alt="EARIST seal"');

      const emailChangeHtml = await renderEmailChangeEmail({
        currentEmail: 'old@earist.edu.ph',
        newEmail: 'new@earist.edu.ph',
        changeUrl: 'https://supabase.co/verify?token=4',
        targetAddress: 'new',
      });
      expect(emailChangeHtml).toContain('Verify New Email Address');

      const magicHtml = await renderMagicLinkEmail({
        email: 'magic@earist.edu.ph',
        magicUrl: 'https://supabase.co/verify?token=5',
      });
      expect(magicHtml).toContain('Sign in to EARIST E-GatePass');

      const reauthHtml = await renderReauthenticationEmail({
        email: 'reauth@earist.edu.ph',
        reauthUrl: 'https://supabase.co/verify?token=6',
      });
      expect(reauthHtml).toContain('Confirm your identity');

      const secHtml = await renderSecurityNotificationEmail({
        email: 'sec@earist.edu.ph',
        actionType: 'password_changed_notification',
        displayName: 'Sec User',
      });
      expect(secHtml).toContain('Security Alert');

      const verifyCodeHtml = await renderVerificationCodeEmail({
        fullName: 'Visitor Test',
        code: '654321',
        expiresInMinutes: 15,
      });
      expect(verifyCodeHtml).toContain('654321');

      const passHtml = await renderPassIssuedEmail({
        fullName: 'Visitor Test',
        visitDate: '2026-10-22',
        purpose: 'Meeting',
        publicReference: 'ref-pass-999',
      });
      expect(passHtml).toContain('ref-pass-999');
    });
  });

});
