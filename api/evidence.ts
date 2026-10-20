import { z } from 'zod';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { recordReconciliation } from '../server/actors.js';
import { getServerSupabaseClients } from '../server/supabase.js';

const idSchema = z.string().uuid();

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  const token = readBearerToken(request);
  const evidenceId = idSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!token) return jsonResponse(401, { error: 'Authentication required' });
  if (!evidenceId.success) return jsonResponse(400, { error: 'Invalid evidence reference' });
  try {
    const { admin } = getServerSupabaseClients();
    const { data: identity, error: authError } = await admin.auth.getUser(token);
    if (authError || !identity.user) return jsonResponse(401, { error: 'Invalid or expired session' });
    const { data: profile, error: profileError } = await admin.from('staff_profiles')
      .select('role, active, must_change_password, privacy_accepted_at').eq('user_id', identity.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.active || profile.must_change_password || !profile.privacy_accepted_at
      || !['guard', 'admin', 'superadmin'].includes(profile.role)) return jsonResponse(403, { error: 'Access denied' });

    const { data: evidence, error: evidenceError } = await admin.from('visitor_evidence')
      .select('visitor_id, bucket_id, object_path, content_type, expires_at, purged_at')
      .eq('id', evidenceId.data).maybeSingle();
    if (evidenceError) throw evidenceError;
    if (!evidence) return jsonResponse(404, { error: 'Evidence not found' });
    if (evidence.purged_at) return jsonResponse(410, { error: 'Evidence expired' });

    const isExpired = new Date(evidence.expires_at).getTime() <= Date.now();
    let isHeld = false;

    if (isExpired) {
      // Ordinary guards cannot access expired evidence even under hold
      if (profile.role === 'guard') {
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

      // 16A: Audit review of expired held evidence and fail closed if audit recording fails
      const { error: auditError } = await admin.from('audit_events').insert({
        actor_id: identity.user.id,
        actor_kind: 'staff',
        actor_role: profile.role,
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
          { actorId: identity.user.id, actorRole: profile.role }
        ).catch(() => undefined);
        return jsonResponse(503, { error: 'Audit recording unavailable' });
      }
    } else if (profile.role === 'guard') {
      const { count, error: passError } = await admin.from('passes').select('id', { count: 'exact', head: true })
        .eq('visitor_id', evidence.visitor_id).eq('status', 'pending');
      if (passError) throw passError;
      if (!count) return jsonResponse(403, { error: 'Evidence is not in the pending queue' });
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
