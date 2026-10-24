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

export type SecurityNotificationType =
  | 'password_changed_notification'
  | 'email_changed_notification'
  | 'phone_changed_notification'
  | 'mfa_factor_enrolled_notification'
  | 'mfa_factor_unenrolled_notification'
  | 'identity_linked_notification'
  | 'identity_unlinked_notification'
  | 'email';

export interface SecurityNotificationEmailProps {
  email: string;
  actionType: SecurityNotificationType;
  displayName?: string;
  actionUrl?: string;
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

interface NotificationContent {
  preview: string;
  heading: string;
  details: string;
  securityNotice: string;
  buttonLabel?: string;
}

function getNotificationContent(actionType: SecurityNotificationType, email: string): NotificationContent {
  switch (actionType) {
    case 'password_changed_notification':
      return {
        preview: 'Security Alert: Your EARIST E-GatePass password was changed',
        heading: 'Password Changed',
        details: `The password for your EARIST E-GatePass account (${email}) was recently changed.`,
        securityNotice: 'If you did not perform this change, contact your Super Admin immediately to secure your account.',
      };
    case 'email_changed_notification':
      return {
        preview: 'Security Alert: Your EARIST E-GatePass email address was changed',
        heading: 'Email Address Changed',
        details: `The email address associated with your EARIST E-GatePass account (${email}) was recently updated.`,
        securityNotice: 'If you did not authorize this change, please report this incident immediately to an administrator.',
      };
    case 'phone_changed_notification':
      return {
        preview: 'Security Alert: Phone number updated for EARIST E-GatePass',
        heading: 'Phone Number Updated',
        details: `A phone number update was made to your EARIST E-GatePass account (${email}).`,
        securityNotice: 'If you did not make this change, please contact an administrator immediately.',
      };
    case 'mfa_factor_enrolled_notification':
      return {
        preview: 'Security Alert: Multi-factor authentication enrolled',
        heading: 'MFA Factor Enrolled',
        details: `A new multi-factor authentication method was enrolled on your EARIST E-GatePass account (${email}).`,
        securityNotice: 'If you did not perform this enrollment, contact an administrator immediately.',
      };
    case 'mfa_factor_unenrolled_notification':
      return {
        preview: 'Security Alert: Multi-factor authentication removed',
        heading: 'MFA Factor Removed',
        details: `A multi-factor authentication method was removed from your EARIST E-GatePass account (${email}).`,
        securityNotice: 'If you did not authorize this removal, contact an administrator immediately.',
      };
    case 'identity_linked_notification':
      return {
        preview: 'Security Alert: External identity linked',
        heading: 'Identity Provider Linked',
        details: `An external identity provider was linked to your EARIST E-GatePass account (${email}).`,
        securityNotice: 'If you did not authorize this link, contact an administrator immediately.',
      };
    case 'identity_unlinked_notification':
      return {
        preview: 'Security Alert: External identity unlinked',
        heading: 'Identity Provider Unlinked',
        details: `An external identity provider was unlinked from your EARIST E-GatePass account (${email}).`,
        securityNotice: 'If you did not authorize this change, contact an administrator immediately.',
      };
    case 'email':
      return {
        preview: 'Confirm your EARIST E-GatePass email address',
        heading: 'Confirm Your Email Address',
        details: `Please confirm your email address (${email}) for EARIST E-GatePass by clicking the button below:`,
        securityNotice: 'If you did not create or link this email, no further action is needed.',
        buttonLabel: 'Confirm Email Address',
      };
  }
}

export function SecurityNotificationEmail({
  email,
  actionType,
  displayName,
  actionUrl,
}: SecurityNotificationEmailProps): React.JSX.Element {
  const content = getNotificationContent(actionType, email);
  const greeting = displayName ? `Hello ${displayName},` : 'Hello,';

  return (
    <Html lang="en">
      <Head />
      <Preview>{content.preview}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />

          <Text style={greetingText}>{greeting}</Text>
          <Text style={bodyText}>{content.details}</Text>

          {actionUrl && content.buttonLabel && (
            <>
              <Section style={buttonContainer}>
                <Button style={actionButton} href={actionUrl}>
                  {content.buttonLabel}
                </Button>
              </Section>
              <Text style={linkNotice}>
                If the button above does not work, copy and paste this link into your browser:
                <br />
                {actionUrl}
              </Text>
            </>
          )}

          <Section style={noticeSection}>
            <Text style={noticeTitle}>Security Alert</Text>
            <Text style={noticeText}>{content.securityNotice}</Text>
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

export default SecurityNotificationEmail;
