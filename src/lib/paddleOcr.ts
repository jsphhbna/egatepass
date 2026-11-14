/**
 * Browser-local OCR engine using PaddleOCR.js with PP-OCRv6 Small models.
 * Operates offline in the visitor's browser via ONNX Runtime Web.
 * Does NOT send images or text to any third-party API.
 */

import {
  type StructuredOcrData,
  type OcrLine,
  type OcrToken,
  type OcrBBox,
  type ParsedIdNames,
  type DocumentFamily,
} from './ocr.js';
import { getDocumentAdapter } from './ocrAdapters.js';

export interface PaddleOcrItem {
  poly: Array<[number, number]>;
  text: string;
  score: number;
}

export interface PaddleOcrPredictionResult {
  image?: { width: number; height: number };
  items: PaddleOcrItem[];
  metrics?: {
    detMs?: number;
    recMs?: number;
    totalMs?: number;
    detectedBoxes?: number;
    recognizedCount?: number;
  };
}

let cachedPaddleOcrInstance: any = null;
let paddleOcrInitPromise: Promise<any> | null = null;
let currentInitGeneration = 0;
let currentPredictionGeneration = 0;
const PADDLE_INIT_TIMEOUT_MS = 15000;
const PADDLE_PREDICT_TIMEOUT_MS = 15000;

/**
 * Cancels or invalidates any pending PaddleOCR prediction jobs and disposes the running instance.
 */
export async function cancelPendingPaddleOcr(): Promise<void> {
  currentInitGeneration++;
  currentPredictionGeneration++;
  const instance = cachedPaddleOcrInstance;
  cachedPaddleOcrInstance = null;
  paddleOcrInitPromise = null;
  if (instance) {
    try {
      if (typeof instance.dispose === 'function') {
        await instance.dispose();
      } else if (typeof instance.terminate === 'function') {
        await instance.terminate();
      } else if (typeof instance.destroy === 'function') {
        await instance.destroy();
      }
    } catch {
      // Ignore termination errors during disposal
    }
  }
}

/**
 * Lazily initialize and return a singleton PaddleOCR instance configured for PP-OCRv6 Small models.
 */
