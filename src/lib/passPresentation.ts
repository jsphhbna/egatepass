import { formatManilaDate } from './manilaTime.js';
import { generateBrandedQrDataUrl } from './brandedQr.js';

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

import { generateCanonicalDigitalPassSvg } from './digitalPassArtifact.js';

/**
 * Renders the full canonical institutional pass card using the shared SVG template
 * onto an HTML5 canvas and exports as PNG data URL.
 * Used for complete card downloads and Web Share API.
 */
export async function renderPassCardToDataUrl(
  presentation: PassPresentation,
  options?: { qrDataUrl?: string; width?: number }
): Promise<string> {
  const width = options?.width ?? 480;
  const height = 696;
  const qrDataUrl = options?.qrDataUrl ?? (await generateBrandedQrDataUrl(presentation.qrToken, { size: 320 }));

  if (typeof document === 'undefined') {
    throw new Error('Canvas rendering is not supported in this environment');
  }

  const svg = generateCanonicalDigitalPassSvg(presentation, qrDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to obtain 2D canvas rendering context');
  }

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          img.onload = null;
          img.onerror = null;
          reject(new Error('Pass card rasterization timed out'));
        }
      }, 5000);

      img.onload = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            ctx.drawImage(img, 0, 0, width, height);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      };

      img.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Failed to load pass card SVG image'));
        }
      };

      img.src = url;
    });
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
