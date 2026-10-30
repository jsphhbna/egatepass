import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getVerifiedSessionContext, HttpError, recordReconciliation } from '../../actors.js';
import { getServerSupabaseClients } from '../../supabase.js';

const idSchema = z.string().uuid();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request);
  const evidenceId = idSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!token) return jsonResponse(401, { error: 'Authentication required' });
  if (!evidenceId.success) return jsonResponse(400, { error: 'Invalid evidence reference' });

  try {
    const { admin } = getServerSupabaseClients();
    let session;
    try {
      session = await getVerifiedSessionContext(admin, token);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code });
      return jsonResponse(401, { error: 'Invalid or expired session' });
    }

    if (session.isRecoverySession || session.isAnonymous) {
      return jsonResponse(403, { error: 'Access denied' });
    }

    let staffActor: { id: string; role: 'guard' | 'admin' | 'superadmin' } | null = null;
    let stationDevice: { id: string; gate: string } | null = null;

    const { data: staff, error: staffError } = await admin.from('staff_profiles')
      .select('role, active, must_change_password, privacy_accepted_at')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (staffError) throw staffError;

    if (
      staff &&
      staff.active &&
      !staff.must_change_password &&
      staff.privacy_accepted_at &&
      ['guard', 'admin', 'superadmin'].includes(staff.role)
    ) {
      staffActor = { id: session.user.id, role: staff.role as 'guard' | 'admin' | 'superadmin' };
    } else {
      const { data: device, error: deviceError } = await admin.from('devices')
        .select('user_id, status, type, gate')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (deviceError) throw deviceError;

      if (device && device.status === 'active' && device.type === 'guard_station') {
        stationDevice = { id: device.user_id, gate: device.gate };
      } else {
        return jsonResponse(403, { error: 'Access denied' });
      }
    }

    const { data: evidence, error: evidenceError } = await admin.from('visitor_evidence')
      .select('visitor_id, bucket_id, object_path, content_type, expires_at, purged_at, kind')
      .eq('id', evidenceId.data).maybeSingle();
    if (evidenceError) throw evidenceError;
    if (!evidence) return jsonResponse(404, { error: 'Evidence not found' });
    if (evidence.purged_at) return jsonResponse(410, { error: 'Evidence expired' });

    const isExpired = new Date(evidence.expires_at).getTime() <= Date.now();
    let isHeld = false;

    if (stationDevice) {
      // Guard station privacy boundary: only photo evidence permitted, never ID document
      if (evidence.kind !== 'photo') {
        return jsonResponse(403, { error: 'Guard station cannot access ID evidence' });
      }
      if (isExpired) {
        return jsonResponse(410, { error: 'Evidence expired' });
      }
      // Same-gate confinement: pass must belong to the device's gate
      const { count, error: passError } = await admin.from('passes').select('id', { count: 'exact', head: true })
        .eq('visitor_id', evidence.visitor_id)
        .eq('gate', stationDevice.gate)
        .in('status', ['issued', 'pending', 'inside', 'exited']);
      if (passError) throw passError;
      if (!count) return jsonResponse(403, { error: 'Evidence is not operationally accessible at this station' });
    } else if (staffActor) {
      if (isExpired) {
        // Ordinary guards cannot access expired evidence even under hold
        if (staffActor.role === 'guard') {
          return jsonResponse(410, { error: 'Evidence expired' });
        }

        // Admins and Super Admins may review expired evidence ONLY if an active incident hold protects it
        const { data: visitorHold, error: visitorHoldError } = await admin
          .from('incident_holds')
          .select('id, reason')
          .eq('visitor_id', evidence.visitor_id)
          .eq('active', true)
          .maybeSingle();

        if (visitorHoldError) throw visitorHoldError;
        let activeHold = visitorHold;

        if (!activeHold) {
          const { data: passes, error: passesError } = await admin
            .from('passes')
            .select('id')
            .eq('visitor_id', evidence.visitor_id);

          if (passesError) throw passesError;
          const passIds = (passes || []).map((p: any) => p.id);
          if (passIds.length > 0) {
            const { data: passHolds, error: passHoldError } = await admin
              .from('incident_holds')
              .select('id, reason')
              .in('pass_id', passIds)
              .eq('active', true)
              .limit(1);

            if (passHoldError) throw passHoldError;
            activeHold = passHolds?.[0] ?? null;
          }
        }

        if (!activeHold) {
          return jsonResponse(410, { error: 'Evidence expired' });
        }

        isHeld = true;

        // Audit review of expired held evidence and fail closed if audit recording fails
        const { error: auditError } = await admin.from('audit_events').insert({
          actor_id: staffActor.id,
          actor_kind: 'staff',
          actor_role: staffActor.role,
          action: 'evidence.review_held',
          target_type: 'visitor_evidence',
          target_id: evidenceId.data,
          outcome: 'success',
        });

        if (auditError) {
          console.error('Audit recording failed during held evidence review:', auditError);
          await recordReconciliation(
            admin,
            'evidence.review_held.audit_failed',
            'visitor_evidence',
            evidenceId.data,
            auditError.message || 'audit_insert_failed',
            { actorId: staffActor.id, actorRole: staffActor.role }
          ).catch(() => undefined);
          return jsonResponse(503, { error: 'Audit recording unavailable' });
        }
      } else if (staffActor.role === 'guard') {
        // Guard access is scoped to operational verification (.eq('status', 'pending') and active recovery passes)
        const { count, error: passError } = await admin.from('passes').select('id', { count: 'exact', head: true })
          .eq('visitor_id', evidence.visitor_id)
          .eq('status', 'pending');
        if (passError) throw passError;
        if (!count) return jsonResponse(403, { error: 'Evidence is not operationally accessible' });
      }
    }

    const file = await admin.storage.from(evidence.bucket_id).download(evidence.object_path);
    if (file.error) return jsonResponse(404, { error: 'Evidence object not found' });
    return new Response(file.data, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': evidence.content_type,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        ...(isHeld ? { 'X-Evidence-Hold-Status': 'active_hold' } : {}),
      },
    });
  } catch (error) {
    console.error('Evidence retrieval failed.', error instanceof Error ? error.message : 'unknown_error');
    return jsonResponse(503, { error: 'Evidence temporarily unavailable' });
  }
}

export default { fetch: handleRequest };
