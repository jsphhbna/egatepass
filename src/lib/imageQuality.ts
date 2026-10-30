/**
 * Browser-side image quality gate for Live Face and Valid ID capture.
 * Provides actionable technical feedback (blur, lighting, resolution)
 * strictly without subjective appearance filtering.
 */

export type QualityResultCode =
  | 'ok'
  | 'decode_failed'
  | 'too_small'
  | 'blurry'
  | 'too_dark'
  | 'overexposed'
  | 'bad_aspect_ratio';

export interface QualityCheckResult {
  passed: boolean;
  code: QualityResultCode;
  message: string;
  details?: {
    width?: number;
    height?: number;
    brightness?: number;
    sharpness?: number;
  };
}

async function loadImageElement(source: Blob | File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let url = '';
    if (typeof source === 'string') {
      url = source;
    } else {
      url = URL.createObjectURL(source);
    }

    img.onload = () => {
      if (typeof source !== 'string') {
        URL.revokeObjectURL(url);
      }
      resolve(img);
    };

    img.onerror = (err) => {
      if (typeof source !== 'string') {
        URL.revokeObjectURL(url);
      }
      reject(new Error('Failed to decode image: ' + err));
    };

    img.src = url;
  });
}

/**
 * Computes mean brightness and Laplacian variance for sharpness.
 */
function analyzeImageQuality(
  img: HTMLImageElement,
  sampleWidth = 320,
  sampleHeight = 240
): { brightness: number; sharpness: number } {
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { brightness: 128, sharpness: 100 };
  }

  ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
  const imgData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const data = imgData.data;

  // 1. Grayscale & Brightness
  let sumLuma = 0;
  const gray = new Float32Array(sampleWidth * sampleHeight);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[p] = luma;
    sumLuma += luma;
  }
  const brightness = sumLuma / (sampleWidth * sampleHeight);

  // 2. Laplacian Variance
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;

  for (let y = 1; y < sampleHeight - 1; y++) {
    const rowOffset = y * sampleWidth;
    for (let x = 1; x < sampleWidth - 1; x++) {
      const idx = rowOffset + x;
      const lap =
        gray[idx - 1]! +
        gray[idx + 1]! +
        gray[idx - sampleWidth]! +
        gray[idx + sampleWidth]! -
        4 * gray[idx]!;

      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }

  const meanLap = lapSum / (count || 1);
  const variance = lapSqSum / (count || 1) - meanLap * meanLap;
  const sharpness = Math.max(0, variance);

  return { brightness, sharpness };
}

/**
 * Validates Live Face photo suitability.
 */
export async function evaluateLiveFaceQuality(source: Blob | File | string): Promise<QualityCheckResult> {
  let img: HTMLImageElement;
  try {
    img = await loadImageElement(source);
  } catch {
    return {
      passed: false,
      code: 'decode_failed',
      message: 'Failed to read image. Please retake your photo.',
    };
  }

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  if (width < 240 || height < 240) {
    return {
      passed: false,
      code: 'too_small',
      message: 'Photo resolution is too low. Move closer to the camera and try again.',
      details: { width, height },
    };
  }

  const { brightness, sharpness } = analyzeImageQuality(img);

  if (brightness < 40) {
    return {
      passed: false,
      code: 'too_dark',
      message: 'Your face is too dark. Please move to better lighting and retake the photo.',
      details: { width, height, brightness, sharpness },
    };
  }

  if (brightness > 230) {
    return {
      passed: false,
      code: 'overexposed',
      message: 'The photo has excessive glare or backlighting. Please adjust your lighting.',
      details: { width, height, brightness, sharpness },
    };
  }

  if (sharpness < 45) {
    return {
      passed: false,
      code: 'blurry',
      message: 'Your photo is too blurry. Please hold the device steady and try again.',
      details: { width, height, brightness, sharpness },
    };
  }

  return {
    passed: true,
    code: 'ok',
    message: 'Photo quality is good.',
    details: { width, height, brightness, sharpness },
  };
}

/**
 * Validates ID document photo suitability.
 */
export async function evaluateIdImageQuality(source: Blob | File | string): Promise<QualityCheckResult> {
  let img: HTMLImageElement;
  try {
    img = await loadImageElement(source);
  } catch {
    return {
      passed: false,
      code: 'decode_failed',
      message: 'Failed to read the ID image. Please select a valid photo.',
    };
  }

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  if (width < 400 || height < 300) {
    return {
      passed: false,
      code: 'too_small',
      message: 'ID image is too small or low resolution. Please provide a clear, higher-resolution photo.',
      details: { width, height },
    };
  }

  const { brightness, sharpness } = analyzeImageQuality(img);

  if (brightness < 35) {
    return {
      passed: false,
      code: 'too_dark',
      message: 'ID document is too dark to read. Please ensure good lighting without shadows.',
      details: { width, height, brightness, sharpness },
    };
  }

  if (brightness > 235) {
    return {
      passed: false,
      code: 'overexposed',
      message: 'ID document has strong glare or flash reflection. Please avoid direct light reflection.',
      details: { width, height, brightness, sharpness },
    };
  }

  if (sharpness < 35) {
    return {
      passed: false,
      code: 'blurry',
      message: 'ID photo is blurry. Please keep the document steady and tap to focus.',
      details: { width, height, brightness, sharpness },
    };
  }

  return {
    passed: true,
    code: 'ok',
    message: 'ID image quality is good.',
    details: { width, height, brightness, sharpness },
  };
}
