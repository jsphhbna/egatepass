import { z } from 'zod';
import type { RetentionPolicy } from '@/lib/retentionPolicy';

export const RETENTION_INPUT_FIELDS = [
  { field: 'visitorRetentionDays', label: 'Visitor / visit records', min: 7, max: 365 },
  { field: 'imageRetentionDays', label: 'Visitor images / valid IDs', min: 1, max: 90 },
  { field: 'auditRetentionDays', label: 'Audit logs', min: 90, max: 1095 },
  { field: 'reconciliationRetentionDays', label: 'Reconciliation records', min: 30, max: 365 },
] as const;

export type RetentionInputField = typeof RETENTION_INPUT_FIELDS[number]['field'];

function createRetentionInputSchema({ label, min, max }: typeof RETENTION_INPUT_FIELDS[number]) {
  return z.string()
    .trim()
    .min(1, `${label} is required. Enter ${min} to ${max} days.`)
    .regex(/^-?\d+$/, `${label} must be a whole number.`)
    .transform(Number)
    .refine(Number.isSafeInteger, `${label} must be between ${min} and ${max} days.`)
    .refine((value) => value >= min && value <= max, `${label} must be between ${min} and ${max} days.`);
}

const retentionInputSchemas = {
  visitorRetentionDays: createRetentionInputSchema(RETENTION_INPUT_FIELDS[0]),
  imageRetentionDays: createRetentionInputSchema(RETENTION_INPUT_FIELDS[1]),
  auditRetentionDays: createRetentionInputSchema(RETENTION_INPUT_FIELDS[2]),
  reconciliationRetentionDays: createRetentionInputSchema(RETENTION_INPUT_FIELDS[3]),
};

export const retentionPolicyInputSchema = z.object(retentionInputSchemas);

export type RetentionInputValues = z.input<typeof retentionPolicyInputSchema>;
export type ValidatedRetentionInputValues = z.output<typeof retentionPolicyInputSchema>;
export type RetentionInputErrors = Partial<Record<RetentionInputField, string>>;

export function createRetentionInputValues(policy: RetentionPolicy): RetentionInputValues {
  return {
    visitorRetentionDays: String(policy.visitorRetentionDays),
    imageRetentionDays: String(policy.imageRetentionDays),
    auditRetentionDays: String(policy.auditRetentionDays),
    reconciliationRetentionDays: String(policy.reconciliationRetentionDays),
  };
}

export function getRetentionInputError(field: RetentionInputField, value: string): string | undefined {
  const result = retentionInputSchemas[field].safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export function validateRetentionInputs(values: RetentionInputValues):
  | { success: true; data: ValidatedRetentionInputValues; errors: RetentionInputErrors }
  | { success: false; errors: RetentionInputErrors } {
  const result = retentionPolicyInputSchema.safeParse(values);
  if (result.success) {
    return { success: true, data: result.data, errors: {} };
  }

  const errors: RetentionInputErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && field in retentionInputSchemas) {
      const retentionField = field as RetentionInputField;
      errors[retentionField] ??= issue.message;
    }
  }
  return { success: false, errors };
}
