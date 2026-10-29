import type { PassPresentation } from './passPresentation.js';
import { splitGraphemes, graphemeLength, truncateGraphemes } from './textGraphemes.js';

export function escapeXml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface CanonicalNameLayout {
  isTwoLines: boolean;
  line1: string;
  line2?: string;
  line1Y: number;
  line2Y?: number;
  fontSize: number;
  line1Attrs: string;
  line2Attrs: string;
  dateY: number;
  validityY: number;
}

export function fitCanonicalVisitorName(name: string): CanonicalNameLayout {
  const trimmed = (name || '').trim();
  const totalGraphemes = graphemeLength(trimmed);

  if (totalGraphemes <= 24) {
    return {
      isTwoLines: false,
      line1: trimmed,
      line1Y: 125,
      fontSize: 22,
      line1Attrs: '',
      line2Attrs: '',
      dateY: 150,
      validityY: 170,
    };
  }

  // Maximum readable graphemes allowed on line 1 and line 2
  const MAX_LINE_GRAPHEMES = 26;

  const words = trimmed.split(/\s+/).filter(Boolean);
  let line1 = '';
  let line2 = '';

  if (words.length <= 1) {
    // Single long token without whitespace
    const g = splitGraphemes(trimmed);
    const mid = Math.min(MAX_LINE_GRAPHEMES, Math.ceil(g.length / 2));
    line1 = g.slice(0, mid).join('');
    const remaining = g.slice(mid).join('');
    if (graphemeLength(remaining) > MAX_LINE_GRAPHEMES) {
      line2 = truncateGraphemes(remaining, MAX_LINE_GRAPHEMES, '…');
    } else {
      line2 = remaining;
    }
  } else {
    // Word-aware distribution across up to 2 lines
    let bestIdx = 1;
    let minDiff = Infinity;

    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i).join(' ');
      const l1Len = graphemeLength(l1);
      const l2Len = graphemeLength(l2);

      const l1Overflow = l1Len > MAX_LINE_GRAPHEMES ? 1000 : 0;
      const penalty = l1Overflow + Math.abs(l1Len - l2Len);
      if (penalty < minDiff) {
        minDiff = penalty;
        bestIdx = i;
      }
    }

    line1 = words.slice(0, bestIdx).join(' ');
    let rawLine2 = words.slice(bestIdx).join(' ');

    if (graphemeLength(line1) > MAX_LINE_GRAPHEMES) {
      line1 = truncateGraphemes(line1, MAX_LINE_GRAPHEMES, '…');
    }

    if (graphemeLength(rawLine2) > MAX_LINE_GRAPHEMES) {
      line2 = truncateGraphemes(rawLine2, MAX_LINE_GRAPHEMES, '…');
    } else {
      line2 = rawLine2;
    }
  }

  const l1Len = graphemeLength(line1);
  const l2Len = graphemeLength(line2);

  // Apply modest textLength squeeze attribute only when approaching boundary
  const line1Attrs = l1Len >= 24 ? ' textLength="420" lengthAdjust="spacingAndGlyphs"' : '';
  const line2Attrs = l2Len >= 24 ? ' textLength="420" lengthAdjust="spacingAndGlyphs"' : '';

  return {
    isTwoLines: true,
    line1,
    line2,
    line1Y: 112,
    line2Y: 136,
    fontSize: 18,
    line1Attrs,
    line2Attrs,
    dateY: 158,
    validityY: 176,
  };
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
  const nameLayout = fitCanonicalVisitorName(presentation.visitorName);
  const escapedDate = escapeXml(presentation.visitDate);
  const escapedRef = escapeXml(presentation.passReference);
  const escapedValidity = presentation.validityWindow ? escapeXml(presentation.validityWindow) : null;
  const escapedPurpose = presentation.purpose
    ? escapeXml(truncateGraphemes(presentation.purpose, 40, '...'))
    : null;

  const validityElement = escapedValidity
    ? `<text x="240" y="${nameLayout.validityY}" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="12" font-weight="500" fill="#800000">Valid Hours: ${escapedValidity}</text>`
    : '';

  const purposeElement = escapedPurpose
    ? `<text x="240" y="510" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="12" font-style="italic" fill="#71717A">Purpose: ${escapedPurpose}</text>`
    : '';

  const visitorNameElement = nameLayout.isTwoLines
    ? `<text x="240" y="${nameLayout.line1Y}" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="${nameLayout.fontSize}" font-weight="bold" fill="#18181B" data-testid="canonical-pass-visitor-name"${nameLayout.line1Attrs}>${escapeXml(nameLayout.line1)}</text>
  <text x="240" y="${nameLayout.line2Y}" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="${nameLayout.fontSize}" font-weight="bold" fill="#18181B" data-testid="canonical-pass-visitor-name"${nameLayout.line2Attrs}>${escapeXml(nameLayout.line2!)}</text>`
    : `<text x="240" y="${nameLayout.line1Y}" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="${nameLayout.fontSize}" font-weight="bold" fill="#18181B" data-testid="canonical-pass-visitor-name"${nameLayout.line1Attrs}>${escapeXml(nameLayout.line1)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 696" width="480" height="696" style="background:#ffffff;">
  <!-- Background -->
  <rect width="480" height="696" fill="#FFFFFF"/>

  <!-- Outer Maroon Border -->
  <rect x="8" y="8" width="464" height="680" fill="none" stroke="#800000" stroke-width="6"/>

  <!-- Inner Gold Accent Border -->
  <rect x="14" y="14" width="452" height="668" fill="none" stroke="#DAA520" stroke-width="2"/>

  <!-- Header Banner -->
  <rect x="16" y="16" width="448" height="64" fill="#800000"/>
  <text x="240" y="45" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="20" font-weight="bold" fill="#FFFFFF">EARIST E-GATEPASS</text>
  <text x="240" y="64" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="10" font-weight="600" fill="#FDE047" letter-spacing="1">OFFICIAL CAMPUS VISITOR ACCESS PASS</text>

  <!-- Visitor Details -->
  ${visitorNameElement}
  <text x="240" y="${nameLayout.dateY}" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="14" font-weight="600" fill="#52525B" data-testid="canonical-pass-visit-date">Visit Date: ${escapedDate}</text>
  ${validityElement}

  <!-- QR Container & Image -->
  <rect x="107" y="182" width="266" height="266" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="1" rx="8"/>
  <image href="${qrDataUrl}" x="115" y="190" width="250" height="250" preserveAspectRatio="xMidYMid meet" data-testid="canonical-pass-qr-image"/>

  <!-- Pass Reference -->
  <text x="240" y="485" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="16" font-weight="bold" fill="#18181B" data-testid="canonical-pass-reference">Ref: ${escapedRef}</text>

  <!-- Purpose -->
  ${purposeElement}

  <!-- Institutional Notice & Watermark -->
  <text x="240" y="655" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="10" fill="#A1A1AA">Present this pass with a valid ID at campus gate security.</text>
  <text x="240" y="670" text-anchor="middle" font-family="'Egatepass Noto Sans', 'Noto Sans', Arial, sans-serif" font-size="10" fill="#A1A1AA">Nagtahan, Sampaloc, Manila • Visitor information handled under EARIST privacy policy</text>
</svg>`.trim();
}
