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
  Hr,
} from '@react-email/components';

export interface OfficeVisitRejectedEmailProps {
  fullName: string;
  officeName: string;
  personnelName: string;
  visitDate: string;
  rejectionReason: string;
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

const reasonSection: React.CSSProperties = {
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '20px 0',
};

const reasonTitle: React.CSSProperties = {
  color: '#991b1b',
  fontSize: '13px',
  fontWeight: '700',
  margin: '0 0 6px 0',
};

const reasonText: React.CSSProperties = {
  color: '#7f1d1d',
  fontSize: '14px',
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

export function OfficeVisitRejectedEmail({
  fullName,
  officeName,
  personnelName,
  visitDate,
  rejectionReason,
}: OfficeVisitRejectedEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Appointment Request Update — {officeName}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />
          <Section>
            <Heading as="h2" style={{ color: '#800000', fontSize: '18px', fontWeight: '700', margin: '0 0 16px 0' }}>
              Office Visit Request Update
            </Heading>
            <Text style={greetingText}>Hello <strong>{fullName}</strong>,</Text>
            <Text style={bodyText}>
              Thank you for contacting EARIST. We regret to inform you that your visit request to meet with <strong>{personnelName}</strong> at <strong>{officeName}</strong> on <strong>{visitDate}</strong> could not be approved at this time.
            </Text>

            <Section style={cardSection}>
              <Text style={detailRow}><strong>Visitor Name:</strong> {fullName}</Text>
              <Text style={detailRow}><strong>Requested Office:</strong> {officeName}</Text>
              <Text style={detailRow}><strong>Requested Person:</strong> {personnelName}</Text>
              <Text style={detailRow}><strong>Requested Date:</strong> {visitDate}</Text>
            </Section>

            <Section style={reasonSection}>
              <Text style={reasonTitle}>Reason provided by the office:</Text>
              <Text style={reasonText}>{rejectionReason}</Text>
            </Section>

            <Text style={bodyText}>
              No E-GatePass has been issued for this request. If you wish to reschedule or have general inquiries, please contact <strong>{officeName}</strong> directly or submit a new request for an alternate date.
            </Text>

            <Hr style={hrStyle} />
            <Text style={footerText}>
              Eulogio "Amang" Rodriguez Institute of Science and Technology
              <br />
              Nagtahan, Sampaloc, Manila, Philippines • E-GatePass Automated Visitor System
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default OfficeVisitRejectedEmail;
