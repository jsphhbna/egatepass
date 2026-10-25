import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';


const calendarSchema = z.record(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.number().int().nonnegative()
);

const insightsSchema = z.object({
  topPurpose: z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
  busiestGate: z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
  topRejection: z.object({
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
  avgApprovalTime: z.string(),
});

interface RawPassRow {
  id: string;
  visitor_id: string;
  source: 'portal' | 'kiosk';
  status: 'issued' | 'pending' | 'inside' | 'rejected' | 'exited' | 'expired';
  valid_from: string;
  valid_until: string;
  issued_at: string;
  entry_scanned_at: string | null;
  decided_at: string | null;
  time_in: string | null;
  time_out: string | null;
  entry_device_id: string | null;
  exit_device_id: string | null;
  decided_by: string | null;
  rejection_reason: string | null;
  gate: string | null;
  visitors: {
    full_name: string;
    purpose: string;
    visitor_evidence: Array<{ id: string; kind: 'photo' | 'id' }>;
  } | null;
}

function mapPass(row: RawPassRow) {
  const visitor = row.visitors;
  const evidenceList = visitor?.visitor_evidence ?? [];
  const photoId = evidenceList.find((e) => e.kind === 'photo')?.id ?? null;
  const idImageId = evidenceList.find((e) => e.kind === 'id')?.id ?? null;

  return {
    id: row.id,
    visitorId: row.visitor_id,
    visitorName: visitor?.full_name ?? '',
    purpose: visitor?.purpose ?? '',
    photoPublicId: photoId,
    idImagePublicId: idImageId,
    source: row.source,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    issuedAt: row.issued_at,
    scannedAt: row.entry_scanned_at,
    timeIn: row.time_in,
    timeOut: row.time_out,
    entryDeviceId: row.entry_device_id,
    exitDeviceId: row.exit_device_id,
    decidedByUid: row.decided_by,
    rejectionReason: row.rejection_reason,
    gate: row.gate,
  };
}

const PASS_SELECT = `
  id,
  visitor_id,
  source,
  status,
  valid_from,
  valid_until,
  issued_at,
  entry_scanned_at,
  decided_at,
  time_in,
  time_out,
  entry_device_id,
  exit_device_id,
  decided_by,
  rejection_reason,
  gate,
  visitors (
    full_name,
    purpose,
    visitor_evidence (
      id,
      kind
    )
  )
`;

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    const expireRes = await admin.schema('api').rpc('expire_stale_passes');
    if (expireRes.error) {
      throw new HttpError(503, 'service_unavailable');
    }

    const now = new Date();
    const manilaDateString = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
    const startToday = `${manilaDateString}T00:00:00+08:00`;
    const endToday = `${manilaDateString}T23:59:59.999+08:00`;

    const startMonth = `${manilaDateString.slice(0, 7)}-01T00:00:00+08:00`;

    // C-01: Filter pendingToday by entry_scanned_at within Manila local day, distinct from all-time pending
    const [
      todayCountRes,
      monthCountRes,
      insideCountRes,
      exitedCountRes,
      pendingCountRes,
      allPendingCountRes,
      rejectedCountRes,
      recentResult,
      insideResult,
      exitedResult,
      decisionsResult,
    ] = await Promise.all([
      admin.from('passes').select('id', { count: 'exact', head: true }).gte('issued_at', startToday).lte('issued_at', endToday),
      admin.from('passes').select('id', { count: 'exact', head: true }).gte('issued_at', startMonth).lte('issued_at', endToday),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'inside'),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'exited').gte('time_out', startToday).lte('time_out', endToday),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'pending').gte('entry_scanned_at', startToday).lte('entry_scanned_at', endToday),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'rejected').gte('decided_at', startToday).lte('decided_at', endToday),
      admin.from('passes').select(PASS_SELECT).order('issued_at', { ascending: false }).limit(100),
      admin.from('passes').select(PASS_SELECT).eq('status', 'inside').limit(200),
      admin.from('passes').select(PASS_SELECT).eq('status', 'exited').gte('time_out', startToday).lte('time_out', endToday).limit(200),
      admin.from('passes').select(PASS_SELECT).gte('decided_at', startToday).lte('decided_at', endToday).limit(200),
    ]);

    if (todayCountRes.error) throw todayCountRes.error;
    if (monthCountRes.error) throw monthCountRes.error;
    if (insideCountRes.error) throw insideCountRes.error;
    if (exitedCountRes.error) throw exitedCountRes.error;
    if (pendingCountRes.error) throw pendingCountRes.error;
    if (allPendingCountRes.error) throw allPendingCountRes.error;
    if (rejectedCountRes.error) throw rejectedCountRes.error;
    if (recentResult.error) throw recentResult.error;
    if (insideResult.error) throw insideResult.error;
    if (exitedResult.error) throw exitedResult.error;
    if (decisionsResult.error) throw decisionsResult.error;

    // Query authoritative database-complete aggregate RPCs without raw-row fallback (Root Cause Class E)
    const [
      calendarRpcRes,
      insightsRpcRes,
    ] = await Promise.all([
      admin.schema('api').rpc('dashboard_calendar_counts', { p_start: startMonth, p_end: endToday }),
      admin.schema('api').rpc('dashboard_today_insights', { p_start: startToday, p_end: endToday }),
    ]);

    if (calendarRpcRes.error || !calendarRpcRes.data) {
      throw new HttpError(503, 'service_unavailable');
    }
    if (insightsRpcRes.error || !insightsRpcRes.data) {
      throw new HttpError(503, 'service_unavailable');
    }

    const calendarParsed = calendarSchema.safeParse(calendarRpcRes.data);
    if (!calendarParsed.success) {
      throw new HttpError(503, 'service_unavailable');
    }

    const insightsParsed = insightsSchema.safeParse(insightsRpcRes.data);
    if (!insightsParsed.success) {
      throw new HttpError(503, 'service_unavailable');
    }

    const calendarCounts = calendarParsed.data;
    const insights = insightsParsed.data;

    return jsonResponse(200, {
      counts: {
        todayTotal: todayCountRes.count ?? 0,
        monthTotal: monthCountRes.count ?? 0,
        currentlyInside: insideCountRes.count ?? 0,
        exitedToday: exitedCountRes.count ?? 0,
        pendingToday: pendingCountRes.count ?? 0,
        allPending: allPendingCountRes.count ?? 0,
        rejectedToday: rejectedCountRes.count ?? 0,
      },
      insights,
      calendarCounts,
      recentPasses: ((recentResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      insidePasses: ((insideResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      exitedTodayPasses: ((exitedResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      decisionsTodayPasses: ((decisionsResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Dashboard metrics load failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
