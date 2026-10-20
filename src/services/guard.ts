import { requireSupabase } from '@/lib/supabase';

export interface GuardQueuePass {
  id: string;
  visitorName: string;
  purpose: string;
  source: 'portal' | 'kiosk';
  status: 'pending';
  validFrom: string;
  validUntil: string;
  scannedAt: string;
  gate: string | null;
  photoPublicId: string;
  idImagePublicId: string | null;
}

export interface GuardDashboardData {
  queue: GuardQueuePass[];
  stats: { inside: number; exited: number; rejected: number; total: number };
  rejectionReasons: string[];
  pendingTotal: number;
  hasMore: boolean;
}

interface DashboardWire {
  queue?: Array<{
    id: string; visitorName: string; purpose: string; source: 'portal' | 'kiosk'; status: 'pending';
    validFrom: string; validUntil: string; scannedAt: string; gate: string | null;
    photoEvidenceId: string; idEvidenceId: string | null;
  }>;
  stats?: GuardDashboardData['stats'];
  rejectionReasons?: string[];
  pendingTotal?: number;
  hasMore?: boolean;
}

export async function fetchGuardDashboard(options?: {
  limit?: number;
  offset?: number;
}): Promise<GuardDashboardData> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const { data: rawData, error } = await requireSupabase()
    .schema('api')
    .rpc('guard_dashboard', {
      requested_limit: limit,
      requested_offset: offset,
    });
  const data = rawData as DashboardWire | null;
  if (error || !data) throw error ?? new Error('Guard dashboard unavailable');
  return {
    queue: (data.queue ?? []).map((item) => ({
      ...item,
      photoPublicId: item.photoEvidenceId,
      idImagePublicId: item.idEvidenceId,
    })),
    stats: data.stats ?? { inside: 0, exited: 0, rejected: 0, total: 0 },
    rejectionReasons: Array.isArray(data.rejectionReasons) ? data.rejectionReasons : [],
    pendingTotal: Number(data.pendingTotal ?? data.queue?.length ?? 0),
    hasMore: Boolean(data.hasMore),
  };
}

export function subscribeToPassChanges(onChange: () => void): () => void {
  const client = requireSupabase();
  const channel = client.channel('guard-pending-pass-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'passes' }, onChange)
    .subscribe();
  return () => { void client.removeChannel(channel); };
}
