import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FIX GROUP B: iOS Safari Form Controls & Date Input Overflow Hardening', () => {
  const inputSrc = readFileSync('src/components/ui/Input.tsx', 'utf8');
  const selectSrc = readFileSync('src/components/ui/Select.tsx', 'utf8');
  const textareaSrc = readFileSync('src/components/ui/Textarea.tsx', 'utf8');
  const formFieldSrc = readFileSync('src/components/ui/FormField.tsx', 'utf8');
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');
  const indexHtml = readFileSync('index.html', 'utf8');

  it('Input component applies text-base on mobile and sm:text-sm on desktop to prevent auto-zoom', () => {
    expect(inputSrc).toContain('text-base sm:text-sm');
  });

  it('Select component applies text-base on mobile and sm:text-sm on desktop', () => {
    expect(selectSrc).toContain('text-base sm:text-sm');
  });

  it('Textarea component applies text-base on mobile and sm:text-sm on desktop', () => {
    expect(textareaSrc).toContain('text-base sm:text-sm');
  });

  it('preserves browser accessibility and user zoom in index.html without user-scalable restrictions', () => {
    expect(indexHtml).not.toContain('user-scalable=no');
    expect(indexHtml).not.toContain('user-scalable=0');
    expect(indexHtml).not.toContain('maximum-scale=1');
    expect(indexHtml).toContain('width=device-width, initial-scale=1.0');
  });

  it('enforces width hardening on shared Input (box-border, w-full, min-w-0, max-w-full)', () => {
    expect(inputSrc).toContain('box-border');
    expect(inputSrc).toContain('w-full');
    expect(inputSrc).toContain('min-w-0');
    expect(inputSrc).toContain('max-w-full');
  });

  it('enforces min-w-0 on FormField container wrapper so flex/grid parents allow shrinking', () => {
    expect(formFieldSrc).toContain('min-w-0');
  });

  it('applies targeted Safari-safe horizontal padding for temporal inputs (date, time, etc.) while preserving standard padding for text', () => {
    // Temporal types must be detected
    expect(inputSrc).toContain("'date'");
    expect(inputSrc).toContain("'time'");

    // Checks that temporal inputs receive reduced mobile padding (px-2 sm:px-3.5)
    // while non-temporal inputs keep full px-3.5
    expect(inputSrc).toContain("isTemporal ? 'px-2 sm:px-3.5' : 'px-3.5'");
  });

  it('preserves native date picker attributes in Portal (GetPassPage) and Kiosk (KioskPage)', () => {
    expect(getPassSrc).toContain('type="date"');
    expect(getPassSrc).toContain('min={today}');
    expect(getPassSrc).toContain('max={latestVisitDate}');

    expect(kioskSrc).toContain('type="date"');
    expect(kioskSrc).toContain('min={today}');
    expect(kioskSrc).toContain('max={latestVisitDate}');
  });

  it('does NOT rely on global overflow-x-hidden workarounds on PageShell, Card, or index.html', () => {
    const pageShellSrc = readFileSync('src/components/ui/PageShell.tsx', 'utf8');
    const cardSrc = readFileSync('src/components/ui/Card.tsx', 'utf8');

    expect(indexHtml).not.toContain('overflow-x-hidden');
    expect(pageShellSrc).not.toContain('overflow-x-hidden');
    expect(cardSrc).not.toContain('overflow-x-hidden');
  });
});
