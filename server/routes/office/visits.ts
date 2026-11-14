import { requireOfficeStaffActor } from '../../lib/office.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';
import { createOfficePortraitToken } from '../../lib/office.js';
import { HttpError } from '../../actors.js';

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'Authentication required' });

  try {
    const { admin } = getServerSupabaseClients();
    const url = new URL(request.url);
    const officeIdParam = url.searchParams.get('officeId') || undefined;
    const actor = await requireOfficeStaffActor(admin, token, officeIdParam);

    // Determine target officeId
    let effectiveOfficeId = officeIdParam;
    if (!effectiveOfficeId) {
      if (actor.role === 'office_staff') {
        if (actor.assignedOfficeIds.length === 0) {
          return jsonResponse(403, { error: 'no_office_assigned_to_staff' });
        }
        effectiveOfficeId = actor.assignedOfficeIds[0];
      } else {
        // Admin: if no officeIdParam, fetch first active office or all
        const { data: firstOffice } = await admin
          .from('offices')
          .select('id')
          .eq('active', true)
          .order('name')
          .limit(1)
          .maybeSingle();
        effectiveOfficeId = firstOffice?.id;
      }
    }

    if (!effectiveOfficeId) {
      return jsonResponse(400, { error: 'office_id_required' });
    }

    // Retrieve office info
    const { data: officeInfo } = await admin
      .from('offices')
      .select('id, name, description')
      .eq('id', effectiveOfficeId)
      .maybeSingle();

    const rawQueue = url.searchParams.get('queue') || url.searchParams.get('status') || 'pending';
    const ALLOWED_QUEUES = ['pending', 'approved', 'awaiting_confirmation', 'confirmed', 'history', 'split'] as const;
    if (!ALLOWED_QUEUES.includes(rawQueue as any)) {
      return jsonResponse(400, {
        error: 'invalid_queue_filter',
        message: `Invalid queue filter '${rawQueue}'. Allowed values: ${ALLOWED_QUEUES.join(', ')}`,
      });
    }
    const statusFilter = rawQueue;
    const searchQuery = (url.searchParams.get('search') || '').trim();
    const dateFilter = url.searchParams.get('date') || '';
    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
    const rawOffset = parseInt(url.searchParams.get('offset') || '0', 10);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    const SELECT_FIELDS = `
        id,
        visit_type,
        registration_mode,
        returning_profile_id,
        office_id,
        personnel_id,
        requested_person_name,
        approval_status,
        rejection_reason,
        decided_at,
        decided_by,
        attendance_status,
        confirmed_at,
        confirmed_by,
        visitor_id,
        pass_id,
        visitor_display_name,
        visitor_first_name,
        visitor_middle_name,
        visitor_last_name,
        visitor_contact_number,
        visitor_email,
        visitor_email_verified,
        visitor_photo_path,
        photo_intent_id,
        purpose,
        visit_date,
        arrival_mode,
        vehicle_details,
        address_details,
        email_delivery_status,
        confirmation_source,
        email_dispatched_at,
        email_error,
        request_id,
        created_at,
        updated_at,
        passes (
          id,
          status,
          public_reference,
          entry_scanned_at,
          time_in,
          time_out,
          valid_from,
          valid_until
        ),
        office_personnel (
          id,
          name,
          title
        )
      `;

    let query = admin
      .from('office_visits')
      .select(SELECT_FIELDS, { count: 'exact' })
      .eq('office_id', effectiveOfficeId);

    // Apply queue section filter
    if (statusFilter === 'pending') {
      // Pending approval queue: strictly specific-person visits needing office review
      query = query
        .eq('visit_type', 'specific_person')
        .eq('approval_status', 'pending');
    } else if (statusFilter === 'approved') {
      // Approved specific-person visits awaiting campus entry
      query = query
        .eq('approval_status', 'approved')
        .eq('attendance_status', 'awaiting_entry');
    } else if (statusFilter === 'awaiting_confirmation') {
      // Inside campus, awaiting office confirmation
      query = query.eq('attendance_status', 'awaiting_office_confirmation');
    } else if (statusFilter === 'confirmed') {
      // Currently at office / confirmed
      query = query.eq('attendance_status', 'confirmed');
    } else if (statusFilter === 'history') {
      // Completed, rejected, exited_unconfirmed, cancelled, expired
      query = query.or('approval_status.eq.rejected,attendance_status.in.(completed,exited_unconfirmed,cancelled,expired)');
    } else if (statusFilter === 'split') {
      // Fetch both pending specific-person and awaiting_confirmation queues
      query = query.or('and(visit_type.eq.specific_person,approval_status.eq.pending),attendance_status.eq.awaiting_office_confirmation');
    }

    if (dateFilter && /^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
      query = query.eq('visit_date', dateFilter);
    }

    const sanitizedSearch = searchQuery.replace(/[^\w\s-]/g, ' ').trim();
    if (sanitizedSearch) {
      query = query.or(`visitor_first_name.ilike.%${sanitizedSearch}%,visitor_last_name.ilike.%${sanitizedSearch}%,purpose.ilike.%${sanitizedSearch}%`);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: rows, count, error } = await query;
    if (error) throw error;

    // Load authoritative email outbox states for the fetched visits
    const visitIds = (rows || []).map((r: any) => r.id);
    const outboxMap = new Map<string, any>();
    let outboxLookupFailed = false;
    if (visitIds.length > 0) {
      const { data: outboxRows, error: outboxErr } = await admin
        .from('office_visit_email_outbox')
        .select('office_visit_id, email_type, delivery_status, provider_message_id, lease_expires_at, retry_count, last_error, confirmation_source, reconciliation_source')
        .in('office_visit_id', visitIds);
      if (outboxErr) {
        console.error('Failed to load office_visit_email_outbox records:', outboxErr);
        outboxLookupFailed = true;
      } else {
        for (const ob of outboxRows || []) {
          outboxMap.set(`${ob.office_visit_id}:${ob.email_type}`, ob);
        }
      }
    }

    // Map rows and attach secure portrait preview tokens
    const visits = (rows || []).map((row: any) => {
      const pass = row.passes;
      const personnel = row.office_personnel;
      const fullName = row.visitor_display_name || [row.visitor_first_name, row.visitor_middle_name, row.visitor_last_name]
        .filter(Boolean)
        .join(' ');

      const portraitToken = (row.visitor_photo_path || row.registration_mode === 'returning' || row.visitor_id || row.photo_intent_id)
        ? createOfficePortraitToken(row.id, actor.id, 3600)
        : null;

      const targetEmailType = row.approval_status === 'rejected' ? 'rejection' : 'approval';
      const outbox = outboxMap.get(`${row.id}:${targetEmailType}`) || outboxMap.get(`${row.id}:approval`) || outboxMap.get(`${row.id}:rejection`);
      const effectiveEmailStatus = outboxLookupFailed
        ? 'unavailable'
        : (outbox?.delivery_status || row.email_delivery_status || null);
      const effectiveConfirmationSource = outboxLookupFailed
        ? null
        : (outbox?.confirmation_source || row.confirmation_source || null);

      return {
        id: row.id,
        visitType: row.visit_type,
        registrationMode: row.registration_mode || 'new',
        officeId: row.office_id,
        officeName: officeInfo?.name || '',
        personnelId: row.personnel_id,
        personnelName: row.requested_person_name || personnel?.name || null,
        requestedPersonName: row.requested_person_name || null,
        personnelTitle: personnel?.title || null,
        approvalStatus: row.approval_status,
        rejectionReason: row.rejection_reason,
        decidedAt: row.decided_at,
        decidedBy: row.decided_by,
        attendanceStatus: row.attendance_status,
        confirmedAt: row.confirmed_at,
        confirmedBy: row.confirmed_by,
        visitorId: row.visitor_id,
        passId: row.pass_id,
        visitorFirstName: row.visitor_first_name,
        visitorMiddleName: row.visitor_middle_name,
        visitorLastName: row.visitor_last_name,
        visitorFullName: fullName,
        visitorContactNumber: row.visitor_contact_number,
        visitorEmail: row.visitor_email,
        visitorEmailVerified: row.visitor_email_verified,
        visitorPhotoPath: row.visitor_photo_path,
        portraitPreviewToken: portraitToken,
        purpose: row.purpose,
        visitDate: row.visit_date,
        arrivalMode: row.arrival_mode,
        vehicleDetails: row.vehicle_details,
        addressDetails: row.address_details,
        gateEntryScannedAt: pass?.entry_scanned_at || null,
        timeIn: pass?.time_in || null,
        timeOut: pass?.time_out || null,
        passStatus: pass?.status || null,
        publicReference: pass?.public_reference || null,
        emailDeliveryStatus: effectiveEmailStatus,
        confirmationSource: effectiveConfirmationSource,
        emailDispatchedAt: row.email_dispatched_at,
        emailError: outbox?.last_error || row.email_error,
        outboxStatus: outboxLookupFailed ? 'unavailable' : (outbox?.delivery_status || null),
        providerMessageId: outbox?.provider_message_id || null,
        leaseExpiresAt: outbox?.lease_expires_at || null,
        retryCount: outbox?.retry_count || 0,
        requestId: row.request_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    const pendingVisits = visits.filter((v: any) => v.approvalStatus === 'pending' && v.visitType === 'specific_person');
    const confirmationVisits = visits.filter((v: any) => v.attendanceStatus === 'awaiting_office_confirmation');

    const queueCounts = {
      pending: pendingVisits.length,
      awaiting_confirmation: confirmationVisits.length,
    };

    return jsonResponse(200, {
      office: officeInfo,
      visits,
      pendingVisits,
      confirmationVisits,
      total: count || 0,
      counts: queueCounts,
      limit,
      offset,
      ...(outboxLookupFailed ? { warning: 'outbox_lookup_failed', emailStatusDegraded: true } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Failed to list office visits:', error);
    return jsonResponse(500, { error: 'failed_to_list_visits' });
  }
}

export default { fetch: handleRequest };
