import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireEmergencyDeviceActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import {
  EMERGENCY_LEASE_TTL_MS,
  normalizeGateName,
  PHYSICAL_ID_ATTESTATION_TEXT,
  signEmergencyManifest,
  type EmergencyManifestExpectedPass,
  type EmergencyManifestPayload,
} from '../../lib/emergency-manifest.js';
import { getServerSupabaseClients } from '../../supabase.js';

const syncItemSchema = z.object({
  requestId: z.string().uuid(),
  recordId: z.string().uuid(),
  claimedGate: z.string().trim().min(1).max(80),
  visitorFullName: z.string().trim().min(2).max(160),
  declaredAddress: z.string().trim().min(5).max(400),
  purpose: z.string().trim().min(2).max(500),
  destinationOfficeId: z.string().uuid().nullable(),
  destinationOfficeNameSnapshot: z.string().trim().min(2).max(160),
  officeResolutionStatus: z.enum(['resolved_snapshot', 'unresolved_stale_snapshot']),
  officeRequiresApprovalSnapshot: z.boolean(),
  idPhysicallyInspected: z.literal(true),
  idInspectionAttestationText: z.literal(PHYSICAL_ID_ATTESTATION_TEXT),
  localRecordedAt: z.string().datetime({ offset: true }),
  localSequence: z.number().int().min(1),
  snapshotVersion: z.string().trim().min(1).max(128),
  manifestId: z.string().uuid().nullable(),
  leaseStatusAtRecord: z.enum([
    'valid',
    'stale_lease',
    'expired_lease',
    'unverified_lease',
    'no_manifest',
  ]),
  emergencyExceptionApplied: z.boolean().default(false),
  emergencyExceptionReason: z.string().trim().max(500).nullable().optional(),
}).strict();

const syncBatchSchema = z.object({
  items: z.array(syncItemSchema).min(1).max(100),
}).strict();

function getManilaDateIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function handleGet(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireEmergencyDeviceActor(admin, token);
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(now.getTime() + EMERGENCY_LEASE_TTL_MS).toISOString();
    const manilaToday = getManilaDateIso(now);
    const normalizedActorGate = normalizeGateName(actor.gate);

    const [settingsRes, officesRes, passesRes, pendingVisitsRes] = await Promise.all([
      admin
        .from('app_settings')
        .select('allow_emergency_exception, emergency_exception_policy_note')
        .eq('singleton', true)
        .maybeSingle(),
      admin
        .from('offices')
        .select('id, name, code, requires_approval_before_pass')
        .eq('active', true)
        .eq('publication_status', 'published')
        .is('archived_at', null)
        .order('name', { ascending: true }),
      admin
        .from('passes')
        .select('id, public_reference, status, expected_gate, valid_until, visitor_id')
        .in('status', ['issued', 'pending', 'inside'])
        .not('expected_gate', 'is', null)
        .or(`valid_until.is.null,valid_until.gte.${nowIso}`)
        .limit(1000),
      admin
        .from('office_visits')
        .select('id, office_id, visitor_first_name, visitor_middle_name, visitor_last_name, purpose, approval_status, expected_gate, visit_date')
        .is('pass_id', null)
        .in('approval_status', ['pending', 'approved'])
        .not('expected_gate', 'is', null)
        .gte('visit_date', manilaToday)
        .limit(500),
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (officesRes.error) throw officesRes.error;
    if (passesRes.error) throw passesRes.error;
    if (pendingVisitsRes.error) throw pendingVisitsRes.error;

    const offices = (officesRes.data || []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      code: (row.code as string | null) ?? null,
      requiresApprovalBeforePass: Boolean(row.requires_approval_before_pass),
    }));
    const officeMap = new Map(offices.map((o) => [o.id, o]));

    const gatePasses = (passesRes.data || []).filter(
      (p) => normalizeGateName(p.expected_gate as string | null) === normalizedActorGate,
    );

    const visitorIds = Array.from(
      new Set(gatePasses.map((p) => p.visitor_id as string).filter(Boolean)),
    );
    const passIds = gatePasses.map((p) => p.id as string);

    const [visitorsRes, visitsForPassesRes] = await Promise.all([
      visitorIds.length > 0
        ? admin.from('visitors').select('id, full_name, purpose').in('id', visitorIds)
        : Promise.resolve({ data: [] as Array<{ id: string; full_name: string; purpose: string }>, error: null }),
      passIds.length > 0
        ? admin.from('office_visits').select('pass_id, office_id, approval_status').in('pass_id', passIds)
        : Promise.resolve({
            data: [] as Array<{ pass_id: string; office_id: string; approval_status: string }>,
            error: null,
          }),
    ]);

    if (visitorsRes.error) throw visitorsRes.error;
    if (visitsForPassesRes.error) throw visitsForPassesRes.error;

    const visitorMap = new Map((visitorsRes.data || []).map((v) => [v.id as string, v]));
    const visitByPassMap = new Map((visitsForPassesRes.data || []).map((ov) => [ov.pass_id as string, ov]));

    const expectedPasses: EmergencyManifestExpectedPass[] = gatePasses.map((p) => {
      const visitor = visitorMap.get(p.visitor_id as string);
      const visit = visitByPassMap.get(p.id as string);
      const office = visit?.office_id ? officeMap.get(visit.office_id as string) : undefined;
      return {
        passId: p.id as string,
        referenceCode: String(p.public_reference || '').slice(0, 8).toUpperCase(),
        status: p.status as string,
        visitorName: (visitor?.full_name as string) || 'Registered Visitor',
        purpose: (visitor?.purpose as string) || 'Campus Visit',
        officeId: office?.id ?? (visit?.office_id as string | null) ?? null,
        officeName: office?.name ?? null,
        requiresApproval: office?.requiresApprovalBeforePass ?? false,
        expectedGate: (p.expected_gate as string) || actor.gate,
        validUntil: (p.valid_until as string | null) ?? null,
      };
    });

    for (const pv of pendingVisitsRes.data || []) {
      if (normalizeGateName(pv.expected_gate as string | null) !== normalizedActorGate) {
        continue;
      }
      const office = pv.office_id ? officeMap.get(pv.office_id as string) : undefined;
      const fullName = [pv.visitor_first_name, pv.visitor_middle_name, pv.visitor_last_name]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join(' ');
      expectedPasses.push({
        passId: pv.id as string,
        referenceCode: String(pv.id || '').slice(0, 8).toUpperCase(),
        status: pv.approval_status === 'pending' ? 'pending_office_approval' : 'approved_prepass',
        visitorName: fullName || 'Pending Office Visitor',
        purpose: (pv.purpose as string) || 'Office Visit',
        officeId: (pv.office_id as string | null) ?? null,
        officeName: office?.name ?? null,
        requiresApproval: office?.requiresApprovalBeforePass ?? true,
        expectedGate: (pv.expected_gate as string) || actor.gate,
        validUntil: pv.visit_date ? `${pv.visit_date as string}T23:59:59+08:00` : null,
      });
    }

    const payload: EmergencyManifestPayload = {
      manifestId: randomUUID(),
      deviceUserId: actor.userId,
      deviceId: actor.deviceId,
      assignedGate: actor.gate,
      normalizedGate: normalizedActorGate,
      snapshotVersion: nowIso,
      issuedAt: nowIso,
      expiresAt: expiresAtIso,
      scope: 'emergency_offline_gate',
      allowEmergencyException: Boolean(settingsRes.data?.allow_emergency_exception),
      emergencyExceptionPolicyNote: (settingsRes.data?.emergency_exception_policy_note as string | null) ?? null,
      expectedPasses,
      offices,
    };

    const manifest = await signEmergencyManifest(admin, payload);

    const { error: recordErr } = await admin.schema('api').rpc('record_emergency_manifest', {
      requested_device_user_id: actor.userId,
      requested_manifest_id: payload.manifestId,
      requested_assigned_gate: actor.gate,
      requested_snapshot_version: payload.snapshotVersion,
      requested_issued_at: payload.issuedAt,
      requested_expires_at: payload.expiresAt,
      requested_manifest_hash: manifest.manifestHash,
      requested_request_id: randomUUID(),
    });
    if (recordErr) throw recordErr;

    return jsonResponse(200, {
      manifest,
      device: {
        deviceId: actor.deviceId,
        userId: actor.userId,
        name: actor.deviceName,
        gate: actor.gate,
        alias: actor.alias,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Emergency device manifest GET error:', error);
    return jsonResponse(503, { error: 'emergency_manifest_unavailable' });
  }
}

async function handlePost(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireEmergencyDeviceActor(admin, token);

    const body = await request.json().catch(() => null);
    const parsed = syncBatchSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'invalid_emergency_sync_payload',
        issues: parsed.error.issues.slice(0, 5),
      });
    }

    const sortedItems = [...parsed.data.items].sort(
      (a, b) => a.localSequence - b.localSequence,
    );

    const results: Array<Record<string, unknown>> = [];
    let acceptedCount = 0;
    let conflictCount = 0;
    let rejectedCount = 0;

    for (const item of sortedItems) {
      const { data, error } = await admin.schema('api').rpc('record_emergency_sync_item', {
        requested_request_id: item.requestId,
        requested_device_user_id: actor.userId,
        requested_record_id: item.recordId,
        requested_claimed_gate: item.claimedGate,
        requested_visitor_full_name: item.visitorFullName,
        requested_declared_address: item.declaredAddress,
        requested_purpose: item.purpose,
        requested_destination_office_id: item.destinationOfficeId,
        requested_destination_office_name_snapshot: item.destinationOfficeNameSnapshot,
        requested_office_resolution_status: item.officeResolutionStatus,
        requested_office_requires_approval_snapshot: item.officeRequiresApprovalSnapshot,
        requested_id_physically_inspected: item.idPhysicallyInspected,
        requested_id_inspection_attestation_text: item.idInspectionAttestationText,
        requested_local_recorded_at: item.localRecordedAt,
        requested_local_sequence: item.localSequence,
        requested_snapshot_version: item.snapshotVersion,
        requested_manifest_id: item.manifestId,
        requested_lease_status_at_record: item.leaseStatusAtRecord,
        requested_emergency_exception_applied: item.emergencyExceptionApplied,
        requested_emergency_exception_reason: item.emergencyExceptionReason ?? null,
      });

      if (error) {
        const errCode = (error as { code?: string }).code;
        if (errCode === '22023') {
          rejectedCount += 1;
          results.push({
            accepted: false,
            httpStatus: 400,
            outcome: 'rejected_validation',
            recordId: item.recordId,
            localSequence: item.localSequence,
            error: error.message,
          });
          continue;
        }
        throw error;
      }

      const row = (data || {}) as Record<string, unknown>;
      if (row.accepted === true) {
        acceptedCount += 1;
      } else if (row.httpStatus === 409) {
        conflictCount += 1;
      } else {
        rejectedCount += 1;
      }

      results.push({
        ...row,
        recordId: item.recordId,
        localSequence: item.localSequence,
        classification: 'OFFLINE MODE RECORDED',
      });
    }

    return jsonResponse(200, {
      syncedAt: new Date().toISOString(),
      deviceId: actor.deviceId,
      gate: actor.gate,
      acceptedCount,
      conflictCount,
      rejectedCount,
      results,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Emergency device sync POST error:', error);
    return jsonResponse(503, { error: 'emergency_sync_unavailable' });
  }
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }
  if (request.method === 'POST') {
    return handlePost(request);
  }
  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
}

export default { fetch: handleRequest };
