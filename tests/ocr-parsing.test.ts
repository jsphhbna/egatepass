import { describe, it, expect } from 'vitest';
import { extractNamesFromIdText } from '../src/lib/ocr';

describe('extractNamesFromIdText Philippine ID parser', () => {
  it('parses PhilSys National ID with bilingual labels', () => {
    const ocrSample = `
REPUBLIC OF THE PHILIPPINES
PHILIPPINE IDENTIFICATION SYSTEM
Last Name / Apelyido
DELA CRUZ
Given Names / Mga Pangalan
JUAN PEDRO
Middle Name / Gitnang Apelyido
SANTOS
Date of Birth: 1990/01/15
Sex: M
Blood Type: O
    `;

    const result = extractNamesFromIdText(ocrSample, 88);
    expect(result.lastName).toBe('Dela Cruz');
    expect(result.firstName).toBe('Juan Pedro');
    expect(result.middleName).toBe('Santos');
    expect(result.confidence).toBe(88);
  });

  it('parses Driver License with comma format LAST, FIRST MIDDLE', () => {
    const ocrSample = `
LAND TRANSPORTATION OFFICE
DRIVER'S LICENSE
DELA CRUZ, JUAN MIGUEL SANTOS
Nationality: PHL Sex: M
Date of Birth: 1988/05/20
Weight: 65 kg Height: 1.70 m
Address: 123 ESPANA BLVD SAMPALOC MANILA
    `;

    const result = extractNamesFromIdText(ocrSample, 92);
    expect(result.lastName).toBe('Dela Cruz');
    expect(result.firstName).toBe('Juan');
    expect(result.middleName).toBe('Miguel Santos');
  });

  it('parses UMID card with colon-separated labels', () => {
    const ocrSample = `
UNIFIED MULTI-PURPOSE ID
SURNAME: AQUINO
GIVEN NAME: MARIA CORAZON
MIDDLE NAME: COJUANGCO
CRN-0012-3456789-0
    `;

    const result = extractNamesFromIdText(ocrSample, 85);
    expect(result.lastName).toBe('Aquino');
    expect(result.firstName).toBe('Maria Corazon');
    expect(result.middleName).toBe('Cojuangco');
  });

  it('handles fallback candidate lines when no explicit labels exist', () => {
    const ocrSample = `
COLLEGE IDENTIFICATION
EARIST MANILA
ROBERTO MENDOZA
STUDENT NO: 2024-00123
VALID UNTIL: 2026
    `;

    const result = extractNamesFromIdText(ocrSample, 75);
    expect(result.firstName).toBe('Roberto');
    expect(result.lastName).toBe('Mendoza');
  });

  it('handles empty or noisy text gracefully without fabricating fields', () => {
    const emptyResult = extractNamesFromIdText('');
    expect(emptyResult.firstName).toBe('');
    expect(emptyResult.middleName).toBe('');
    expect(emptyResult.lastName).toBe('');

    const noisyResult = extractNamesFromIdText(`
### 1234567890 ???
--- === +++
DATE: 2025-01-01
BLVD ST AVE BRGY 100
    `);
    expect(noisyResult.firstName).toBe('');
    expect(noisyResult.lastName).toBe('');
  });

  it('never invents phone numbers, addresses, or dates in parsed names', () => {
    const ocrSample = `
PHILIPPINE POSTAL ID
SURNAME: VILLANUEVA
GIVEN NAME: LUIS
MIDDLE NAME: REYES
POSTAL CODE: 1008
TEL NO: 0917-000-0000
    `;

    const result = extractNamesFromIdText(ocrSample, 80);
    expect(result.lastName).toBe('Villanueva');
    expect(result.firstName).toBe('Luis');
    expect(result.middleName).toBe('Reyes');
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('contactNumber');
  });
});
