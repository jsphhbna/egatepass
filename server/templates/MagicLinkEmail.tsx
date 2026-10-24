import React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Button,
  Hr,
} from '@react-email/components';
import { EmailHeader } from './components/EmailHeader.js';

export interface MagicLinkEmailProps {
  email: string;
  magicUrl: string;
  displayName?: string;
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
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 20px 0',
};

const buttonContainer: React.CSSProperties = {
  textAlign: 'center',
  margin: '28px 0',
};

const actionButton: React.CSSProperties = {
  backgroundColor: '#800000',
  borderRadius: '6px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: '600',
  padding: '12px 28px',
  textDecoration: 'none',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
};

const linkNotice: React.CSSProperties = {
  color: '#71717a',
  fontSize: '12px',
  lineHeight: '18px',
  wordBreak: 'break-all',
  margin: '16px 0 0 0',
};

const noticeSection: React.CSSProperties = {
  backgroundColor: '#fffbeb',
  borderRadius: '6px',
  border: '1px solid #fde68a',
  padding: '12px 16px',
  margin: '24px 0 0 0',
};

const noticeTitle: React.CSSProperties = {
  color: '#92400e',
  fontSize: '12px',
  fontWeight: '700',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  margin: '0 0 4px 0',
};

const noticeText: React.CSSProperties = {
  color: '#78350f',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '0',
};

const footerDivider: React.CSSProperties = {
  borderColor: '#e4e4e7',
  margin: '28px 0 20px 0',
};

const footerText: React.CSSProperties = {
  color: '#a1a1aa',
  fontSize: '12px',
  lineHeight: '18px',
  margin: '0',
  textAlign: 'center',
};

export function MagicLinkEmail({
  email,
  magicUrl,
  displayName,
}: MagicLinkEmailProps): React.JSX.Element {
  const greeting = displayName ? `Hello ${displayName},` : 'Hello,';

  return (
    <Html lang="en">
      <Head />
      <Preview>Sign in to EARIST E-GatePass</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />

          <Text style={greetingText}>{greeting}</Text>
          <Text style={bodyText}>
            You requested a secure link to sign in to your EARIST E-GatePass account ({email}).
            Click the button below to complete your sign-in:
          </Text>

          <Section style={buttonContainer}>
            <Button style={actionButton} href={magicUrl}>
              Sign In to E-GatePass
            </Button>
          </Section>

          <Text style={linkNotice}>
            If the button above does not work, copy and paste this link into your browser:
            <br />
            {magicUrl}
          </Text>

          <Section style={noticeSection}>
            <Text style={noticeTitle}>Security Notice</Text>
            <Text style={noticeText}>
              If you did not request this sign-in link, you can safely ignore this email. No access will be granted without clicking the link.
            </Text>
          </Section>

          <Hr style={footerDivider} />
          <Text style={footerText}>
            E-GatePass Campus Access Management System • Nagtahan, Sampaloc, Manila
            <br />
            This is an automated institutional message. Please do not reply directly to this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default MagicLinkEmail;
