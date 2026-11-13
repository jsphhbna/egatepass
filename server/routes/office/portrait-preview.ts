import { verifyOfficePortraitToken, requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { HttpError } from '../../actors.js';

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  const url = new URL(request.url);
  const previewToken = url.searchParams.get('token');
  if (!previewToken) {
    return jsonResponse(400, { error: 'preview_token_required' });
  }

  try {
    const { admin } = getServerSupabaseClients();

    // Verify visit existence first to obtain office_id for authorization
    // Decode preview token to get visitId
    // Preview token format: office_p.<visitId>.<actorId>.<expiresAt>.<sig>
    const parts = previewToken.split('.');
    const visitId = parts[1];
    if (!visitId) {
      return jsonResponse(400, { error: 'invalid_preview_token' });
    }

    const { data: visit, error: fetchErr } = await admin
      .from('office_visits')
      .select('office_id, visitor_photo_path, registration_mode, returning_profile_id, visitor_id, photo_intent_id')
      .eq('id', visitId)
      .maybeSingle();

    if (fetchErr || !visit) {
      return jsonResponse(404, { error: 'visit_not_found' });
    }

    // Comprehensive office actor authorization: validates active staff, email confirmed,
    // privacy accepted, no forced password change, and assigned office binding
    const actor = await requireOfficeStaffActor(admin, token, visit.office_id);

    // Verify portrait token signature and binding to this actor
    const verified = verifyOfficePortraitToken(previewToken, actor.id);
    if (!verified || verified.visitId !== visitId) {
      return jsonResponse(403, { error: 'invalid_or_expired_preview_token' });
    }

    let bucketId = 'visitor-photos';
    let objectPath = visit.visitor_photo_path;

    if (!objectPath) {
      // 1. Check if returning visitor profile has photo evidence
      if (visit.returning_profile_id) {
        const { data: retVisitors } = await admin
          .from('visitors')
          .select('id')
          .eq('returning_profile_id', visit.returning_profile_id);
        const vIds = (retVisitors || []).map((v: any) => v.id);
        if (vIds.length > 0) {
          const { data: ev } = await admin
            .from('visitor_evidence')
            .select('bucket_id, object_path, purged_at')
            .in('visitor_id', vIds)
            .eq('kind', 'photo')
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();
          if (ev) {
            if (ev.purged_at) {
              return jsonResponse(410, {
                error: 'photo_expired_under_retention',
                message: 'Visitor photo was removed under retention policy.',
              });
            }
            bucketId = ev.bucket_id || 'visitor-photos';
            objectPath = ev.object_path;
          }
        }
      }

      // 2. Check visitor_id in visitor_evidence
      if (!objectPath && visit.visitor_id) {
        const { data: ev } = await admin
          .from('visitor_evidence')
          .select('bucket_id, object_path, purged_at')
          .eq('visitor_id', visit.visitor_id)
          .eq('kind', 'photo')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (ev) {
          if (ev.purged_at) {
            return jsonResponse(410, {
              error: 'photo_expired_under_retention',
              message: 'Visitor photo was removed under retention policy.',
            });
          }
          bucketId = ev.bucket_id || 'visitor-photos';
          objectPath = ev.object_path;
        }
      }

      // 3. Check upload_intents if photo_intent_id is present
      if (!objectPath && visit.photo_intent_id) {
        const { data: intent } = await admin
          .from('upload_intents')
          .select('bucket_id, object_path')
          .eq('id', visit.photo_intent_id)
          .maybeSingle();
        if (intent) {
          bucketId = intent.bucket_id || 'visitor-photos';
          objectPath = intent.object_path;
        }
      }
    }

    if (!objectPath) {
      return jsonResponse(404, { error: 'photo_not_found' });
    }

    // Download image from private storage
    const { data: fileData, error: downloadErr } = await admin.storage
      .from(bucketId)
      .download(objectPath);

    if (downloadErr || !fileData) {
      console.error('Storage download error:', downloadErr);
      return jsonResponse(404, { error: 'photo_download_failed' });
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'Content-Length': String(buffer.byteLength),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Portrait preview error:', error);
    return jsonResponse(500, { error: 'preview_failed' });
  }
}

export default { fetch: handleRequest };
