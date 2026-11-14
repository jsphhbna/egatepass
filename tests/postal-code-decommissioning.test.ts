import { describe, it, expect, vi } from 'vitest';
import { hydrateReturningAddress } from '../src/lib/returningAddressHydration';
import fs from 'fs';
import path from 'path';

describe('Priority 1: Postal Code Decommissioning & Application Contract Protection', () => {
  it('1. Returning-profile hydration does not restore postal codes and output object has no postalCode property', () => {
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
    expect('postalCode' in hydrated).toBe(false);
    expect((hydrated as any).postalCode).toBeUndefined();
    expect(hydrated.selectedPsgc).toBeDefined();
    expect((hydrated.selectedPsgc as any)?.postalCode).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCodeSource).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
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

  it('6. AddressCascadingSelector onSelect payload and SelectedPsgcAddress contain no postal code properties', () => {
    const selectorSrc = fs.readFileSync(path.resolve('src/components/AddressCascadingSelector.tsx'), 'utf-8');
    // Ensure onSelect only emits administrative hierarchy
    const onSelectMatch = selectorSrc.match(/onSelect\(\{[\s\S]*?\}\);/);
    expect(onSelectMatch).toBeTruthy();
    expect(onSelectMatch![0]).not.toContain('postalCode');
    expect(onSelectMatch![0]).not.toContain('postalCodeSource');

    // Interface SelectedPsgcAddress has no postal properties
    expect(selectorSrc).not.toMatch(/export interface SelectedPsgcAddress\s*\{[\s\S]*?postalCode/);
  });

  it('7. Application contracts contain no postal properties across client interfaces', () => {
    const psgcSrc = fs.readFileSync(path.resolve('src/lib/psgc.ts'), 'utf-8');
    const serviceSrc = fs.readFileSync(path.resolve('src/services/visitorRegistration.ts'), 'utf-8');
    const hydrationSrc = fs.readFileSync(path.resolve('src/lib/returningAddressHydration.ts'), 'utf-8');

    // src/lib/psgc.ts
    expect(psgcSrc).not.toContain('export interface PostalResolution');
    expect(psgcSrc).not.toMatch(/export interface StructuredAddress\s*\{[\s\S]*?postalCode/);

    // src/services/visitorRegistration.ts
    expect(serviceSrc).not.toContain('PostalResolution');
    expect(serviceSrc).not.toMatch(/export interface PsgcAddressPayload\s*\{[\s\S]*?postalCode/);
    expect(serviceSrc).not.toMatch(/export interface ReturningIdentifyProfile\s*\{[\s\S]*?postalCode/);

    // src/lib/returningAddressHydration.ts
    expect(hydrationSrc).not.toMatch(/export interface HydratedAddressState\s*\{[\s\S]*?postalCode/);
  });

  it('8. Issue route Zod schema strips legacy postal properties without rejection', () => {
    const issueSrc = fs.readFileSync(path.resolve('server/routes/passes/issue.ts'), 'utf-8');
    expect(issueSrc).not.toMatch(/psgc:\s*z\.object\(\{[\s\S]*?postalCode/);
    expect(issueSrc).not.toMatch(/psgc:\s*z\.object\(\{[\s\S]*?postalCodeSource/);
  });
});
