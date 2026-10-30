import { describe, it, expect } from 'vitest';
import { extractNamesFromIdText, type StructuredOcrData } from '../src/lib/ocr';
import { getDocumentAdapter } from '../src/lib/ocrAdapters';

describe('OCR Family Adapters & Behavioral Fixtures', () => {
  // 1. PhilSys National ID
  it('parses PhilSys National ID with standard bilingual labels', () => {
    const text = `
REPUBLIKA NG PILIPINAS
PHILIPPINE IDENTIFICATION SYSTEM
Last Name / Apelyido
DELA CRUZ
Given Names / Mga Pangalan
JUAN PEDRO
Middle Name / Gitnang Apelyido
SANTOS
    `;
    const res = extractNamesFromIdText(text, 92);
    expect(res.documentFamily).toBe('philsys');
    expect(res.lastName).toBe('Dela Cruz');
    expect(res.firstName).toBe('Juan Pedro');
    expect(res.middleName).toBe('Santos');
  });

  // 2. PhilSys corrupted labels
  it('parses PhilSys National ID with OCR corrupted labels (APELY1DO, PANGALANA, G1TNANG)', () => {
    const text = `
REPUBLIKA NG PILIPINAS
PHILIPPINE IDENTIFICATION CARD
APELY1DO
MENDOZA
PANGALANA
MARIA CLARA
G1TNANG APELY1DO
DELOS REYES
    `;
    const res = extractNamesFromIdText(text, 88);
    expect(res.documentFamily).toBe('philsys');
    expect(res.lastName).toBe('Mendoza');
    expect(res.firstName).toBe('Maria Clara');
    expect(res.middleName).toBe('Delos Reyes');
  });

  // 3. Driver License with multi-word given name
  it('parses LTO Driver License with multi-word given name in comma format', () => {
    const text = `
REPUBLIC OF THE PHILIPPINES
DEPARTMENT OF TRANSPORTATION
LAND TRANSPORTATION OFFICE
DRIVER'S LICENSE
DELA PEÑA, JUAN MIGUEL ANGELO SANTOS
Nationality: PHL
Date of Birth: 1992/08/14
Address: 123 ESPANA BLVD MANILA
    `;
    const res = extractNamesFromIdText(text, 95);
    expect(res.documentFamily).toBe('driver_license');
    expect(res.lastName).toBe('Dela Peña');
    expect(res.firstName).toBe('Juan Miguel Angelo'); // Multi-word given name!
    expect(res.middleName).toBe('Santos');
  });

  // 4. UMID
  it('parses UMID card with colon-separated fields', () => {
    const text = `
REPUBLIC OF THE PHILIPPINES
UNIFIED MULTI-PURPOSE ID
SURNAME: MAGSAYSAY
GIVEN NAME: RAMON DELA CRUZ
MIDDLE NAME: BAUTISTA
CRN-0011-2233445-6
    `;
    const res = extractNamesFromIdText(text, 90);
    expect(res.documentFamily).toBe('umid');
    expect(res.lastName).toBe('Magsaysay');
    expect(res.firstName).toBe('Ramon Dela Cruz');
    expect(res.middleName).toBe('Bautista');
  });

  // 5. Passport
  it('parses Philippine Passport format with bilingual headings and MRZ', () => {
    const text = `
REPUBLIKA NG PILIPINAS / REPUBLIC OF THE PHILIPPINES
PASAPORTE / PASSPORT
Surname / Apelyido
RODRIGUEZ
Given Names / Mga Pangalan
ANA SOFIA
Nationality: PHILIPPINES
P<PHLRODRIGUEZ<<ANA<SOFIA<<<<<<<<<<<<<<<<<<
    `;
    const res = extractNamesFromIdText(text, 94);
    expect(res.documentFamily).toBe('passport');
    expect(res.lastName).toBe('Rodriguez');
    expect(res.firstName).toBe('Ana Sofia');
  });

  // 6. PRC same-row layout
  it('parses PRC ID utilizing same-row spatial token alignment', () => {
    const structuredPrc: StructuredOcrData = {
      text: 'PROFESSIONAL REGULATION COMMISSION\nLAST NAME: SANTOS FIRST NAME: ROBERTO MIDDLE NAME: CRUZ',
      confidence: 93,
      lines: [
        {
          text: 'PROFESSIONAL REGULATION COMMISSION',
          confidence: 95,
          bbox: { x0: 20, y0: 10, x1: 300, y1: 30 },
          tokens: [],
        },
        {
          text: 'LAST NAME',
          confidence: 94,
          bbox: { x0: 20, y0: 50, x1: 100, y1: 70 },
          tokens: [{ text: 'LAST NAME', confidence: 94, bbox: { x0: 20, y0: 50, x1: 100, y1: 70 } }],
        },
        {
          text: 'SANTOS',
          confidence: 92,
          bbox: { x0: 110, y0: 50, x1: 180, y1: 70 },
          tokens: [{ text: 'SANTOS', confidence: 92, bbox: { x0: 110, y0: 50, x1: 180, y1: 70 } }],
        },
        {
          text: 'FIRST NAME',
          confidence: 94,
          bbox: { x0: 20, y0: 80, x1: 110, y1: 100 },
          tokens: [{ text: 'FIRST NAME', confidence: 94, bbox: { x0: 20, y0: 80, x1: 110, y1: 100 } }],
        },
        {
          text: 'ROBERTO',
          confidence: 95,
          bbox: { x0: 120, y0: 80, x1: 200, y1: 100 },
          tokens: [{ text: 'ROBERTO', confidence: 95, bbox: { x0: 120, y0: 80, x1: 200, y1: 100 } }],
        },
        {
          text: 'MIDDLE NAME',
          confidence: 91,
          bbox: { x0: 20, y0: 110, x1: 120, y1: 130 },
          tokens: [{ text: 'MIDDLE NAME', confidence: 91, bbox: { x0: 20, y0: 110, x1: 120, y1: 130 } }],
        },
        {
          text: 'CRUZ',
          confidence: 90,
          bbox: { x0: 130, y0: 110, x1: 190, y1: 130 },
          tokens: [{ text: 'CRUZ', confidence: 90, bbox: { x0: 130, y0: 110, x1: 190, y1: 130 } }],
        },
      ],
    };

    const res = extractNamesFromIdText(structuredPrc.text, 93, structuredPrc);
    expect(res.documentFamily).toBe('prc');
    expect(res.lastName).toBe('Santos');
    expect(res.firstName).toBe('Roberto');
    expect(res.middleName).toBe('Cruz');
  });

  // 7. Postal ID with column layout and suffix handling (Requirement 13)
  it('parses Postal ID column layout: First Name | Middle Name | Surname | Suffix using spatial bboxes', () => {
    const postalStructured: StructuredOcrData = {
      text: 'PHILPOST POSTAL ID\nFIRST NAME MIDDLE NAME SURNAME SUFFIX\nJUAN PEDRO BAUTISTA DELA CRUZ JR',
      confidence: 91,
      lines: [
        {
          text: 'PHILPOST POSTAL ID',
          confidence: 95,
          bbox: { x0: 20, y0: 10, x1: 250, y1: 30 },
          tokens: [],
        },
        {
          text: 'FIRST NAME MIDDLE NAME SURNAME SUFFIX',
          confidence: 92,
          bbox: { x0: 20, y0: 50, x1: 400, y1: 70 },
          tokens: [
            { text: 'FIRST NAME', confidence: 94, bbox: { x0: 20, y0: 50, x1: 140, y1: 70 } },
            { text: 'MIDDLE NAME', confidence: 92, bbox: { x0: 150, y0: 50, x1: 240, y1: 70 } },
            { text: 'SURNAME', confidence: 95, bbox: { x0: 250, y0: 50, x1: 340, y1: 70 } },
            { text: 'SUFFIX', confidence: 90, bbox: { x0: 350, y0: 50, x1: 400, y1: 70 } },
          ],
        },
        {
          text: 'JUAN PEDRO BAUTISTA DELA CRUZ JR',
          confidence: 90,
          bbox: { x0: 20, y0: 80, x1: 400, y1: 105 },
          tokens: [
            { text: 'JUAN', confidence: 92, bbox: { x0: 20, y0: 80, x1: 70, y1: 105 } },
            { text: 'PEDRO', confidence: 91, bbox: { x0: 75, y0: 80, x1: 135, y1: 105 } },
            { text: 'BAUTISTA', confidence: 90, bbox: { x0: 150, y0: 80, x1: 235, y1: 105 } },
            { text: 'DELA', confidence: 93, bbox: { x0: 250, y0: 80, x1: 290, y1: 105 } },
            { text: 'CRUZ', confidence: 91, bbox: { x0: 295, y0: 80, x1: 340, y1: 105 } },
            { text: 'JR', confidence: 94, bbox: { x0: 355, y0: 80, x1: 395, y1: 105 } },
          ],
        },
      ],
    };

    const res = extractNamesFromIdText(postalStructured.text, 91, postalStructured);
    expect(res.documentFamily).toBe('postal');
    expect(res.firstName).toBe('Juan Pedro');
    expect(res.middleName).toBe('Bautista');
    expect(res.lastName).toBe('Dela Cruz');
    // Notice JR recognized as suffix and NOT appended to surname!
    expect(res.lastName).not.toContain('JR');
  });

  // 8. Generic Student / Company ID
  it('parses University / Student ID with student label header', () => {
    const text = `
EARIST TECHNOLOGICAL UNIVERSITY
STUDENT IDENTIFICATION
DELA CRUZ, JUAN SANTOS
STUDENT NO: 2024-00123
COLLEGE OF ENGINEERING
    `;
    const res = extractNamesFromIdText(text, 87);
    expect(res.lastName).toBe('Dela Cruz');
    expect(res.firstName).toBe('Juan');
    expect(res.middleName).toBe('Santos');
  });

  // 9. Unknown Layout without ordering signal
  it('does NOT fabricate name components when full-name order is completely unknown without punctuation or labels', () => {
    const text = `
UNKNOWN INSTITUTION CARD
1234567890
ABC XYZ
    `;
    const res = extractNamesFromIdText(text, 50);
    expect(res.documentFamily).toBe('generic');
    // Does not make up middle names or fabricate complex structures
    expect(res.middleName).toBe('');
  });

  // 10. Low-confidence garbage
  it('gracefully rejects low-confidence garbage text (< 25)', () => {
    const text = `
###%^ &*!!
xkz 1289 qwp
    `;
    const res = extractNamesFromIdText(text, 15);
    expect(res.firstName).toBe('');
    expect(res.lastName).toBe('');
    expect(res.middleName).toBe('');
  });

  // 11. Address-like text
  it('never mistakes address lines for visitor personal names', () => {
    const text = `
CAMPUS IDENTIFICATION
BLOCK 12 LOT 34 BARANGAY PINAGBUHATAN PASIG CITY
METRO MANILA PHILIPPINES 1600
    `;
    const res = extractNamesFromIdText(text, 75);
    expect(res.lastName).not.toContain('Pinagbuhatan');
    expect(res.firstName).not.toContain('Barangay');
  });
});
