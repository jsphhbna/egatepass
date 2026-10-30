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
    expect(result.firstName).toBe('Juan Miguel');
    expect(result.middleName).toBe('Santos');
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

  it('correctly preserves accented Unicode characters (José Niño Dela Cruz, María Peña, Ana Muñoz)', () => {
    const ocrSampleJose = `
REPUBLIC OF THE PHILIPPINES
Last Name: DELA CRUZ
First Name: JOSÉ NIÑO
Middle Name: SANTOS
    `;
    const resJose = extractNamesFromIdText(ocrSampleJose, 90);
    expect(resJose.lastName).toBe('Dela Cruz');
    expect(resJose.firstName).toBe('José Niño');
    expect(resJose.middleName).toBe('Santos');

    const ocrSampleMaria = `
PHILIPPINE IDENTIFICATION SYSTEM
Surname / Apelyido
PEÑA
Given Names / Mga Pangalan
MARÍA
    `;
    const resMaria = extractNamesFromIdText(ocrSampleMaria, 92);
    expect(resMaria.lastName).toBe('Peña');
    expect(resMaria.firstName).toBe('María');

    const ocrSampleAna = `
LAND TRANSPORTATION OFFICE
MUÑOZ, ANA CLARA SANTOS
    `;
    const resAna = extractNamesFromIdText(ocrSampleAna, 89);
    expect(resAna.lastName).toBe('Muñoz');
    expect(resAna.firstName).toBe('Ana Clara');
    expect(resAna.middleName).toBe('Santos');
  });

  it('parses Professional Regulation Commission (PRC) ID format', () => {
    const ocrSamplePrc = `
PROFESSIONAL REGULATION COMMISSION
PROFESSIONAL IDENTIFICATION CARD
REGISTRATION NO: 0123456
DELA CRUZ, JUAN PEDRO SANTOS
PROFESSION: CIVIL ENGINEER
VALIDITY: 2027/10/30
    `;
    const res = extractNamesFromIdText(ocrSamplePrc, 95);
    expect(res.lastName).toBe('Dela Cruz');
    expect(res.firstName).toBe('Juan Pedro');
    expect(res.middleName).toBe('Santos');
  });

  it('parses Philippine Passport format with surname and given names labels', () => {
    const ocrSamplePassport = `
REPUBLIC OF THE PHILIPPINES / REPUBLIKA NG PILIPINAS
PASSPORT / PASAPORTE
Surname / Apelyido
DELA CRUZ
Given Names / Mga Pangalan
JUAN PEDRO
Nationality / Pagkamamamayan: PHILIPPINES
Date of Birth / Petsa ng kapanganakan: 15 JAN 1990
    `;
    const res = extractNamesFromIdText(ocrSamplePassport, 91);
    expect(res.lastName).toBe('Dela Cruz');
    expect(res.firstName).toBe('Juan Pedro');
  });

  it('parses University / Student ID and Company ID format', () => {
    const ocrSampleStudent = `
EULOGIO "AMANG" RODRIGUEZ INSTITUTE OF SCIENCE AND TECHNOLOGY
STUDENT IDENTIFICATION
SANTOS, MARIA CLARA REYES
STUDENT NO: 2023-99887-MN-0
COLLEGE OF ENGINEERING
    `;
    const resStudent = extractNamesFromIdText(ocrSampleStudent, 88);
    expect(resStudent.lastName).toBe('Santos');
    expect(resStudent.firstName).toBe('Maria');
    expect(resStudent.middleName).toBe('Clara Reyes');

    const ocrSampleCompany = `
ACME CORPORATION
EMPLOYEE ID
RAMOS, EDUARDO JOSE
EMP ID: 10492
DEPARTMENT: SECURITY
    `;
    const resCompany = extractNamesFromIdText(ocrSampleCompany, 85);
    expect(resCompany.lastName).toBe('Ramos');
    expect(resCompany.firstName).toBe('Eduardo');
    expect(resCompany.middleName).toBe('Jose');
  });
});
