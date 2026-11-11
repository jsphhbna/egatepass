export interface AdminOfficeAccountSummary {
  userId: string;
  email?: string;
  displayName: string;
  role: string;
  active: boolean;
  mustChangePassword: boolean;
  emailConfirmed?: boolean;
}

export interface AdminOfficeRecord {
  id: string;
  name: string;
  code?: string | null;
  description: string | null;
  active: boolean;
  verified?: boolean;
  verified_at?: string | null;
  verified_by?: string | null;
  publication_status?: 'draft' | 'published' | 'archived';
  requires_approval_before_pass?: boolean;
  published_at?: string | null;
  archived_at?: string | null;
  hasDependencies?: boolean;
  created_at?: string;
  updated_at?: string;
  dedicatedAccount?: AdminOfficeAccountSummary | null;
  assignedStaff?: AdminOfficeAccountSummary[];
}

export interface OfficeDirectoryStatusMeta {
  combinedLabel:
    | 'Active / Verified'
    | 'Active / Unverified'
    | 'Inactive / Verified'
    | 'Inactive / Unverified';
  lifecycleLabel: 'Published' | 'Draft' | 'Archived';
  visitorSelectable: boolean;
  visitorHint: string;
}

/**
 * Merges a server-confirmed office record into the local Admin directory list
 * without dropping existing account/staff metadata and keeping alphabetical order.
 */
export function upsertOfficeInDirectory(
  current: AdminOfficeRecord[],
  incoming: Partial<AdminOfficeRecord> & { id: string; name: string },
): AdminOfficeRecord[] {
  const existing = current.find((item) => item.id === incoming.id);
  const merged: AdminOfficeRecord = {
    id: incoming.id,
    name: incoming.name,
    code: incoming.code !== undefined ? incoming.code : (existing?.code ?? null),
    description: incoming.description !== undefined ? incoming.description : (existing?.description ?? null),
    active: incoming.active !== undefined ? incoming.active : (existing?.active ?? true),
    verified: incoming.verified !== undefined ? incoming.verified : (existing?.verified ?? false),
    verified_at: incoming.verified_at !== undefined ? incoming.verified_at : (existing?.verified_at ?? null),
    verified_by: incoming.verified_by !== undefined ? incoming.verified_by : (existing?.verified_by ?? null),
    publication_status: incoming.publication_status ?? existing?.publication_status,
    requires_approval_before_pass:
      incoming.requires_approval_before_pass !== undefined
        ? incoming.requires_approval_before_pass
        : existing?.requires_approval_before_pass,
    published_at: incoming.published_at !== undefined ? incoming.published_at : (existing?.published_at ?? null),
    archived_at: incoming.archived_at !== undefined ? incoming.archived_at : (existing?.archived_at ?? null),
    hasDependencies: incoming.hasDependencies !== undefined ? incoming.hasDependencies : existing?.hasDependencies,
    created_at: incoming.created_at ?? existing?.created_at,
    updated_at: incoming.updated_at ?? existing?.updated_at,
    dedicatedAccount: incoming.dedicatedAccount !== undefined ? incoming.dedicatedAccount : (existing?.dedicatedAccount ?? null),
    assignedStaff: incoming.assignedStaff !== undefined ? incoming.assignedStaff : (existing?.assignedStaff ?? []),
  };

  const next = existing
    ? current.map((item) => (item.id === incoming.id ? merged : item))
    : [...current, merged];

  return [...next].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Computes unambiguous administrative visibility status and visitor-selection eligibility.
 * Only Active / Published (non-archived) offices appear in public visitor office selection.
 */
export function getOfficeDirectoryStatusMeta(
  office: Pick<AdminOfficeRecord, 'active' | 'verified' | 'publication_status' | 'archived_at'>,
): OfficeDirectoryStatusMeta {
  const isArchived = office.publication_status === 'archived' || Boolean(office.archived_at);
  const isActive = Boolean(office.active) && !isArchived;
  const isVerified = office.publication_status
    ? office.publication_status === 'published'
    : Boolean(office.verified);

  const lifecycleLabel: OfficeDirectoryStatusMeta['lifecycleLabel'] = isArchived
    ? 'Archived'
    : (office.publication_status === 'published' || (!office.publication_status && isActive && isVerified))
      ? 'Published'
      : 'Draft';

  if (isArchived) {
    return {
      combinedLabel: 'Inactive / Unverified',
      lifecycleLabel: 'Archived',
      visitorSelectable: false,
      visitorHint: 'Archived and hidden from new visitor selections',
    };
  }

  if (isActive && isVerified) {
    return {
      combinedLabel: 'Active / Verified',
      lifecycleLabel: 'Published',
      visitorSelectable: true,
      visitorHint: 'Published and selectable by visitors',
    };
  }
  if (isActive && !isVerified) {
    return {
      combinedLabel: 'Active / Unverified',
      lifecycleLabel: 'Draft',
      visitorSelectable: false,
      visitorHint: 'Draft office — hidden from visitors until published by Superadmin',
    };
  }
  if (!isActive && isVerified) {
    return {
      combinedLabel: 'Inactive / Verified',
      lifecycleLabel,
      visitorSelectable: false,
      visitorHint: 'Hidden from visitors while inactive',
    };
  }
  return {
    combinedLabel: 'Inactive / Unverified',
    lifecycleLabel,
    visitorSelectable: false,
    visitorHint: 'Hidden from visitors (inactive draft)',
  };
}
