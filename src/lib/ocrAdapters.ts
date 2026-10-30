/**
 * Modular OCR Document Adapters for Philippine Identity Documents.
 *
 * Implements explicit family adapters:
 * - PhilSys (National ID)
 * - Driver's License (LTO)
 * - UMID (Unified Multi-Purpose ID)
 * - Passport (DFA)
 * - PRC (Professional Regulation Commission)
 * - Postal ID (PhilPost column layout with suffix support)
 * - Generic (School / Company / Fallback)
 */

import {
  type DocumentFamily,
  type StructuredOcrData,
  type ParsedIdNames,
  type FieldCandidate,
  isFuzzyLabel,
} from './ocr.js';

export interface DocumentAdapter {
  readonly family: DocumentFamily;
  parse(
    text: string,
    overallConfidence: number,
    structuredData?: StructuredOcrData,
    sourcePass?: 1 | 2
  ): ParsedIdNames;
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
  'UNTIL', 'EXPIRATION', 'CRN', 'REGISTRATION', 'PROFESSION', 'SUFFIX',
]);

const KNOWN_LABEL_CORRUPTIONS = new Map<string, 'last' | 'first' | 'middle' | 'suffix'>([
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
  ['G1TNANG APELY1DO', 'middle'],
  ['G1TNANG APELYIDO', 'middle'],
  ['GITNANG APELY1DO', 'middle'],
  ['SUFF1X', 'suffix'],
]);

const KNOWN_SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V']);

