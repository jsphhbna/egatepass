import { formatManilaDate } from './manilaTime.js';
import { generateBrandedQrDataUrl } from './brandedQr.js';
import { generateCanonicalDigitalPassSvg } from './digitalPassArtifact.js';

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
  plateNumber?: string | null;
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
  plateNumber?: string | null;
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
    plateNumber: params.plateNumber ?? null,
  };
}

interface EmbeddedFontCache {
  regularBase64: string;
  boldBase64: string;
}

let cachedEmbeddedFonts: EmbeddedFontCache | null = null;

export function __resetEmbeddedFontCacheForTests(): void {
  cachedEmbeddedFonts = null;
}

export function __setEmbeddedFontCacheForTests(fonts: EmbeddedFontCache | null): void {
  cachedEmbeddedFonts = fonts;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

export async function getSelfContainedSvgFontFace(): Promise<string> {
  if (!cachedEmbeddedFonts) {
    if (typeof fetch !== 'function') {
      throw new Error('deterministic_font_preparation_failed: fetch is not available in environment');
    }

    const [regularRes, boldRes] = await Promise.all([
      fetch('/fonts/NotoSans-Regular.ttf'),
      fetch('/fonts/NotoSans-Bold.ttf'),
    ]);

    if (!regularRes.ok || !boldRes.ok) {
      throw new Error(
        `deterministic_font_preparation_failed: font fetch returned status ${regularRes.status}/${boldRes.status}`
      );
    }

    const [regularBuf, boldBuf] = await Promise.all([
      regularRes.arrayBuffer(),
      boldRes.arrayBuffer(),
    ]);

    if (!regularBuf.byteLength || !boldBuf.byteLength) {
      throw new Error('deterministic_font_preparation_failed: font buffer is empty');
    }

    cachedEmbeddedFonts = {
      regularBase64: bufferToBase64(regularBuf),
      boldBase64: bufferToBase64(boldBuf),
    };
  }

  return `<defs>
    <style>
      @font-face {
        font-family: 'Egatepass Noto Sans';
        src: url('data:font/ttf;charset=utf-8;base64,${cachedEmbeddedFonts.regularBase64}') format('truetype');
        font-weight: 400;
        font-style: normal;
      }
      @font-face {
        font-family: 'Egatepass Noto Sans';
        src: url('data:font/ttf;charset=utf-8;base64,${cachedEmbeddedFonts.boldBase64}') format('truetype');
        font-weight: 700;
        font-style: normal;
      }
    </style>
  </defs>`;
}

/**
 * Renders the full canonical institutional pass card using the shared SVG template
 * onto an HTML5 canvas and exports as PNG data URL.
 * Used for complete card downloads.
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

  const fontDefs = await getSelfContainedSvgFontFace();
  let svg = generateCanonicalDigitalPassSvg(presentation, qrDataUrl);
  svg = svg.replace(/(<svg[^>]*>)/i, `$1\n  ${fontDefs}`);

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
