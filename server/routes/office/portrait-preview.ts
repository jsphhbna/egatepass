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
      .select('office_id, visitor_photo_path')
      .eq('id', visitId)
      .maybeSingle();

    if (fetchErr || !visit || !visit.visitor_photo_path) {
      return jsonResponse(404, { error: 'photo_not_found' });
    }

    // Comprehensive office actor authorization: validates active staff, email confirmed,
    // privacy accepted, no forced password change, and assigned office binding
    const actor = await requireOfficeStaffActor(admin, token, visit.office_id);

    // Verify portrait token signature and binding to this actor
    const verified = verifyOfficePortraitToken(previewToken, actor.id);
    if (!verified || verified.visitId !== visitId) {
      return jsonResponse(403, { error: 'invalid_or_expired_preview_token' });
    }

    // Download image from private storage
    const { data: fileData, error: downloadErr } = await admin.storage
      .from('visitor-photos')
      .download(visit.visitor_photo_path);

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
