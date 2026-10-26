import { describe, it, expect } from 'vitest';
import {
  THERMAL_CANVAS_WIDTH,
  MIN_CANVAS_HEIGHT,
  MAX_CANVAS_HEIGHT,
  MIN_QR_SIZE,
  thermalElementSchema,
  thermalTemplateLayoutSchema,
  validateThermalTemplateLayout,
  type ThermalTemplateLayout,
} from '@/types/thermalTemplate';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';

describe('Phase 3 & Phase 17: Super Admin Thermal Template Management', () => {
  it('3.1. Bundled default thermal template passes strict schema validation', () => {
    const valResult = validateThermalTemplateLayout(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
    expect(valResult.success).toBe(true);
    expect(BUNDLED_DEFAULT_THERMAL_TEMPLATE.width).toBe(THERMAL_CANVAS_WIDTH);
    expect(BUNDLED_DEFAULT_THERMAL_TEMPLATE.height).toBeGreaterThanOrEqual(MIN_CANVAS_HEIGHT);
    expect(BUNDLED_DEFAULT_THERMAL_TEMPLATE.height).toBeLessThanOrEqual(MAX_CANVAS_HEIGHT);
  });

  it('3.2. Enforces mandatory elements: fails when visitor_name or QR is missing', () => {
    // Missing QR code
    const invalidLayoutWithoutQr: ThermalTemplateLayout = {
      width: 384,
      height: 600,
      elements: BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements.filter((el) => el.type !== 'qr'),
    };
    const qrResult = validateThermalTemplateLayout(invalidLayoutWithoutQr);
    expect(qrResult.success).toBe(false);
    if (!qrResult.success) {
      expect(qrResult.error.issues.some((i) => i.message.includes('QR code element is required'))).toBe(true);
    }

    // Missing visitor name
    const invalidLayoutWithoutName: ThermalTemplateLayout = {
      width: 384,
      height: 600,
      elements: BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements.filter((el) => el.field !== 'visitor_name'),
    };
    const nameResult = validateThermalTemplateLayout(invalidLayoutWithoutName);
    expect(nameResult.success).toBe(false);
    if (!nameResult.success) {
      expect(nameResult.error.issues.some((i) => i.message.includes('Visitor Name is required'))).toBe(true);
    }
  });

  it('3.3. Rejects invalid width: only native 384px width is permitted', () => {
    const invalidWidthLayout = {
      ...BUNDLED_DEFAULT_THERMAL_TEMPLATE,
      width: 576, // 3-inch or 80mm width instead of 384px MXW01 width
    };
    const result = thermalTemplateLayoutSchema.safeParse(invalidWidthLayout);
    expect(result.success).toBe(false);
  });

  it('3.4. Rejects elements exceeding canvas boundaries', () => {
    const outOfBoundsLayout: ThermalTemplateLayout = {
      ...BUNDLED_DEFAULT_THERMAL_TEMPLATE,
      elements: [
        ...BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements,
        {
          id: 'out-of-bounds-el',
          type: 'text',
          text: 'Off Canvas',
          x: 350,
          y: 100,
          width: 100, // 350 + 100 = 450 > 384
          height: 30,
        },
      ],
    };
    const result = validateThermalTemplateLayout(outOfBoundsLayout);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('exceeds canvas width'))).toBe(true);
    }
  });

  it('3.5. Security: Rejects scripts and HTML injection in custom text elements', () => {
    const xssElement = {
      id: 'custom-text-xss',
      type: 'text',
      text: '<script>alert("xss")</script>',
      x: 10,
      y: 10,
      width: 200,
      height: 30,
    };
    const result = thermalElementSchema.safeParse(xssElement);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('HTML or script tags'))).toBe(true);
    }
  });

  it('3.6. Enforces minimum QR size for optical scan reliability', () => {
    const tinyQrElement = {
      id: 'tiny-qr',
      type: 'qr',
      x: 10,
      y: 10,
      width: 80, // Less than MIN_QR_SIZE (140)
      height: 80,
    };
    const result = thermalElementSchema.safeParse(tinyQrElement);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes(`at least ${MIN_QR_SIZE}x${MIN_QR_SIZE}`))).toBe(true);
    }
  });
});
