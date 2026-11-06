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
import { formatPassReference } from '../../src/lib/passPresentation.js';

export interface OfficeVisitApprovedEmailProps {
  fullName: string;
  officeName: string;
  personnelName: string;
  visitDate: string;
  purpose: string;
  publicReference: string;
  validFrom?: string;
  validUntil?: string;
  attachmentFilename?: string;
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

const noticeSection: React.CSSProperties = {
  backgroundColor: '#f0fdf4',
  border: '1px solid #bbf7d0',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '20px 0',
};

const noticeText: React.CSSProperties = {
  color: '#166534',
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

export function OfficeVisitApprovedEmail({
  fullName,
  officeName,
  personnelName,
  visitDate,
  purpose,
  publicReference,
  validFrom,
  validUntil,
  attachmentFilename,
}: OfficeVisitApprovedEmailProps) {
  const formattedRef = formatPassReference(publicReference);
  const displayAttachmentName = attachmentFilename || `egatepass-${formattedRef}.png`;

  return (
    <Html lang="en">
      <Head />
      <Preview>Appointment Approved — EARIST E-GatePass Ref: {formattedRef}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />
          <Section>
            <Heading as="h2" style={{ color: '#800000', fontSize: '18px', fontWeight: '700', margin: '0 0 16px 0' }}>
              Office Visit Approved — Your E-GatePass is Ready
            </Heading>
            <Text style={greetingText}>Hello <strong>{fullName}</strong>,</Text>
            <Text style={bodyText}>
              Your appointment request with <strong>{personnelName}</strong> at <strong>{officeName}</strong> has been approved. Your official digital E-GatePass has been issued and is attached to this email as an image (<code>{displayAttachmentName}</code>).
            </Text>

            <Section style={cardSection}>
              <Text style={detailRow}><strong>Visitor Name:</strong> {fullName}</Text>
              <Text style={detailRow}><strong>Destination Office:</strong> {officeName}</Text>
              <Text style={detailRow}><strong>Meeting With:</strong> {personnelName}</Text>
              <Text style={detailRow}><strong>Pass Reference:</strong> {formattedRef}</Text>
              <Text style={detailRow}><strong>Visit Date:</strong> {visitDate}</Text>
              <Text style={detailRow}><strong>Purpose:</strong> {purpose}</Text>
              {validFrom && validUntil && (
                <Text style={detailRow}><strong>Valid Hours:</strong> {validFrom} – {validUntil} (Asia/Manila)</Text>
              )}
            </Section>

            <Section style={noticeSection}>
              <Text style={noticeText}>
                <strong>Campus Arrival Instructions:</strong>
                <br />• Present your attached QR code at the campus entry scanner.
                <br />• Bring a valid physical ID card matching your registration.
                <br />• Upon arriving at <strong>{officeName}</strong>, inform the office staff so they can confirm your arrival.
                <br />• Scan your QR code at the exit gate when departing campus.
              </Text>
            </Section>

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

export default OfficeVisitApprovedEmail;
