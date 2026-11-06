import { verifyOfficePortraitToken } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getVerifiedSessionContext, HttpError } from '../../actors.js';

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
    const session = await getVerifiedSessionContext(admin, token);

    if (session.isRecoverySession || session.isAnonymous) {
      return jsonResponse(403, { error: 'access_denied' });
    }

    const verified = verifyOfficePortraitToken(previewToken, session.user.id);
    if (!verified) {
      return jsonResponse(403, { error: 'invalid_or_expired_preview_token' });
    }

    // Retrieve visit record
    const { data: visit, error: fetchErr } = await admin
      .from('office_visits')
      .select('office_id, visitor_photo_path')
      .eq('id', verified.visitId)
      .maybeSingle();

    if (fetchErr || !visit || !visit.visitor_photo_path) {
      return jsonResponse(404, { error: 'photo_not_found' });
    }

    // Verify staff assignment
    const { data: profile } = await admin
      .from('staff_profiles')
      .select('role, active')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (!profile?.active) return jsonResponse(403, { error: 'access_denied' });

    if (profile.role === 'office_staff') {
      const { data: assignment } = await admin
        .from('office_staff_assignments')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('office_id', visit.office_id)
        .maybeSingle();

      if (!assignment) {
        return jsonResponse(403, { error: 'cross_office_photo_access_denied' });
      }
    }

    // Download image from storage
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
