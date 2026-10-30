import { describe, it, expect } from 'vitest';
import {
  extractNamesFromIdText,
  extractStructuredOcrData,
  mergeParsedNames,
  isFuzzyLabel,
  type StructuredOcrData,
  type ParsedIdNames,
} from '../src/lib/ocr';

describe('Structured OCR Pipeline & Spatial Adapter', () => {
  it('correctly builds structured lines and bounding boxes from Tesseract data blocks', () => {
    const mockTesseractData = {
      text: 'Last Name\nDELA CRUZ\nGiven Names\nJUAN',
      confidence: 90,
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  text: 'Last Name',
                  confidence: 95,
                  bbox: { x0: 20, y0: 50, x1: 120, y1: 75 },
                  words: [
                    { text: 'Last', confidence: 95, bbox: { x0: 20, y0: 50, x1: 60, y1: 75 } },
                    { text: 'Name', confidence: 95, bbox: { x0: 65, y0: 50, x1: 120, y1: 75 } },
                  ],
                },
                {
                  text: 'DELA CRUZ',
                  confidence: 92,
                  bbox: { x0: 20, y0: 80, x1: 160, y1: 110 },
                  words: [
                    { text: 'DELA', confidence: 93, bbox: { x0: 20, y0: 80, x1: 80, y1: 110 } },
                    { text: 'CRUZ', confidence: 91, bbox: { x0: 85, y0: 80, x1: 160, y1: 110 } },
                  ],
                },
                {
                  text: 'Given Names',
                  confidence: 94,
                  bbox: { x0: 20, y0: 125, x1: 150, y1: 150 },
                  words: [
                    { text: 'Given', confidence: 94, bbox: { x0: 20, y0: 125, x1: 80, y1: 150 } },
                    { text: 'Names', confidence: 94, bbox: { x0: 85, y0: 125, x1: 150, y1: 150 } },
                  ],
                },
                {
                  text: 'JUAN',
                  confidence: 96,
                  bbox: { x0: 20, y0: 155, x1: 90, y1: 185 },
                  words: [
                    { text: 'JUAN', confidence: 96, bbox: { x0: 20, y0: 155, x1: 90, y1: 185 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const structured = extractStructuredOcrData(mockTesseractData);
    expect(structured.lines).toHaveLength(4);
    expect(structured.lines[0].text).toBe('Last Name');
    expect(structured.lines[0].tokens).toHaveLength(2);
    expect(structured.lines[1].text).toBe('DELA CRUZ');

    const parsed = extractNamesFromIdText(mockTesseractData.text, 90, structured);
    expect(parsed.lastName).toBe('Dela Cruz');
    expect(parsed.firstName).toBe('Juan');
  });

  it('tolerates OCR corruptions like PANGALANA, PANGAIAN, G1VEN, APELY1DO, MIDDIE', () => {
    // Check fuzzy label recognition
    expect(isFuzzyLabel('PANGALANA')).toBe(true);
    expect(isFuzzyLabel('PANGAIAN')).toBe(true);
    expect(isFuzzyLabel('APELY1DO')).toBe(true);
    expect(isFuzzyLabel('G1VEN NAMES')).toBe(true);
    expect(isFuzzyLabel('MIDDIE NAME')).toBe(true);

    const corruptedOcrText = `
      REPUBLIKA NG PILIPINAS
      APELY1DO
      MENDOZA
      MGA PANGALANA
      CARLO JOSE
      GITNANG APELY1DO
      BAUTISTA
    `;

    const parsed = extractNamesFromIdText(corruptedOcrText, 86);
    expect(parsed.lastName).toBe('Mendoza');
    expect(parsed.firstName).toBe('Carlo Jose');
    expect(parsed.middleName).toBe('Bautista');
  });

  it('guarantees label tokens are NEVER treated as visitor name values', () => {
    const rawWithIsolatedLabels = `
      LAST NAME
      SURNAME
      APELYIDO
      GIVEN NAMES
      MGA PANGALAN
      MIDDLE NAME
      GITNANG APELYIDO
    `;

    const parsed = extractNamesFromIdText(rawWithIsolatedLabels, 80);
    expect(parsed.firstName).toBe('');
    expect(parsed.middleName).toBe('');
    expect(parsed.lastName).toBe('');
  });

  it('merges Pass 1 and Pass 2 field-by-field, preserving best values', () => {
    const pass1: ParsedIdNames = {
      firstName: 'Juan',
      middleName: '',
      lastName: '',
      confidence: 70,
      rawText: 'First Name: Juan',
    };

    const pass2: ParsedIdNames = {
      firstName: '',
      middleName: 'Santos',
      lastName: 'Dela Cruz',
      confidence: 85,
      rawText: 'Surname: Dela Cruz\nMiddle Name: Santos',
    };

    const merged = mergeParsedNames(pass1, pass2);
    expect(merged.firstName).toBe('Juan'); // Retained from Pass 1
    expect(merged.middleName).toBe('Santos'); // Picked up from Pass 2
    expect(merged.lastName).toBe('Dela Cruz'); // Picked up from Pass 2
    expect(merged.confidence).toBe(85);
  });

  it('parses Philippine Driver License comma separated names', () => {
    const dlText = `
      REPUBLIC OF THE PHILIPPINES
      DEPARTMENT OF TRANSPORTATION
      LAND TRANSPORTATION OFFICE
      DRIVER'S LICENSE
      SANTOS, MARIA CLARA REYES
      NATIONALITY: PHL
      SEX: F
      DATE OF BIRTH: 1995/10/24
    `;

    const parsed = extractNamesFromIdText(dlText, 94);
    expect(parsed.lastName).toBe('Santos');
    expect(parsed.firstName).toBe('Maria Clara');
    expect(parsed.middleName).toBe('Reyes');
  });
});
