export interface RetentionPolicy {
  visitorRetentionDays: number;
  imageRetentionDays: number;
  auditRetentionDays: number;
  reconciliationRetentionDays: number;
  automaticCleanupEnabled: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  visitorRetentionDays: 30,
  imageRetentionDays: 7,
  auditRetentionDays: 365,
  reconciliationRetentionDays: 90,
  automaticCleanupEnabled: true,
};

export function normalizeRetentionPolicy(value: unknown): RetentionPolicy {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  // Legacy retentionDays was used only by the image purge. It never becomes visitor/audit retention.
  const imageRetentionDays = typeof source.imageRetentionDays === 'number'
    ? source.imageRetentionDays
    : typeof source.retentionDays === 'number' ? source.retentionDays : DEFAULT_RETENTION_POLICY.imageRetentionDays;
  return {
    visitorRetentionDays: typeof source.visitorRetentionDays === 'number' ? source.visitorRetentionDays : DEFAULT_RETENTION_POLICY.visitorRetentionDays,
    imageRetentionDays,
    auditRetentionDays: typeof source.auditRetentionDays === 'number' ? source.auditRetentionDays : DEFAULT_RETENTION_POLICY.auditRetentionDays,
    reconciliationRetentionDays: typeof source.reconciliationRetentionDays === 'number' ? source.reconciliationRetentionDays : DEFAULT_RETENTION_POLICY.reconciliationRetentionDays,
    automaticCleanupEnabled: typeof source.automaticCleanupEnabled === 'boolean' ? source.automaticCleanupEnabled : DEFAULT_RETENTION_POLICY.automaticCleanupEnabled,
  };
}
