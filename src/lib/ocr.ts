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

const COMMON_HEADER_WORDS = new Set([
  'REPUBLIC', 'PHILIPPINES', 'PILIPINAS', 'DEPARTMENT', 'TRANSPORTATION',
  'LAND', 'OFFICE', 'COMMISSION', 'IDENTIFICATION', 'CARD', 'SYSTEM',
  'PHILSYS', 'NATIONAL', 'DRIVER', 'DRIVERS', 'LICENSE', 'POSTAL', 'POST',
  'SOCIAL', 'SECURITY', 'GOVERNMENT', 'SERVICE', 'INSURANCE', 'HEALTH',
  'PHILHEALTH', 'COMMISSION', 'ELECTIONS', 'VOTER', 'VOTERS', 'PROFESSIONAL',
  'REGULATION', 'STUDENT', 'EMPLOYEE', 'CAMPUS', 'COLLEGE', 'UNIVERSITY',
  'SIGNATURE', 'BEARER', 'HOLDERS', 'ADDRESS', 'TIN', 'BIR', 'UMID', 'SSS',
  'PASSPORT', 'REPUBLIKA', 'LTO', 'PRC', 'GSIS', 'EARIST', 'MANILA', 'QUEZON',
  'MAKATI', 'PASIG', 'TAGUIG', 'CALOOCAN', 'CEBU', 'DAVAO', 'CITY', 'PROVINCE',
  'APELYIDO', 'PANGALAN', 'GITNANG', 'NAME', 'NAMES', 'SURNAME', 'GIVEN',
]);

const BILINGUAL_LABEL_REGEX = /^(?:(?:last\s*name|surname|apelyido|given\s*names?|first\s*names?|mga\s*pangalan|middle\s*name|gitnang\s*apelyido)[\s\/\-\.:]*)+/i;

function cleanNameCandidate(text: string): string {
  return text
    .replace(BILINGUAL_LABEL_REGEX, '')
    .replace(/[^a-zA-Z\s\-\.']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureLabelLine(text: string): boolean {
  const stripped = text
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
  return /^[a-zA-Z\-\.']+$/.test(word);
}

function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Pure parsing logic to extract suggested names from raw OCR text.
 * Handles labeled Philippine IDs (PhilSys, LTO, UMID, Postal) and fallback name lines.
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
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Strategy 1: Explicit labels (PhilSys, UMID, LTO format)
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
      if (!val && nextLine && !/(?:given|first|middle|name|date|birth|sex|address)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.lastName) result.lastName = toTitleCase(val);
    }

    // First name / Given names
    if (/(?:given\s*names?|first\s*names?|mga\s*pangalan)\b/i.test(line)) {
      let val = isPureLabelLine(line) ? '' : cleanNameCandidate(line);
      if (!val && nextLine && !/(?:last|surname|middle|name|date|birth|sex|address)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.firstName) result.firstName = toTitleCase(val);
    }

    // Middle name
    if (/(?:middle\s*name|gitnang\s*apelyido)\b/i.test(line)) {
      let val = isPureLabelLine(line) ? '' : cleanNameCandidate(line);
      if (!val && nextLine && !/(?:last|surname|first|given|name|date|birth|sex|address)/i.test(nextLine)) {
        val = cleanNameCandidate(nextLine);
      }
      if (val && !result.middleName) result.middleName = toTitleCase(val);
    }
  }

  // If labeled parsing succeeded for at least first and last name, return it
  if (result.firstName && result.lastName) {
    return result;
  }

  // Strategy 2: Comma separated "LASTNAME, FIRSTNAME MIDDLENAME" (Common on Driver's Licenses)
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

/**
 * Lazily initialize and return a singleton Tesseract worker configured for offline execution.
 */
export async function getLocalOcrWorker(): Promise<any> {
  if (cachedWorkerPromise) {
    return cachedWorkerPromise;
  }

  cachedWorkerPromise = (async () => {
    // Dynamically import tesseract.js so it is never bundled into initial page chunks
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
      langPath: '/tesseract',
      gzip: true,
      logger: () => {
        // Suppress or hook into progress
      },
    });
    return worker;
  })().catch((err) => {
    cachedWorkerPromise = null;
    throw err;
  });

  return cachedWorkerPromise;
}

/**
 * Terminate any running OCR worker and release memory.
 */
export async function terminateLocalOcrWorker(): Promise<void> {
  if (cachedWorkerPromise) {
    try {
      const worker = await cachedWorkerPromise;
      await worker.terminate();
    } catch {
      // Ignore termination errors during cleanup
    } finally {
      cachedWorkerPromise = null;
    }
  }
}

/**
 * Recognize text from an image blob or image element offline.
 */
export async function recognizeIdImage(
  imageSource: Blob | string,
  onProgress?: (progress: number) => void
): Promise<ParsedIdNames> {
  const worker = await getLocalOcrWorker();

  if (onProgress) {
    onProgress(10);
  }

  let imageUrl: string | null = null;
  let sourceToRecognize: string;

  if (typeof imageSource === 'string') {
    sourceToRecognize = imageSource;
  } else {
    imageUrl = URL.createObjectURL(imageSource);
    sourceToRecognize = imageUrl;
  }

  try {
    const { data } = await worker.recognize(sourceToRecognize);
    if (onProgress) {
      onProgress(100);
    }
    return extractNamesFromIdText(data.text, data.confidence);
  } finally {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
  }
}
