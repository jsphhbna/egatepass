import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FIX GROUP B: iOS Safari Form Zoom Prevention', () => {
  it('Input component applies text-base on mobile and sm:text-sm on desktop', () => {
    const inputSrc = readFileSync('src/components/ui/Input.tsx', 'utf8');
    expect(inputSrc).toContain('text-base sm:text-sm');
  });

  it('Select component applies text-base on mobile and sm:text-sm on desktop', () => {
    const selectSrc = readFileSync('src/components/ui/Select.tsx', 'utf8');
    expect(selectSrc).toContain('text-base sm:text-sm');
  });

  it('Textarea component applies text-base on mobile and sm:text-sm on desktop', () => {
    const textareaSrc = readFileSync('src/components/ui/Textarea.tsx', 'utf8');
    expect(textareaSrc).toContain('text-base sm:text-sm');
  });

  it('preserves browser accessibility and user zoom in index.html', () => {
    const indexHtml = readFileSync('index.html', 'utf8');
    expect(indexHtml).not.toContain('user-scalable=no');
    expect(indexHtml).not.toContain('user-scalable=0');
    expect(indexHtml).not.toContain('maximum-scale=1');
    expect(indexHtml).toContain('width=device-width, initial-scale=1.0');
  });
});
