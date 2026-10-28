// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FormField } from '@/components/ui/FormField';
import { VisitPurposeField } from '@/components/VisitPurposeField';

describe('Group A: System-Wide Required / Optional Field Indication', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders required indicator with accessible text and asterisk when requirement="required"', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          FormField,
          { label: 'First Name', id: 'first-name', requirement: 'required' },
          React.createElement('input', { id: 'first-name', type: 'text', required: true, 'aria-required': 'true' })
        )
      );
    });

    expect(container.textContent).toContain('First Name');

    const asterisk = container.querySelector('span[aria-hidden="true"]');
    expect(asterisk).not.toBeNull();
    expect(asterisk?.textContent).toBe('*');
    expect(asterisk?.className).toContain('text-[var(--color-danger)]');

    const srOnly = container.querySelector('.sr-only');
    expect(srOnly).not.toBeNull();
    expect(srOnly?.textContent?.trim()).toBe('(required)');

    const input = container.querySelector('input');
    expect(input?.hasAttribute('required')).toBe(true);
    expect(input?.getAttribute('aria-required')).toBe('true');
  });

  it('renders optional indicator with muted secondary styling when requirement="optional"', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          FormField,
          { label: 'Middle Name', id: 'middle-name', requirement: 'optional' },
          React.createElement('input', { id: 'middle-name', type: 'text' })
        )
      );
    });

    expect(container.textContent).toContain('Middle Name');
    expect(container.textContent).toContain('(Optional)');

    const optionalSpan = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent?.includes('(Optional)')
    );
    expect(optionalSpan).not.toBeUndefined();
    expect(optionalSpan?.className).toContain('text-[var(--color-text-muted)]');

    // Must NOT contain an asterisk
    expect(container.textContent).not.toContain('*');
  });

  it('defaults to requirement="none" and renders no asterisk or optional label', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          FormField,
          { label: 'Filter Search', id: 'search' },
          React.createElement('input', { id: 'search', type: 'text' })
        )
      );
    });

    expect(container.textContent).toContain('Filter Search');
    expect(container.textContent).not.toContain('*');
    expect(container.textContent).not.toContain('(Optional)');
    expect(container.textContent).not.toContain('(required)');
  });

  it('makes conditional purpose details visibly required when requiresDetails=true', async () => {
    const defaultPurposeOptions = [
      { label: 'Official Business', requiresDetails: true, detailPrompt: 'Office or department to visit' },
      { label: 'General Inquiry', requiresDetails: false },
    ];

    await act(async () => {
      root.render(
        React.createElement(VisitPurposeField, {
          purposes: defaultPurposeOptions,
          value: 'General Inquiry',
          onChange: () => {},
        })
      );
    });

    // General Inquiry requiresDetails = false -> no details field
    expect(container.textContent).not.toContain('Office or department to visit');

    // Select Official Business via user interaction (select dropdown change)
    const select = container.querySelector('select');
    expect(select).not.toBeNull();

    await act(async () => {
      if (select) {
        select.value = 'Official Business';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    expect(container.textContent).toContain('Office or department to visit');

    // The details field must visibly show the required asterisk
    const asterisks = Array.from(container.querySelectorAll('span[aria-hidden="true"]')).filter(
      (s) => s.textContent === '*'
    );
    expect(asterisks.length).toBeGreaterThanOrEqual(2); // Purpose * + Details *
  });
});
