import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { resolveVisitorAccountability, getAccountabilitySummary } from '../../lib/accountability.js';
import { assignPassExpectedGate } from '../../lib/office.js';
import { getServerSupabaseClients } from '../../supabase.js';

const EXPORT_MAX_ROWS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchExpectedGateSchema = z.object({
  passId: z.string().regex(UUID_RE),
  expectedGate: z.string().trim().min(1).max(80),
}).strict();

const resolveAccountabilitySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record_verified_exit'),
    passId: z.string().regex(UUID_RE),
    exitTime: z.string().optional(),
    gate: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
  z.object({
    action: z.literal('confirm_office_visit'),
    passId: z.string().regex(UUID_RE),
    arrivalTime: z.string().optional(),
    verifiedTime: z.string().optional(),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
  z.object({
    action: z.literal('mark_reviewed'),
    passId: z.string().regex(UUID_RE),
    reason: z.string().trim().min(5).max(1000).optional(),
    notes: z.string().trim().min(5).max(1000).optional(),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict().refine((data) => Boolean((data.reason && data.reason.trim().length >= 5) || (data.notes && data.notes.trim().length >= 5)), {
    message: 'Either reason or notes must be at least 5 characters',
  }),
  z.object({
    action: z.literal('record_exception'),
    passId: z.string().regex(UUID_RE),
    exceptionType: z.enum([
      'redirected',
      'office_closed',
      'cancelled_after_entry',
      'cctv_verified',
      'emergency_evacuation',
      'other',
    ]),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
]);

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

interface RawRecordPassRow {
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
  accountability_status?: string | null;
  accountability_notes?: string | null;
  accountability_resolved_at?: string | null;
  accountability_resolved_by?: string | null;
  exit_verification_type?: string | null;
  visitors: {
    full_name: string;
    purpose: string;
    gender?: string | null;
    visit_date?: string | null;
    contact_number?: string | null;
    email?: string | null;
    home_address?: string | null;
    home_street?: string | null;
    home_building?: string | null;
    psgc_barangay_name?: string | null;
    psgc_city_municipality_name?: string | null;
    psgc_province_name?: string | null;
    psgc_region_name?: string | null;
    arrival_mode?: string | null;
    visitor_evidence: Array<{ id: string; kind: 'photo' | 'id' }>;
  } | null;
  office_visits?: Array<{
    id: string;
    attendance_status: string;
    confirmed_at?: string | null;
    confirmed_by?: string | null;
    attendance_verification_type?: string | null;
    accountability_notes?: string | null;
    visit_type?: string;
    approval_status?: string;
    offices?: { id?: string; name: string } | null;
  }> | {
    id: string;
    attendance_status: string;
    confirmed_at?: string | null;
    confirmed_by?: string | null;
    attendance_verification_type?: string | null;
    accountability_notes?: string | null;
    visit_type?: string;
    approval_status?: string;
    offices?: { id?: string; name: string } | null;
  } | null;
  visitor_accountability_resolutions?: Array<{
    id: string;
    resolution_type: string;
    exception_type: string | null;
    reason: string;
    verified_event_time: string | null;
    gate: string | null;
    created_at: string;
    actor_id: string;
  }> | null;
}

interface RawOfflineRecordRow {
  id: string;
  device_user_id: string;
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

function mapPass(row: RawRecordPassRow, closingHours = '17:00', nowMs = Date.now()) {
  const visitor = row.visitors;
  const evidenceList = visitor?.visitor_evidence ?? [];
  const photoId = evidenceList.find((e) => e.kind === 'photo')?.id ?? null;
  const idImageId = evidenceList.find((e) => e.kind === 'id')?.id ?? null;

  const officeVisit = Array.isArray(row.office_visits) ? row.office_visits[0] : row.office_visits;
  const destinationOffice = officeVisit?.offices?.name ?? null;
  const destinationOfficeId = officeVisit?.offices?.id ?? null;
  const attendanceStatus = officeVisit?.attendance_status ?? null;
  const visitType = officeVisit?.visit_type ?? null;
  const approvalStatus = officeVisit?.approval_status ?? null;

  // Accountability & Timeline Calculation
  const visitDate = visitor?.visit_date || (row.valid_from ? row.valid_from.slice(0, 10) : null);
  let closingDate: Date;
  if (row.valid_until) {
    closingDate = new Date(row.valid_until);
  } else if (visitDate) {
    closingDate = new Date(`${visitDate}T${closingHours}:00+08:00`);
  } else {
    closingDate = new Date();
  }
  const isPastClosing = nowMs >= closingDate.getTime();
  const hasEntered = Boolean(row.time_in || row.entry_scanned_at || row.status === 'inside' || row.status === 'exited');
  const hasExited = Boolean(row.time_out || row.status === 'exited');

  // Rule: A visitor with no entry scan must not be classified as someone who failed to exit.
  // Rule: After school closing time, an entry without an exit is flagged as No Recorded Exit.
  const missingExit = Boolean(hasEntered && !hasExited && isPastClosing);
  const overdueMinutes = missingExit ? Math.max(0, Math.round((nowMs - closingDate.getTime()) / 60000)) : 0;

  // Rule: Destination office selected, entered campus, but arrival not recorded by closing time or upon exit.
  const hasOffice = Boolean(destinationOffice && destinationOffice.trim() !== '' && destinationOffice.toLowerCase() !== 'general campus');
  const officeConfirmed = Boolean(attendanceStatus === 'confirmed' || attendanceStatus === 'completed' || officeVisit?.confirmed_at);
  const missingOffice = Boolean(hasEntered && hasOffice && !officeConfirmed && (isPastClosing || hasExited));

  const bothMissing = Boolean(missingExit && missingOffice);
  const isCompleted = Boolean(hasEntered && hasExited && (!hasOffice || officeConfirmed));

  const rawResolutions = Array.isArray(row.visitor_accountability_resolutions) ? row.visitor_accountability_resolutions : [];
  const resolutions = rawResolutions.map((r) => ({
    id: r.id,
    resolutionType: r.resolution_type,
    exceptionType: r.exception_type,
    reason: r.reason,
    verifiedEventTime: r.verified_event_time,
    gate: r.gate,
    createdAt: r.created_at,
    actorId: r.actor_id,
  }));

  return {
    id: row.id,
    visitorId: row.visitor_id,
    visitorName: visitor?.full_name ?? '',
    purpose: visitor?.purpose ?? '',
    gender: visitor?.gender ?? null,
    visitDate: visitor?.visit_date ?? null,
    contactNumber: visitor?.contact_number ?? null,
    email: visitor?.email ?? null,
    homeAddress: visitor?.home_address ?? null,
    homeStreet: visitor?.home_street ?? null,
    homeBuilding: visitor?.home_building ?? null,
    barangayName: visitor?.psgc_barangay_name ?? null,
    cityName: visitor?.psgc_city_municipality_name ?? null,
    provinceName: visitor?.psgc_province_name ?? null,
    regionName: visitor?.psgc_region_name ?? null,
    arrivalMode: visitor?.arrival_mode ?? null,
    destinationOffice,
    destinationOfficeId,
    attendanceStatus,
    officeConfirmedAt: officeVisit?.confirmed_at ?? null,
    officeConfirmedBy: officeVisit?.confirmed_by ?? null,
    attendanceVerificationType: officeVisit?.attendance_verification_type ?? null,
    officeAccountabilityNotes: officeVisit?.accountability_notes ?? null,
    visitType,
    approvalStatus,
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
    accountabilityStatus: row.accountability_status || 'pending',
    accountabilityNotes: row.accountability_notes || null,
    accountabilityResolvedAt: row.accountability_resolved_at || null,
    accountabilityResolvedBy: row.accountability_resolved_by || null,
    exitVerificationType: row.exit_verification_type || (hasExited ? 'scanner' : null),
    officeVisitId: officeVisit?.id || null,
    hasEntered,
    hasExited,
    isPastClosing,
    missingExit,
    missingOffice,
    bothMissing,
    isCompleted,
    overdueMinutes,
    expectedClosingTime: closingDate.toISOString(),
    resolutions,
  };
}

function mapOfflineRecord(row: RawOfflineRecordRow) {
  return {
    id: row.id,
    deviceUserId: row.device_user_id,
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

async function handleGet(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const url = new URL(request.url);
  const modeParam = (url.searchParams.get('mode') || 'standard').trim();
  if (!['standard', 'offline', 'all', 'accountability'].includes(modeParam)) {
    return jsonResponse(400, { error: 'invalid_mode' });
  }
  const mode = modeParam as 'standard' | 'offline' | 'all' | 'accountability';

  const statusParam = url.searchParams.get('status')?.trim();
  const categoryParam = url.searchParams.get('category')?.trim();
  const officeParam = url.searchParams.get('office')?.trim();
  const reviewStatusParam = url.searchParams.get('reviewStatus')?.trim();
  const singleDateParam = url.searchParams.get('date')?.trim();
  const dateFromParam = url.searchParams.get('dateFrom')?.trim() || singleDateParam;
  const dateToParam = url.searchParams.get('dateTo')?.trim() || singleDateParam;

  if (dateFromParam && !isValidManilaDate(dateFromParam)) {
    return jsonResponse(400, { error: 'invalid_date_from' });
  }
  if (dateToParam && !isValidManilaDate(dateToParam)) {
    return jsonResponse(400, { error: 'invalid_date_to' });
  }
  if (dateFromParam && dateToParam && dateFromParam > dateToParam) {
    return jsonResponse(400, { error: 'invalid_date_range' });
  }

  const searchParam = url.searchParams.get('search')?.trim().toLowerCase();
  const cursor = url.searchParams.get('cursor')?.trim();
  const offlineCursor = url.searchParams.get('offlineCursor')?.trim();
  const exportAll = url.searchParams.get('export')?.trim() === 'all';

  const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '50', 10);
  const pageSize = exportAll
    ? EXPORT_MAX_ROWS
    : Math.min(Math.max(Number.isFinite(pageSizeParam) ? pageSizeParam : 50, 1), 250);

  try {
    const decodedCursor = cursor ? decodeCursorStrict(cursor, { idType: 'uuid' }) : null;
    if (cursor && !decodedCursor) {
      return jsonResponse(400, { error: 'invalid_cursor' });
    }
    const decodedOfflineCursor = offlineCursor ? decodeCursorStrict(offlineCursor, { idType: 'uuid' }) : null;
    if (offlineCursor && !decodedOfflineCursor) {
      return jsonResponse(400, { error: 'invalid_cursor' });
    }
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

    // Fetch school operating hours and timezone configuration (with safe fallback for test mocks)
    let closingHours = '17:00';
    let openingHours = '08:00';
    let timeZone = 'Asia/Manila';

    try {
      const q: any = admin.from('app_settings').select('working_hours_start, working_hours_end, timezone').eq('singleton', true);
      const res = typeof q?.maybeSingle === 'function' ? await q.maybeSingle() : typeof q?.limit === 'function' ? await q.limit(1) : null;
      if (res?.data) {
        const row = Array.isArray(res.data) ? res.data[0] : res.data;
        if (row?.working_hours_end) closingHours = String(row.working_hours_end).slice(0, 5);
        if (row?.working_hours_start) openingHours = String(row.working_hours_start).slice(0, 5);
        if (row?.timezone) timeZone = String(row.timezone);
      }
    } catch {
      // Graceful fallback to default institutional operating hours 08:00 - 17:00
    }
    const nowMs = Date.now();

    let passes: ReturnType<typeof mapPass>[] = [];
    let nextCursor: string | null = null;
    let hasMore = false;
    let totalCount = 0;
    let truncated = false;

    if (mode === 'standard' || mode === 'all' || mode === 'accountability') {
      let query = admin
        .from('passes')
        .select(
          `
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
          accountability_status,
          accountability_notes,
          accountability_resolved_at,
          accountability_resolved_by,
          exit_verification_type,
          visitors!inner (
            full_name,
            purpose,
            gender,
            visit_date,
            contact_number,
            email,
            home_address,
            home_street,
            home_building,
            psgc_barangay_name,
            psgc_city_municipality_name,
            psgc_province_name,
            psgc_region_name,
            arrival_mode,
            visitor_evidence (
              id,
              kind
            )
          ),
          office_visits (
            id,
            attendance_status,
            confirmed_at,
            confirmed_by,
            attendance_verification_type,
            accountability_notes,
            visit_type,
            approval_status,
            offices (
              id,
              name
            )
          ),
          visitor_accountability_resolutions (
            id,
            resolution_type,
            exception_type,
            reason,
            verified_event_time,
            gate,
            created_at,
            actor_id
          )
        `,
          { count: 'exact' },
        )
        .order('issued_at', { ascending: false })
        .order('id', { ascending: false });

      if (statusParam) {
        const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          query = query.eq('status', statuses[0]);
        } else if (statuses.length > 1) {
          query = query.in('status', statuses);
        }
      }

      if (dateFromParam) {
        query = query.gte('visitors.visit_date', dateFromParam);
      }
      if (dateToParam) {
        query = query.lte('visitors.visit_date', dateToParam);
      }

      if (searchParam) {
        const cleanedSearch = searchParam.replace(/[,()]/g, ' ').trim();
        if (cleanedSearch) {
          const digits = cleanedSearch.replace(/\D/g, '');
          const orConditions = [
            `full_name.ilike.%${cleanedSearch}%`,
            `purpose.ilike.%${cleanedSearch}%`,
          ];
          if (digits.length >= 4) {
            orConditions.push(`contact_number.ilike.%${digits}%`);
            if (digits.startsWith('09') && digits.length >= 5) {
              orConditions.push(`contact_number.ilike.%+63${digits.slice(1)}%`);
            } else if (digits.startsWith('639') && digits.length >= 6) {
              orConditions.push(`contact_number.ilike.%0${digits.slice(2)}%`);
            }
          }
          query = query.or(orConditions.join(','), { referencedTable: 'visitors' });
        }
      }

      if (reviewStatusParam && reviewStatusParam !== 'all') {
        query = query.eq('accountability_status', reviewStatusParam);
      }

      if (categoryParam) {
        if (categoryParam === 'campus_exit') {
          query = query.or('time_in.not.is.null,entry_scanned_at.not.is.null,status.in.(inside,exited)').is('time_out', null).neq('status', 'exited');
        } else if (categoryParam === 'completed') {
          query = query.or('status.eq.exited,time_out.not.is.null');
        } else if (categoryParam === 'missing_timeout') {
          query = query.not('time_in', 'is', null).is('time_out', null);
        } else if (categoryParam === 'currently_inside') {
          query = query.or('status.eq.inside,and(time_in.not.is.null,time_out.is.null)');
        } else if (categoryParam === 'approved_no_arrival') {
          query = query.in('status', ['issued', 'approved']).is('time_in', null).is('entry_scanned_at', null);
        } else if (categoryParam === 'requiring_review') {
          query = query.eq('accountability_status', 'pending');
        }
      }

      if (cursor) {
        const decoded = decodeCursorStrict(cursor, { idType: 'uuid' })!;
        if (decoded.id) {
          query = query.or(`issued_at.lt.${decoded.timestamp},and(issued_at.eq.${decoded.timestamp},id.lt.${decoded.id})`);
        } else {
          query = query.lt('issued_at', decoded.timestamp);
        }
      }

      query = query.limit(exportAll ? EXPORT_MAX_ROWS : pageSize + 1);

      const { data: rawRows, count, error } = await query;
      if (error) throw error;

      const rows = (rawRows ?? []) as unknown as RawRecordPassRow[];
      const mappedRows = rows.map((r) => mapPass(r, closingHours, nowMs));

      if (exportAll) {
        passes = mappedRows.slice(0, EXPORT_MAX_ROWS);
        totalCount = typeof count === 'number' ? count : passes.length;
        truncated = totalCount > EXPORT_MAX_ROWS;
      } else {
        hasMore = mappedRows.length > pageSize;
        const returnRows = hasMore ? mappedRows.slice(0, pageSize) : mappedRows;
        passes = returnRows;
        const lastRow = rows[returnRows.length - 1];
        nextCursor = hasMore && lastRow ? encodeCursor(lastRow.issued_at, lastRow.id) : null;
        totalCount = typeof count === 'number' ? count : passes.length;
      }
    }

    // Compute Authoritative Accountability Summary across full date range
    let accountabilitySummary: any = null;
    try {
      const summaryRpcRes = await getAccountabilitySummary(admin, {
        actorId: actor.id,
        dateFrom: dateFromParam,
        dateTo: dateToParam,
        closingHours,
      });
      if (!summaryRpcRes.error && summaryRpcRes.data) {
        accountabilitySummary = summaryRpcRes.data;
      }
    } catch {
      // Fallback to in-memory computation if RPC is unavailable
    }

    if (!accountabilitySummary) {
      const uniqueVisitorIds = new Set<string>();
      const completedVisitorIds = new Set<string>();
      const missingExitVisitorIds = new Set<string>();
      const missingOfficeVisitorIds = new Set<string>();
      const requiringReviewVisitorIds = new Set<string>();
      const reviewedVisitorIds = new Set<string>();

      for (const p of passes) {
        const vid = p.visitorId || p.id;
        uniqueVisitorIds.add(vid);
        if (p.isCompleted) completedVisitorIds.add(vid);
        if (p.missingExit && p.accountabilityStatus === 'pending') missingExitVisitorIds.add(vid);
        if (p.missingOffice && p.accountabilityStatus === 'pending') missingOfficeVisitorIds.add(vid);
        if ((p.missingExit || p.missingOffice) && p.accountabilityStatus === 'pending') requiringReviewVisitorIds.add(vid);
        if (p.accountabilityStatus && p.accountabilityStatus !== 'pending') reviewedVisitorIds.add(vid);
      }

      accountabilitySummary = {
        totalVisitors: uniqueVisitorIds.size,
        completedVisits: completedVisitorIds.size,
        missingExitCount: missingExitVisitorIds.size,
        missingOfficeCount: missingOfficeVisitorIds.size,
        requiringReviewCount: requiringReviewVisitorIds.size,
        reviewedCount: reviewedVisitorIds.size,
        schoolClosingTime: closingHours,
        schoolOpeningTime: openingHours,
        timezone: timeZone,
      };
    }

    // Filter passes by category if explicitly requested
    if (categoryParam) {
      if (categoryParam === 'campus_exit') {
        passes = passes.filter((p) => p.missingExit);
      } else if (categoryParam === 'office_visit') {
        passes = passes.filter((p) => p.missingOffice);
      } else if (categoryParam === 'completed') {
        passes = passes.filter((p) => p.isCompleted);
      } else if (categoryParam === 'requiring_review') {
        passes = passes.filter((p) => (p.missingExit || p.missingOffice) && p.accountabilityStatus === 'pending');
      } else if (categoryParam === 'missing_timeout') {
        passes = passes.filter((p) => p.timeIn != null && p.timeOut == null);
      } else if (categoryParam === 'currently_inside') {
        passes = passes.filter((p) => p.status === 'inside' || (p.timeIn != null && p.timeOut == null));
      } else if (categoryParam === 'approved_no_arrival') {
        passes = passes.filter((p) => (p.status === 'issued' || p.approvalStatus === 'approved') && p.timeIn == null);
      }
    }

    // Filter passes by office if specified
    if (officeParam && officeParam !== 'all') {
      passes = passes.filter((p) => p.destinationOffice?.toLowerCase() === officeParam.toLowerCase() || p.destinationOfficeId === officeParam);
    }

    // Filter passes by review status if specified
    if (reviewStatusParam && reviewStatusParam !== 'all') {
      passes = passes.filter((p) => p.accountabilityStatus === reviewStatusParam);
    }

    let offlineRecords: ReturnType<typeof mapOfflineRecord>[] = [];
    let offlineNextCursor: string | null = null;
    let offlineHasMore = false;
    let offlineTotalCount = 0;

    if (mode === 'offline' || mode === 'all') {
      let offlineQuery = admin
        .from('emergency_gate_records')
        .select(
          `
          id,
          device_user_id,
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
        `,
          { count: 'exact' },
        )
        .order('local_recorded_at', { ascending: false })
        .order('id', { ascending: false });

      if (statusParam && statusParam !== 'all') {
        offlineQuery = offlineQuery.eq('reconciliation_status', statusParam);
      }
      if (dateFromParam) {
        offlineQuery = offlineQuery.gte('local_recorded_at', `${dateFromParam}T00:00:00+08:00`);
      }
      if (dateToParam) {
        offlineQuery = offlineQuery.lte('local_recorded_at', `${dateToParam}T23:59:59.999+08:00`);
      }
      if (searchParam) {
        const cleanedSearch = searchParam.replace(/[,()]/g, ' ').trim();
        if (cleanedSearch) {
          offlineQuery = offlineQuery.or(
            `visitor_full_name.ilike.%${cleanedSearch}%,purpose.ilike.%${cleanedSearch}%,declared_address.ilike.%${cleanedSearch}%,destination_office_name_snapshot.ilike.%${cleanedSearch}%`,
          );
        }
      }
      if (offlineCursor) {
        const decodedOffline = decodeCursorStrict(offlineCursor, { idType: 'uuid' })!;
        if (decodedOffline.id) {
          offlineQuery = offlineQuery.or(
            `local_recorded_at.lt.${decodedOffline.timestamp},and(local_recorded_at.eq.${decodedOffline.timestamp},id.lt.${decodedOffline.id})`,
          );
        } else {
          offlineQuery = offlineQuery.lt('local_recorded_at', decodedOffline.timestamp);
        }
      }

      offlineQuery = offlineQuery.limit(pageSize + 1);

      const { data: rawOfflineRows, count: offlineCount, error: offlineError } = await offlineQuery;
      if (offlineError) throw offlineError;

      const offlineRows = (rawOfflineRows ?? []) as unknown as RawOfflineRecordRow[];
      offlineHasMore = offlineRows.length > pageSize;
      const returnOfflineRows = offlineHasMore ? offlineRows.slice(0, pageSize) : offlineRows;
      offlineRecords = returnOfflineRows.map(mapOfflineRecord);
      const lastOfflineRow = returnOfflineRows[returnOfflineRows.length - 1];
      offlineNextCursor =
        offlineHasMore && lastOfflineRow
          ? encodeCursor(lastOfflineRow.local_recorded_at, lastOfflineRow.id)
          : null;
      offlineTotalCount = typeof offlineCount === 'number' ? offlineCount : offlineRecords.length;
    }

    return jsonResponse(200, {
      mode,
      passes,
      nextCursor,
      hasMore,
      totalCount,
      total: totalCount,
      truncated,
      accountabilitySummary,
      offlineClassification: 'OFFLINE MODE RECORDED',
      offlineRecords,
      offlineNextCursor,
      offlineHasMore,
      offlineTotalCount,
      offlineTotal: offlineTotalCount,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Visitor records load failed.', JSON.stringify(extractErrorDiagnostics(error)));
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

async function handlePatch(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const body = await request.json().catch(() => null);
  const parsed = patchExpectedGateSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, { error: 'invalid_expected_gate_request' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);
    const result = await assignPassExpectedGate(admin, actor.id, parsed.data.passId, parsed.data.expectedGate);
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Expected gate assignment failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'service_unavailable' });
  }
}

async function handlePost(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  const body = await request.json().catch(() => null);
  const parsed = resolveAccountabilitySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, {
      error: 'invalid_resolution_request',
      message: 'Request payload failed schema validation.',
      details: parsed.error.issues,
    });
  }

  try {
    const { admin } = getServerSupabaseClients();
    // Super Admin authorization strictly enforced on resolution mutations
    const actor = await requireStaffActor(admin, token, ['superadmin']);
    const clientRequestId = parsed.data.requestId || randomUUID();

    const payload = parsed.data;
    const eventTime =
      payload.action === 'record_verified_exit' && payload.exitTime
        ? payload.exitTime
        : payload.action === 'confirm_office_visit' && (payload.arrivalTime || payload.verifiedTime)
        ? (payload.arrivalTime || payload.verifiedTime)
        : null;

    const requestedReason =
      payload.action === 'mark_reviewed'
        ? (payload.reason || payload.notes || '')
        : payload.reason;

    const exceptionType = payload.action === 'record_exception' ? payload.exceptionType : null;
    const gate = payload.action === 'record_verified_exit' ? payload.gate || null : null;

    const { data, error } = await resolveVisitorAccountability(admin, {
      actorId: actor.id,
      passId: payload.passId,
      action: payload.action,
      reason: requestedReason,
      eventTime,
      exceptionType,
      gate,
      requestId: clientRequestId,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      const msg = String(error.message || '');
      if (code === '22023') return jsonResponse(400, { error: msg || 'invalid_request' });
      if (code === '42501') return jsonResponse(403, { error: msg || 'forbidden' });
      throw error;
    }

    return jsonResponse(200, data);
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Visitor accountability resolution failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(500, { error: 'resolution_failed' });
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }
  if (request.method === 'POST') {
    return handlePost(request);
  }
  if (request.method === 'PATCH') {
    return handlePatch(request);
  }
  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH' });
}

export { handleRequest };
export default { fetch: handleRequest };
