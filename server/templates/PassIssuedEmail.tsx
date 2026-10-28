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

export interface PassIssuedEmailProps {
  fullName: string;
  visitDate: string;
  purpose: string;
  publicReference: string;
  validFrom?: string;
  validUntil?: string;
  visitorInstructions?: string[];
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
  backgroundColor: '#fffbeb',
  border: '1px solid #fef3c7',
  borderRadius: '8px',
  padding: '14px 18px',
  margin: '20px 0',
};

const noticeText: React.CSSProperties = {
  color: '#92400e',
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

export function PassIssuedEmail({
  fullName,
  visitDate,
  purpose,
  publicReference,
  validFrom,
  validUntil,
  visitorInstructions = [
    'Follow the EARIST visitor dress code and campus policies.',
    'Bring a valid ID for identity verification at the gate.',
    'Keep your E-GatePass ready before approaching the entrance.',
    'This visitor pass is personal and non-transferable.',
    'Scan your E-GatePass when leaving the campus.',
  ],
  attachmentFilename,
}: PassIssuedEmailProps) {
  const formattedRef = formatPassReference(publicReference);
  const displayAttachmentName = attachmentFilename || `egatepass-${formattedRef}.png`;

  return (
    <Html lang="en">
      <Head />
      <Preview>Your EARIST E-GatePass is ready — Ref: {formattedRef}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <EmailHeader />
          <Section>
            <Heading as="h2" style={{ color: '#800000', fontSize: '18px', fontWeight: '700', margin: '0 0 16px 0' }}>
              Official Campus Visitor E-GatePass
            </Heading>
            <Text style={greetingText}>Hello <strong>{fullName}</strong>,</Text>
            <Text style={bodyText}>
              Your campus visitor pass is ready. Your complete canonical digital E-GatePass is attached to this email as an image file (<code>{displayAttachmentName}</code>).
            </Text>

            <Section style={cardSection}>
              <Text style={detailRow}><strong>Visitor Name:</strong> {fullName}</Text>
              <Text style={detailRow}><strong>Pass Reference:</strong> {formattedRef}</Text>
              <Text style={detailRow}><strong>Visit Date:</strong> {visitDate}</Text>
              {validFrom && validUntil && (
                <Text style={detailRow}><strong>Valid Hours:</strong> {validFrom} – {validUntil} (Asia/Manila)</Text>
              )}
              <Text style={detailRow}><strong>Purpose:</strong> {purpose}</Text>
            </Section>

            {visitorInstructions && visitorInstructions.length > 0 && (
              <Section style={{ margin: '16px 0', padding: '14px 18px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <Text style={{ fontWeight: '600', color: '#1e293b', fontSize: '13px', margin: '0 0 8px 0' }}>
                  Before You Arrive:
                </Text>
                <ul style={{ margin: '0', paddingLeft: '20px', color: '#334155', fontSize: '12px', lineHeight: '1.6' }}>
                  {visitorInstructions.map((instruction, idx) => (
                    <li key={idx} style={{ marginBottom: '4px' }}>{instruction}</li>
                  ))}
                </ul>
              </Section>
            )}

            <Section style={noticeSection}>
              <Text style={noticeText}>
                <strong>Security Notice:</strong> Present your attached E-GatePass along with a valid ID upon arrival at campus gate security. This visitor pass is personal and strictly non-transferable—do not share your QR code or pass with another person.
              </Text>
            </Section>
          </Section>
          <Hr style={hrStyle} />
          <Section>
            <Text style={footerText}>
              EARIST Manila Campus • Nagtahan, Sampaloc, Manila • Automated E-GatePass Notification
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default PassIssuedEmail;
