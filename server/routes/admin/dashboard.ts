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

const REPORT_MAX_ROWS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;

type DashboardPeriodType = 'today' | 'date' | 'month' | 'year' | 'range';

function extractErrorDiagnostics(error: unknown): { code?: string; message: string; details?: string; hint?: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    return {
      code: typeof errObj.code === 'string' ? errObj.code : undefined,
      message: typeof errObj.message === 'string' ? errObj.message : 'unknown_error',
      details: typeof errObj.details === 'string' ? errObj.details : undefined,
      hint: typeof errObj.hint === 'string' ? errObj.hint : undefined,
    };
  }
  return { message: String(error) || 'unknown_error' };
}

function isValidManilaDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(parsed) === value;
}

function getMonthLastDate(monthKey: string): string | null {
  if (!MONTH_RE.test(monthKey)) return null;
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2000 || year > 2100 || month < 1 || month > 12) {
    return null;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(lastDay).padStart(2, '0')}`;
}

interface PeriodWindow {
  period: DashboardPeriodType;
  startDate: string;
  endDate: string;
  periodStart: string;
  periodEnd: string;
  calendarStart: string;
  calendarEnd: string;
  label: string;
}

function resolvePeriodWindow(url: URL, manilaToday: string): PeriodWindow {
  const rawPeriod = (url.searchParams.get('period') || 'today').trim();
  if (!['today', 'date', 'month', 'year', 'range'].includes(rawPeriod)) {
    throw new HttpError(400, 'invalid_period');
  }
  const period = rawPeriod as DashboardPeriodType;
  const currentMonth = manilaToday.slice(0, 7);
  const currentYear = manilaToday.slice(0, 4);

  if (period === 'today') {
    const startDate = manilaToday;
    const endDate = manilaToday;
    return {
      period,
      startDate,
      endDate,
      periodStart: `${startDate}T00:00:00+08:00`,
      periodEnd: `${endDate}T23:59:59.999+08:00`,
      calendarStart: `${currentMonth}-01T00:00:00+08:00`,
      calendarEnd: `${endDate}T23:59:59.999+08:00`,
      label: startDate,
    };
  }

  if (period === 'date') {
    const dateParam = url.searchParams.get('date')?.trim() || '';
    if (!isValidManilaDate(dateParam)) {
      throw new HttpError(400, 'invalid_date');
    }
    const monthKey = dateParam.slice(0, 7);
    const monthEnd = getMonthLastDate(monthKey) || dateParam;
    return {
      period,
      startDate: dateParam,
      endDate: dateParam,
      periodStart: `${dateParam}T00:00:00+08:00`,
      periodEnd: `${dateParam}T23:59:59.999+08:00`,
      calendarStart: `${monthKey}-01T00:00:00+08:00`,
      calendarEnd: `${monthEnd}T23:59:59.999+08:00`,
      label: dateParam,
    };
  }

  if (period === 'month') {
    const monthParam = url.searchParams.get('month')?.trim() || currentMonth;
    const endDate = getMonthLastDate(monthParam);
    if (!endDate) {
      throw new HttpError(400, 'invalid_month');
    }
    const startDate = `${monthParam}-01`;
    return {
      period,
      startDate,
      endDate,
      periodStart: `${startDate}T00:00:00+08:00`,
      periodEnd: `${endDate}T23:59:59.999+08:00`,
      calendarStart: `${startDate}T00:00:00+08:00`,
      calendarEnd: `${endDate}T23:59:59.999+08:00`,
      label: monthParam,
    };
  }

  if (period === 'year') {
    const yearParam = url.searchParams.get('year')?.trim() || currentYear;
    const yearNum = Number(yearParam);
    if (!YEAR_RE.test(yearParam) || yearNum < 2000 || yearNum > 2100) {
      throw new HttpError(400, 'invalid_year');
    }
    const startDate = `${yearParam}-01-01`;
    const endDate = `${yearParam}-12-31`;
    return {
      period,
      startDate,
      endDate,
      periodStart: `${startDate}T00:00:00+08:00`,
      periodEnd: `${endDate}T23:59:59.999+08:00`,
      calendarStart: `${startDate}T00:00:00+08:00`,
      calendarEnd: `${endDate}T23:59:59.999+08:00`,
      label: yearParam,
    };
  }

  const dateFrom = url.searchParams.get('dateFrom')?.trim() || '';
  const dateTo = url.searchParams.get('dateTo')?.trim() || '';
  if (!isValidManilaDate(dateFrom) || !isValidManilaDate(dateTo) || dateFrom > dateTo) {
    throw new HttpError(400, 'invalid_date_range');
  }
  return {
    period,
    startDate: dateFrom,
    endDate: dateTo,
    periodStart: `${dateFrom}T00:00:00+08:00`,
    periodEnd: `${dateTo}T23:59:59.999+08:00`,
    calendarStart: `${dateFrom}T00:00:00+08:00`,
    calendarEnd: `${dateTo}T23:59:59.999+08:00`,
    label: `${dateFrom} to ${dateTo}`,
  };
}

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
  expected_gate?: string | null;
  visitors: {
    full_name: string;
    purpose: string;
    visitor_evidence: Array<{ id: string; kind: 'photo' | 'id' }>;
  } | null;
}

interface RawOfflineRecordRow {
  id: string;
  gate: string | null;
  visitor_full_name: string;
  declared_address: string;
  address_status: string;
  purpose: string;
  destination_office_name_snapshot: string | null;
  office_resolution_status: string;
  id_physically_inspected: boolean;
  record_classification: string;
  local_recorded_at: string;
  server_received_at: string | null;
  local_sequence: number;
  snapshot_version: string;
  emergency_exception_applied: boolean;
  reconciliation_status: string;
  reconciliation_notes: string | null;
  reconciled_at: string | null;
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
    expectedGate: row.expected_gate ?? null,
  };
}

function mapOfflineRecord(row: RawOfflineRecordRow) {
  return {
    id: row.id,
    gate: row.gate,
    visitorName: row.visitor_full_name,
    declaredAddress: row.declared_address,
    addressStatus: row.address_status,
    purpose: row.purpose,
    officeName: row.destination_office_name_snapshot,
    officeResolutionStatus: row.office_resolution_status,
    idPhysicallyInspected: row.id_physically_inspected,
    classification: row.record_classification || 'OFFLINE MODE RECORDED',
    localRecordedAt: row.local_recorded_at,
    serverReceivedAt: row.server_received_at,
    localSequence: row.local_sequence,
    snapshotVersion: row.snapshot_version,
    emergencyExceptionApplied: Boolean(row.emergency_exception_applied),
    reconciliationStatus: row.reconciliation_status,
    reconciliationNotes: row.reconciliation_notes,
    reconciledAt: row.reconciled_at,
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
  expected_gate,
  visitors (
    full_name,
    purpose,
    visitor_evidence (
      id,
      kind
    )
  )
`;

