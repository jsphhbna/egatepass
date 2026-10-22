export interface RetentionPolicy {
  visitorRetentionDays: number;
  imageRetentionDays: number;
  photoRetentionDays: number;
  idRetentionDays: number;
  auditRetentionDays: number;
  reconciliationRetentionDays: number;
  automaticCleanupEnabled: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  visitorRetentionDays: 30,
  imageRetentionDays: 7,
  photoRetentionDays: 7,
  idRetentionDays: 30,
  auditRetentionDays: 365,
  reconciliationRetentionDays: 90,
  automaticCleanupEnabled: true,
};

export function normalizeRetentionPolicy(value: unknown): RetentionPolicy {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const imageRetentionDays = typeof source.imageRetentionDays === 'number'
    ? source.imageRetentionDays
    : typeof source.retentionDays === 'number' ? source.retentionDays : DEFAULT_RETENTION_POLICY.imageRetentionDays;
  const photoRetentionDays = typeof source.photoRetentionDays === 'number'
    ? source.photoRetentionDays
    : (typeof source.imageRetentionDays === 'number' ? source.imageRetentionDays : DEFAULT_RETENTION_POLICY.photoRetentionDays);
  const idRetentionDays = typeof source.idRetentionDays === 'number'
    ? source.idRetentionDays
    : (typeof source.id_retention_days === 'number' ? source.id_retention_days : 30);

  return {
    visitorRetentionDays: typeof source.visitorRetentionDays === 'number' ? source.visitorRetentionDays : DEFAULT_RETENTION_POLICY.visitorRetentionDays,
    imageRetentionDays,
    photoRetentionDays,
    idRetentionDays,
    auditRetentionDays: typeof source.auditRetentionDays === 'number' ? source.auditRetentionDays : DEFAULT_RETENTION_POLICY.auditRetentionDays,
    reconciliationRetentionDays: typeof source.reconciliationRetentionDays === 'number' ? source.reconciliationRetentionDays : DEFAULT_RETENTION_POLICY.reconciliationRetentionDays,
    automaticCleanupEnabled: typeof source.automaticCleanupEnabled === 'boolean' ? source.automaticCleanupEnabled : DEFAULT_RETENTION_POLICY.automaticCleanupEnabled,
  };
}
