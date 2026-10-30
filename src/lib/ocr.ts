/**
 * Browser-local OCR using self-hosted Tesseract.js.
 * Operates strictly offline on device; does NOT upload images or text to any third-party service.
 */

import { preprocessIdForOcr } from './ocrImageProcessing.js';

export interface OcrBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrToken {
  text: string;
  confidence: number;
  bbox: OcrBBox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBBox;
  tokens: OcrToken[];
}

export interface StructuredOcrData {
  text: string;
  confidence: number;
  lines: OcrLine[];
}

export interface ParsedIdNames {
  firstName: string;
  middleName: string;
  lastName: string;
  confidence: number;
  rawText?: string;
}

export type OcrFailureCode =
  | 'worker_initialization_failed'
  | 'recognition_failed'
  | 'recognition_timeout'
  | 'image_decode_failed';

export class OcrError extends Error {
  readonly code: OcrFailureCode;
  constructor(code: OcrFailureCode, message: string) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
  }
}

export const OCR_INIT_TIMEOUT_MS = 45000;
export const OCR_RECOGNIZE_TIMEOUT_MS = 30000;

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}

const COMMON_HEADER_WORDS = new Set([
  'REPUBLIC', 'PHILIPPINES', 'PILIPINAS', 'DEPARTMENT', 'TRANSPORTATION',
  'LAND', 'OFFICE', 'COMMISSION', 'IDENTIFICATION', 'CARD', 'SYSTEM',
  'PHILSYS', 'NATIONAL', 'DRIVER', 'DRIVERS', 'LICENSE', 'POSTAL', 'POST',
  'SOCIAL', 'SECURITY', 'GOVERNMENT', 'SERVICE', 'INSURANCE', 'HEALTH',
  'PHILHEALTH', 'ELECTIONS', 'VOTER', 'VOTERS', 'PROFESSIONAL',
  'REGULATION', 'REGULATORY', 'BOARD', 'STUDENT', 'EMPLOYEE', 'CAMPUS',
  'COLLEGE', 'UNIVERSITY', 'INSTITUTE', 'SIGNATURE', 'BEARER', 'HOLDERS',
  'ADDRESS', 'TIN', 'BIR', 'UMID', 'SSS', 'PASSPORT', 'PASAPORTE', 'FOREIGN',
  'AFFAIRS', 'DFA', 'REPUBLIKA', 'LTO', 'PRC', 'GSIS', 'EARIST', 'MANILA',
  'QUEZON', 'MAKATI', 'PASIG', 'TAGUIG', 'CALOOCAN', 'CEBU', 'DAVAO',
  'CITY', 'PROVINCE', 'APELYIDO', 'PANGALAN', 'GITNANG', 'NAME', 'NAMES',
  'SURNAME', 'GIVEN', 'COMPANY', 'CORPORATION', 'CORP', 'INC', 'LIMITED',
  'LTD', 'STAFF', 'FACULTY', 'BADGE', 'NO', 'NUMBER', 'DATE', 'ISSUED',
  'EXPIRY', 'BIRTH', 'SEX', 'NATIONALITY', 'CIVIL', 'STATUS', 'VALID',
  'UNTIL', 'EXPIRATION', 'CRN', 'REGISTRATION', 'PROFESSION',
]);

const BILINGUAL_LABEL_TARGETS = [
  'LAST NAME', 'SURNAME', 'APELYIDO',
  'GIVEN NAMES', 'FIRST NAME', 'FIRST NAMES', 'MGA PANGALAN',
  'MIDDLE NAME', 'GITNANG APELYIDO',
  'DATE OF BIRTH', 'PETSA NG KAPANGANAKAN',
  'SEX', 'KASARIAN',
  'ADDRESS', 'TIRAHAN',
  'PHILIPPINE IDENTIFICATION CARD', 'REPUBLIKA NG PILIPINAS',
  'NATIONAL ID', 'DRIVERS LICENSE', 'STUDENT ID',
];