const OFFLINE_SELECT = `
  id,
  gate,
  visitor_full_name,
  declared_address,
  address_status,
  purpose,
  destination_office_name_snapshot,
  office_resolution_status,
  id_physically_inspected,
  record_classification,
  local_recorded_at,
  server_received_at,
  local_sequence,
  snapshot_version,
  emergency_exception_applied,
  reconciliation_status,
  reconciliation_notes,
  reconciled_at
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

    const url = new URL(request.url);
    const now = new Date();
    const manilaDateString = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
    const window = resolvePeriodWindow(url, manilaDateString);
    const includeReportRows = ['true', '1'].includes((url.searchParams.get('includeReportRows') || '').trim().toLowerCase());

    const startToday = `${manilaDateString}T00:00:00+08:00`;
    const endToday = `${manilaDateString}T23:59:59.999+08:00`;
    const startMonth = `${manilaDateString.slice(0, 7)}-01T00:00:00+08:00`;

    // C-01: Filter pendingToday by entry_scanned_at within Manila local day, distinct from all-time pending
    const [
      expectedTodayRes,
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
      periodTotalRes,
      periodIssuedRes,
      periodInsideRes,
      periodExitedRes,
      periodPendingRes,
      periodRejectedRes,
      periodExpiredRes,
      offlineResult,
      reportPassesResult,
    ] = await Promise.all([
      admin
        .from('passes')
        .select('id', { count: 'exact', head: true })
        .neq('source', 'kiosk')
        .in('status', ['issued', 'inside', 'exited'])
        .lte('valid_from', endToday)
        .gte('valid_until', startToday),
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
      admin.from('passes').select('id', { count: 'exact', head: true }).gte('issued_at', window.periodStart).lte('issued_at', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'issued').gte('issued_at', window.periodStart).lte('issued_at', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'inside').gte('time_in', window.periodStart).lte('time_in', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'exited').gte('time_out', window.periodStart).lte('time_out', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'pending').gte('entry_scanned_at', window.periodStart).lte('entry_scanned_at', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'rejected').gte('decided_at', window.periodStart).lte('decided_at', window.periodEnd),
      admin.from('passes').select('id', { count: 'exact', head: true }).eq('status', 'expired').gte('issued_at', window.periodStart).lte('issued_at', window.periodEnd),
      admin
        .from('emergency_gate_records')
        .select(OFFLINE_SELECT, { count: 'exact' })
        .gte('local_recorded_at', window.periodStart)
        .lte('local_recorded_at', window.periodEnd)
        .order('local_recorded_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(REPORT_MAX_ROWS),
      includeReportRows
        ? admin
            .from('passes')
            .select(PASS_SELECT, { count: 'exact' })
            .gte('issued_at', window.periodStart)
            .lte('issued_at', window.periodEnd)
            .order('issued_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(REPORT_MAX_ROWS)
        : Promise.resolve({ data: null, count: null, error: null }),
    ]);

    if (expectedTodayRes.error) throw expectedTodayRes.error;
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
    if (periodTotalRes.error) throw periodTotalRes.error;
    if (periodIssuedRes.error) throw periodIssuedRes.error;
    if (periodInsideRes.error) throw periodInsideRes.error;
    if (periodExitedRes.error) throw periodExitedRes.error;
    if (periodPendingRes.error) throw periodPendingRes.error;
    if (periodRejectedRes.error) throw periodRejectedRes.error;
    if (periodExpiredRes.error) throw periodExpiredRes.error;
    if (offlineResult.error) throw offlineResult.error;
    if (reportPassesResult.error) throw reportPassesResult.error;

    // Query authoritative database-complete aggregate RPCs without raw-row fallback (Root Cause Class E)
    const [
      calendarRpcRes,
      insightsRpcRes,
    ] = await Promise.all([
      admin.schema('api').rpc('dashboard_calendar_counts', { p_start: window.calendarStart, p_end: window.calendarEnd }),
      admin.schema('api').rpc('dashboard_today_insights', { p_start: window.periodStart, p_end: window.periodEnd }),
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

    const rawOfflineRows = (offlineResult.data ?? []) as unknown as RawOfflineRecordRow[];
    const offlineTotal = offlineResult.count ?? rawOfflineRows.length;
    const offlineModeMetrics = {
      classification: 'OFFLINE MODE RECORDED' as const,
      total: offlineTotal,
      pendingSync: rawOfflineRows.filter((r) => r.reconciliation_status === 'pending_sync').length,
      received: rawOfflineRows.filter((r) => r.reconciliation_status === 'received').length,
      accepted: rawOfflineRows.filter((r) => r.reconciliation_status === 'accepted').length,
      needsReview: rawOfflineRows.filter((r) => r.reconciliation_status === 'needs_review').length,
      duplicate: rawOfflineRows.filter((r) => r.reconciliation_status === 'duplicate').length,
      rejected: rawOfflineRows.filter((r) => r.reconciliation_status === 'rejected').length,
      exceptionApplied: rawOfflineRows.filter((r) => Boolean(r.emergency_exception_applied)).length,
      truncated: offlineTotal > REPORT_MAX_ROWS,
    };

    const reportPassRows = ((reportPassesResult.data ?? []) as unknown as RawPassRow[]).map(mapPass);
    const totalMatchingCount = reportPassesResult.count ?? reportPassRows.length;

    return jsonResponse(200, {
      counts: {
        expectedVisitorsToday: expectedTodayRes.count ?? 0,
        todayTotal: todayCountRes.count ?? 0,
        monthTotal: monthCountRes.count ?? 0,
        currentlyInside: insideCountRes.count ?? 0,
        exitedToday: exitedCountRes.count ?? 0,
        pendingToday: pendingCountRes.count ?? 0,
        allPending: allPendingCountRes.count ?? 0,
        rejectedToday: rejectedCountRes.count ?? 0,
      },
      periodMeta: {
        period: window.period,
        startDate: window.startDate,
        endDate: window.endDate,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        timezone: 'Asia/Manila',
        label: window.label,
      },
      periodCounts: {
        total: periodTotalRes.count ?? 0,
        issued: periodIssuedRes.count ?? 0,
        inside: periodInsideRes.count ?? 0,
        exited: periodExitedRes.count ?? 0,
        pending: periodPendingRes.count ?? 0,
        rejected: periodRejectedRes.count ?? 0,
        expired: periodExpiredRes.count ?? 0,
      },
      offlineModeMetrics,
      insights,
      calendarCounts,
      recentPasses: ((recentResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      insidePasses: ((insideResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      exitedTodayPasses: ((exitedResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      decisionsTodayPasses: ((decisionsResult.data ?? []) as unknown as RawPassRow[]).map(mapPass),
      ...(includeReportRows
        ? {
            reportRows: {
              passes: reportPassRows,
              offlineRecords: rawOfflineRows.map(mapOfflineRecord),
              totalMatchingCount,
              offlineTotalCount: offlineTotal,
              truncated: totalMatchingCount > REPORT_MAX_ROWS || offlineTotal > REPORT_MAX_ROWS,
              maxRows: REPORT_MAX_ROWS,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Dashboard metrics load failed.', JSON.stringify(extractErrorDiagnostics(error)));
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

export default { fetch: handleRequest };
