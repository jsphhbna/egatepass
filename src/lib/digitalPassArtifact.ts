import type { PassPresentation } from './passPresentation.js';

export function escapeXml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates the canonical digital E-GatePass SVG artifact.
 * Pure function with no DOM dependencies, shared by browser and server.
 * Fixed geometry: 480 x 696.
 */
export function generateCanonicalDigitalPassSvg(
  presentation: PassPresentation,
  qrDataUrl: string
): string {
  const escapedName = escapeXml(presentation.visitorName);
  const escapedDate = escapeXml(presentation.visitDate);
  const escapedRef = escapeXml(presentation.passReference);
  const escapedValidity = presentation.validityWindow ? escapeXml(presentation.validityWindow) : null;
  const escapedPurpose = presentation.purpose
    ? escapeXml(
        presentation.purpose.length > 40
          ? `${presentation.purpose.slice(0, 37)}...`
          : presentation.purpose
      )
    : null;

  const validityElement = escapedValidity
    ? `<text x="240" y="170" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="12" font-weight="500" fill="#800000">Valid Hours: ${escapedValidity}</text>`
    : '';

  const purposeElement = escapedPurpose
    ? `<text x="240" y="510" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="12" font-style="italic" fill="#71717A">Purpose: ${escapedPurpose}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 696" width="480" height="696" style="background:#ffffff;">
  <!-- Background -->
  <rect width="480" height="696" fill="#FFFFFF"/>

  <!-- Outer Maroon Border -->
  <rect x="8" y="8" width="464" height="680" fill="none" stroke="#800000" stroke-width="6"/>

  <!-- Inner Gold Accent Border -->
  <rect x="14" y="14" width="452" height="668" fill="none" stroke="#DAA520" stroke-width="2"/>

  <!-- Header Banner -->
  <rect x="16" y="16" width="448" height="64" fill="#800000"/>
  <text x="240" y="45" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="20" font-weight="bold" fill="#FFFFFF">EARIST E-GATEPASS</text>
  <text x="240" y="64" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="10" font-weight="600" fill="#FDE047" letter-spacing="1">OFFICIAL CAMPUS VISITOR ACCESS PASS</text>

  <!-- Visitor Details -->
  <text x="240" y="125" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="22" font-weight="bold" fill="#18181B" data-testid="canonical-pass-visitor-name">${escapedName}</text>
  <text x="240" y="150" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="14" font-weight="600" fill="#52525B" data-testid="canonical-pass-visit-date">Visit Date: ${escapedDate}</text>
  ${validityElement}

  <!-- QR Container & Image -->
  <rect x="107" y="182" width="266" height="266" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1" rx="8"/>
  <image href="${qrDataUrl}" x="115" y="190" width="250" height="250" preserveAspectRatio="xMidYMid meet" data-testid="canonical-pass-qr-image"/>

  <!-- Pass Reference -->
  <text x="240" y="485" text-anchor="middle" font-family="'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace" font-size="16" font-weight="bold" fill="#18181B" data-testid="canonical-pass-reference">Ref: ${escapedRef}</text>

  <!-- Purpose -->
  ${purposeElement}

  <!-- Institutional Notice & Watermark -->
  <text x="240" y="655" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="10" fill="#A1A1AA">Present this pass with a valid ID at campus gate security.</text>
  <text x="240" y="670" text-anchor="middle" font-family="'Segoe UI', Roboto, Arial, sans-serif" font-size="10" fill="#A1A1AA">Nagtahan, Sampaloc, Manila • Visitor information handled under EARIST privacy policy</text>
</svg>`.trim();
}
