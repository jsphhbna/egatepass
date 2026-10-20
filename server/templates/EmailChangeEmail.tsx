import React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Heading,
  Text,
  Button,
  Hr,
} from '@react-email/components';

export interface EmailChangeEmailProps {
  currentEmail: string;
  newEmail: string;
  changeUrl: string;
  targetAddress: 'current' | 'new';
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

const headerSection: React.CSSProperties = {
  borderBottom: '2px solid #800000',
  paddingBottom: '16px',
  marginBottom: '24px',
};

const headerTitle: React.CSSProperties = {
  color: '#800000',
  fontSize: '24px',
  fontWeight: '700',
  letterSpacing: '-0.5px',
  margin: '0 0 4px 0',
};

const headerSubtitle: React.CSSProperties = {
  color: '#71717a',
  fontSize: '13px',
  fontWeight: '500',
  margin: '0',
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

const alertSection: React.CSSProperties = {
  backgroundColor: '#fffbeb',
  borderRadius: '6px',
  border: '1px solid #fde68a',
  padding: '12px 16px',
  margin: '24px 0 0 0',
};

const alertTitle: React.CSSProperties = {
  color: '#92400e',
  fontSize: '12px',
  fontWeight: '700',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  margin: '0 0 4px 0',
};

const alertText: React.CSSProperties = {
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

export function EmailChangeEmail({
  currentEmail,
  newEmail,
  changeUrl,
  targetAddress,
  displayName,
}: EmailChangeEmailProps): React.JSX.Element {
  const greeting = displayName ? `Hello ${displayName},` : 'Hello,';
  const isCurrent = targetAddress === 'current';

  return (
    <Html lang="en">
      <Head />
      <Preview>Confirm email address change for EARIST E-GatePass</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <Section style={headerSection}>
            <Heading style={headerTitle}>EARIST E-GatePass</Heading>
            <Text style={headerSubtitle}>Eulogio "Amang" Rodriguez Institute of Science and Technology</Text>
          </Section>

          <Text style={greetingText}>{greeting}</Text>
          <Text style={bodyText}>
            A request was submitted to change the email address on your EARIST E-GatePass account from{' '}
            <strong>{currentEmail}</strong> to <strong>{newEmail}</strong>.
            {isCurrent
              ? ' Please confirm this change from your current email address to authorize the transition.'
              : ' Please verify this new email address to complete your account update.'}
          </Text>

          <Section style={buttonContainer}>
            <Button style={actionButton} href={changeUrl}>
              {isCurrent ? 'Authorize Email Change' : 'Verify New Email Address'}
            </Button>
          </Section>

          <Text style={linkNotice}>
            If the button above does not work, copy and paste this link into your browser:
            <br />
            {changeUrl}
          </Text>

          <Section style={alertSection}>
            <Text style={alertTitle}>Security Notice</Text>
            <Text style={alertText}>
              If you did not request this email change, please do not click the link and report this immediately to the EARIST ICT / Campus Security Administration.
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

export default EmailChangeEmail;
