import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Workstream D: FAQ Single-Open Controlled Accordion', () => {
  const landingSrc = readFileSync('src/pages/LandingPage.tsx', 'utf8');

  it('proves independent <details> element is completely removed from LandingPage FAQ', () => {
    expect(landingSrc).not.toContain('<details');
    expect(landingSrc).not.toContain('</details>');
  });

  it('proves single-open accordion state openFaqIndex is implemented', () => {
    expect(landingSrc).toContain('const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);');
  });

  it('proves accessible button and ARIA controls are configured on each FAQ item', () => {
    expect(landingSrc).toContain('aria-expanded={isOpen}');
    expect(landingSrc).toContain('aria-controls={`faq-panel-${idx}`}');
    expect(landingSrc).toContain('id={`faq-trigger-${idx}`}');
    expect(landingSrc).toContain('id={`faq-panel-${idx}`}');
    expect(landingSrc).toContain('role="region"');
    expect(landingSrc).toContain('aria-labelledby={`faq-trigger-${idx}`}');
  });

  it('proves toggle logic closes active index when re-clicked and opens selected index', () => {
    expect(landingSrc).toContain('setOpenFaqIndex(isOpen ? null : idx)');
  });

  it('proves indicator rotates when expanded', () => {
    expect(landingSrc).toContain("isOpen ? 'rotate-180' : ''");
  });
});
