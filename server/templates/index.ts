import React from 'react';
import { render } from '@react-email/render';
import { VerificationCodeEmail, type VerificationCodeEmailProps } from './VerificationCodeEmail.js';
import { PassIssuedEmail, type PassIssuedEmailProps } from './PassIssuedEmail.js';
import { SignupConfirmationEmail, type SignupConfirmationEmailProps } from './SignupConfirmationEmail.js';
import { PasswordResetEmail, type PasswordResetEmailProps } from './PasswordResetEmail.js';
import { StaffInviteEmail, type StaffInviteEmailProps } from './StaffInviteEmail.js';
import { EmailChangeEmail, type EmailChangeEmailProps } from './EmailChangeEmail.js';

export { VerificationCodeEmail, type VerificationCodeEmailProps } from './VerificationCodeEmail.js';
export { PassIssuedEmail, type PassIssuedEmailProps } from './PassIssuedEmail.js';
export { SignupConfirmationEmail, type SignupConfirmationEmailProps } from './SignupConfirmationEmail.js';
export { PasswordResetEmail, type PasswordResetEmailProps } from './PasswordResetEmail.js';
export { StaffInviteEmail, type StaffInviteEmailProps } from './StaffInviteEmail.js';
export { EmailChangeEmail, type EmailChangeEmailProps } from './EmailChangeEmail.js';

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
