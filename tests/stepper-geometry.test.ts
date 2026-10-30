// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { Stepper } from '../src/components/ui/Stepper';

describe('Stepper Component Geometry & 2-Row Track Invariants', () => {
  let container: HTMLDivElement;
  let root: any;

  const sampleSteps = [
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Live Face' },
    { id: 'id', title: 'Valid ID' },
    { id: 'verify', title: 'Verify' },
    { id: 'review', title: 'Review' },
  ];

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

  it('renders a CSS grid with repeat(N, minmax(0, 1fr)) for horizontal orientation', async () => {
    await act(async () => {
      root.render(
        React.createElement(Stepper, {
          steps: sampleSteps,
          currentStepIndex: 1,
          orientation: 'horizontal',
        })
      );
    });

    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol?.style.gridTemplateColumns).toBe('repeat(5, minmax(0, 1fr))');

    const listItems = container.querySelectorAll('li');
    expect(listItems.length).toBe(5);

    // Each list item has its column index set
    listItems.forEach((li, idx) => {
      expect(li.style.gridColumn).toBe(String(idx + 1));
      // First child is the marker container with fixed height h-8 sm:h-10
      const markerRow = li.firstElementChild as HTMLElement;
      expect(markerRow).not.toBeNull();
      expect(markerRow.className).toContain('h-8');

      // Second child is the label wrapper
      const labelRow = li.children[1] as HTMLElement;
      expect(labelRow).not.toBeNull();
      expect(labelRow.textContent).toContain(sampleSteps[idx].title);
    });
  });

  it('connectors use top-1/2 -translate-y-1/2 within fixed marker container', async () => {
    await act(async () => {
      root.render(
        React.createElement(Stepper, {
          steps: sampleSteps,
          currentStepIndex: 2,
          orientation: 'horizontal',
        })
      );
    });

    // There should be 4 connectors between 5 steps
    const connectors = container.querySelectorAll('.top-1\\/2.-translate-y-1\\/2');
    expect(connectors.length).toBe(4);

    connectors.forEach((conn) => {
      expect(conn.className).toContain('left-1/2');
      expect(conn.className).toContain('w-full');
      expect(conn.className).toContain('h-0.5');
    });
  });

  it('renders completed, active, and upcoming steps correctly without layout shifting', async () => {
    for (let activeStep = 0; activeStep < sampleSteps.length; activeStep++) {
      await act(async () => {
        root.render(
          React.createElement(Stepper, {
            steps: sampleSteps,
            currentStepIndex: activeStep,
            orientation: 'horizontal',
          })
        );
      });

      const listItems = container.querySelectorAll('li');
      listItems.forEach((li, idx) => {
        const marker = li.querySelector('.rounded-full');
        if (idx < activeStep) {
          // Completed: contains check icon
          expect(marker?.textContent).toContain('completed');
        } else if (idx === activeStep) {
          // Active
          expect(marker?.getAttribute('aria-current')).toBe('step');
          expect(marker?.textContent).toContain(String(idx + 1));
        } else {
          // Upcoming
          expect(marker?.getAttribute('aria-current')).toBeNull();
          expect(marker?.textContent).toContain(String(idx + 1));
        }
      });
    }
  });

  it('supports vertical orientation for kiosk displays', async () => {
    await act(async () => {
      root.render(
        React.createElement(Stepper, {
          steps: sampleSteps,
          currentStepIndex: 0,
          orientation: 'vertical',
        })
      );
    });

    const ol = container.querySelector('ol');
    expect(ol?.className).toContain('flex-col');
  });
});
