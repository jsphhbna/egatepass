import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('PSGC Reference and Postal Code Resolution Decommissioning', () => {
  it('confirms postal reference data is not bundled into psgc.ts runtime', () => {
    const psgcSrc = fs.readFileSync(path.resolve('src/lib/psgc.ts'), 'utf-8');
    expect(psgcSrc).not.toContain('postal_codes.json');
    expect(psgcSrc).not.toContain('resolvePostalCode');
  });

  it('confirms postal code reference rows are completely retired in DB and not queried by client', () => {
    const psgcSrc = fs.readFileSync(path.resolve('src/lib/psgc.ts'), 'utf-8');
    expect(psgcSrc).not.toContain('postal_code_reference');
  });
});