export function cleanNameCandidate(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[’']/g, "'")
    .replace(/^(?:(?:last\s*name|surname|(?<!gitnang\s*|<!g1tnang\s*)apelyido|apely1do|given\s*names?|first\s*names?|mga\s*pangalana?|mga\s*pangaian|pangalana?|pangaian|middle\s*name|middie\s*name|(?:gitnang|g1tnang)(?:\s*(?:apelyido|apely1do))?|suffix|suff1x)[\s\/\-\.:]*)+/i, '')
    .replace(/[^\p{L}\s\-\.']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPureLabelLine(text: string): boolean {
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

export function isValidNameWord(word: string): boolean {
  if (word.length < 2) return false;
  const upper = word.toUpperCase();
  if (COMMON_HEADER_WORDS.has(upper) || isFuzzyLabel(upper)) return false;
  if (/^(MR|MS|MRS|DR|ENGR|ATTY)$/i.test(word)) return false;
  return /^[\p{L}\-\.']+$/u.test(word);
}

export function toTitleCase(str: string): string {
  return str
    .normalize('NFC')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function classifyLabel(text: string): 'last' | 'first' | 'middle' | 'suffix' | null {
  const upper = text.toUpperCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (KNOWN_LABEL_CORRUPTIONS.has(upper)) {
    return KNOWN_LABEL_CORRUPTIONS.get(upper)!;
  }
  if (/(?:middle\s*name|middie\s*name|(?:gitnang|g1tnang)(?:\s*(?:apelyido|apely1do))?|gitnang|g1tnang)\b/i.test(upper)) {
    return 'middle';
  }
  if (/(?:given\s*names?|first\s*names?|mga\s*pangalan|pangalana?|pangaian|g1ven)\b/i.test(upper)) {
    return 'first';
  }
  if (/(?:last\s*name|surname|(?<!gitnang\s*|<!g1tnang\s*)apelyido|apely1do)\b/i.test(upper)) {
    return 'last';
  }
  if (/(?:suffix|suff1x)\b/i.test(upper)) {
    return 'suffix';
  }
  return null;
}

/**
 * Standard spatial parser for stacked labels (PhilSys, UMID, generic labeled).
 */
function parseSpatialStackedLabels(
  structuredData: StructuredOcrData,
  docFamily: DocumentFamily,
  overallConfidence: number,
  sourcePass: 1 | 2 = 1,
  preferSameRow = false
): {
  firstName: string;
  middleName: string;
  lastName: string;
  fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']>;
} {
  const sLines = structuredData.lines;
  const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
  let firstName = '';
  let middleName = '';
  let lastName = '';

  for (let i = 0; i < sLines.length; i++) {
    const curLine = sLines[i]!;
    const labelKind = classifyLabel(curLine.text);

    if (labelKind && labelKind !== 'suffix') {
      let extractedVal = '';
      let extractionMode: FieldCandidate['extractionMode'] = 'below_label';
      let candidateConf = curLine.confidence || overallConfidence;

      // Check same row to the right
      let sameRowVal = '';
      const cleanedInLine = cleanNameCandidate(curLine.text);
      const inLineWords = cleanedInLine ? cleanedInLine.split(' ').filter(isValidNameWord) : [];

      if (inLineWords.length > 0) {
        sameRowVal = inLineWords.join(' ');
      } else {
        const labelRightEdge = curLine.tokens.length > 0
          ? curLine.tokens[curLine.tokens.length - 1]!.bbox.x1
          : curLine.bbox.x1;
        const sameRowTokens: string[] = [];
        for (let j = 0; j < sLines.length; j++) {
          if (i === j) continue;
          const other = sLines[j]!;
          const vertOverlap = Math.max(
            0,
            Math.min(curLine.bbox.y1, other.bbox.y1) - Math.max(curLine.bbox.y0, other.bbox.y0)
          );
          const lineH = Math.max(1, curLine.bbox.y1 - curLine.bbox.y0);
          if (vertOverlap / lineH > 0.4 && other.bbox.x0 >= labelRightEdge - 15) {
            const otherClean = cleanNameCandidate(other.text);
            const otherWords = otherClean ? otherClean.split(' ').filter(isValidNameWord) : [];
            if (otherWords.length > 0) {
              sameRowTokens.push(...otherWords);
              candidateConf = other.confidence || candidateConf;
              break;
            }
          }
        }
        if (sameRowTokens.length > 0) sameRowVal = sameRowTokens.join(' ');
      }

      // Check aligned line below
      let belowVal = '';
      if (i + 1 < sLines.length) {
        const nextLine = sLines[i + 1]!;
        if (!classifyLabel(nextLine.text) && !isPureLabelLine(nextLine.text)) {
          const vertGap = nextLine.bbox.y0 - curLine.bbox.y1;
          const lineH = Math.max(1, curLine.bbox.y1 - curLine.bbox.y0);
          if (vertGap >= -5 && vertGap < lineH * 3.5) {
            const cleanedBelow = cleanNameCandidate(nextLine.text);
            const belowWords = cleanedBelow ? cleanedBelow.split(' ').filter(isValidNameWord) : [];
            if (belowWords.length > 0) {
              belowVal = belowWords.join(' ');
              candidateConf = nextLine.confidence || candidateConf;
            }
          }
        }
      }

      if (preferSameRow && sameRowVal) {
        extractedVal = sameRowVal;
        extractionMode = 'same_row';
      } else if (belowVal) {
        extractedVal = belowVal;
        extractionMode = 'below_label';
      } else if (sameRowVal) {
        extractedVal = sameRowVal;
        extractionMode = 'same_row';
      }

      if (extractedVal) {
        const formatted = toTitleCase(extractedVal);
        if (labelKind === 'last' && !lastName) {
          lastName = formatted;
          fieldCandidates.lastName = {
            value: formatted,
            confidence: candidateConf,
            sourcePass,
            documentFamily: docFamily,
            extractionMode,
          };
        } else if (labelKind === 'first' && !firstName) {
          firstName = formatted;
          fieldCandidates.firstName = {
            value: formatted,
            confidence: candidateConf,
            sourcePass,
            documentFamily: docFamily,
            extractionMode,
          };
        } else if (labelKind === 'middle' && !middleName) {
          middleName = formatted;
          fieldCandidates.middleName = {
            value: formatted,
            confidence: candidateConf,
            sourcePass,
            documentFamily: docFamily,
            extractionMode,
          };
        }
      }
    }
  }

  return { firstName, middleName, lastName, fieldCandidates };
}

/**
 * Standard text-line label parser.
 */
function parseTextLinesLabels(
  lines: string[],
  docFamily: DocumentFamily,
  overallConfidence: number,
  sourcePass: 1 | 2 = 1
): {
  firstName: string;
  middleName: string;
  lastName: string;
  fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']>;
} {
  const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
  let firstName = '';
  let middleName = '';
  let lastName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
    const labelKind = classifyLabel(line);

    if (labelKind && labelKind !== 'suffix') {
      let val = cleanNameCandidate(line);
      let words = val ? val.split(' ').filter(isValidNameWord) : [];
      let mode: FieldCandidate['extractionMode'] = 'same_row';

      if (words.length === 0 && nextLine && !classifyLabel(nextLine) && !isPureLabelLine(nextLine)) {
        val = cleanNameCandidate(nextLine);
        words = val ? val.split(' ').filter(isValidNameWord) : [];
        mode = 'below_label';
      }

      if (words.length > 0) {
        const formatted = toTitleCase(words.join(' '));
        if (labelKind === 'last' && !lastName) {
          lastName = formatted;
          fieldCandidates.lastName = {
            value: formatted,
            confidence: overallConfidence,
            sourcePass,
            documentFamily: docFamily,
            extractionMode: mode,
          };
        } else if (labelKind === 'first' && !firstName) {
          firstName = formatted;
          fieldCandidates.firstName = {
            value: formatted,
            confidence: overallConfidence,
            sourcePass,
            documentFamily: docFamily,
            extractionMode: mode,
          };
        } else if (labelKind === 'middle' && !middleName) {
          middleName = formatted;
          fieldCandidates.middleName = {
            value: formatted,
            confidence: overallConfidence,
            sourcePass,
            documentFamily: docFamily,
            extractionMode: mode,
          };
        }
      }
    }
  }

  return { firstName, middleName, lastName, fieldCandidates };
}

// -------------------------------------------------------------
// 1. PhilSys Adapter
// -------------------------------------------------------------
export class PhilSysAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'philsys';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    if (structuredData?.lines && structuredData.lines.length > 0) {
      const spatial = parseSpatialStackedLabels(structuredData, this.family, overallConfidence, sourcePass, false);
      if (spatial.firstName && spatial.lastName) {
        return { ...result, ...spatial };
      }
      Object.assign(fieldCandidates, spatial.fieldCandidates);
      result.firstName = spatial.firstName;
      result.middleName = spatial.middleName;
      result.lastName = spatial.lastName;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (!result.firstName && textRes.firstName) result.firstName = textRes.firstName;
    if (!result.middleName && textRes.middleName) result.middleName = textRes.middleName;
    if (!result.lastName && textRes.lastName) result.lastName = textRes.lastName;
    Object.assign(fieldCandidates, textRes.fieldCandidates);

    return result;
  }
}

// -------------------------------------------------------------
// 2. Driver License Adapter (LTO)
// -------------------------------------------------------------
export class DriverLicenseAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'driver_license';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // Primary: Comma separated format "SURNAME, GIVEN NAMES (one or more) MIDDLE NAME"
    for (const line of lines) {
      if (line.includes(',')) {
        const parts = line.split(',');
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join(' ').trim();
        if (p0 && p1) {
          const lastWords = cleanNameCandidate(p0).split(' ').filter(isValidNameWord);
          const restWords = cleanNameCandidate(p1).split(' ').filter(isValidNameWord);

          if (lastWords.length >= 1 && restWords.length >= 1) {
            result.lastName = toTitleCase(lastWords.join(' '));
            fieldCandidates.lastName = {
              value: result.lastName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };

            if (restWords.length >= 2) {
              // Final word is middle name candidate, all preceding words are multi-word given name!
              const middleWord = restWords[restWords.length - 1]!;
              const givenWords = restWords.slice(0, -1).join(' ');
              result.firstName = toTitleCase(givenWords);
              result.middleName = toTitleCase(middleWord);
            } else {
              result.firstName = toTitleCase(restWords[0]!);
              result.middleName = '';
            }

            fieldCandidates.firstName = {
              value: result.firstName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            if (result.middleName) {
              fieldCandidates.middleName = {
                value: result.middleName,
                confidence: Math.max(30, overallConfidence - 10),
                sourcePass,
                documentFamily: this.family,
                extractionMode: 'combined_field',
              };
            }
            return result;
          }
        }
      }
    }

    // Secondary: Explicit stacked labels if present
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (textRes.firstName && textRes.lastName) {
      return { ...result, ...textRes };
    }

    return result;
  }
}

// -------------------------------------------------------------
// 3. UMID Adapter
// -------------------------------------------------------------
export class UmidAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'umid';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    if (structuredData?.lines && structuredData.lines.length > 0) {
      const spatial = parseSpatialStackedLabels(structuredData, this.family, overallConfidence, sourcePass, false);
      if (spatial.firstName && spatial.lastName) {
        return { ...result, ...spatial };
      }
      Object.assign(fieldCandidates, spatial.fieldCandidates);
      result.firstName = spatial.firstName;
      result.middleName = spatial.middleName;
      result.lastName = spatial.lastName;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (!result.firstName && textRes.firstName) result.firstName = textRes.firstName;
    if (!result.middleName && textRes.middleName) result.middleName = textRes.middleName;
    if (!result.lastName && textRes.lastName) result.lastName = textRes.lastName;
    Object.assign(fieldCandidates, textRes.fieldCandidates);

    return result;
  }
}

// -------------------------------------------------------------
// 4. Passport Adapter
// -------------------------------------------------------------
export class PassportAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'passport';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // 1. Check for standard stacked or colon labels
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (textRes.firstName && textRes.lastName) {
      return { ...result, ...textRes };
    }

    // 2. Check for MRZ lines (P<PHL...)
    for (const line of lines) {
      const upper = line.toUpperCase().replace(/\s+/g, '');
      if (upper.startsWith('P<PHL') || (upper.startsWith('P<') && upper.length >= 20)) {
        const payload = upper.slice(5); // strip P<PHL
        const parts = payload.split('<<');
        if (parts.length >= 2) {
          const surnamePart = parts[0]?.replace(/</g, ' ').trim();
          const givenPart = parts[1]?.replace(/</g, ' ').trim();
          if (surnamePart && givenPart) {
            result.lastName = toTitleCase(surnamePart);
            const givenWords = givenPart.split(' ').filter(Boolean);
            if (givenWords.length >= 2) {
              result.firstName = toTitleCase(givenWords.slice(0, -1).join(' '));
              result.middleName = toTitleCase(givenWords[givenWords.length - 1]!);
            } else {
              result.firstName = toTitleCase(givenWords[0]!);
            }

            fieldCandidates.lastName = {
              value: result.lastName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            fieldCandidates.firstName = {
              value: result.firstName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            return result;
          }
        }
      }
    }

    return result;
  }
}

// -------------------------------------------------------------
// 5. PRC Adapter (Professional Regulation Commission)
// -------------------------------------------------------------
export class PrcAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'prc';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    // PRC heavily prefers same-row token to the right of label
    if (structuredData?.lines && structuredData.lines.length > 0) {
      const spatial = parseSpatialStackedLabels(structuredData, this.family, overallConfidence, sourcePass, true);
      if (spatial.firstName && spatial.lastName) {
        return { ...result, ...spatial };
      }
      Object.assign(fieldCandidates, spatial.fieldCandidates);
      result.firstName = spatial.firstName;
      result.middleName = spatial.middleName;
      result.lastName = spatial.lastName;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // Comma-separated format check (e.g. DELA CRUZ, JUAN PEDRO SANTOS)
    for (const line of lines) {
      if (line.includes(',')) {
        const parts = line.split(',');
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join(' ').trim();
        if (p0 && p1) {
          const lastWords = cleanNameCandidate(p0).split(' ').filter(isValidNameWord);
          const restWords = cleanNameCandidate(p1).split(' ').filter(isValidNameWord);

          if (lastWords.length >= 1 && restWords.length >= 1) {
            result.lastName = toTitleCase(lastWords.join(' '));
            fieldCandidates.lastName = {
              value: result.lastName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };

            if (restWords.length >= 2) {
              const middleWord = restWords[restWords.length - 1]!;
              const givenWords = restWords.slice(0, -1).join(' ');
              result.firstName = toTitleCase(givenWords);
              result.middleName = toTitleCase(middleWord);
            } else {
              result.firstName = toTitleCase(restWords[0]!);
              result.middleName = '';
            }

            fieldCandidates.firstName = {
              value: result.firstName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            if (result.middleName) {
              fieldCandidates.middleName = {
                value: result.middleName,
                confidence: Math.max(30, overallConfidence - 10),
                sourcePass,
                documentFamily: this.family,
                extractionMode: 'combined_field',
              };
            }
            return result;
          }
        }
      }
    }

    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (!result.firstName && textRes.firstName) result.firstName = textRes.firstName;
    if (!result.middleName && textRes.middleName) result.middleName = textRes.middleName;
    if (!result.lastName && textRes.lastName) result.lastName = textRes.lastName;
    Object.assign(fieldCandidates, textRes.fieldCandidates);

    return result;
  }
}

// -------------------------------------------------------------
// 6. Postal ID Adapter (Spatial Columns: First | Middle | Surname | Suffix)
// -------------------------------------------------------------
export class PostalIdAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'postal';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    // Requirement 13: Spatial layout using structured bounding boxes
    if (structuredData?.lines && structuredData.lines.length > 0) {
      const lines = structuredData.lines;

      // Find the header line containing column headers
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const upper = line.text.toUpperCase();

        const hasFirstHeader = upper.includes('FIRST') || upper.includes('GIVEN');
        const hasLastHeader = upper.includes('SURNAME') || upper.includes('LAST');
        const hasMiddleHeader = upper.includes('MIDDLE');

        if ((hasFirstHeader && hasLastHeader) || (hasLastHeader && hasMiddleHeader)) {
          // Identify each header column's horizontal span
          interface ColumnSpan {
            kind: 'first' | 'middle' | 'last' | 'suffix';
            x0: number;
            x1: number;
          }
          const columns: ColumnSpan[] = [];

          // Inspect words / tokens in header line
          for (const token of line.tokens) {
            const kind = classifyLabel(token.text);
            if (kind) {
              columns.push({
                kind,
                x0: token.bbox.x0,
                x1: token.bbox.x1,
              });
            }
          }

          // If tokens weren't individual, split by line words
          if (columns.length < 2) {
            // Fallback: estimate column positions from line bounding box
            const totalW = line.bbox.x1 - line.bbox.x0;
            // Typical Postal layout: First (40%), Middle (25%), Surname (25%), Suffix (10%)
            columns.push(
              { kind: 'first', x0: line.bbox.x0, x1: line.bbox.x0 + totalW * 0.38 },
              { kind: 'middle', x0: line.bbox.x0 + totalW * 0.38, x1: line.bbox.x0 + totalW * 0.65 },
              { kind: 'last', x0: line.bbox.x0 + totalW * 0.65, x1: line.bbox.x0 + totalW * 0.90 },
              { kind: 'suffix', x0: line.bbox.x0 + totalW * 0.90, x1: line.bbox.x1 }
            );
          }

          // Value line is the line immediately below the header line
          if (i + 1 < lines.length) {
            const valLine = lines[i + 1]!;
            const vertGap = valLine.bbox.y0 - line.bbox.y1;
            const lineH = Math.max(1, line.bbox.y1 - line.bbox.y0);

            if (vertGap >= -5 && vertGap < lineH * 3.5 && !classifyLabel(valLine.text) && !isPureLabelLine(valLine.text)) {
              const colTokens: Record<'first' | 'middle' | 'last' | 'suffix', string[]> = {
                first: [],
                middle: [],
                last: [],
                suffix: [],
              };

              for (const tok of valLine.tokens) {
                const cleanedWord = tok.text.replace(/[^\w\s\.\-]/g, '').trim();
                if (!cleanedWord) continue;

                const upperWord = cleanedWord.toUpperCase();

                // Recognize suffixes (JR, SR, II, III, IV) as suffixes, not invalid garbage
                if (KNOWN_SUFFIXES.has(upperWord)) {
                  colTokens.suffix.push(upperWord);
                  continue;
                }

                if (!isValidNameWord(cleanedWord)) continue;

                // Assign to column based on token center geometry
                const tokCenter = (tok.bbox.x0 + tok.bbox.x1) / 2;

                // Find matching column span or closest column
                let bestCol = columns[0]!.kind;
                let minDistance = Infinity;

                for (const col of columns) {
                  if (tokCenter >= col.x0 - 15 && tokCenter <= col.x1 + 15) {
                    bestCol = col.kind;
                    minDistance = 0;
                    break;
                  }
                  const colCenter = (col.x0 + col.x1) / 2;
                  const dist = Math.abs(tokCenter - colCenter);
                  if (dist < minDistance) {
                    minDistance = dist;
                    bestCol = col.kind;
                  }
                }

                colTokens[bestCol].push(cleanedWord);
              }

              if (colTokens.first.length > 0 && colTokens.last.length > 0) {
                result.firstName = toTitleCase(colTokens.first.join(' '));
                result.lastName = toTitleCase(colTokens.last.join(' '));
                if (colTokens.middle.length > 0) {
                  result.middleName = toTitleCase(colTokens.middle.join(' '));
                }

                fieldCandidates.firstName = {
                  value: result.firstName,
                  confidence: valLine.confidence || overallConfidence,
                  sourcePass,
                  documentFamily: this.family,
                  extractionMode: 'below_label',
                };
                fieldCandidates.lastName = {
                  value: result.lastName,
                  confidence: valLine.confidence || overallConfidence,
                  sourcePass,
                  documentFamily: this.family,
                  extractionMode: 'below_label',
                };
                if (result.middleName) {
                  fieldCandidates.middleName = {
                    value: result.middleName,
                    confidence: valLine.confidence || overallConfidence,
                    sourcePass,
                    documentFamily: this.family,
                    extractionMode: 'below_label',
                  };
                }
                return result;
              }
            }
          }
        }
      }
    }

    // Fallback: If structured geometry is ambiguous or unavailable: DO NOT GUESS!
    // Leave uncertain fields manual.
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (textRes.firstName && textRes.lastName) {
      return { ...result, ...textRes };
    }

    return result;
  }
}

