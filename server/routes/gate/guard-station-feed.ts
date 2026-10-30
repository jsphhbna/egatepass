import { getVerifiedSessionContext, HttpError } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

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
        const url = new URL(request.url);
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

    // 2. Fetch passes scanned at this gate today (last 24 hours), strictly portal entries
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: passes, error: passesError } = await admin
      .from('passes')
      .select('id, public_reference, status, source, entry_scanned_at, time_in, time_out, visitor_id, gate')
      .eq('gate', stationGate)
      .eq('source', 'portal')
      .in('status', ['inside', 'exited'])
      .not('entry_scanned_at', 'is', null)
      .gte('entry_scanned_at', twentyFourHoursAgo)
      .order('entry_scanned_at', { ascending: false })
      .limit(50);

    if (passesError) throw passesError;

    const passList = passes || [];
    const visitorIds = Array.from(new Set(passList.map((p) => p.visitor_id)));

    let visitors: Array<{ id: string; full_name: string; contact_number: string; purpose: string }> = [];
    let photoEvidence: Array<{ id: string; visitor_id: string }> = [];

    if (visitorIds.length > 0) {
      const [{ data: vData, error: vError }, { data: eData, error: eError }] = await Promise.all([
        admin.from('visitors').select('id, full_name, contact_number, purpose').in('id', visitorIds),
        admin.from('visitor_evidence').select('id, visitor_id').in('visitor_id', visitorIds).eq('kind', 'photo').is('purged_at', null),
      ]);

      if (vError) throw vError;
      if (eError) throw eError;

      visitors = vData || [];
      photoEvidence = eData || [];
    }

    const visitorMap = new Map(visitors.map((v) => [v.id, v]));
    const photoMap = new Map(photoEvidence.map((e) => [e.visitor_id, e.id]));

    const entries = passList.map((p) => {
      const v = visitorMap.get(p.visitor_id);
      return {
        passId: p.id,
        publicReference: p.public_reference,
        status: p.status,
        source: p.source,
        enteredAt: p.time_in || p.entry_scanned_at,
        visitorName: v?.full_name || 'Visitor',
        contactNumber: v?.contact_number || '',
        purpose: v?.purpose || '',
        photoEvidenceId: photoMap.get(p.visitor_id) || null,
        gate: p.gate,
      };
    });

    return jsonResponse(200, {
      station: stationInfo,
      entries,
    });
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    console.error('Guard station feed error:', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(500, { error: 'station_feed_unavailable' });
  }
}

export default { fetch: handleRequest };
