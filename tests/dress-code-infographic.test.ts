import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { LANDING_CONTENT } from '../src/content/landing.js';

describe('Visitor Dress Code Policy & Infographic Component Integration Suite', () => {
  const landingSrc = readFileSync('src/pages/LandingPage.tsx', 'utf8');
  const infographicSrc = readFileSync('src/components/DressCodeInfographic.tsx', 'utf8');

  // ==========================================================================
  // 1. POLICY CONTENT CONTRACT
  // ==========================================================================
  describe('1. Content Model Consistency', () => {
    it('enforces exactly the approved 3 acceptable attire rules in content model', () => {
      const proper = LANDING_CONTENT.dressCode.proper.items;
      expect(proper).toHaveLength(3);
      expect(proper).toContain('T-shirt');
      expect(proper).toContain('Full-length pants or trousers');
      expect(proper).toContain('Shoes');

      // Does not impose mandatory formal suit or business uniform
      expect(proper.some((item) => /suit|tie|formal|collared shirt|barong/i.test(item))).toBe(false);
    });

    it('enforces exactly the approved 3 prohibited attire rules in content model', () => {
      const avoid = LANDING_CONTENT.dressCode.avoid.items;
      expect(avoid).toHaveLength(3);
      expect(avoid).toContain('Shorts');
      expect(avoid.some((item) => /sandals/i.test(item))).toBe(true);
      expect(avoid.some((item) => /sleeveless/i.test(item))).toBe(true);
    });

    it('preserves official policy heading, campus context, and institutional note', () => {
      const dc = LANDING_CONTENT.dressCode;
      expect(dc.heading).toBe('Visitor Dress Code');
      expect(dc.eyebrow).toBe('Before visiting campus');
      expect(dc.intro).toContain('EARIST');
      expect(dc.note).toContain('security policies at the gate');
    });
  });

  // ==========================================================================
  // 2. LANDING PAGE INTEGRATION & NAVIGATION
  // ==========================================================================
  describe('2. Actual Landing-Page Integration & Reachability', () => {
    it('imports and renders DressCodeInfographic inside LandingPage.tsx', () => {
      expect(landingSrc).toContain("import { DressCodeInfographic } from '@/components/DressCodeInfographic';");
      expect(landingSrc).toContain('<DressCodeInfographic />');
    });

    it('renders the infographic within the authoritative #dress-code section', () => {
      expect(landingSrc).toContain('id="dress-code"');
      const sectionSnippet = landingSrc.slice(
        landingSrc.indexOf('id="dress-code"'),
        landingSrc.indexOf('id="dress-code"') + 1200
      );
      expect(sectionSnippet).toContain('<DressCodeInfographic />');
      expect(sectionSnippet).toContain('className="scroll-mt-20');
    });

    it('preserves navigation link to #dress-code in header navLinks', () => {
      const navLink = LANDING_CONTENT.header.navLinks.find((l) => l.href === '#dress-code');
      expect(navLink).toBeDefined();
      expect(navLink?.label).toBe('Dress Code');
      expect(landingSrc).toContain('scrollToSection(event, link.href)');
    });
  });

  // ==========================================================================
  // 3. ALL SIX VISIBLE ATTIRE RULES
  // ==========================================================================
  describe('3. Presence of All Six Required Attire Rules', () => {
    it('visibly distinguishes ACCEPTABLE attire rules with complete descriptions', () => {
      // 1. T-shirt, polo shirt or collared blouse
      expect(infographicSrc).toContain('T-shirt, polo shirt or collared blouse');
      // 2. Full-length pants, trousers or long jeans
      expect(infographicSrc).toContain('Full-length pants, trousers or long jeans');
      // 3. Closed shoes, sneakers or formal footwear
      expect(infographicSrc).toContain('Closed shoes, sneakers or formal footwear');
    });

    it('visibly distinguishes PROHIBITED attire rules with complete descriptions', () => {
      // 1. Shorts, including athletic and cycling shorts
      expect(infographicSrc).toContain('Shorts, including athletic and cycling shorts');
      // 2. Sandals, slippers and open-toe rubber footwear
      expect(infographicSrc).toContain('Sandals, slippers and open-toe rubber footwear');
      // 3. Sleeveless tops, sando, tank tops and spaghetti straps
      expect(infographicSrc).toContain('Sleeveless tops, sando, tank tops and spaghetti straps');
    });
  });

  // ==========================================================================
  // 4. CUSTOM SVG ILLUSTRATIONS & VISUAL SECTION CONTRACT
  // ==========================================================================
  describe('4. Custom SVG Illustrations & Visual Section Contract', () => {
    it('renders distinct acceptable and prohibited section containers', () => {
      expect(infographicSrc).toContain('data-testid="acceptable-attire-section"');
      expect(infographicSrc).toContain('data-testid="prohibited-attire-section"');
      expect(infographicSrc).toContain('Proper Campus Attire');
      expect(infographicSrc).toContain('Please Avoid');
    });

    it('includes inline custom SVG illustrations for all acceptable clothing items', () => {
      expect(infographicSrc).toContain('aria-label="T-shirt, polo shirt or collared blouse illustration"');
      expect(infographicSrc).toContain('aria-label="Full-length pants, trousers or long jeans illustration"');
      expect(infographicSrc).toContain('aria-label="Closed shoes, sneakers or formal footwear illustration"');
    });

    it('includes inline custom SVG illustrations for all prohibited clothing items', () => {
      expect(infographicSrc).toContain('aria-label="Shorts, including athletic and cycling shorts illustration"');
      expect(infographicSrc).toContain('aria-label="Sandals, slippers and open-toe rubber footwear illustration"');
      expect(infographicSrc).toContain('aria-label="Sleeveless tops, sando, tank tops and spaghetti straps illustration"');
    });

    it('applies EARIST institutional maroon styling (#7b1113)', () => {
      expect(infographicSrc).toContain('#7b1113');
      expect(infographicSrc).toContain('Institutional Gate Attire Standards');
      expect(infographicSrc).toContain('Official EARIST Policy');
    });
  });
});
