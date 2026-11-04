import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { decodeCursorStrict, encodeCursor } from '../../cursor.js';

export function getManilaDayBounds(now = new Date()): { startUtc: string; endUtc: string } {
  const manilaOffsetMs = 8 * 60 * 60 * 1000;
  const manilaNow = new Date(now.getTime() + manilaOffsetMs);
  const year = manilaNow.getUTCFullYear();
  const month = manilaNow.getUTCMonth();
  const date = manilaNow.getUTCDate();
  const startUtc = new Date(Date.UTC(year, month, date) - manilaOffsetMs).toISOString();
  const endUtc = new Date(Date.UTC(year, month, date, 23, 59, 59, 999) - manilaOffsetMs).toISOString();
  return { startUtc, endUtc };
}

export function getManilaBusinessDate(now = new Date()): string {
  const manilaOffsetMs = 8 * 60 * 60 * 1000;
  const manilaNow = new Date(now.getTime() + manilaOffsetMs);
  const year = manilaNow.getUTCFullYear();
  const month = String(manilaNow.getUTCMonth() + 1).padStart(2, '0');
  const date = String(manilaNow.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'invalid_session' });
    }

    if (session.isRecoverySession || session.isAnonymous) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 100));
    const rawCursor = url.searchParams.get('cursor')?.trim();

    let decodedCursor = null;
    if (rawCursor) {
      try {
        decodedCursor = decodeCursorStrict(rawCursor, { idType: 'uuid' });
      } catch {
        return jsonResponse(400, { error: 'invalid_cursor' });
      }
    }

    // 1. Authorize caller: must be an active guard_station device, or admin/superadmin
    let stationGate: string | null = null;
    let stationInfo: { id: string; name: string; alias: string; gate: string } | null = null;

    const { data: device, error: deviceError } = await admin
      .from('devices')
      .select('user_id, name, alias, type, gate, status')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (deviceError) throw deviceError;

    if (device && device.status === 'active' && device.type === 'guard_station') {
      stationGate = device.gate;
      stationInfo = {
        id: device.user_id,
        name: device.name,
        alias: device.alias,
        gate: device.gate,
      };
    } else {
      // Check if admin / superadmin
      const { data: staff, error: staffError } = await admin
        .from('staff_profiles')
        .select('user_id, role, active, must_change_password, privacy_accepted_at')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (staffError) throw staffError;

      if (
        staff &&
        staff.active &&
        !staff.must_change_password &&
        staff.privacy_accepted_at &&
        (staff.role === 'admin' || staff.role === 'superadmin')
      ) {
        const requestedGate = url.searchParams.get('gate')?.trim();

        // Validate gate against configured active devices to prevent spoofing
        const { data: activeDevices, error: devicesError } = await admin
          .from('devices')
          .select('gate')
          .eq('status', 'active');

        if (devicesError) throw devicesError;

        const validGates = Array.from(new Set((activeDevices || []).map((d) => d.gate).filter(Boolean)));
        if (validGates.length === 0) {
          validGates.push('Gate 1');
        }

        let gateName: string;
        if (requestedGate) {
          if (!validGates.includes(requestedGate)) {
            return jsonResponse(400, { error: 'invalid_gate' });
          }
          gateName = requestedGate;
        } else {
          gateName = validGates[0] || 'Gate 1';
        }

        stationGate = gateName;
        stationInfo = {
          id: staff.user_id,
          name: `Admin Console (${gateName})`,
          alias: 'admin-monitor',
          gate: gateName,
        };
      } else {
        return jsonResponse(403, { error: 'access_denied' });
      }
    }

    if (!stationGate) {
      return jsonResponse(400, { error: 'invalid_gate' });
    }

    // 2. Fetch passes scanned at this gate today (Asia/Manila calendar day)
    const { startUtc, endUtc } = getManilaDayBounds();

    // Query authoritative total count for today
    const { count: totalCount, error: countErr } = await admin
      .from('passes')
      .select('id', { count: 'exact', head: true })
      .eq('gate', stationGate)
      .eq('source', 'portal')
      .in('status', ['inside', 'exited'])
      .not('entry_scanned_at', 'is', null)
      .gte('entry_scanned_at', startUtc)
      .lte('entry_scanned_at', endUtc);

    if (countErr) throw countErr;

    // Keyset query with limit + 1
    let query = admin
      .from('passes')
      .select('id, public_reference, status, source, entry_scanned_at, time_in, time_out, visitor_id, gate')
      .eq('gate', stationGate)
      .eq('source', 'portal')
      .in('status', ['inside', 'exited'])
      .not('entry_scanned_at', 'is', null)
      .gte('entry_scanned_at', startUtc)
      .lte('entry_scanned_at', endUtc);

    if (decodedCursor && decodedCursor.id) {
      query = query.or(`entry_scanned_at.lt.${decodedCursor.timestamp},and(entry_scanned_at.eq.${decodedCursor.timestamp},id.lt.${decodedCursor.id})`);
    } else if (decodedCursor) {
      query = query.lt('entry_scanned_at', decodedCursor.timestamp);
    }

    query = query
      .order('entry_scanned_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const { data: passes, error: passesError } = await query;
    if (passesError) throw passesError;

    const rawList = passes || [];
    const hasMore = rawList.length > limit;
    const passList = hasMore ? rawList.slice(0, limit) : rawList;
    const lastItem = passList[passList.length - 1];
    const nextCursor = hasMore && lastItem && lastItem.entry_scanned_at
      ? encodeCursor(lastItem.entry_scanned_at, lastItem.id)
      : null;

    const visitorIds = Array.from(new Set(passList.map((p) => p.visitor_id)));
    const passIds = passList.map((p) => p.id);

    let visitors: Array<{ id: string; full_name: string; purpose: string; returning_profile_id?: string | null }> = [];
    let photoEvidence: Array<{ id: string; visitor_id: string }> = [];
    let vehicles: Array<{
      pass_id: string;
      vehicle_type: string;
      plate_number: string;
      color: string;
      make_model: string | null;
      vehicle_photo_evidence_id?: string | null;
      plate_conflict_flag?: boolean | null;
    }> = [];

    const fetchPromises: Promise<void>[] = [];

    if (visitorIds.length > 0) {
      fetchPromises.push(
        (async () => {
          const { data, error } = await admin.from('visitors').select('id, full_name, purpose, returning_profile_id').in('id', visitorIds);
          if (error) throw error;
          visitors = data || [];
        })(),
        (async () => {
          const { data, error } = await admin.from('visitor_evidence').select('id, visitor_id').in('visitor_id', visitorIds).eq('kind', 'photo').is('purged_at', null);
          if (error) throw error;
          photoEvidence = data || [];
        })()
      );
    }

    if (passIds.length > 0) {
      fetchPromises.push(
        (async () => {
          const { data, error } = await admin.from('visit_vehicle_declarations').select('pass_id, vehicle_type, plate_number, color, make_model, vehicle_photo_evidence_id, plate_conflict_flag').in('pass_id', passIds);
          if (error) throw error;
          vehicles = data || [];
        })()
      );
    }

    if (fetchPromises.length > 0) {
      await Promise.all(fetchPromises);
    }

    const visitorMap = new Map(visitors.map((v) => [v.id, v]));
    const photoMap = new Map(photoEvidence.map((e) => [e.visitor_id, e.id]));

    // Resolve historical photo evidence for returning visitors without a direct photo in visitor_evidence
    const returningProfileIds = Array.from(new Set(visitors.map((v) => v.returning_profile_id).filter(Boolean))) as string[];
    if (returningProfileIds.length > 0) {
      const { data: linkedVisitors } = await admin.from('visitors').select('id, returning_profile_id').in('returning_profile_id', returningProfileIds);
      const linkedIds = (linkedVisitors || []).map((lv) => lv.id);
      if (linkedIds.length > 0) {
        const { data: origEv } = await admin.from('visitor_evidence')
          .select('id, visitor_id, created_at')
          .in('visitor_id', linkedIds)
          .eq('kind', 'photo')
          .is('purged_at', null)
          .order('created_at', { ascending: true });

        if (origEv && origEv.length > 0) {
          const profileToEvMap = new Map<string, string>();
          const vToProfileMap = new Map((linkedVisitors || []).map((lv) => [lv.id, lv.returning_profile_id!]));
          for (const ev of origEv) {
            const profId = vToProfileMap.get(ev.visitor_id);
            if (profId && !profileToEvMap.has(profId)) {
              profileToEvMap.set(profId, ev.id);
            }
          }
          for (const v of visitors) {
            if (v.returning_profile_id && profileToEvMap.has(v.returning_profile_id)) {
              if (!photoMap.has(v.id)) {
                photoMap.set(v.id, profileToEvMap.get(v.returning_profile_id)!);
              }
            }
          }
        }
      }
    }
    const vehicleMap = new Map(vehicles.map((v) => [v.pass_id, v]));

    const entries = passList.map((p) => {
      const v = visitorMap.get(p.visitor_id);
      const veh = vehicleMap.get(p.id);
      return {
        passId: p.id,
        publicReference: p.public_reference,
        status: p.status, // 'inside' | 'exited'
        source: p.source,
        enteredAt: p.time_in || p.entry_scanned_at,
        visitorName: v?.full_name || 'Visitor',
        purpose: v?.purpose || '',
        photoEvidenceId: photoMap.get(p.visitor_id) || null,
        gate: p.gate,
        vehicle: veh
          ? {
              plateNumber: veh.plate_number,
              vehicleType: veh.vehicle_type,
              color: veh.color,
              makeModel: veh.make_model || null,
              vehiclePhotoEvidenceId: veh.vehicle_photo_evidence_id || null,
              plateConflictFlag: Boolean(veh.plate_conflict_flag),
            }
          : null,
      };
    });

    return jsonResponse(200, {
      station: stationInfo,
      businessDate: getManilaBusinessDate(),
      entries,
      hasMore,
      nextCursor,
      total: totalCount ?? entries.length,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Guard station feed error:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(500, { error: 'station_feed_unavailable' });
  }
}

export default { fetch: handleRequest };
