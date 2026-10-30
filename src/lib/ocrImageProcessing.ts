/**
 * Browser-side image preprocessing for Tesseract.js OCR.
 * Normalizes orientation, resizes to target OCR scale (long edge 1800-2200px, max 2400px),
 * and provides dual-pass enhancement (standard contrast vs. PhilSys binarization).
 */

export interface PreprocessedOcrImage {
  blob: Blob;
  width: number;
  height: number;
}

export type OcrPreprocessingPass = 'standard' | 'high_contrast';

/**
 * Loads an image Blob or File into an HTMLImageElement or ImageBitmap.
 */
async function loadImage(source: Blob | File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(source);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for OCR preprocessing: ' + err));
    };
    img.src = url;
  });
}

/**
 * Calculates optimal OCR dimensions with long edge constrained to [1800, 2200] px (max 2400 px).
 */
export function calculateOcrDimensions(
  srcWidth: number,
  srcHeight: number,
  minLongEdge = 1800,
  maxLongEdge = 2200,
  absoluteMax = 2400
): { width: number; height: number } {
  const longEdge = Math.max(srcWidth, srcHeight);
  if (longEdge <= 0) return { width: srcWidth, height: srcHeight };

  let targetLongEdge = longEdge;
  if (longEdge < minLongEdge) {
    targetLongEdge = Math.min(minLongEdge, absoluteMax);
  } else if (longEdge > maxLongEdge) {
    targetLongEdge = Math.min(maxLongEdge, absoluteMax);
  }

  const scale = targetLongEdge / longEdge;
  const width = Math.round(srcWidth * scale);
  const height = Math.round(srcHeight * scale);
  return { width, height };
}

/**
 * Applies contrast enhancement and binarization filters in 2D canvas.
 */
function applyEnhancementFilter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pass: OcrPreprocessingPass
) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const totalPixels = width * height;

  if (pass === 'standard') {
    // Grayscale + mild contrast boost
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      // Contrast stretch centered at 128
      const factor = 1.25;
      const enhanced = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
      data[i] = enhanced;
      data[i + 1] = enhanced;
      data[i + 2] = enhanced;
    }
  } else {
    // High-contrast thresholding for patterned IDs (e.g. PhilSys guilloche background)
    // 1. Calculate average luminance
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      sum += gray;
    }
    const mean = sum / totalPixels;
    // Threshold with bias towards text retention
    const threshold = Math.max(80, Math.min(170, mean * 0.92));

    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      const val = gray > threshold ? 255 : 0;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

/**
 * Preprocesses an ID image for optimal local OCR recognition.
 */
export async function preprocessIdForOcr(
  source: Blob | File,
  pass: OcrPreprocessingPass = 'standard'
): Promise<PreprocessedOcrImage> {
  const img = await loadImage(source);
  const { width, height } = calculateOcrDimensions(img.naturalWidth || img.width, img.naturalHeight || img.height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }

  // Draw scaled image
  ctx.drawImage(img, 0, 0, width, height);

  // Apply contrast filter
  applyEnhancementFilter(ctx, width, height, pass);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Canvas toBlob conversion failed'));
    }, 'image/png');
  });

  return { blob, width, height };
}
