import QRCode from 'qrcode';

export interface BrandedQrOptions {
  size?: number;
  logoSrc?: string;
}

export const QR_BRANDED_CONFIG = {
  errorCorrectionLevel: 'H' as const,
  size: 360,
  logoRatio: 0.17, // 17% of QR width (strictly within 15-18% safe bounds)
  logoPadding: 6,
  margin: 2,
  darkColor: '#000000',
  lightColor: '#ffffff',
  defaultLogoSrc: '/earist-logo.png',
};

/**
 * Generates a branded QR code data URL with the EARIST logo centered inside.
 * Preserves exact bearer token payload with Error Correction Level H.
 */
export async function generateBrandedQrDataUrl(
  qrToken: string,
  options?: BrandedQrOptions
): Promise<string> {
  const size = options?.size ?? QR_BRANDED_CONFIG.size;
  const logoSrc = options?.logoSrc ?? QR_BRANDED_CONFIG.defaultLogoSrc;

  // If running in a non-browser environment (e.g. node tests), fallback to toDataURL directly
  if (typeof document === 'undefined') {
    return QRCode.toDataURL(qrToken, {
      width: size,
      margin: QR_BRANDED_CONFIG.margin,
      errorCorrectionLevel: QR_BRANDED_CONFIG.errorCorrectionLevel,
      color: {
        dark: QR_BRANDED_CONFIG.darkColor,
        light: QR_BRANDED_CONFIG.lightColor,
      },
    });
  }

  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, qrToken, {
    width: size,
    margin: QR_BRANDED_CONFIG.margin,
    errorCorrectionLevel: QR_BRANDED_CONFIG.errorCorrectionLevel,
    color: {
      dark: QR_BRANDED_CONFIG.darkColor,
      light: QR_BRANDED_CONFIG.lightColor,
    },
  });

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return canvas.toDataURL('image/png');
  }

  try {
    const logoImg = await loadLogoImage(logoSrc);
    const logoSize = Math.round(size * QR_BRANDED_CONFIG.logoRatio);
    const padding = QR_BRANDED_CONFIG.logoPadding;
    const boxSize = logoSize + padding * 2;
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const boxX = centerX - boxSize / 2;
    const boxY = centerY - boxSize / 2;
    const radius = 6;
    if (typeof (ctx as any).roundRect === 'function') {
      (ctx as any).roundRect(boxX, boxY, boxSize, boxSize, radius);
    } else {
      ctx.rect(boxX, boxY, boxSize, boxSize);
    }
    ctx.fill();

    const logoX = centerX - logoSize / 2;
    const logoY = centerY - logoSize / 2;
    ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
    ctx.restore();
  } catch (err) {
    console.warn('Failed to overlay EARIST logo on QR code, returning base QR:', err);
  }

  return canvas.toDataURL('image/png');
}

function loadLogoImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}
