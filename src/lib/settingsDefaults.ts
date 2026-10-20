import type { VisitPurposeOption } from '@/types';

export const DEFAULT_VISIT_PURPOSES: VisitPurposeOption[] = [
  { label: 'Meeting', requiresDetails: false, detailPrompt: '' },
  { label: 'Document submission', requiresDetails: false, detailPrompt: '' },
  { label: 'Appointment', requiresDetails: false, detailPrompt: '' },
  { label: 'Delivery', requiresDetails: false, detailPrompt: '' },
  { label: 'Personal concern', requiresDetails: false, detailPrompt: '' },
  { label: 'Student or employee concern', requiresDetails: false, detailPrompt: '' },
];

export function normalizeVisitPurposes(value: unknown): VisitPurposeOption[] {
  const source = Array.isArray(value) ? value : DEFAULT_VISIT_PURPOSES;
  const labels = new Set<string>();
  const purposes: VisitPurposeOption[] = [];

  for (const item of source) {
    const label = (typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null && 'label' in item && typeof item.label === 'string'
        ? item.label
        : '').trim();
    if (label.length < 3 || label.length > 100) continue;

    const normalizedLabel = label.toLocaleLowerCase();
    if (labels.has(normalizedLabel)) continue;
    labels.add(normalizedLabel);

    const requiresDetails = typeof item === 'object' && item !== null && 'requiresDetails' in item
      ? item.requiresDetails === true
      : false;
    const detailPrompt = typeof item === 'object' && item !== null && 'detailPrompt' in item && typeof item.detailPrompt === 'string'
      ? item.detailPrompt.trim().slice(0, 160)
      : '';

    purposes.push({ label, requiresDetails, detailPrompt });
  }

  return purposes;
}

export const DEFAULT_REJECTION_REASONS = [
  'Invalid ID',
  'No prior appointment',
  'Underage',
  'Refused inspection',
];
