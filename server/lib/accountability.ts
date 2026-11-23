import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolveVisitorAccountabilityParams {
  actorId: string;
  passId: string;
  action: 'record_verified_exit' | 'confirm_office_visit' | 'mark_reviewed' | 'record_exception';
  reason: string;
  eventTime?: string | null;
  exceptionType?: string | null;
  gate?: string | null;
  requestId: string;
}

export async function resolveVisitorAccountability(
  admin: SupabaseClient,
  params: ResolveVisitorAccountabilityParams,
) {
  return admin.schema('api').rpc('resolve_visitor_accountability', {
    requested_actor_id: params.actorId,
    requested_pass_id: params.passId,
    requested_action: params.action,
    requested_reason: params.reason,
    requested_event_time: params.eventTime ?? null,
    requested_exception_type: params.exceptionType ?? null,
    requested_gate: params.gate ?? null,
    requested_request_id: params.requestId,
  });
}

export interface GetAccountabilitySummaryParams {
  actorId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  closingHours?: string;
}

export async function getAccountabilitySummary(
  admin: SupabaseClient,
  params: GetAccountabilitySummaryParams,
) {
  return admin.schema('api').rpc('get_accountability_summary', {
    requested_actor_id: params.actorId,
    requested_date_from: params.dateFrom || null,
    requested_date_to: params.dateTo || null,
    requested_closing_hours: params.closingHours || '17:00',
  });
}
