/**
 * Browser-local OCR using self-hosted Tesseract.js.
 * Operates strictly offline on device; does NOT upload images or text to any third-party service.
 */

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
  'UNTIL', 'EXPIRATION',
]);

const BILINGUAL_LABEL_REGEX = /^(?:(?:last\s*name|surname|apelyido|given\s*names?|first\s*names?|mga\s*pangalan|middle\s*name|gitnang\s*apelyido)[\s\/\-\.:]*)+/i;

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
  return tokens.every((t) => COMMON_HEADER_WORDS.has(t));
}

function isValidNameWord(word: string): boolean {
  if (word.length < 2) return false;
  const upper = word.toUpperCase();
  if (COMMON_HEADER_WORDS.has(upper)) return false;
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
 * Pure parsing logic to extract suggested names from raw OCR text.
 * Handles labeled Philippine IDs (PhilSys, LTO, UMID, Postal, Passport, PRC, Student, Company) and fallback name lines.
 */
export function extractNamesFromIdText(text: string, overallConfidence = 0): ParsedIdNames {
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

  const lines = text
    .normalize('NFC')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Strategy 1: Explicit labels (PhilSys, UMID, LTO, Passport, PRC format)
  // E.g.: "Last Name / Apelyido: DELA CRUZ"
  //       "Given Names / Mga Pangalan: JUAN"
  //       "Middle Name / Gitnang Apelyido: SANTOS"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

    // Last name / Surname
    if (/(?:last\s*name|surname|apelyido)\b/i.test(line)) {
      let val = isPureLabelLine(line) ? '' : cleanNameCandidate(line);
      if (!val && nextLine && !/(?:given|first|middle|name|date|birth|sex|address|valid|nationality)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.lastName) result.lastName = toTitleCase(val);
    }

    // First name / Given names
    if (/(?:given\s*names?|first\s*names?|mga\s*pangalan)\b/i.test(line)) {
      let val = isPureLabelLine(line) ? '' : cleanNameCandidate(line);
      if (!val && nextLine && !/(?:last|surname|middle|name|date|birth|sex|address|valid|nationality)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.firstName) result.firstName = toTitleCase(val);
    }

    // Middle name
    if (/(?:middle\s*name|gitnang\s*apelyido)\b/i.test(line)) {
      let val = isPureLabelLine(line) ? '' : cleanNameCandidate(line);
      if (!val && nextLine && !/(?:last|surname|first|given|name|date|birth|sex|address|valid|nationality)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.middleName) result.middleName = toTitleCase(val);
    }
  }

  // If labeled parsing succeeded for at least first and last name, return it
  if (result.firstName && result.lastName) {
    return result;
  }

  // Strategy 2: Comma separated "LASTNAME, FIRSTNAME MIDDLENAME" (Common on Driver's Licenses, PRC, Passports)
  for (const line of lines) {
    if (!line) continue;
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

  // Strategy 3: Heuristic scan for lines containing 2-4 valid capitalized words
  // that don't match card headers or addresses
  const candidateNameLines: string[] = [];
  for (const line of lines) {
    if (!line) continue;
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
      result.firstName = toTitleCase(first);
      result.lastName = toTitleCase(second);
    } else if (nameWords.length >= 3 && first && last) {
      result.firstName = toTitleCase(first);
      result.middleName = toTitleCase(nameWords.slice(1, -1).join(' '));
      result.lastName = toTitleCase(last);
    }
  }

  return result;
}

let cachedWorkerPromise: Promise<any> | null = null;
let activeWorkerInstance: any = null;

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
 * Bounded with timeouts and direct Blob passing without createObjectURL.
 */
export async function recognizeIdImage(
  imageSource: Blob | File | string,
  onProgress?: (progress: number) => void
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

  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OcrError('recognition_timeout', 'OCR recognition timed out'));
    }, OCR_RECOGNIZE_TIMEOUT_MS);
  });

  const recognitionPromise = (async () => {
    try {
      // Pass Blob/File directly without URL.createObjectURL!
      const { data } = await worker.recognize(imageSource);
      return data;
    } catch (err: any) {
      throw new OcrError('recognition_failed', `OCR recognition failed: ${err?.message || err}`);
    }
  })();

  try {
    const data = await Promise.race([recognitionPromise, timeoutPromise]);
    if (onProgress) {
      onProgress(100);
    }
    return extractNamesFromIdText(data.text, data.confidence);
  } catch (err) {
    // Fatal failure or timeout terminates the worker
    await terminateLocalOcrWorker();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