// Common OCR corruptions for Philippine ID field labels
const KNOWN_LABEL_CORRUPTIONS = new Map<string, 'last' | 'first' | 'middle'>([
  ['APELY1DO', 'last'],
  ['APELYID0', 'last'],
  ['APELIYDO', 'last'],
  ['SURNAMF', 'last'],
  ['SURNAMF:', 'last'],
  ['PANGALANA', 'first'],
  ['PANGAIAN', 'first'],
  ['PANGALAN', 'first'],
  ['G1VEN', 'first'],
  ['G1VEN NAMES', 'first'],
  ['GIVEN NAMES:', 'first'],
  ['MIDDIE', 'middle'],
  ['MIDDIE NAME', 'middle'],
  ['G1TNANG', 'middle'],
  ['GITNANG APELY1DO', 'middle'],
]);

export function isFuzzyLabel(text: string): boolean {
  const norm = text.toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (norm.length < 3) return false;
  if (KNOWN_LABEL_CORRUPTIONS.has(norm)) return true;
  for (const target of BILINGUAL_LABEL_TARGETS) {
    if (norm === target) return true;
    if (Math.abs(norm.length - target.length) <= 2) {
      const dist = levenshteinDistance(norm, target);
      if (dist <= 2) return true;
    }
  }
  return false;
}

const BILINGUAL_LABEL_REGEX = /^(?:(?:last\s*name|surname|(?<!gitnang\s*)apelyido|apely1do|given\s*names?|first\s*names?|mga\s*pangalana?|mga\s*pangaian|pangalana?|pangaian|middle\s*name|middie\s*name|gitnang(?:\s*apelyido|apely1do)?)[\s\/\-\.:]*)+/i;

