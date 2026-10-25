import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PATCH 11: Portal Raw File Memory Guard & Limit Separation', () => {
  const getPassPagePath = join(__dirname, '../src/pages/GetPassPage.tsx');
  const getPassPageContent = readFileSync(getPassPagePath, 'utf-8');

  it('11A. Enforces 10 MiB MAX_RAW_ID_FILE_BYTES constant before compression in GetPassPage', () => {
    expect(getPassPageContent).toContain('const MAX_RAW_ID_FILE_BYTES = 10 * 1024 * 1024;');
    expect(getPassPageContent).toContain('if (file.size > MAX_RAW_ID_FILE_BYTES)');
  });

  it('11B. Displays exact user error message on oversized raw file', () => {
    const expectedMsg = 'This image is too large to process safely. Please choose an image 10 MB or smaller.';
    expect(getPassPageContent).toContain(expectedMsg);
  });

  it('11C. Preserves authoritative 5 MiB upload-intent evidence limit', () => {
    const docPath = join(__dirname, '../docs/IMAGE_SECURITY.md');
    const docContent = readFileSync(docPath, 'utf-8');
    expect(docContent).toContain('5 MiB (`5242880` bytes)');
    expect(docContent).toContain('Authoritative Storage & Evidence Limit');
  });

  it('11C. Active documentation (docs/IMAGE_SECURITY.md) documents 10 MiB client decode limit vs 5 MiB storage limit', () => {
    const docPath = join(__dirname, '../docs/IMAGE_SECURITY.md');
    const docContent = readFileSync(docPath, 'utf-8');
    expect(docContent).toContain('10 MiB');
    expect(docContent).toContain('5 MiB');
    expect(docContent).toContain('client decoding safety limit');
  });
});
