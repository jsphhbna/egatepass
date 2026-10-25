import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

export const SERVER_QR_CONFIG = {
  errorCorrectionLevel: 'H' as const,
  size: 360,
  logoRatio: 0.17, // 17% of QR width (strictly within 15-18% safe bounds)
  logoPadding: 6,
  margin: 2,
  darkColor: '#000000',
  lightColor: '#ffffff',
};

let cachedLogoPng: PNG | null = null;

function getLogoPng(): PNG | null {
  if (cachedLogoPng) return cachedLogoPng;
  try {
    const candidates = [
      path.resolve(process.cwd(), 'public/earist-logo-email.png'),
      path.resolve(process.cwd(), 'public/earist-logo.png'),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const buf = fs.readFileSync(cand);
        cachedLogoPng = PNG.sync.read(buf);
        return cachedLogoPng;
      }
    }
  } catch (err) {
    console.warn('Could not read EARIST logo file for server QR branding:', err);
  }
  return null;
}

export async function generateBrandedQrPngBuffer(qrToken: string): Promise<Buffer> {
  const size = SERVER_QR_CONFIG.size;
  const qrBuffer = await QRCode.toBuffer(qrToken, {
    type: 'png',
    width: size,
    margin: SERVER_QR_CONFIG.margin,
    errorCorrectionLevel: SERVER_QR_CONFIG.errorCorrectionLevel,
    color: {
      dark: SERVER_QR_CONFIG.darkColor,
      light: SERVER_QR_CONFIG.lightColor,
    },
  });

  const logoPng = getLogoPng();
  if (!logoPng) {
    return qrBuffer;
  }

  try {
    const qrPng = PNG.sync.read(qrBuffer);
    const logoSize = Math.round(size * SERVER_QR_CONFIG.logoRatio);
    const padding = SERVER_QR_CONFIG.logoPadding;
    const boxSize = logoSize + padding * 2;
    const centerX = Math.floor(qrPng.width / 2);
    const centerY = Math.floor(qrPng.height / 2);
    const boxX = centerX - Math.floor(boxSize / 2);
    const boxY = centerY - Math.floor(boxSize / 2);

    // Draw white background backing in center
    for (let y = boxY; y < boxY + boxSize; y++) {
      for (let x = boxX; x < boxX + boxSize; x++) {
        if (x >= 0 && x < qrPng.width && y >= 0 && y < qrPng.height) {
          const idx = (qrPng.width * y + x) << 2;
          qrPng.data[idx] = 255;
          qrPng.data[idx + 1] = 255;
          qrPng.data[idx + 2] = 255;
          qrPng.data[idx + 3] = 255;
        }
      }
    }

    // Draw logo centered inside white backing
    const logoX = centerX - Math.floor(logoSize / 2);
    const logoY = centerY - Math.floor(logoSize / 2);

    for (let y = 0; y < logoSize; y++) {
      for (let x = 0; x < logoSize; x++) {
        const srcX = Math.floor((x / logoSize) * logoPng.width);
        const srcY = Math.floor((y / logoSize) * logoPng.height);
        const srcIdx = (logoPng.width * srcY + srcX) << 2;

        const srcAlpha = logoPng.data[srcIdx + 3] ?? 0;
        const alpha = srcAlpha / 255;
        if (alpha > 0) {
          const targetX = logoX + x;
          const targetY = logoY + y;
          if (targetX >= 0 && targetX < qrPng.width && targetY >= 0 && targetY < qrPng.height) {
            const targetIdx = (qrPng.width * targetY + targetX) << 2;
            const srcR = logoPng.data[srcIdx] ?? 255;
            const srcG = logoPng.data[srcIdx + 1] ?? 255;
            const srcB = logoPng.data[srcIdx + 2] ?? 255;
            qrPng.data[targetIdx] = Math.round(srcR * alpha + 255 * (1 - alpha));
            qrPng.data[targetIdx + 1] = Math.round(srcG * alpha + 255 * (1 - alpha));
            qrPng.data[targetIdx + 2] = Math.round(srcB * alpha + 255 * (1 - alpha));
            qrPng.data[targetIdx + 3] = 255;
          }
        }
      }
    }

    return PNG.sync.write(qrPng);
  } catch (err) {
    console.warn('Failed to composite EARIST logo on server QR, returning unbranded QR:', err);
    return qrBuffer;
  }
}