function cleanNameCandidate(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[’']/g, "'")
    .replace(BILINGUAL_LABEL_REGEX, '')
    .replace(/[^\p{L}\s\-\.']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureLabelLine(text: string): boolean {
  const stripped = text
    .normalize('NFC')
    .replace(/[’']/g, "'")
    .replace(/[\s\/\-\.:]+/g, ' ')
    .trim()
    .toUpperCase();
  const tokens = stripped.split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => COMMON_HEADER_WORDS.has(t) || isFuzzyLabel(t));
}

function isValidNameWord(word: string): boolean {
  if (word.length < 2) return false;
  const upper = word.toUpperCase();
  if (COMMON_HEADER_WORDS.has(upper) || isFuzzyLabel(upper)) return false;
  // Ignore single letters or Roman numerals or common abbreviations
  if (/^(II|III|IV|JR|SR|MR|MS|MRS)$/i.test(word)) return false;
  return /^[\p{L}\-\.']+$/u.test(word);
}

function toTitleCase(str: string): string {
  return str
    .normalize('NFC')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Classifies if a line or token acts as a specific name label.
 */
function classifyLabel(text: string): 'last' | 'first' | 'middle' | null {
  const upper = text.toUpperCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (KNOWN_LABEL_CORRUPTIONS.has(upper)) {
    return KNOWN_LABEL_CORRUPTIONS.get(upper)!;
  }
  // Check middle name first (e.g. "Middle Name / Gitnang Apelyido" contains "apelyido", but means middle name!)
  if (/(?:middle\s*name|middie\s*name|gitnang\s*apelyido|gitnang)\b/i.test(upper)) {
    return 'middle';
  }
  // Check first name / given names
  if (/(?:given\s*names?|first\s*names?|mga\s*pangalan|pangalana?|pangaian|g1ven)\b/i.test(upper)) {
    return 'first';
  }
  // Check last name / surname (not preceded by gitnang)
  if (/(?:last\s*name|surname|(?<!gitnang\s*)apelyido|apely1do)\b/i.test(upper)) {
    return 'last';
  }
  return null;
}

/**
 * Extracts structured lines and bounding boxes from raw Tesseract data.
 */
export function extractStructuredOcrData(data: any): StructuredOcrData {
  const lines: OcrLine[] = [];
  if (data?.blocks && Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const tokens: OcrToken[] = (line.words || []).map((w: any) => ({
            text: w.text || '',
            confidence: typeof w.confidence === 'number' ? w.confidence : 0,
            bbox: w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
          }));
          lines.push({
            text: line.text || '',
            confidence: typeof line.confidence === 'number' ? line.confidence : 0,
            bbox: line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
            tokens,
          });
        }
      }
    }
  }
  return {
    text: data?.text || '',
    confidence: typeof data?.confidence === 'number' ? data.confidence : 0,
    lines,
  };
}

/**
 * Merges two ParsedIdNames field-by-field, picking the strongest candidate for each field.
 */
export function mergeParsedNames(pass1: ParsedIdNames, pass2: ParsedIdNames): ParsedIdNames {
  return {
    firstName: pass1.firstName || pass2.firstName,
    middleName: pass1.middleName || pass2.middleName,
    lastName: pass1.lastName || pass2.lastName,
    confidence: Math.max(pass1.confidence, pass2.confidence),
    rawText: [pass1.rawText, pass2.rawText].filter(Boolean).join('\n---\n'),
  };
}

/**
 * Pure parsing logic to extract suggested names from raw OCR text and optional structured layout data.
 * Handles labeled Philippine IDs (PhilSys, LTO, UMID, Postal, Passport, PRC, Student, Company) and fallback name lines.
 */
export function extractNamesFromIdText(
  text: string,
  overallConfidence = 0,
  structuredData?: StructuredOcrData
): ParsedIdNames {
  const result: ParsedIdNames = {
    firstName: '',
    middleName: '',
    lastName: '',
    confidence: overallConfidence,
    rawText: text,
  };

  if (!text || text.trim().length === 0) {
    return result;
  }

  // Strategy A: Spatial Layout-aware parsing when structured data with bounding boxes is available
  if (structuredData?.lines && structuredData.lines.length > 0) {
    const sLines = structuredData.lines;
    for (let i = 0; i < sLines.length; i++) {
      const curLine = sLines[i]!;
      const labelKind = classifyLabel(curLine.text);

      if (labelKind) {
        // 1. Try finding value on same line to the right of label
        let val = cleanNameCandidate(curLine.text);
        let words = val ? val.split(' ').filter(isValidNameWord) : [];
        // 2. If same line contains only the label (or no valid name words), check immediate next line below
        if (words.length === 0 && i + 1 < sLines.length) {
          const nextLine = sLines[i + 1]!;
          if (!classifyLabel(nextLine.text) && !isPureLabelLine(nextLine.text)) {
            val = cleanNameCandidate(nextLine.text);
            words = val ? val.split(' ').filter(isValidNameWord) : [];
          }
        }

        if (words.length > 0) {
          const formatted = toTitleCase(words.join(' '));
          if (labelKind === 'last' && !result.lastName) {
            result.lastName = formatted;
          } else if (labelKind === 'first' && !result.firstName) {
            result.firstName = formatted;
          } else if (labelKind === 'middle' && !result.middleName) {
            result.middleName = formatted;
          }
        }
      }
    }

    if (result.firstName && result.lastName) {
      return result;
    }
  }

  // Strategy B: Text-line heuristic parsing
  const lines = text
    .normalize('NFC')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Strategy B.1: Explicit/fuzzy labels (PhilSys, UMID, LTO, Passport, PRC, Postal ID)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
    const labelKind = classifyLabel(line);

    if (labelKind) {
      let val = cleanNameCandidate(line);
      let words = val ? val.split(' ').filter(isValidNameWord) : [];
      if (words.length === 0 && nextLine && !classifyLabel(nextLine) && !isPureLabelLine(nextLine)) {
        val = cleanNameCandidate(nextLine);
        words = val ? val.split(' ').filter(isValidNameWord) : [];
      }
      if (words.length > 0) {
        const formatted = toTitleCase(words.join(' '));
        if (labelKind === 'last' && !result.lastName) {
          result.lastName = formatted;
        } else if (labelKind === 'first' && !result.firstName) {
          result.firstName = formatted;
        } else if (labelKind === 'middle' && !result.middleName) {
          result.middleName = formatted;
        }
      }
    }
  }

  // If labeled parsing succeeded for at least first and last name, return it
  if (result.firstName && result.lastName) {
    return result;
  }

  // Strategy B.2: Comma separated "LASTNAME, FIRSTNAME MIDDLENAME" (Common on Driver's Licenses, PRC, Passports)
  for (const line of lines) {
    if (line.includes(',')) {
      const parts = line.split(',');
      const p0 = parts[0];
      if (parts.length >= 2 && p0) {
        const potentialLast = cleanNameCandidate(p0);
        const rest = cleanNameCandidate(parts.slice(1).join(' '));
        const restWords = rest.split(' ').filter(isValidNameWord);
        const lastWords = potentialLast.split(' ').filter(isValidNameWord);

        if (lastWords.length >= 1 && restWords.length >= 1 && restWords[0]) {
          result.lastName = toTitleCase(lastWords.join(' '));
          result.firstName = toTitleCase(restWords[0]);
          if (restWords.length > 1) {
            result.middleName = toTitleCase(restWords.slice(1).join(' '));
          }
          return result;
        }
      }
    }
  }

  // Strategy B.3: Heuristic scan for lines containing 2-4 valid capitalized words
  // that don't match card headers or addresses
  const candidateNameLines: string[] = [];
  for (const line of lines) {
    if (isPureLabelLine(line) || classifyLabel(line)) continue;
    const cleaned = cleanNameCandidate(line);
    const words = cleaned.split(' ').filter(Boolean);
    if (words.length >= 2 && words.length <= 4) {
      const allValid = words.every(isValidNameWord);
      // Avoid dates, digits, addresses (ST, AVE, BARANGAY, CITY, MANILA)
      const hasAddressWords = /\b(ST|STREET|AVE|AVENUE|BRGY|BARANGAY|CITY|DISTRICT|ROAD|BLK|LOT|ZONE)\b/i.test(line);
      if (allValid && !hasAddressWords) {
        candidateNameLines.push(cleaned);
      }
    }
  }

  const firstCandidate = candidateNameLines[0];
  if (firstCandidate) {
    const nameWords = firstCandidate.split(' ').filter(Boolean);
    const first = nameWords[0];
    const second = nameWords[1];
    const last = nameWords[nameWords.length - 1];
    if (nameWords.length === 2 && first && second) {
      if (!result.firstName) result.firstName = toTitleCase(first);
      if (!result.lastName) result.lastName = toTitleCase(second);
    } else if (nameWords.length >= 3 && first && last) {
      if (!result.firstName) result.firstName = toTitleCase(first);
      if (!result.middleName) result.middleName = toTitleCase(nameWords.slice(1, -1).join(' '));
      if (!result.lastName) result.lastName = toTitleCase(last);
    }
  }

  return result;
}

let cachedWorkerPromise: Promise<any> | null = null;
let activeWorkerInstance: any = null;
let globalOcrJobCounter = 0;

/**
 * Gets a fresh unique OCR Job ID to prevent race conditions from cancelled runs.
 */
export function getNextOcrJobId(): number {
  return ++globalOcrJobCounter;
}

/**
 * Lazily initialize and return a singleton Tesseract worker configured for offline execution.
 */
export async function getLocalOcrWorker(
  onProgress?: (progress: number) => void
): Promise<any> {
  if (cachedWorkerPromise) {
    return cachedWorkerPromise;
  }

  let timer: NodeJS.Timeout | undefined;

  const initPromise = (async () => {
    // Dynamically import tesseract.js so it is never bundled into initial page chunks
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract',
      langPath: '/tesseract',
      gzip: true,
      logger: (m: { status?: string; progress?: number }) => {
        if (!onProgress || !m) return;
        const status = m.status || '';
        const p = typeof m.progress === 'number' ? m.progress : 0;
        if (status.includes('loading') || status.includes('initializing')) {
          onProgress(Math.min(30, Math.round(p * 30)));
        } else if (status.includes('recognizing')) {
          onProgress(Math.min(95, 30 + Math.round(p * 65)));
        }
      },
    });
    activeWorkerInstance = worker;
    return worker;
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OcrError('worker_initialization_failed', 'OCR worker initialization timed out'));
    }, OCR_INIT_TIMEOUT_MS);
  });

  cachedWorkerPromise = Promise.race([initPromise, timeoutPromise])
    .then((worker) => {
      if (timer) clearTimeout(timer);
      return worker;
    })
    .catch(async (err) => {
      if (timer) clearTimeout(timer);
      await terminateLocalOcrWorker();
      if (err instanceof OcrError) {
        throw err;
      }
      throw new OcrError('worker_initialization_failed', `OCR worker initialization failed: ${err?.message || err}`);
    });

  return cachedWorkerPromise;
}

