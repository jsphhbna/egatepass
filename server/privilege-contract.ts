export type PrivilegeType = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface ServerTablePrivilegeContract {
  table: string;
  allowedPrivileges: PrivilegeType[];
  forbiddenPrivileges: PrivilegeType[];
  justification: string;
}

export interface DirectServerTableOperation {
  file: string;
  table: string;
  operations: (PrivilegeType | 'UPSERT')[];
  purpose: string;
}

/**
 * Authoritative matrix of all 14 public tables and their least-privilege
 * database grants for the service_role role.
 */
export const SERVICE_ROLE_TABLE_CONTRACT: Record<string, ServerTablePrivilegeContract> = {
  app_settings: {
    table: 'app_settings',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server reads singleton app settings in retention-maintenance, settings, and purge-images. Mutations are restricted to api.update_app_settings RPC.',
  },
  audit_events: {
    table: 'audit_events',
    allowedPrivileges: ['SELECT', 'INSERT', 'DELETE'],
    forbiddenPrivileges: ['UPDATE'],
    justification: 'Server inserts audit records across admin/gate/auth endpoints, reads for activity feeds, and deletes aged records during retention. UPDATE is forbidden to preserve audit immutability.',
  },
  devices: {
    table: 'devices',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server verifies device metadata and lists devices for admin. Mutations are restricted to api.create_device_profile, api.update_device_profile, and api.retire_device RPCs.',
  },
  incident_holds: {
    table: 'incident_holds',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server queries active holds during evidence retrieval and image purge. Creation and release are restricted to api.create_incident_hold and api.release_incident_hold RPCs.',
  },
  maintenance_state: {
    table: 'maintenance_state',
    allowedPrivileges: ['SELECT', 'INSERT', 'UPDATE'],
    forbiddenPrivileges: ['DELETE'],
    justification: 'Server queries and upserts job cursors (e.g. image purge) during maintenance. DELETE is forbidden.',
  },
  pass_email_verifications: {
    table: 'pass_email_verifications',
    allowedPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    forbiddenPrivileges: [],
    justification: 'Server handles email verification lifecycles and retention cleanup of expired codes older than 24h.',
  },
  passes: {
    table: 'passes',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server queries passes for idempotent replay (issue.ts), email dispatch, evidence check, and admin views. Pass creation and status changes are strictly RPC-only.',
  },
  rate_limit_buckets: {
    table: 'rate_limit_buckets',
    allowedPrivileges: [],
    forbiddenPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server does not directly query rate limits; managed strictly within database functions and triggers.',
  },
  reconciliation_tasks: {
    table: 'reconciliation_tasks',
    allowedPrivileges: ['SELECT', 'INSERT', 'DELETE'],
    forbiddenPrivileges: ['UPDATE'],
    justification: 'Server records unhandled failure tasks, lists items for superadmin, and purges resolved items during retention. Direct UPDATE is forbidden.',
  },
  staff_profiles: {
    table: 'staff_profiles',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server verifies staff actor identity in requireStaffActor and lists users in admin. Profile creation and updates are restricted to api.create_staff_profile and api.update_staff_profile RPCs.',
  },
  upload_intents: {
    table: 'upload_intents',
    allowedPrivileges: ['SELECT', 'UPDATE'],
    forbiddenPrivileges: ['INSERT', 'DELETE'],
    justification: 'Server validates upload intents during pass issuance and expires abandoned intents during retention. Creation is restricted to api.create_upload_intent RPC.',
  },
  visit_events: {
    table: 'visit_events',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server reads activity logs for admin. Event creation is restricted to api.scan_pass and api.decide_visit RPCs.',
  },
  visitor_evidence: {
    table: 'visitor_evidence',
    allowedPrivileges: ['SELECT'],
    forbiddenPrivileges: ['INSERT', 'UPDATE', 'DELETE'],
    justification: 'Server reads evidence metadata for gate viewing and purge candidate selection. Creation and purge finalization are restricted to RPCs.',
  },
  visitors: {
    table: 'visitors',
    allowedPrivileges: ['SELECT', 'UPDATE'],
    forbiddenPrivileges: ['INSERT', 'DELETE'],
    justification: 'Server reads visitor info during idempotent replay and anonymizes visitor personal data during retention. Creation is restricted to api.issue_pass RPC.',
  },
};

/**
 * Audit registry of all known server files performing direct table operations.
 * Used by architecture contract tests to ensure no direct table access is added
 * without explicit registration and grant coverage.
 */
