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

/**
 * Lazily initialize and return a singleton PaddleOCR instance configured for PP-OCRv6 Small models.
 */
export async function getPaddleOcrInstance(
  onProgress?: (progress: number) => void
): Promise<any> {
  if (cachedPaddleOcrInstance) {
    return cachedPaddleOcrInstance;
  }

  if (paddleOcrInitPromise) {
    return paddleOcrInitPromise;
  }

  paddleOcrInitPromise = (async () => {
    try {
      if (onProgress) onProgress(10);
      const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
      if (onProgress) onProgress(25);

      const isWorkerSupported = typeof Worker !== 'undefined';

      // Explicitly configure PP-OCRv6 with Tagalog ('tl') / English language support
      const ocr = await PaddleOCR.create({
        ocrVersion: 'PP-OCRv6',
        lang: 'tl',
        worker: isWorkerSupported,
        ortOptions: {
          backend: 'auto', // WebGPU where supported, graceful fallback to WASM
        },
      });

      if (onProgress) onProgress(40);
      cachedPaddleOcrInstance = ocr;
      return ocr;
    } catch (err) {
      cachedPaddleOcrInstance = null;
      paddleOcrInitPromise = null;
      throw err;
    }
  })();

  return paddleOcrInitPromise;
}

/**
 * Terminate or reset the PaddleOCR instance to free browser memory.
 */
export async function terminatePaddleOcr(): Promise<void> {
  if (cachedPaddleOcrInstance) {
    try {
      if (typeof cachedPaddleOcrInstance.terminate === 'function') {
        await cachedPaddleOcrInstance.terminate();
      }
    } catch {
      // Ignore termination errors during disposal
    }
    cachedPaddleOcrInstance = null;
    paddleOcrInitPromise = null;
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
 * Extracts address lines from structured lines using spatial proximity to address labels.
 */
export function extractAddressFromOcrLines(lines: OcrLine[]): string {
  const addressLabelIdx = lines.findIndex((l) =>
    /(?:address|tirahan|residence)\b/i.test(l.text)
  );

  if (addressLabelIdx === -1) return '';

  const labelLine = lines[addressLabelIdx]!;
  const addressParts: string[] = [];

  // Check if address text continues on the same line after the label
  const cleanedSameLine = labelLine.text
    .replace(/(?:tirahan|address|residence|[\s\/\-\.:])+/gi, ' ')
    .trim();
  if (cleanedSameLine.length > 2 && !/^(?:date|sex|birth|valid|expiry|kasarian|petsa)/i.test(cleanedSameLine)) {
    addressParts.push(cleanedSameLine);
  }

  // Look for lines stacked immediately below the address label
  for (let i = addressLabelIdx + 1; i < lines.length && i <= addressLabelIdx + 3; i++) {
    const nextLine = lines[i]!;
    // Stop if encountering another standard field label
    if (
      /(?:date\s*of\s*birth|petsa|sex|kasarian|blood|date\s*of\s*issue|valid|crn|signature)/i.test(
        nextLine.text
      )
    ) {
      break;
    }
    const cleanLine = nextLine.text.trim();
    if (cleanLine.length > 1) {
      addressParts.push(cleanLine);
    }
  }

  return addressParts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Executes browser-side ID recognition using PaddleOCR.js PP-OCRv6 Small.
 */
export async function recognizeIdImageWithPaddle(
  imageSource: Blob | File,
  onProgress?: (progress: number) => void
): Promise<ParsedIdNames> {
  const ocr = await getPaddleOcrInstance(onProgress);

  if (onProgress) onProgress(60);

  const [prediction] = (await ocr.predict(imageSource)) as [PaddleOcrPredictionResult];

  if (onProgress) onProgress(85);

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
