import { z } from 'zod';
import { requireSupabase } from '@/lib/supabase';
import { getAccessToken } from '@/services/auth';

export class GuardApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'GuardApiError';
    this.status = status;
    this.code = code;
  }
}

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

export const guardQueueItemSchema = z.object({
  id: z.string().uuid(),
  visitorName: z.string().min(1),
  purpose: z.string(),
  source: z.enum(['portal', 'kiosk']),
  status: z.literal('pending'),
  validFrom: z.string(),
  validUntil: z.string(),
  scannedAt: z.string(),
  gate: z.string().nullable(),
  photoEvidenceId: z.string().uuid(),
  idEvidenceId: z.string().uuid().nullable(),
});

export const guardStatsSchema = z.object({
  inside: z.number().int().nonnegative(),
  exited: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const guardDashboardWireSchema = z.object({
  queue: z.array(guardQueueItemSchema),
  stats: guardStatsSchema,
  rejectionReasons: z.array(z.string()),
  pendingTotal: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

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
  if (error || !rawData) throw error ?? new Error('Guard dashboard unavailable');

  // Strict Runtime Wire Contract Validation:
  // Detects incompatible database RPC contract mutations without leaking sensitive visitor data
  const parsed = guardDashboardWireSchema.safeParse(rawData);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new Error(`api.guard_dashboard contract violation: ${issueSummary}`);
  }

  const data = parsed.data;

  return {
    queue: data.queue.map((item) => ({
      id: item.id,
      visitorName: item.visitorName,
      purpose: item.purpose,
      source: item.source,
      status: item.status,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      scannedAt: item.scannedAt,
      gate: item.gate,
      photoPublicId: item.photoEvidenceId,
      idImagePublicId: item.idEvidenceId,
    })),
    stats: data.stats,
    rejectionReasons: data.rejectionReasons,
    pendingTotal: data.pendingTotal,
    hasMore: data.hasMore,
  };
}

export function subscribeToPassChanges(onChange: () => void): () => void {
  const client = requireSupabase();
  const channel = client.channel('guard-pending-pass-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'passes' }, onChange)
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

export async function recordDecision(
  passId: string,
  decision: 'approved' | 'rejected',
  reason: string | null = null,
): Promise<{ status: string }> {
  const token = await getAccessToken();

  const response = await fetch('/api/decide-visit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ passId, decision, reason }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GuardApiError(
      body?.error || 'Decision could not be recorded',
      response.status,
      body?.code,
    );
  }
  return body;
}
