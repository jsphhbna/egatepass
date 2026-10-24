import React from 'react';
import { Section, Heading, Text, Img } from '@react-email/components';
import { EARIST_LOGO_URL, EARIST_BUILDING_EMAIL_URL } from '../branding.js';

export interface EmailHeaderProps {
  subtitle?: string;
}

const headerSection: React.CSSProperties = {
  borderBottom: '2px solid #800000',
  paddingBottom: '16px',
  marginBottom: '24px',
};

const logoStyle: React.CSSProperties = {
  display: 'block',
  margin: '0 0 12px 0',
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

const buildingStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  maxWidth: '504px',
  height: 'auto',
  borderRadius: '6px',
  marginTop: '16px',
};

export function EmailHeader({
  subtitle = 'Eulogio "Amang" Rodriguez Institute of Science and Technology',
}: EmailHeaderProps): React.JSX.Element {
  return (
    <Section style={headerSection}>
      <Img
        src={EARIST_LOGO_URL}
        alt="EARIST seal"
        width="64"
        height="64"
        style={logoStyle}
      />
      <Heading style={headerTitle}>EARIST E-GatePass</Heading>
      <Text style={headerSubtitle}>{subtitle}</Text>
      <Img
        src={EARIST_BUILDING_EMAIL_URL}
        alt="EARIST Main Campus building"
        width="504"
        height="155"
        style={buildingStyle}
      />
    </Section>
  );
}

export default EmailHeader;