export const SERVER_DIRECT_TABLE_OPERATIONS: DirectServerTableOperation[] = [
  { file: 'server/actors.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'Verify staff identity and role' },
  { file: 'server/actors.ts', table: 'reconciliation_tasks', operations: ['INSERT'], purpose: 'Record unhandled failure task' },
  { file: 'server/routes/admin/activity.ts', table: 'visit_events', operations: ['SELECT'], purpose: 'List visitor visit events' },
  { file: 'server/routes/admin/activity.ts', table: 'audit_events', operations: ['SELECT'], purpose: 'List staff audit events' },
  { file: 'server/routes/admin/dashboard.ts', table: 'passes', operations: ['SELECT'], purpose: 'Dashboard statistics and active pass counts' },
  { file: 'server/routes/admin/devices.ts', table: 'devices', operations: ['SELECT'], purpose: 'List active devices' },
  { file: 'server/routes/admin/emergency.ts', table: 'passes', operations: ['SELECT'], purpose: 'Emergency evacuation pass roster' },
  { file: 'server/routes/admin/holds.ts', table: 'incident_holds', operations: ['SELECT'], purpose: 'List incident holds' },
  { file: 'server/routes/admin/holds.ts', table: 'passes', operations: ['SELECT'], purpose: 'Lookup visitor_id for hold target' },
  { file: 'server/routes/admin/records.ts', table: 'passes', operations: ['SELECT'], purpose: 'Search and paginate pass history' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'app_settings', operations: ['SELECT'], purpose: 'Read retention periods' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'audit_events', operations: ['SELECT', 'INSERT', 'DELETE'], purpose: 'Audit retention queries, purge execution, and logging' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'maintenance_state', operations: ['SELECT', 'UPSERT'], purpose: 'Track evidence purge job cursor' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'visitor_evidence', operations: ['SELECT'], purpose: 'Scan candidate evidence for expiration' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'upload_intents', operations: ['SELECT', 'UPDATE'], purpose: 'Scan and expire abandoned upload intents' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'visitors', operations: ['SELECT', 'UPDATE'], purpose: 'Scan and anonymize stale visitor records' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'incident_holds', operations: ['SELECT'], purpose: 'Check active holds blocking visitor anonymization' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'passes', operations: ['SELECT'], purpose: 'Check active passes blocking visitor anonymization' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'reconciliation_tasks', operations: ['SELECT', 'DELETE'], purpose: 'Scan and purge resolved reconciliation tasks' },
  { file: 'server/routes/admin/retention-maintenance.ts', table: 'pass_email_verifications', operations: ['DELETE'], purpose: 'Purge expired pass email verification codes' },
  { file: 'server/routes/admin/settings.ts', table: 'app_settings', operations: ['SELECT'], purpose: 'Read current settings' },
  { file: 'server/routes/admin/users.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'List staff users' },
  { file: 'server/routes/auth/complete-password-change.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'Verify staff role before completing password change' },
  { file: 'server/routes/auth/reset-password.ts', table: 'devices', operations: ['SELECT'], purpose: 'Lookup device for reset target' },
  { file: 'server/routes/auth/reset-password.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'Lookup staff profile for reset target' },
  { file: 'server/routes/auth/reset-password.ts', table: 'audit_events', operations: ['INSERT'], purpose: 'Log password reset audit event' },
  { file: 'server/routes/device/update-device-auth.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'Verify admin actor authorization' },
  { file: 'server/routes/device/update-device-auth.ts', table: 'devices', operations: ['SELECT'], purpose: 'Lookup target device and check alias uniqueness' },
  { file: 'server/routes/device/update-device-auth.ts', table: 'audit_events', operations: ['INSERT'], purpose: 'Log device credential rotation event' },
  { file: 'server/routes/gate/evidence.ts', table: 'visitor_evidence', operations: ['SELECT'], purpose: 'Fetch evidence metadata' },
  { file: 'server/routes/gate/evidence.ts', table: 'incident_holds', operations: ['SELECT'], purpose: 'Check active holds on evidence target' },
  { file: 'server/routes/gate/evidence.ts', table: 'passes', operations: ['SELECT'], purpose: 'Check pending pass for guard view authorization' },
  { file: 'server/routes/gate/evidence.ts', table: 'audit_events', operations: ['INSERT'], purpose: 'Log evidence access audit event' },
  { file: 'server/routes/passes/email.ts', table: 'passes', operations: ['SELECT'], purpose: 'Lookup pass for email dispatch' },
  { file: 'server/routes/passes/email.ts', table: 'devices', operations: ['SELECT'], purpose: 'Verify issuing device status' },
  { file: 'server/routes/passes/issue.ts', table: 'upload_intents', operations: ['SELECT'], purpose: 'Validate photo/ID upload intents belong to session' },
  { file: 'server/routes/passes/issue.ts', table: 'passes', operations: ['SELECT'], purpose: 'Idempotent replay query by issue_request_id' },
  { file: 'server/routes/passes/issue.ts', table: 'visitors', operations: ['SELECT'], purpose: 'Lookup existing visitor on replay' },
  { file: 'server/routes/system/purge-images.ts', table: 'app_settings', operations: ['SELECT'], purpose: 'Read image retention days' },
  { file: 'server/routes/system/purge-images.ts', table: 'incident_holds', operations: ['SELECT'], purpose: 'Filter out evidence under active holds' },
  { file: 'server/routes/system/purge-images.ts', table: 'passes', operations: ['SELECT'], purpose: 'Filter out evidence with active/pending passes' },
  { file: 'server/routes/system/purge-images.ts', table: 'visitor_evidence', operations: ['SELECT'], purpose: 'Query candidate evidence for purge' },
  { file: 'server/routes/system/purge-images.ts', table: 'audit_events', operations: ['INSERT'], purpose: 'Log image purge summary audit event' },
  { file: 'server/routes/system/reconciliation-items.ts', table: 'reconciliation_tasks', operations: ['SELECT'], purpose: 'Query pending reconciliation tasks for superadmin' },
  { file: 'server/routes/system/create-user.ts', table: 'staff_profiles', operations: ['SELECT'], purpose: 'Check if existing Auth user already has a staff profile' },
  { file: 'server/routes/system/create-user.ts', table: 'devices', operations: ['SELECT'], purpose: 'Check if existing Auth user is a registered device' },
];
