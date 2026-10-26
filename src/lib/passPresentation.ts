import { formatManilaDate } from './manilaTime';
import { generateBrandedQrDataUrl } from './brandedQr';

export const INSTITUTION_NAME = 'EARIST E-GATEPASS';
export const INSTITUTION_SUBTITLE = 'Eulogio "Amang" Rodriguez Institute of Science and Technology';

export interface PassPresentation {
  institutionName: string;
  systemTitle?: string;
  visitorName: string;
  visitDate: string;
  passReference: string;
  rawReference: string;
  qrToken: string;
  validityWindow?: string | null;
  purpose?: string | null;
}

export interface FormatPassParams {
  firstName?: string;
  middleName?: string | null;
  lastName?: string | null;
  visitorName?: string;
  visitDate: string | Date;
  passReference: string; // UUID or existing reference
  qrToken: string;
  validityWindow?: string | null;
  purpose?: string | null;
}

/**
 * Format visitor full name consistently across all presentation surfaces.
 * Outputs uppercase for institutional clarity: e.g. "JUAN DELA CRUZ"
 */
export function formatPassVisitorName(
  firstNameOrObj: string | { firstName?: string; middleName?: string | null; lastName?: string | null; visitorName?: string },
  middleName?: string | null,
  lastName?: string | null
): string {
  if (typeof firstNameOrObj === 'object' && firstNameOrObj !== null) {
    if (firstNameOrObj.visitorName) return firstNameOrObj.visitorName.trim().toUpperCase();
    const parts = [
      firstNameOrObj.firstName?.trim(),
      firstNameOrObj.middleName?.trim(),
      firstNameOrObj.lastName?.trim(),
    ].filter(Boolean);
    return parts.join(' ').toUpperCase();
  }
  const parts = [firstNameOrObj?.trim(), middleName?.trim(), lastName?.trim()].filter(Boolean);
  return parts.join(' ').toUpperCase();
}

/**
 * Format Manila visit date for institutional display: e.g. "Oct 27, 2026"
 */
export function formatPassVisitDate(visitDate: string | Date): string {
  if (!visitDate) return '—';
  // If visitDate is 'YYYY-MM-DD', append Manila timezone offset to avoid UTC date shift
  if (typeof visitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visitDate)) {
    return formatManilaDate(`${visitDate}T00:00:00+08:00`);
  }
  return formatManilaDate(visitDate);
}

/**
 * Format opaque reference into canonical institutional pass reference:
 * "EG-" followed by the first 8 hex characters uppercase: e.g. "EG-8A2B3C4D"
 */
export function formatPassReference(rawRef: string): string {
  if (!rawRef) return 'EG-00000000';
  const clean = rawRef.trim().toUpperCase();
  if (clean.startsWith('EG-')) return clean;
  // If UUID or alphanumeric, strip dashes and take first 8 chars
  const hexOnly = clean.replace(/[^A-Z0-9]/g, '');
  return `EG-${hexOnly.slice(0, 8) || '00000000'}`;
}

/**
 * Canonical factory for pass presentation data
 */
export function createPassPresentation(params: FormatPassParams): PassPresentation {
  const visitorName = params.visitorName
    ? params.visitorName.trim().toUpperCase()
    : formatPassVisitorName(params.firstName || '', params.middleName, params.lastName);

  return {
    institutionName: INSTITUTION_NAME,
    systemTitle: 'CAMPUS VISITOR PASS',
    visitorName,
    visitDate: formatPassVisitDate(params.visitDate),
    passReference: formatPassReference(params.passReference),
    rawReference: params.passReference,
    qrToken: params.qrToken,
    validityWindow: params.validityWindow ?? null,
    purpose: params.purpose ?? null,
  };
}

/**
 * Renders the full institutional pass card onto an HTML5 canvas and exports as PNG data URL.
 * Used for complete card downloads (Phase 1.4) and Web Share API.
 */
export async function renderPassCardToDataUrl(
  presentation: PassPresentation,
  options?: { qrDataUrl?: string; width?: number }
): Promise<string> {
  const width = options?.width ?? 480;
  const height = Math.round(width * 1.45); // 480 x 696 standard pass card aspect ratio

  if (typeof document === 'undefined') {
    // Return standard branded QR data URL in non-browser environments
    return options?.qrDataUrl ?? (await generateBrandedQrDataUrl(presentation.qrToken, { size: 360 }));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return options?.qrDataUrl ?? (await generateBrandedQrDataUrl(presentation.qrToken, { size: 360 }));
  }

  // 1. Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // 2. Card Border & Outer Styling
  ctx.strokeStyle = '#800000'; // EARIST maroon
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, width - 16, height - 16);

  ctx.strokeStyle = '#DAA520'; // Gold accent inner border
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, width - 28, height - 28);

  // 3. Header Banner
  ctx.fillStyle = '#800000';
  ctx.fillRect(16, 16, width - 32, 64);

  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.font = 'bold 20px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillText('EARIST E-GATEPASS', width / 2, 45);

  ctx.font = '10px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillStyle = '#FDE047'; // Gold
  ctx.fillText('OFFICIAL CAMPUS VISITOR ACCESS PASS', width / 2, 64);

  // 4. Visitor Name
  ctx.fillStyle = '#18181B';
  ctx.font = 'bold 22px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillText(presentation.visitorName, width / 2, 125);

  // 5. Visit Date
  ctx.fillStyle = '#52525B';
  ctx.font = '600 14px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillText(`Visit Date: ${presentation.visitDate}`, width / 2, 150);

  if (presentation.validityWindow) {
    ctx.font = '12px "Segoe UI", Roboto, Arial, sans-serif';
    ctx.fillStyle = '#800000';
    ctx.fillText(`Valid Hours: ${presentation.validityWindow}`, width / 2, 170);
  }

  // 6. QR Code Image
  const qrDataUrl = options?.qrDataUrl ?? (await generateBrandedQrDataUrl(presentation.qrToken, { size: 320 }));
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const qrSize = 250;
      const qrX = (width - qrSize) / 2;
      const qrY = 190;
      // White container box with subtle border
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16);
      ctx.strokeStyle = '#E4E4E7';
      ctx.lineWidth = 1;
      ctx.strokeRect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16);

      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = qrDataUrl;
  });

  // 7. Pass Reference
  ctx.fillStyle = '#18181B';
  ctx.font = 'bold 16px "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`Ref: ${presentation.passReference}`, width / 2, 485);

  // 8. Purpose (if present)
  if (presentation.purpose) {
    ctx.fillStyle = '#71717A';
    ctx.font = 'italic 12px "Segoe UI", Roboto, Arial, sans-serif';
    const truncatedPurpose = presentation.purpose.length > 40
      ? `${presentation.purpose.slice(0, 37)}...`
      : presentation.purpose;
    ctx.fillText(`Purpose: ${truncatedPurpose}`, width / 2, 510);
  }

  // 9. Institutional Notice & Watermark
  ctx.fillStyle = '#A1A1AA';
  ctx.font = '10px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillText('Present this pass with a valid ID at campus gate security.', width / 2, height - 35);
  ctx.fillText('Nagtahan, Sampaloc, Manila • Data Privacy Act Aligned', width / 2, height - 22);

  return canvas.toDataURL('image/png');
}
