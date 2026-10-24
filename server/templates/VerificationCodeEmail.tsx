import React from 'react';
import { EmailHeader } from './components/EmailHeader.js';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Hr,
} from '@react-email/components';

export interface VerificationCodeEmailProps {
  fullName: string;
  code: string;
  expiresInMinutes?: number;
}

const mainStyle: React.CSSProperties = {
  backgroundColor: '#f4f4f5',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: '0',
  padding: '24px 0',
};

const containerStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  border: '1px solid #e4e4e7',
  maxWidth: '560px',
  margin: '0 auto',
  padding: '32px 28px',
};

const greetingText: React.CSSProperties = {
  color: '#18181b',
  fontSize: '16px',
  margin: '0 0 16px 0',
};

const bodyText: React.CSSProperties = {
  color: '#3f3f46',
  fontSize: '15px',
  lineHeight: '1.5',
  margin: '0 0 20px 0',
};

const codeContainer: React.CSSProperties = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  textAlign: 'center',
  padding: '18px',
  margin: '24px 0',
};

const codeText: React.CSSProperties = {
  color: '#800000',
  fontSize: '32px',
  fontWeight: '800',
  letterSpacing: '8px',
  margin: '0',
};

const expiryText: React.CSSProperties = {
  color: '#71717a',
  fontSize: '13px',
  lineHeight: '1.4',
  margin: '0 0 24px 0',
};

const hrStyle: React.CSSProperties = {
  borderColor: '#e4e4e7',
  margin: '24px 0 16px 0',
};

const footerText: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: '12px',
  lineHeight: '1.4',
  margin: '0',
  textAlign: 'center',
};

export function VerificationCodeEmail({
  fullName,
  code,
  expiresInMinutes = 10,
}: VerificationCodeEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your EARIST Gate Pass verification code: {code}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />
          <Section>
            <Text style={greetingText}>Hello <strong>{fullName}</strong>,</Text>
            <Text style={bodyText}>
              Enter this 6-digit verification code to confirm ownership of your email address for your digital gate pass:
            </Text>
            <Section style={codeContainer}>
              <Text style={codeText}>{code}</Text>
            </Section>
            <Text style={expiryText}>
              {`This code will expire in ${expiresInMinutes} minutes. If you did not request this pass, please disregard this email.`}
            </Text>
          </Section>
          <Hr style={hrStyle} />
          <Section>
            <Text style={footerText}>
              Automated verification from the EARIST Visitor Management System. Please do not reply directly to this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
export default VerificationCodeEmail;