export async function getPaddleOcrInstance(
  onProgress?: (progress: number, status?: string) => void,
  maxTimeoutMs: number = PADDLE_INIT_TIMEOUT_MS
): Promise<any> {
  if (cachedPaddleOcrInstance) {
    return cachedPaddleOcrInstance;
  }

  if (paddleOcrInitPromise) {
    return paddleOcrInitPromise;
  }

  const generation = ++currentInitGeneration;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const effectiveTimeout = Math.min(PADDLE_INIT_TIMEOUT_MS, Math.max(1000, maxTimeoutMs));

  const initPromise = (async () => {
    try {
      if (onProgress) onProgress(10, 'Initializing neural OCR engine...');
      const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
      if (onProgress) onProgress(25, 'Loading PP-OCRv6 Tagalog/English model...');

      // Explicitly configure PP-OCRv6 with Tagalog ('tl') / English language support
      // worker: false avoids spawning Vite worker chunk with unhashed URL that triggers 404/reload
      const ocr = await PaddleOCR.create({
        ocrVersion: 'PP-OCRv6',
        lang: 'tl',
        worker: false,
        ortOptions: {
          backend: 'auto', // WebGPU where supported, graceful fallback to WASM
        },
      });

      // Generation check: If this initialization was abandoned or superseded (e.g. timeout fired or terminated):
      if (generation !== currentInitGeneration) {
        try {
          const anyOcr = ocr as any;
          if (typeof anyOcr?.dispose === 'function') {
            await anyOcr.dispose();
          } else if (typeof anyOcr?.terminate === 'function') {
            await anyOcr.terminate();
          } else if (typeof anyOcr?.destroy === 'function') {
            await anyOcr.destroy();
          }
        } catch {
          // Ignore disposal errors
        }
        throw new Error('PaddleOCR initialization superseded or timed out');
      }

      if (onProgress) onProgress(40, 'Neural OCR engine ready');
      cachedPaddleOcrInstance = ocr;
      return ocr;
    } catch (err) {
      if (generation === currentInitGeneration) {
        cachedPaddleOcrInstance = null;
        paddleOcrInitPromise = null;
      }
      throw err;
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Invalidate this generation so late resolution discards and disposes the instance
      if (currentInitGeneration === generation) {
        currentInitGeneration++;
      }
      cachedPaddleOcrInstance = null;
      paddleOcrInitPromise = null;
      reject(new Error(`PaddleOCR initialization timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);
  });

  paddleOcrInitPromise = Promise.race([initPromise, timeoutPromise])
    .then((ocr) => {
      if (timer) clearTimeout(timer);
      return ocr;
    })
    .catch(async (err) => {
      if (timer) clearTimeout(timer);
      if (generation === currentInitGeneration) {
        await terminatePaddleOcr();
      }
      throw err;
    });

  return paddleOcrInitPromise;
}

/**
 * Terminate or reset the PaddleOCR instance to free browser memory.
 */
export async function terminatePaddleOcr(): Promise<void> {
  currentInitGeneration++;
  currentPredictionGeneration++;
  const instance = cachedPaddleOcrInstance;
  cachedPaddleOcrInstance = null;
  paddleOcrInitPromise = null;
  if (instance) {
    try {
      if (typeof instance.dispose === 'function') {
        await instance.dispose();
      } else if (typeof instance.terminate === 'function') {
        await instance.terminate();
      } else if (typeof instance.destroy === 'function') {
        await instance.destroy();
      }
    } catch {
      // Ignore termination errors during disposal
    }
  }
}

/**
 * Converts raw PaddleOCR polygon detection items into StructuredOcrData.
 */
export function convertPaddleItemsToStructuredData(
  items: PaddleOcrItem[],
  imgW = 1000,
  imgH = 650
): StructuredOcrData {
  if (!items || items.length === 0) {
    return { text: '', confidence: 0, lines: [] };
  }

  const ocrLines: OcrLine[] = items.map((item) => {
    const poly = item.poly || [];
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);

    const x0 = xs.length > 0 ? Math.max(0, Math.min(...xs)) : 0;
    const x1 = xs.length > 0 ? Math.min(imgW, Math.max(...xs)) : imgW;
    const y0 = ys.length > 0 ? Math.max(0, Math.min(...ys)) : 0;
    const y1 = ys.length > 0 ? Math.min(imgH, Math.max(...ys)) : imgH;

    const bbox: OcrBBox = { x0, y0, x1, y1 };
    const conf = Math.round((item.score ?? 0.8) * 100);
    const text = (item.text || '').trim();

    // Proportional token bounding boxes for each word
    const words = text.split(/\s+/).filter(Boolean);
    const totalChars = words.reduce((sum, w) => sum + w.length, 0) || 1;
    const lineWidth = Math.max(1, x1 - x0);
    let curX = x0;

    const tokens: OcrToken[] = words.map((w) => {
      const charRatio = w.length / totalChars;
      const wordW = Math.max(10, Math.round(lineWidth * charRatio));
      const tokenBBox: OcrBBox = {
        x0: curX,
        y0,
        x1: Math.min(imgW, curX + wordW),
        y1,
      };
      curX += wordW + 5;
      return {
        text: w,
        confidence: conf,
        bbox: tokenBBox,
      };
    });

    return {
      text,
      confidence: conf,
      bbox,
      tokens,
    };
  });

  // Sort lines top-to-bottom, left-to-right
  ocrLines.sort((a, b) => {
    const yDiff = a.bbox.y0 - b.bbox.y0;
    if (Math.abs(yDiff) > 15) return yDiff;
    return a.bbox.x0 - b.bbox.x0;
  });

  const fullText = ocrLines.map((l) => l.text).join('\n');
  const avgConfidence = Math.round(
    ocrLines.reduce((sum, l) => sum + l.confidence, 0) / ocrLines.length
  );

  return {
    text: fullText,
    confidence: avgConfidence,
    lines: ocrLines,
  };
}

/**
 * Extracts address lines from structured lines using spatial proximity to address labels,
 * strictly enforcing column boundaries and line-spacing constraints (Priority 3).
 */
export function extractAddressFromOcrLines(lines: OcrLine[]): string {
  const addressLabelIdx = lines.findIndex((l) =>
    /(?:address|tirahan|residence)\b/i.test(l.text)
  );

  if (addressLabelIdx === -1) return '';

  const labelLine = lines[addressLabelIdx]!;
  const addressParts: string[] = [];
  const addressLines: OcrLine[] = [];

  const labelHeight = Math.max(12, labelLine.bbox.y1 - labelLine.bbox.y0);
  const colLeft = labelLine.bbox.x0;

  // Check if address text continues on the same line after the label
  const cleanedSameLine = labelLine.text
    .replace(/(?:tirahan|address|residence|[\s\/\-\.:])+/gi, ' ')
    .trim();
  if (cleanedSameLine.length > 2 && !/^(?:date|sex|birth|valid|expiry|kasarian|petsa)/i.test(cleanedSameLine)) {
    addressParts.push(cleanedSameLine);
    addressLines.push(labelLine);
  } else {
    addressLines.push(labelLine);
  }

  // Priority 3: Spatial column boundary and line-spacing enforcement
  for (let i = addressLabelIdx + 1; i < lines.length && addressParts.length < 4 && i <= addressLabelIdx + 8; i++) {
    const nextLine = lines[i]!;

    // 1. Column alignment check: candidate line must start in the same column (not an adjacent column)
    if (nextLine.bbox.x0 > colLeft + 80 || nextLine.bbox.x1 < colLeft - 40) {
      // Candidate line belongs to an adjacent column (e.g. right-side photo or secondary column)
      continue;
    }

    // 2. Stop if encountering another standard field label in the address column
    if (
      /(?:date\s*of\s*birth|petsa|sex|kasarian|blood|date\s*of\s*issue|issue|expiry|valid|crn|signature|tin|philhealth|sss)\b/i.test(
        nextLine.text
      )
    ) {
      break;
    }

    const lastLine = addressLines[addressLines.length - 1]!;

    // 3. Line spacing check: vertical distance between lines must be reasonable (not jumping sections)
    const verticalGap = nextLine.bbox.y0 - lastLine.bbox.y1;
    const maxGap = Math.max(30, labelHeight * 2.5);
    if (verticalGap > maxGap || verticalGap < -10) {
      // Discontinuous vertical gap; section ended
      break;
    }

    const cleanLine = nextLine.text.trim();
    if (cleanLine.length > 1) {
      addressParts.push(cleanLine);
      addressLines.push(nextLine);
    }
  }

  return addressParts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Executes browser-side ID recognition using PaddleOCR.js PP-OCRv6 Small.
 */
export async function recognizeIdImageWithPaddle(
  imageSource: Blob | File,
  onProgress?: (progress: number, status?: string) => void,
  jobId?: number,
  isJobStale?: (id: number) => boolean,
  timeoutMs: number = PADDLE_PREDICT_TIMEOUT_MS
): Promise<ParsedIdNames> {
  const predictionGen = ++currentPredictionGeneration;
  const effectiveTimeout = Math.min(PADDLE_PREDICT_TIMEOUT_MS, Math.max(1000, timeoutMs));
  const ocr = await getPaddleOcrInstance(onProgress, effectiveTimeout);
  if (
    predictionGen !== currentPredictionGeneration ||
    (jobId != null && isJobStale && isJobStale(jobId))
  ) {
    throw new Error('PaddleOCR prediction superseded');
  }

  if (onProgress) onProgress(50, 'Detecting text regions...');

  let predictTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    predictTimer = setTimeout(() => {
      reject(new Error(`PaddleOCR prediction timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);
  });

  let prediction: PaddleOcrPredictionResult;
  try {
    const predictPromise = ocr.predict(imageSource).then((res: any) => (Array.isArray(res) ? res[0] : res));
    prediction = await Promise.race([predictPromise, timeoutPromise]);
    if (
      predictionGen !== currentPredictionGeneration ||
      (jobId != null && isJobStale && isJobStale(jobId))
    ) {
      throw new Error('PaddleOCR prediction superseded');
    }
  } catch (err: any) {
    // Only terminate/dispose if this prediction was NOT superseded by a newer job
    if (predictionGen === currentPredictionGeneration && !err?.message?.includes('superseded')) {
      await terminatePaddleOcr();
    }
    throw err;
  } finally {
    if (predictTimer) clearTimeout(predictTimer);
  }

  if (onProgress) onProgress(80, 'Extracting ID details...');

  const imgW = prediction?.image?.width || 1000;
  const imgH = prediction?.image?.height || 650;
  const structured = convertPaddleItemsToStructuredData(prediction?.items || [], imgW, imgH);

  // Layout-aware Philippine ID family classification
  const fullText = structured.text;
  let family: DocumentFamily = 'generic';
  if (/philsys|national\s*id|republika\s*ng\s*pilipinas/i.test(fullText)) {
    family = 'philsys';
  } else if (/driver|license|lto/i.test(fullText)) {
    family = 'driver_license';
  } else if (/umid|unified\s*multi/i.test(fullText)) {
    family = 'umid';
  } else if (/postal|philpost/i.test(fullText)) {
    family = 'postal';
  } else if (/passport|pasaporte/i.test(fullText)) {
    family = 'passport';
  }

  const adapter = getDocumentAdapter(family);
  const parsed = adapter.parse(fullText, structured.confidence, structured, 1);

  // Layout-aware address extraction
  const extractedAddress = extractAddressFromOcrLines(structured.lines);
  if (extractedAddress) {
    parsed.address = extractedAddress;
    if (parsed.fieldCandidates) {
      parsed.fieldCandidates.address = {
        value: extractedAddress,
        confidence: structured.confidence,
        sourcePass: 1,
        documentFamily: family,
        extractionMode: 'below_label',
      };
    }
  }

  if (onProgress) onProgress(100);
  return parsed;
}
