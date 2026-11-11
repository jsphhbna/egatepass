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
  description: string | null;
  active: boolean;
  verified?: boolean;
  verified_at?: string | null;
  verified_by?: string | null;
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
    description: incoming.description !== undefined ? incoming.description : (existing?.description ?? null),
    active: incoming.active !== undefined ? incoming.active : (existing?.active ?? true),
    verified: incoming.verified !== undefined ? incoming.verified : (existing?.verified ?? false),
    verified_at: incoming.verified_at !== undefined ? incoming.verified_at : (existing?.verified_at ?? null),
    verified_by: incoming.verified_by !== undefined ? incoming.verified_by : (existing?.verified_by ?? null),
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
 * Only Active / Verified offices appear in public visitor office selection.
 */
export function getOfficeDirectoryStatusMeta(
  office: Pick<AdminOfficeRecord, 'active' | 'verified'>,
): OfficeDirectoryStatusMeta {
  const isActive = Boolean(office.active);
  const isVerified = Boolean(office.verified);

  if (isActive && isVerified) {
    return {
      combinedLabel: 'Active / Verified',
      visitorSelectable: true,
      visitorHint: 'Selectable by visitors',
    };
  }
  if (isActive && !isVerified) {
    return {
      combinedLabel: 'Active / Unverified',
      visitorSelectable: false,
      visitorHint: 'Hidden from visitors until verified by Superadmin',
    };
  }
  if (!isActive && isVerified) {
    return {
      combinedLabel: 'Inactive / Verified',
      visitorSelectable: false,
      visitorHint: 'Hidden from visitors while inactive',
    };
  }
  return {
    combinedLabel: 'Inactive / Unverified',
    visitorSelectable: false,
    visitorHint: 'Hidden from visitors (inactive and unverified)',
  };
}
