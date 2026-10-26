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

export interface GuardQueueCursor {
  scannedAt: string | null;
  id: string;
}

export const guardQueueCursorSchema = z.object({
  scannedAt: z.string().nullable(),
  id: z.string().uuid(),
});

export interface GuardDashboardPageData extends GuardDashboardData {
  nextCursor: GuardQueueCursor | null;
}

export const guardDashboardPageWireSchema = z.object({
  queue: z.array(guardQueueItemSchema),
  stats: guardStatsSchema,
  rejectionReasons: z.array(z.string()),
  pendingTotal: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextCursor: guardQueueCursorSchema.nullable(),
});

export async function fetchGuardDashboardPage(options?: {
  limit?: number;
  cursor?: GuardQueueCursor | null;
}): Promise<GuardDashboardPageData> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const { data: rawData, error } = await requireSupabase()
    .schema('api')
    .rpc('guard_dashboard_page', {
      requested_limit: limit,
      after_scanned_at: options?.cursor?.scannedAt ?? null,
      after_id: options?.cursor?.id ?? null,
    });
  if (error || !rawData) throw error ?? new Error('Guard dashboard page unavailable');

  const parsed = guardDashboardPageWireSchema.safeParse(rawData);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new Error(`api.guard_dashboard_page contract violation: ${issueSummary}`);
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
    nextCursor: data.nextCursor,
  };
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

export interface GuardDashboardWindowResult extends GuardDashboardData {
  reachedSafetyCeiling: boolean;
  queueChangedDuringPaging: boolean;
}

export async function fetchGuardDashboardWindow(options: {
  desiredCount: number;
  pageSize?: number;
  safetyCeiling?: number;
}): Promise<GuardDashboardWindowResult> {
  const safetyCeiling = options.safetyCeiling ?? 5000;
  const targetCount = Math.min(
    Math.max(options.desiredCount, 50),
    safetyCeiling
  );

  let attempts = 0;
  let finalAccumulated: GuardQueuePass[] = [];
  let finalLatestDashboard: GuardDashboardPageData | null = null;
  let finalQueueChanged = false;

  while (attempts < 2) {
    attempts++;
    const accumulated: GuardQueuePass[] = [];
    const seenIds = new Set<string>();

    let cursor: GuardQueueCursor | null = null;
    let hasMore = true;
    let latestDashboard: GuardDashboardPageData | null = null;
    let firstPendingTotal: number | null = null;
    let queueChangedDuringPaging = false;

    while (hasMore && accumulated.length < targetCount) {
      const remaining = targetCount - accumulated.length;
      const page = await fetchGuardDashboardPage({
        limit: Math.min(200, remaining),
        cursor,
      });

      latestDashboard = page;

      if (firstPendingTotal === null) {
        firstPendingTotal = page.pendingTotal;
      } else if (page.pendingTotal !== firstPendingTotal) {
        queueChangedDuringPaging = true;
      }

      for (const pass of page.queue) {
        if (!seenIds.has(pass.id)) {
          seenIds.add(pass.id);
          accumulated.push(pass);
        }
      }

      hasMore = page.hasMore;
      cursor = page.nextCursor;

      if (page.hasMore && page.nextCursor === null) {
        throw new Error(
          'guard_dashboard_page contract violation: hasMore without nextCursor'
        );
      }
    }

    finalAccumulated = accumulated;
    finalLatestDashboard = latestDashboard;
    finalQueueChanged = queueChangedDuringPaging;

    if (!queueChangedDuringPaging || attempts >= 2) {
      break;
    }
  }

  if (!finalLatestDashboard) {
    return {
      queue: [],
      stats: { inside: 0, exited: 0, rejected: 0, total: 0 },
      rejectionReasons: [],
      pendingTotal: 0,
      hasMore: false,
      reachedSafetyCeiling: false,
      queueChangedDuringPaging: false,
    };
  }

  const reachedSafetyCeiling =
    finalAccumulated.length >= safetyCeiling &&
    finalLatestDashboard.hasMore;

  return {
    queue: finalAccumulated,
    stats: finalLatestDashboard.stats,
    rejectionReasons: finalLatestDashboard.rejectionReasons,
    pendingTotal: finalLatestDashboard.pendingTotal,
    hasMore: finalLatestDashboard.hasMore,
    reachedSafetyCeiling,
    queueChangedDuringPaging: finalQueueChanged,
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
