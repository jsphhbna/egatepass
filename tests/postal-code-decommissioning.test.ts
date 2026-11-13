import { describe, it, expect, vi } from 'vitest';
import { hydrateReturningAddress } from '../src/lib/returningAddressHydration';
import fs from 'fs';
import path from 'path';

describe('Priority 2: Postal Code Decommissioning Regression Protection', () => {
  it('1. Returning-profile hydration does not restore postal codes from legacy profile', () => {
    const legacyProfile = {
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'National Capital Region (NCR)' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380606014', name: 'Barangay 408' },
        houseBuilding: 'Unit 401',
        street: 'Nagtahan St.',
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      },
    };

    const hydrated = hydrateReturningAddress(legacyProfile);
    expect(hydrated.postalCode).toBe('');
    expect(hydrated.selectedPsgc).toBeDefined();
    expect(hydrated.selectedPsgc?.postalCode).toBeUndefined();
    expect(hydrated.selectedPsgc?.postalCodeSource).toBeUndefined();
    expect(hydrated.selectedPsgc?.postalResolution).toBeUndefined();
    expect(hydrated.homeBuilding).toBe('Unit 401');
    expect(hydrated.homeStreet).toBe('Nagtahan St.');
  });

  it('2. New registration issuance sets requested_postal_code and requested_postal_code_source to null', () => {
    const issueSrc = fs.readFileSync(path.resolve('server/routes/passes/issue.ts'), 'utf-8');
    // Ensure the RPC call explicitly forwards null for postal fields
    expect(issueSrc).toContain('requested_postal_code: null');
    expect(issueSrc).toContain('requested_postal_code_source: null');
    // Ensure returning profile updates do not persist postal values
    expect(issueSrc).not.toContain('profileUpdate.postal_code');
  });

  it('3. Returning identity endpoint does not serialize postal fields in profile response', () => {
    const identifySrc = fs.readFileSync(path.resolve('server/routes/passes/identify-returning.ts'), 'utf-8');
    expect(identifySrc).not.toMatch(/postalCode:\s*(?:cleanPostal|profile\.postal_code)/);
    expect(identifySrc).not.toContain('cleanPostal');
  });

  it('4. No active UI component in registration or address flow renders postal fields or badges', () => {
    const selectorSrc = fs.readFileSync(path.resolve('src/components/AddressCascadingSelector.tsx'), 'utf-8');
    const fieldSrc = fs.readFileSync(path.resolve('src/components/StructuredAddressField.tsx'), 'utf-8');
    const getPassSrc = fs.readFileSync(path.resolve('src/pages/GetPassPage.tsx'), 'utf-8');

    // AddressCascadingSelector does not render postal input or badge
    expect(selectorSrc).not.toContain('input name="postalCode"');
    expect(selectorSrc).not.toContain('Postal Code');

    // StructuredAddressField does not render postal input or badge
    expect(fieldSrc).not.toContain('postalCode');

    // GetPassPage does not render postal input or postal-specific badge
    expect(getPassSrc).not.toContain('name="postalCode"');
    expect(getPassSrc).not.toContain('PHLPost Auto-filled');
  });

  it('5. Historical legacy pass replay is not rejected due to presence of legacy postal codes', () => {
    const issueSrc = fs.readFileSync(path.resolve('server/routes/passes/issue.ts'), 'utf-8');
    // Verify replay consistency check compares only administrative hierarchy, house, and street, NOT postal_code
    expect(issueSrc).not.toContain('existingVisitor.postal_code !==');
  });

  it('6. AddressCascadingSelector onSelect payload contains no postal code properties', () => {
    const selectorSrc = fs.readFileSync(path.resolve('src/components/AddressCascadingSelector.tsx'), 'utf-8');
    // Ensure onSelect only emits administrative hierarchy
    const onSelectMatch = selectorSrc.match(/onSelect\(\{[\s\S]*?\}\);/);
    expect(onSelectMatch).toBeTruthy();
    expect(onSelectMatch![0]).not.toContain('postalCode');
    expect(onSelectMatch![0]).not.toContain('postalCodeSource');
  });
});