// -------------------------------------------------------------
// 7. Generic Adapter (Student ID, Company, Unlabeled Fallbacks)
// -------------------------------------------------------------
export class GenericAdapter implements DocumentAdapter {
  readonly family: DocumentFamily = 'generic';

  parse(text: string, overallConfidence: number, structuredData?: StructuredOcrData, sourcePass: 1 | 2 = 1): ParsedIdNames {
    void structuredData;
    const fieldCandidates: NonNullable<ParsedIdNames['fieldCandidates']> = {};
    const result: ParsedIdNames = {
      firstName: '',
      middleName: '',
      lastName: '',
      confidence: overallConfidence,
      rawText: text,
      documentFamily: this.family,
      fieldCandidates,
    };

    if (overallConfidence < 25) {
      // Reject low-confidence garbage
      return result;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // 1. Explicit labels if present
    const textRes = parseTextLinesLabels(lines, this.family, overallConfidence, sourcePass);
    if (textRes.firstName && textRes.lastName) {
      return { ...result, ...textRes };
    }

    // 2. Comma separated
    for (const line of lines) {
      if (line.includes(',')) {
        const parts = line.split(',');
        const p0 = parts[0]?.trim();
        const p1 = parts.slice(1).join(' ').trim();
        if (p0 && p1) {
          const lastWords = cleanNameCandidate(p0).split(' ').filter(isValidNameWord);
          const restWords = cleanNameCandidate(p1).split(' ').filter(isValidNameWord);
          if (lastWords.length >= 1 && restWords.length >= 1) {
            result.lastName = toTitleCase(lastWords.join(' '));
            result.firstName = toTitleCase(restWords[0]!);
            if (restWords.length > 1) {
              result.middleName = toTitleCase(restWords.slice(1).join(' '));
            } else {
              result.middleName = '';
            }
            fieldCandidates.lastName = {
              value: result.lastName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            fieldCandidates.firstName = {
              value: result.firstName,
              confidence: overallConfidence,
              sourcePass,
              documentFamily: this.family,
              extractionMode: 'combined_field',
            };
            if (result.middleName) {
              fieldCandidates.middleName = {
                value: result.middleName,
                confidence: Math.max(30, overallConfidence - 10),
                sourcePass,
                documentFamily: this.family,
                extractionMode: 'combined_field',
              };
            }
            return result;
          }
        }
      }
    }

    // 3. Fallback candidate line:
    // When unknown full-name order: do NOT fabricate components unless labels or punctuation provide clear ordering signal!
    const candidateNameLines: string[] = [];
    for (const line of lines) {
      if (isPureLabelLine(line) || classifyLabel(line)) continue;
      // Filter out address lines
      const hasAddressWords = /\b(ST|STREET|AVE|AVENUE|BRGY|BARANGAY|CITY|DISTRICT|ROAD|BLK|LOT|ZONE|SUBD|VILLAGE|POBLACION|MANILA|QUEZON|PASIG|MAKATI|TAGUIG|PROVINCE)\b/i.test(line);
      const hasNumbers = /\d{2,}/.test(line);
      if (hasAddressWords || hasNumbers) continue;

      const cleaned = cleanNameCandidate(line);
      const words = cleaned.split(' ').filter(Boolean);
      if (words.length >= 2 && words.length <= 4) {
        if (words.every(isValidNameWord)) {
          candidateNameLines.push(cleaned);
        }
      }
    }

    const firstCandidate = candidateNameLines[0];
    if (firstCandidate) {
      const words = firstCandidate.split(' ').filter(Boolean);
      if (words.length === 2) {
        result.firstName = toTitleCase(words[0]!);
        result.lastName = toTitleCase(words[1]!);
        fieldCandidates.firstName = {
          value: result.firstName,
          confidence: Math.max(20, overallConfidence - 20),
          sourcePass,
          documentFamily: this.family,
          extractionMode: 'generic',
        };
        fieldCandidates.lastName = {
          value: result.lastName,
          confidence: Math.max(20, overallConfidence - 20),
          sourcePass,
          documentFamily: this.family,
          extractionMode: 'generic',
        };
      } else if (words.length >= 3) {
        result.firstName = toTitleCase(words[0]!);
        result.middleName = toTitleCase(words.slice(1, -1).join(' '));
        result.lastName = toTitleCase(words[words.length - 1]!);
        fieldCandidates.firstName = {
          value: result.firstName,
          confidence: Math.max(20, overallConfidence - 20),
          sourcePass,
          documentFamily: this.family,
          extractionMode: 'generic',
        };
        fieldCandidates.middleName = {
          value: result.middleName,
          confidence: Math.max(20, overallConfidence - 25),
          sourcePass,
          documentFamily: this.family,
          extractionMode: 'generic',
        };
        fieldCandidates.lastName = {
          value: result.lastName,
          confidence: Math.max(20, overallConfidence - 20),
          sourcePass,
          documentFamily: this.family,
          extractionMode: 'generic',
        };
      }
    }

    return result;
  }
}

// -------------------------------------------------------------
// Adapter Registry & Dispatcher
// -------------------------------------------------------------
const ADAPTERS: Record<DocumentFamily, DocumentAdapter> = {
  philsys: new PhilSysAdapter(),
  driver_license: new DriverLicenseAdapter(),
  umid: new UmidAdapter(),
  passport: new PassportAdapter(),
  prc: new PrcAdapter(),
  postal: new PostalIdAdapter(),
  generic: new GenericAdapter(),
};

export function getDocumentAdapter(family: DocumentFamily): DocumentAdapter {
  return ADAPTERS[family] || ADAPTERS.generic;
}
