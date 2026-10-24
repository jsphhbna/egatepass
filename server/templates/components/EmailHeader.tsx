import React from 'react';
import { Section, Heading, Text, Img } from '@react-email/components';
import { EARIST_EMAIL_HEADER_ART_URL } from '../branding.js';

export interface EmailHeaderProps {
  subtitle?: string;
}

const headerSection: React.CSSProperties = {
  borderBottom: '2px solid #800000',
  paddingBottom: '16px',
  marginBottom: '24px',
};

const headerArtStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  maxWidth: '504px',
  height: 'auto',
  borderRadius: '4px',
  margin: '0 0 14px 0',
};

const headerTitle: React.CSSProperties = {
  color: '#800000',
  fontSize: '24px',
  fontWeight: '700',
  letterSpacing: '-0.5px',
  margin: '0 0 4px 0',
  lineHeight: '1.2',
};

const headerSubtitle: React.CSSProperties = {
  color: '#71717a',
  fontSize: '13px',
  fontWeight: '500',
  lineHeight: '1.4',
  margin: '0',
};

export function EmailHeader({
  subtitle = 'Eulogio "Amang" Rodriguez Institute of Science and Technology',
}: EmailHeaderProps): React.JSX.Element {
  return (
    <Section style={headerSection}>
      <Img
        src={EARIST_EMAIL_HEADER_ART_URL}
        alt="EARIST campus"
        width="504"
        height="190"
        style={headerArtStyle}
      />
      <Heading style={headerTitle}>EARIST E-GatePass</Heading>
      <Text style={headerSubtitle}>{subtitle}</Text>
    </Section>
  );
}

export default EmailHeader;
