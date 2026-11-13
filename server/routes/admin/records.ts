import { z } from 'zod';
import { HttpError, requireStaffActor } from '../../actors.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { assignPassExpectedGate } from '../../lib/office.js';
import { getServerSupabaseClients } from '../../supabase.js';

const EXPORT_MAX_ROWS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchExpectedGateSchema = z.object({
  passId: z.string().regex(UUID_RE),
  expectedGate: z.string().trim().min(1).max(80),
}).strict();

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
  visitors: {
    full_name: string;
    purpose: string;
    visit_date?: string | null;
    contact_number?: string | null;
    home_address?: string | null;
    home_street?: string | null;
    home_building?: string | null;
    barangay_name?: string | null;
    city_name?: string | null;
    province_name?: string | null;
    region_name?: string | null;
    visitor_evidence: Array<{ id: string; kind: 'photo' | 'id' }>;
  } | null;
  office_visits?: Array<{
    id: string;
    attendance_status: string;
    visit_type?: string;
    approval_status?: string;
    offices?: { name: string } | null;
  }> | {
    id: string;
    attendance_status: string;
    visit_type?: string;
    approval_status?: string;
    offices?: { name: string } | null;
  } | null;
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

function mapPass(row: RawRecordPassRow) {
  const visitor = row.visitors;
  const evidenceList = visitor?.visitor_evidence ?? [];
  const photoId = evidenceList.find((e) => e.kind === 'photo')?.id ?? null;
  const idImageId = evidenceList.find((e) => e.kind === 'id')?.id ?? null;

  const officeVisit = Array.isArray(row.office_visits) ? row.office_visits[0] : row.office_visits;
  const destinationOffice = officeVisit?.offices?.name ?? null;
  const attendanceStatus = officeVisit?.attendance_status ?? null;
  const visitType = officeVisit?.visit_type ?? null;
  const approvalStatus = officeVisit?.approval_status ?? null;

  return {
    id: row.id,
    visitorId: row.visitor_id,
    visitorName: visitor?.full_name ?? '',
    purpose: visitor?.purpose ?? '',
    visitDate: visitor?.visit_date ?? null,
    contactNumber: visitor?.contact_number ?? null,
    homeAddress: visitor?.home_address ?? null,
    homeStreet: visitor?.home_street ?? null,
    homeBuilding: visitor?.home_building ?? null,
    barangayName: visitor?.barangay_name ?? null,
    cityName: visitor?.city_name ?? null,
    provinceName: visitor?.province_name ?? null,
    regionName: visitor?.region_name ?? null,
    destinationOffice,
    attendanceStatus,
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
  if (!['standard', 'offline', 'all'].includes(modeParam)) {
    return jsonResponse(400, { error: 'invalid_mode' });
  }
  const mode = modeParam as 'standard' | 'offline' | 'all';

  const statusParam = url.searchParams.get('status')?.trim();
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
    await requireStaffActor(admin, token, ['admin', 'superadmin']);

    let passes: ReturnType<typeof mapPass>[] = [];
    let nextCursor: string | null = null;
    let hasMore = false;
    let totalCount = 0;
    let truncated = false;

    if (mode === 'standard' || mode === 'all') {
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
          visitors!inner (
            full_name,
            purpose,
            visit_date,
            contact_number,
            home_address,
            home_street,
            home_building,
            barangay_name,
            city_name,
            province_name,
            region_name,
            visitor_evidence (
              id,
              kind
            )
          ),
          office_visits (
            id,
            attendance_status,
            visit_type,
            approval_status,
            offices (
              name
            )
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
        query = query.ilike('visitors.full_name', `%${searchParam}%`);
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
      if (exportAll) {
        passes = rows.slice(0, EXPORT_MAX_ROWS).map(mapPass);
        totalCount = typeof count === 'number' ? count : passes.length;
        truncated = totalCount > EXPORT_MAX_ROWS;
      } else {
        hasMore = rows.length > pageSize;
        const returnRows = hasMore ? rows.slice(0, pageSize) : rows;
        passes = returnRows.map(mapPass);
        const lastRow = returnRows[returnRows.length - 1];
        nextCursor = hasMore && lastRow ? encodeCursor(lastRow.issued_at, lastRow.id) : null;
        totalCount = typeof count === 'number' ? count : passes.length;
      }
    }

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
        offlineQuery = offlineQuery.ilike('visitor_full_name', `%${searchParam}%`);
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

      offlineQuery = offlineQuery.limit(exportAll ? EXPORT_MAX_ROWS : pageSize + 1);
      const { data: rawOfflineRows, count: offlineCount, error: offlineErr } = await offlineQuery;
      if (offlineErr) throw offlineErr;

      const offlineRows = (rawOfflineRows ?? []) as unknown as RawOfflineRecordRow[];
      const offlineHasMore = exportAll ? false : offlineRows.length > pageSize;
      const returnOffline = exportAll
        ? offlineRows.slice(0, EXPORT_MAX_ROWS)
        : (offlineHasMore ? offlineRows.slice(0, pageSize) : offlineRows);
      const offlineRecords = returnOffline.map(mapOfflineRecord);
      const lastOffline = returnOffline[returnOffline.length - 1];
      const offlineNextCursor = offlineHasMore && lastOffline
        ? encodeCursor(lastOffline.local_recorded_at, lastOffline.id)
        : null;
      const offlineTotalCount = typeof offlineCount === 'number' ? offlineCount : offlineRecords.length;
      const offlineTruncated = exportAll && offlineTotalCount > EXPORT_MAX_ROWS;

      return jsonResponse(200, {
        mode,
        passes,
        nextCursor,
        hasMore,
        totalCount,
        truncated: truncated || offlineTruncated,
        offlineClassification: 'OFFLINE MODE RECORDED',
        offlineRecords,
        offlineNextCursor,
        offlineHasMore,
        offlineTotalCount,
      });
    }

    return jsonResponse(200, {
      mode,
      passes,
      nextCursor,
      hasMore,
      totalCount,
      truncated,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Visitor records load failed.', error instanceof Error ? error.message : 'unknown_error');
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

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }
  if (request.method === 'PATCH') {
    return handlePatch(request);
  }
  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, PATCH' });
}

export { handleRequest };
export default { fetch: handleRequest };
