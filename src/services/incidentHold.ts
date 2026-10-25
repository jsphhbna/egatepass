import { getAccessToken } from '@/services/auth';

export interface IncidentHold {
  id: string;
  visitorId: string | null;
  passId: string | null;
  visitorName: string | null;
  passReference: string | null;
  reason: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
}

export async function listIncidentHolds(activeOrOptions?: boolean | { active?: boolean; activeOnly?: boolean; limit?: number }): Promise<IncidentHold[]> {
  const token = await getAccessToken();
  const url = new URL('/api/admin/holds', window.location.origin);
  if (typeof activeOrOptions === 'boolean') {
    url.searchParams.set('active', String(activeOrOptions));
  } else if (activeOrOptions && typeof activeOrOptions === 'object') {
    const activeVal = activeOrOptions.active ?? activeOrOptions.activeOnly;
    if (typeof activeVal === 'boolean') {
      url.searchParams.set('active', String(activeVal));
    }
    if (typeof activeOrOptions.limit === 'number') {
      url.searchParams.set('limit', String(activeOrOptions.limit));
    }
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error('Failed to load incident holds');
  }
  const data = await response.json().catch(() => ({}));
  return (data.holds || []) as IncidentHold[];
}

export async function getActiveIncidentHoldsForRecord(params: {
  passId?: string | null;
  visitorId?: string | null;
}): Promise<IncidentHold[]> {
  const token = await getAccessToken();
  const url = new URL('/api/admin/holds', window.location.origin);
  url.searchParams.set('active', 'true');
  url.searchParams.set('activeOnly', 'true');
  if (params.passId) url.searchParams.set('passId', params.passId);
  if (params.visitorId) url.searchParams.set('visitorId', params.visitorId);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error('Failed to load incident holds for record');
  }
  const data = await response.json().catch(() => ({}));
  return (data.holds || []) as IncidentHold[];
}

export async function createIncidentHold(params: {
  visitorId?: string | null;
  passId?: string | null;
  reason: string;
}): Promise<{ holdId: string }> {
  const token = await getAccessToken();
  const response = await fetch('/api/admin/holds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Failed to place incident hold');
  }
  return { holdId: data.holdId };
}

export async function releaseIncidentHold(holdId: string, reason?: string): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch('/api/admin/holds', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ holdId, reason }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Failed to release incident hold');
  }
}
