import React from 'react';
import { render } from '@react-email/render';
import { VerificationCodeEmail, type VerificationCodeEmailProps } from './VerificationCodeEmail.js';
import { PassIssuedEmail, type PassIssuedEmailProps } from './PassIssuedEmail.js';

export { VerificationCodeEmail } from './VerificationCodeEmail.js';
export type { VerificationCodeEmailProps } from './VerificationCodeEmail.js';
export { PassIssuedEmail } from './PassIssuedEmail.js';
export type { PassIssuedEmailProps } from './PassIssuedEmail.js';

export async function renderVerificationCodeEmail(props: VerificationCodeEmailProps): Promise<string> {
  return render(React.createElement(VerificationCodeEmail, props));
}

export async function renderPassIssuedEmail(props: PassIssuedEmailProps): Promise<string> {
  return render(React.createElement(PassIssuedEmail, props));
}
