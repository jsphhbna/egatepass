import { createHash } from 'node:crypto';
import { HttpError } from '../../actors.js';
import { jsonResponse } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { getClientNetworkIdentifier } from './issue.js';

export function maskNamePart(str: string): string {
  const trimmed = (str || '').trim();
  if (!trimmed) return '';
  if (trimmed.length === 1) return `${trimmed}*`;
  if (trimmed.length === 2) return `${trimmed[0]}*`;
  return `${trimmed[0]}${'*'.repeat(Math.max(1, trimmed.length - 2))}${trimmed[trimmed.length - 1]}`;
}

export function maskVisitorName(first: string, last: string): string {
  const p1 = maskNamePart(first);
  const p2 = maskNamePart(last);
  return `${p1} ${p2}`.trim();
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const { admin } = getServerSupabaseClients();

  // Rate limiting per client network identifier
  let networkKeyHex: string;
  try {
    networkKeyHex = getClientNetworkIdentifier(request);
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    networkKeyHex = 'default';
  }

  const { data: netAllowed, error: netRlError } = await admin.schema('api').rpc('consume_rate_limit', {
    p_key: `ip:${networkKeyHex}`,
    p_action: 'portal.track_visit',
    p_max_hits: 60,
    p_window_seconds: 60,
  });

  if (netRlError || netAllowed === false) {
    return jsonResponse(429, {
      error: 'rate_limited',
      message: 'Too many tracking status requests. Please wait a moment before trying again.',
    }, {
      'Retry-After': '60',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  const body = await request.json().catch(() => null);
  const token = body?.token;

  if (typeof token !== 'string' || token.trim().length < 16 || token.trim().length > 256) {
    return jsonResponse(400, {
      error: 'invalid_token',
      message: 'A valid tracking token is required.',
    }, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  const cleanToken = token.trim();
  const tokenDigest = createHash('sha256').update(cleanToken).digest('hex');

  const { data: statusRows, error: statusErr } = await admin
    .schema('api')
    .rpc('lookup_office_visit_tracking_status', {
      requested_token_digest: tokenDigest,
    });

  if (statusErr) {
    console.error('Failed to lookup office visit tracking status:', statusErr);
    return jsonResponse(500, {
      error: 'lookup_failed',
      message: 'Unable to retrieve visit request tracking status at this time.',
    }, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  const row = Array.isArray(statusRows) ? statusRows[0] : statusRows;
  if (!row) {
    return jsonResponse(404, {
      error: 'visit_not_found',
      message: 'Visit request not found or tracking link is invalid.',
    }, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  if (row.is_expired) {
    return jsonResponse(410, {
      error: 'tracking_expired',
      message: 'This tracking link has expired.',
    }, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Robots-Tag': 'noindex, nofollow',
    });
  }

  return jsonResponse(200, {
    ok: true,
    tracking: {
      approvalStatus: row.approval_status,
      attendanceStatus: row.attendance_status,
      officeName: row.office_name,
      personnelName: row.personnel_name || null,
      purpose: row.purpose,
      visitDate: row.visit_date,
      arrivalMode: row.arrival_mode,
      maskedVisitorName: maskVisitorName(row.visitor_first_name, row.visitor_last_name),
      rejectionReason: row.approval_status === 'rejected' ? (row.rejection_reason || null) : null,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at || null,
    },
  }, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
