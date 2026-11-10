import React from 'react';
import { EmailHeader } from './components/EmailHeader.js';
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

export interface OfficeVisitAcknowledgedEmailProps {
  fullName: string;
  officeName: string;
  personnelName: string;
  visitDate: string;
  purpose?: string;
  trackingUrl: string;
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

const cardSection: React.CSSProperties = {
  backgroundColor: '#fafafa',
  border: '1px solid #e4e4e7',
  borderRadius: '8px',
  padding: '16px 20px',
  margin: '20px 0',
};

const detailRow: React.CSSProperties = {
  color: '#27272a',
  fontSize: '14px',
  lineHeight: '1.6',
  margin: '4px 0',
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
  border: '1px solid #fde68a',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '20px 0',
};

const noticeHeading: React.CSSProperties = {
  color: '#92400e',
  fontSize: '13px',
  fontWeight: '700',
  margin: '0 0 6px 0',
};

const noticeText: React.CSSProperties = {
  color: '#78350f',
  fontSize: '13px',
  lineHeight: '1.5',
  margin: '0',
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

export function OfficeVisitAcknowledgedEmail({
  fullName = 'Valued Visitor',
  officeName = 'EARIST Office',
  personnelName = 'Designated Personnel',
  visitDate = 'Scheduled Date',
  purpose,
  trackingUrl = 'https://egatepass.tech/track',
}: OfficeVisitAcknowledgedEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your EARIST visit request has been received — Track your request status</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />
          <Section>
            <Heading as="h2" style={{ color: '#800000', fontSize: '18px', fontWeight: '700', margin: '0 0 16px 0' }}>
              Visit Request Submitted — Review in Progress
            </Heading>
            <Text style={greetingText}>
              Hello <strong>{fullName}</strong>,
            </Text>

            <Text style={bodyText}>
              Your appointment request has been securely submitted to the concerned EARIST office for review.
            </Text>

          <Section style={cardSection}>
            <Heading as="h3" style={{ fontSize: '15px', color: '#18181b', margin: '0 0 12px 0' }}>
              Request Details:
            </Heading>
            <Text style={detailRow}>
              <strong>Visitor:</strong> {fullName}
            </Text>
            <Text style={detailRow}>
              <strong>Destination:</strong> {officeName}
            </Text>
            <Text style={detailRow}>
              <strong>Requested personnel:</strong> {personnelName}
            </Text>
            <Text style={detailRow}>
              <strong>Requested visit date:</strong> {visitDate}
            </Text>
            {purpose && (
              <Text style={detailRow}>
                <strong>Purpose:</strong> {purpose}
              </Text>
            )}
            <Text style={{ ...detailRow, color: '#b45309', fontWeight: 'bold' }}>
              <strong>Current status:</strong> Pending Office Confirmation
            </Text>
          </Section>

          <Text style={bodyText}>
            Your request is now waiting for the concerned office to review it. You can check its status anytime using your private tracking link:
          </Text>

          <Section style={buttonContainer}>
            <Button style={actionButton} href={trackingUrl}>
              Track My Visit Request
            </Button>
            <Text style={linkNotice}>
              Or copy and paste this link in your browser:
              <br />
              <a href={trackingUrl} style={{ color: '#800000', textDecoration: 'underline' }}>
                {trackingUrl}
              </a>
            </Text>
          </Section>

          <Section style={noticeSection}>
            <Text style={noticeHeading}>Important Information Regarding Gate Entry:</Text>
            <Text style={noticeText}>
              • You will receive another email once the office approves or rejects your request.
              <br />
              • Please remember that <strong>no QR pass has been issued yet</strong>. An official QR gate pass will only be generated and emailed after approval.
            </Text>
          </Section>

          <Hr style={hrStyle} />

          <Text style={footerText}>
            Thank you for using EARIST E-GatePass.
            <br />
            Eulogio &quot;Amang&quot; Rodriguez Institute of Science and Technology
            <br />
            Nagtahan, Sampaloc, Manila, Philippines
          </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default OfficeVisitAcknowledgedEmail;
