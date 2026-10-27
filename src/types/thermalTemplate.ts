import { z } from 'zod';

export const THERMAL_CANVAS_WIDTH = 384;
export const MIN_CANVAS_HEIGHT = 400;
export const MAX_CANVAS_HEIGHT = 1600;
export const DEFAULT_CANVAS_HEIGHT = 640;

export const MIN_QR_SIZE = 140;
export const MAX_QR_SIZE = 300;

export type ThermalElementType = 'text' | 'qr' | 'divider' | 'rectangle';

export type ThermalFieldBinding =
  | 'institution_name'
  | 'system_title'
  | 'visitor_name'
  | 'visit_date'
  | 'pass_reference'
  | 'validity_window'
  | 'purpose'
  | 'custom';

export interface ThermalTemplateElement {
  id: string;
  type: ThermalElementType;
  field?: ThermalFieldBinding;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  isMandatory?: boolean; // If true, cannot be removed
}

export type ThermalElement = ThermalTemplateElement;

export const MANDATORY_ELEMENT_TYPES: string[] = [
  'institution_name',
  'visitor_name',
  'visit_date',
  'qr_code',
  'pass_reference',
];

export interface ThermalTemplateLayout {
  width: typeof THERMAL_CANVAS_WIDTH;
  height: number;
  elements: ThermalTemplateElement[];
}

export function validateThermalTemplateLayout(layout: unknown) {
  return thermalTemplateLayoutSchema.safeParse(layout);
}

export type TemplateStatus = 'draft' | 'published' | 'archived';

export interface ThermalTemplateRecord {
  id: string;
  name: string;
  version: number;
  status: TemplateStatus;
  layout: ThermalTemplateLayout;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}

// Strict Zod schema for server & client template validation (Phase 3.3)
export const thermalElementSchema = z.object({
  id: z.string().min(1).max(50),
  type: z.enum(['text', 'qr', 'divider', 'rectangle']),
  field: z
    .enum([
      'institution_name',
      'system_title',
      'visitor_name',
      'visit_date',
      'pass_reference',
      'validity_window',
      'purpose',
      'custom',
    ])
    .optional(),
  text: z.string().max(200).optional(),
  x: z.number().min(0).max(THERMAL_CANVAS_WIDTH),
  y: z.number().min(0).max(MAX_CANVAS_HEIGHT),
  width: z.number().min(1).max(THERMAL_CANVAS_WIDTH),
  height: z.number().min(1).max(MAX_CANVAS_HEIGHT),
  fontSize: z.number().min(8).max(48).optional(),
  fontWeight: z.enum(['normal', 'bold']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  isMandatory: z.boolean().optional(),
}).strict().superRefine((el, ctx) => {
  // Disallow scripts, HTML, or remote URLs in custom text
  if (
    el.text &&
    (/<script/i.test(el.text) ||
      /<[^>]+>/i.test(el.text) ||
      /javascript:/i.test(el.text) ||
      /https?:\/\//i.test(el.text))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'HTML or script tags, and remote URLs are strictly prohibited in template elements',
    });
  }
  // If QR, validate size constraints
  if (el.type === 'qr') {
    if (el.width < MIN_QR_SIZE || el.height < MIN_QR_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `QR code must be at least ${MIN_QR_SIZE}x${MIN_QR_SIZE} pixels for scan reliability`,
      });
    }
  }
});

export const thermalTemplateLayoutSchema = z.object({
  width: z.literal(384),
  height: z.number().min(MIN_CANVAS_HEIGHT).max(MAX_CANVAS_HEIGHT),
  elements: z.array(thermalElementSchema).min(5).max(40),
}).strict().superRefine((layout, ctx) => {
  // Validate that all elements fit within canvas boundaries
  for (const el of layout.elements) {
    if (el.x + el.width > layout.width + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Element '${el.id}' exceeds canvas width (${el.x + el.width} > ${layout.width})`,
      });
    }
    if (el.y + el.height > layout.height + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Element '${el.id}' exceeds canvas height (${el.y + el.height} > ${layout.height})`,
      });
    }
  }

  // Validate mandatory locked elements exist (Phase 3.2)
  // Required: Institution identity, Visitor Name, Visit Date, QR, Pass Reference
  const hasInstitution = layout.elements.some(
    (el) => el.field === 'institution_name' || (el.type === 'text' && el.text?.includes('EARIST'))
  );
  const hasVisitorName = layout.elements.some((el) => el.field === 'visitor_name');
  const hasVisitDate = layout.elements.some((el) => el.field === 'visit_date');
  const hasQr = layout.elements.some((el) => el.type === 'qr');
  const hasPassRef = layout.elements.some((el) => el.field === 'pass_reference');

  if (!hasInstitution) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mandatory element missing: Institution identity is required',
    });
  }
  if (!hasVisitorName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mandatory element missing: Visitor Name is required',
    });
  }
  if (!hasVisitDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mandatory element missing: Visit Date is required',
    });
  }
  if (!hasQr) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mandatory element missing: QR code element is required',
    });
  }
  if (!hasPassRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mandatory element missing: Pass Reference is required',
    });
  }
});
