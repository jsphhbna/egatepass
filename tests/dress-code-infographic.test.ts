import { describe, it, expect } from 'vitest';
import { LANDING_CONTENT } from '../src/content/landing.js';

describe('Visitor Dress Code Policy & Infographic Content', () => {
  it('1. Enforces exactly the approved 3 acceptable attire rules', () => {
    const proper = LANDING_CONTENT.dressCode.proper.items;
    expect(proper).toHaveLength(3);
    expect(proper).toContain('T-shirt');
    expect(proper).toContain('Full-length pants or trousers');
    expect(proper).toContain('Shoes');

    // Does not impose mandatory formal suit or business uniform
    expect(proper.some((item) => /suit|tie|formal|collared shirt|barong/i.test(item))).toBe(false);
  });

  it('2. Enforces exactly the approved 3 prohibited attire rules', () => {
    const avoid = LANDING_CONTENT.dressCode.avoid.items;
    expect(avoid).toHaveLength(3);
    expect(avoid).toContain('Shorts');
    expect(avoid.some((item) => /sandals/i.test(item))).toBe(true);
    expect(avoid.some((item) => /sleeveless/i.test(item))).toBe(true);
  });

  it('3. Preserves official policy heading, campus context, and institutional note', () => {
    const dc = LANDING_CONTENT.dressCode;
    expect(dc.heading).toBe('Visitor Dress Code');
    expect(dc.eyebrow).toBe('Before visiting campus');
    expect(dc.intro).toContain('EARIST');
    expect(dc.note).toContain('security policies at the gate');
  });
});
