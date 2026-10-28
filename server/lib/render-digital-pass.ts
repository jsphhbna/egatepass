import sharp from 'sharp';
import { generateCanonicalDigitalPassSvg } from '../../src/lib/digitalPassArtifact.js';
import { generateQrPngBuffer } from '../email.js';
import {
  formatPassReference,
  formatPassVisitDate,
  formatPassVisitorName,
  type PassPresentation,
} from '../../src/lib/passPresentation.js';

export interface ServerPassPresentationInput {
  fullName: string;
  visitDate: string;
  publicReference: string;
  qrToken: string;
  purpose?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export async function renderDigitalPassPngBuffer(input: ServerPassPresentationInput): Promise<{
  pngBuffer: Buffer;
  filename: string;
  presentation: PassPresentation;
}> {
  const qrBuffer = await generateQrPngBuffer(input.qrToken);
  const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;

  const formattedRef = formatPassReference(input.publicReference);
  const validityWindow =
    input.validFrom && input.validUntil ? `${input.validFrom} – ${input.validUntil}` : null;

  const presentation: PassPresentation = {
    institutionName: 'EARIST E-GATEPASS',
    systemTitle: 'CAMPUS VISITOR PASS',
    visitorName: formatPassVisitorName(input.fullName),
    visitDate: formatPassVisitDate(input.visitDate),
    passReference: formattedRef,
    rawReference: input.publicReference,
    qrToken: input.qrToken,
    validityWindow,
    purpose: input.purpose ?? null,
  };

  const svg = generateCanonicalDigitalPassSvg(presentation, qrDataUrl);
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const filename = `egatepass-${formattedRef}.png`;

  return { pngBuffer, filename, presentation };
}
