import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LANDING_CONTENT } from '@/content/landing';

describe('Workstream C & E: Landing Navigation and Dress Code Policy', () => {
  const landingSrc = readFileSync('src/pages/LandingPage.tsx', 'utf8');

  it('proves scrollToSection does NOT call window.history.pushState', () => {
    expect(landingSrc).not.toContain('window.history.pushState');
    expect(landingSrc).not.toContain('history.pushState');
  });

  it('proves scrollToSection uses prefers-reduced-motion check and scrollIntoView', () => {
    expect(landingSrc).toContain('function scrollToSection');
    expect(landingSrc).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'");
    expect(landingSrc).toContain('section.scrollIntoView');
  });

  it('proves navigation links include Dress Code pointing to #dress-code', () => {
    const dressCodeNav = LANDING_CONTENT.header.navLinks.find((link) => link.href === '#dress-code');
    expect(dressCodeNav).toBeDefined();
    expect(dressCodeNav?.label).toBe('Dress Code');
    expect(landingSrc).toContain('LANDING_CONTENT.header.navLinks.map');
  });

  it('proves #dress-code section exists in LandingPage with required guidelines', () => {
    expect(landingSrc).toContain('id="dress-code"');
    expect(landingSrc).toContain('Proper Campus Attire');
    expect(landingSrc).toContain('Please Avoid');

    // Assert content presence in LANDING_CONTENT
    expect(LANDING_CONTENT.dressCode).toBeDefined();
    expect(LANDING_CONTENT.dressCode.proper.title).toBe('Proper Campus Attire');
    expect(LANDING_CONTENT.dressCode.avoid.title).toBe('Please Avoid');

    const prohibitedItems = LANDING_CONTENT.dressCode.avoid.items.join(' ').toLowerCase();
    expect(prohibitedItems).toContain('shorts');
    expect(prohibitedItems).toContain('sando');
    expect(prohibitedItems).toContain('sleeveless');
    expect(prohibitedItems).toContain('slippers');
  });
});
