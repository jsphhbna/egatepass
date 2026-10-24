import React from 'react';
import { render } from '@react-email/render';
import { VerificationCodeEmail, type VerificationCodeEmailProps } from './VerificationCodeEmail.js';
import { PassIssuedEmail, type PassIssuedEmailProps } from './PassIssuedEmail.js';
import { SignupConfirmationEmail, type SignupConfirmationEmailProps } from './SignupConfirmationEmail.js';
import { PasswordResetEmail, type PasswordResetEmailProps } from './PasswordResetEmail.js';
import { StaffInviteEmail, type StaffInviteEmailProps } from './StaffInviteEmail.js';
import { EmailChangeEmail, type EmailChangeEmailProps } from './EmailChangeEmail.js';
import { MagicLinkEmail, type MagicLinkEmailProps } from './MagicLinkEmail.js';
import { ReauthenticationEmail, type ReauthenticationEmailProps } from './ReauthenticationEmail.js';
import { SecurityNotificationEmail, type SecurityNotificationEmailProps } from './SecurityNotificationEmail.js';

export { EARIST_LOGO_URL, EARIST_BUILDING_EMAIL_URL, EARIST_EMAIL_HEADER_ART_URL } from './branding.js';
export { EmailHeader, type EmailHeaderProps } from './components/EmailHeader.js';
export { VerificationCodeEmail, type VerificationCodeEmailProps } from './VerificationCodeEmail.js';
export { PassIssuedEmail, type PassIssuedEmailProps } from './PassIssuedEmail.js';
export { SignupConfirmationEmail, type SignupConfirmationEmailProps } from './SignupConfirmationEmail.js';
export { PasswordResetEmail, type PasswordResetEmailProps } from './PasswordResetEmail.js';
export { StaffInviteEmail, type StaffInviteEmailProps } from './StaffInviteEmail.js';
export { EmailChangeEmail, type EmailChangeEmailProps } from './EmailChangeEmail.js';
export { MagicLinkEmail, type MagicLinkEmailProps } from './MagicLinkEmail.js';
export { ReauthenticationEmail, type ReauthenticationEmailProps } from './ReauthenticationEmail.js';
export { SecurityNotificationEmail, type SecurityNotificationEmailProps, type SecurityNotificationType } from './SecurityNotificationEmail.js';

export async function renderVerificationCodeEmail(props: VerificationCodeEmailProps): Promise<string> {
  return render(React.createElement(VerificationCodeEmail, props));
}

export async function renderPassIssuedEmail(props: PassIssuedEmailProps): Promise<string> {
  return render(React.createElement(PassIssuedEmail, props));
}

export async function renderSignupConfirmationEmail(props: SignupConfirmationEmailProps): Promise<string> {
  return render(React.createElement(SignupConfirmationEmail, props));
}

export async function renderPasswordResetEmail(props: PasswordResetEmailProps): Promise<string> {
  return render(React.createElement(PasswordResetEmail, props));
}

export async function renderStaffInviteEmail(props: StaffInviteEmailProps): Promise<string> {
  return render(React.createElement(StaffInviteEmail, props));
}

export async function renderEmailChangeEmail(props: EmailChangeEmailProps): Promise<string> {
  return render(React.createElement(EmailChangeEmail, props));
}

export async function renderMagicLinkEmail(props: MagicLinkEmailProps): Promise<string> {
  return render(React.createElement(MagicLinkEmail, props));
}

export async function renderReauthenticationEmail(props: ReauthenticationEmailProps): Promise<string> {
  return render(React.createElement(ReauthenticationEmail, props));
}

export async function renderSecurityNotificationEmail(props: SecurityNotificationEmailProps): Promise<string> {
  return render(React.createElement(SecurityNotificationEmail, props));
}
