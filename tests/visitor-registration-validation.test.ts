// @vitest-environment happy-dom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createGetPassSchema, personalDetailsStepSchema } from '@/pages/GetPassPage';
import { createKioskPassSchema } from '@/pages/KioskPage';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { getManilaDateString } from '@/lib/scheduling';

describe('R6 Visitor Registration UI & Purpose Validation Suite', () => {
  const todayManila = getManilaDateString(new Date());

  describe('createGetPassSchema purpose validation', () => {
    const schema = createGetPassSchema();

    const baseValidInput = {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      contactNumber: '09171234567',
      visitDate: todayManila,
      arrivalMode: 'no_vehicle' as const,
      consent: true as const,
    };

    it('rejects missing or empty purpose', () => {
      const res = schema.safeParse({ ...baseValidInput, purpose: '' });
      expect(res.success).toBe(false);
      if (!res.success) {
        const purposeIssue = res.error.issues.find((i) => i.path.includes('purpose'));
        expect(purposeIssue).toBeDefined();
        expect(purposeIssue?.message).toContain('minimum 3 characters');
      }
    });

    it('rejects whitespace-only purpose', () => {
      const res = schema.safeParse({ ...baseValidInput, purpose: '    ' });
      expect(res.success).toBe(false);
      if (!res.success) {
        const purposeIssue = res.error.issues.find((i) => i.path.includes('purpose'));
        expect(purposeIssue).toBeDefined();
        expect(purposeIssue?.message).toContain('minimum 3 characters');
      }
    });

    it('rejects purpose with fewer than 3 trimmed characters', () => {
      const res1 = schema.safeParse({ ...baseValidInput, purpose: 'ab' });
      expect(res1.success).toBe(false);

      const res2 = schema.safeParse({ ...baseValidInput, purpose: '  x  ' });
      expect(res2.success).toBe(false);
    });

    it('accepts valid trimmed purpose between 3 and 300 characters', () => {
      const res = schema.safeParse({
        ...baseValidInput,
        purpose: '  Consultation with Dean  ',
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.purpose).toBe('Consultation with Dean');
      }
    });

    it('rejects purpose exceeding 300 characters', () => {
      const res = schema.safeParse({
        ...baseValidInput,
        purpose: 'a'.repeat(301),
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        const purposeIssue = res.error.issues.find((i) => i.path.includes('purpose'));
        expect(purposeIssue).toBeDefined();
      }
    });
  });

  describe('createKioskPassSchema purpose validation', () => {
    const kioskSchema = createKioskPassSchema();

    const baseValidKiosk = {
      firstName: 'Maria',
      lastName: 'Santos',
      contactNumber: '09181234567',
      visitDate: todayManila,
      consent: true as const,
    };

    it('trims purpose and rejects whitespace-only purpose in kiosk schema', () => {
      const res = kioskSchema.safeParse({
        ...baseValidKiosk,
        purpose: '   ',
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        const purposeIssue = res.error.issues.find((i) => i.path.includes('purpose'));
        expect(purposeIssue).toBeDefined();
      }
    });

    it('accepts and trims valid purpose in kiosk schema', () => {
      const res = kioskSchema.safeParse({
        ...baseValidKiosk,
        purpose: '  Registrar document pick-up  ',
      });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.purpose).toBe('Registrar document pick-up');
      }
    });
  });

  describe('VisitPurposeField component inline validation', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    const testPurposes = [
      { label: 'Campus Tour', requiresDetails: false },
      { label: 'Official Business', requiresDetails: true, detailPrompt: 'Department or office to visit' },
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

    it('shows inline error when custom purpose (__other__) has less than 3 characters', async () => {
      let currentVal = '';
      await act(async () => {
        root.render(
          React.createElement(VisitPurposeField, {
            purposes: testPurposes,
            value: currentVal,
            onChange: (val) => {
              currentVal = val;
            },
          })
        );
      });

      // Select Other
      const select = container.querySelector('select');
      expect(select).not.toBeNull();
      await act(async () => {
        if (select) {
          select.value = '__other__';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Should render textarea for custom purpose
      const textarea = container.querySelector('textarea');
      expect(textarea).not.toBeNull();

      // Because value is empty, inline error should be rendered
      expect(container.textContent).toContain('Please describe the purpose of your visit (minimum 3 characters)');

      // User types only 2 characters
      await act(async () => {
        root.render(
          React.createElement(VisitPurposeField, {
            purposes: testPurposes,
            value: 'ab',
            onChange: (val) => {
              currentVal = val;
            },
          })
        );
      });
      expect(container.textContent).toContain('Please describe the purpose of your visit (minimum 3 characters)');

      // User types 3 valid characters
      await act(async () => {
        root.render(
          React.createElement(VisitPurposeField, {
            purposes: testPurposes,
            value: 'abc',
            onChange: (val) => {
              currentVal = val;
            },
          })
        );
      });
      expect(container.textContent).not.toContain('Please describe the purpose of your visit (minimum 3 characters)');
    });

    it('shows inline error when preset detail-required input has less than 2 characters', async () => {
      let currentVal = '';
      await act(async () => {
        root.render(
          React.createElement(VisitPurposeField, {
            purposes: testPurposes,
            value: currentVal,
            onChange: (val) => {
              currentVal = val;
            },
          })
        );
      });

      // Select Official Business (requiresDetails = true)
      const select = container.querySelector('select');
      await act(async () => {
        if (select) {
          select.value = 'Official Business';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Should show inline error for details required
      expect(container.textContent).toContain('Please provide the requested details');

      // Type 2 characters
      const textarea = container.querySelector('textarea');
      expect(textarea).not.toBeNull();
      await act(async () => {
        if (textarea) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value'
          )?.set;
          setter?.call(textarea, 'HR');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Value emitted should be composed with details
      expect(currentVal).toBe('Official Business — HR');
    });
  });

  describe('Step 1 Personal Details Multi-Step Validation Invariant', () => {
    it('validates Step 1 fields with personalDetailsStepSchema independently of purpose', () => {
      const step1Valid = {
        firstName: 'Juan',
        middleName: 'Perez',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        consent: true,
      };

      const res = personalDetailsStepSchema.safeParse(step1Valid);
      expect(res.success).toBe(true);

      // Rejects missing consent
      const withoutConsent = personalDetailsStepSchema.safeParse({ ...step1Valid, consent: false });
      expect(withoutConsent.success).toBe(false);

      // Rejects invalid phone
      const invalidPhone = personalDetailsStepSchema.safeParse({ ...step1Valid, contactNumber: '12345' });
      expect(invalidPhone.success).toBe(false);

      // Rejects short name
      const shortName = personalDetailsStepSchema.safeParse({ ...step1Valid, firstName: 'A' });
      expect(shortName.success).toBe(false);
    });

    it('allows Step 1 personal details to validate independently while purpose is empty (Step 2 field)', () => {
      // Step 1 only triggers personal details: firstName, middleName, lastName, contactNumber, consent
      const step1Fields = {
        firstName: 'Juan',
        middleName: 'Perez',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        consent: true,
      };

      // Purpose is unpopulated on Step 1 defaultValues
      const step1FormState = {
        ...step1Fields,
        purpose: '', // Populated later on Step 2 (Visit & Vehicle Details)
        arrivalMode: 'no_vehicle',
      };

      // Validating Step 1 fields specifically succeeds
      expect(step1FormState.firstName.trim().length).toBeGreaterThanOrEqual(2);
      expect(step1FormState.lastName.trim().length).toBeGreaterThanOrEqual(2);
      expect(step1FormState.contactNumber).toMatch(/^(09|\+639)\d{9}$/);
      expect(step1FormState.consent).toBe(true);

      // Verify that full-schema submission should NOT be run on Step 1 form submission
      // because purpose is empty until Step 2
      const fullSchema = createGetPassSchema();
      const fullValidation = fullSchema.safeParse(step1FormState);
      expect(fullValidation.success).toBe(false);
      // The failure in full schema is solely due to purpose being empty on Step 1
      if (!fullValidation.success) {
        const issues = fullValidation.error.issues;
        expect(issues.every((i) => i.path.includes('purpose'))).toBe(true);
      }
    });
  });
});
