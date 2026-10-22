import React from 'react';
import { EARIST_LOGO_URL } from './branding.js';
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
  Img,
} from '@react-email/components';

export interface PassIssuedEmailProps {
  fullName: string;
  visitDate: string;
  purpose: string;
  publicReference: string;
  validFrom?: string;
  validUntil?: string;
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

const logoStyle: React.CSSProperties = {
  display: 'block',
  margin: '0 0 12px 0',
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
}: PassIssuedEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your EARIST Gate Pass QR Code — Ref: {publicReference}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          <Section style={headerSection}>
            <Img
              src={EARIST_LOGO_URL}
              alt="EARIST seal"
              width="64"
              height="64"
              style={logoStyle}
            />
            <Heading style={headerTitle}>EARIST E-GatePass</Heading>
            <Text style={headerSubtitle}>Official Campus Visitor Gate Pass</Text>
          </Section>
          <Section>
            <Text style={greetingText}>Hello <strong>{fullName}</strong>,</Text>
            <Text style={bodyText}>
              Your campus visitor pass has been issued. Your scannable entry QR code is attached to this email as an image file (<code>earist-gate-pass-qr.png</code>).
            </Text>
            <Section style={cardSection}>
              <Text style={detailRow}><strong>Visitor Name:</strong> {fullName}</Text>
              <Text style={detailRow}><strong>Pass Reference:</strong> {publicReference}</Text>
              <Text style={detailRow}><strong>Visit Date:</strong> {visitDate}</Text>
              {validFrom && validUntil && (
                <Text style={detailRow}><strong>Valid Hours:</strong> {validFrom} – {validUntil} (Asia/Manila)</Text>
              )}
              <Text style={detailRow}><strong>Purpose:</strong> {purpose}</Text>
            </Section>
            <Section style={noticeSection}>
              <Text style={noticeText}>
                <strong>Security Notice:</strong> Present the attached QR code at the entrance scanner upon arrival. You must present the same valid government or school ID used during registration.
              </Text>
            </Section>
          </Section>
          <Hr style={hrStyle} />
          <Section>
            <Text style={footerText}>
              EARIST Manila Campus • Nagtahan, Sampaloc, Manila • Automated Gate Pass Notification
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
export default PassIssuedEmail;