/**
 * Terminate any running OCR worker and release memory.
 */
export async function terminateLocalOcrWorker(): Promise<void> {
  const currentWorker = activeWorkerInstance;
  activeWorkerInstance = null;
  cachedWorkerPromise = null;

  if (currentWorker) {
    try {
      await currentWorker.terminate();
    } catch {
      // Ignore termination errors during cleanup
    }
  }
}

/**
 * Recognize text from an image Blob, File, or image element offline.
 * Implements two-pass enhancement (standard vs. high contrast) with explicit PSM configuration,
 * structured layout parsing, field-by-field merge, and independent per-pass timeout budgets.
 */
export async function recognizeIdImage(
  imageSource: Blob | File | string,
  onProgress?: (progress: number) => void,
  jobId?: number
): Promise<ParsedIdNames> {
  if (onProgress) {
    onProgress(5);
  }

  let worker: any;
  try {
    worker = await getLocalOcrWorker(onProgress);
  } catch (err) {
    await terminateLocalOcrWorker();
    throw err;
  }

  if (jobId != null && jobId !== globalOcrJobCounter) {
    return { firstName: '', middleName: '', lastName: '', confidence: 0 };
  }

  // Preprocess Pass 1 if source is Blob or File in browser
  let pass1Source: any = imageSource;
  if (typeof window !== 'undefined' && typeof imageSource !== 'string' && (imageSource as any) instanceof Blob) {
    try {
      const preprocessed = await preprocessIdForOcr(imageSource, 'standard');
      pass1Source = preprocessed.blob;
    } catch (e) {
      console.warn('Pass 1 preprocessing fallback to raw image:', e);
      pass1Source = imageSource;
    }
  }

  // Helper for running recognition with its own bounded timeout
  const runPassWithTimeout = async (source: any, psmMode: string): Promise<any> => {
    let passTimer: NodeJS.Timeout | undefined;
    const passTimeout = new Promise<never>((_, reject) => {
      passTimer = setTimeout(() => {
        reject(new OcrError('recognition_timeout', 'OCR recognition timed out'));
      }, OCR_RECOGNIZE_TIMEOUT_MS);
    });

    try {
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          tessedit_pageseg_mode: psmMode,
          preserve_interword_spaces: '1',
        });
      }
      const recognitionPromise = worker.recognize(source, {}, { text: true, blocks: true });
      const { data } = await Promise.race([recognitionPromise, passTimeout]);
      return data;
    } finally {
      if (passTimer) clearTimeout(passTimer);
    }
  };

  try {
    // Pass 1: Standard contrast, PSM 3 (AUTO)
    const dataPass1 = await runPassWithTimeout(pass1Source, '3');
    if (jobId != null && jobId !== globalOcrJobCounter) {
      return { firstName: '', middleName: '', lastName: '', confidence: 0 };
    }

    const structuredPass1 = extractStructuredOcrData(dataPass1);
    let parsed = extractNamesFromIdText(dataPass1.text, dataPass1.confidence, structuredPass1);

    // If Pass 1 did not detect both first and last name, run Pass 2 (high contrast, PSM 11 SPARSE_TEXT)
    if (
      (!parsed.firstName || !parsed.lastName) &&
      typeof window !== 'undefined' &&
      typeof imageSource !== 'string' &&
      (imageSource as any) instanceof Blob
    ) {
      try {
        if (onProgress) onProgress(60);
        const pass2 = await preprocessIdForOcr(imageSource, 'high_contrast');
        const dataPass2 = await runPassWithTimeout(pass2.blob, '11');

        if (jobId != null && jobId !== globalOcrJobCounter) {
          return { firstName: '', middleName: '', lastName: '', confidence: 0 };
        }

        const structuredPass2 = extractStructuredOcrData(dataPass2);
        const parsedPass2 = extractNamesFromIdText(dataPass2.text, dataPass2.confidence, structuredPass2);

        // Merge field-by-field
        parsed = mergeParsedNames(parsed, parsedPass2);
      } catch (err: any) {
        if (err?.message === 'ocr_job_superseded') throw err;
        console.warn('Pass 2 high contrast OCR skipped/failed:', err);
      }
    }

    if (onProgress) {
      onProgress(100);
    }
    return parsed;
  } catch (err: any) {
    if (err?.message === 'ocr_job_superseded' || (jobId != null && jobId !== globalOcrJobCounter)) {
      return { firstName: '', middleName: '', lastName: '', confidence: 0 };
    }
    await terminateLocalOcrWorker();
    throw err;
  }
}
