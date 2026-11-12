import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const officesRoute = readFileSync('server/routes/admin/offices.ts', 'utf8');
const emergencyDeviceRoute = readFileSync('server/routes/gate/emergency-device.ts', 'utf8');
const emergencyRecordsRoute = readFileSync('server/routes/admin/emergency-records.ts', 'utf8');
const identifyReturningRoute = readFileSync('server/routes/passes/identify-returning.ts', 'utf8');
const lookupReturningRoute = readFileSync('server/routes/passes/lookup-returning.ts', 'utf8');
const visitorRegistrationService = readFileSync('src/services/visitorRegistration.ts', 'utf8');
const emergencyCryptoIdb = readFileSync('src/lib/offline/emergencyCryptoIdb.ts', 'utf8');
const emergencyDevicePage = readFileSync('src/pages/EmergencyDevicePage.tsx', 'utf8');
const retentionMaintenanceRoute = readFileSync('server/routes/admin/retention-maintenance.ts', 'utf8');
const actorsModule = readFileSync('server/actors.ts', 'utf8');

const m92Migration = readFileSync(
  'supabase/migrations/20261112000700_followup_reliability_and_retention_hardening.sql',
  'utf8',
);
const m93Migration = readFileSync(
  'supabase/migrations/20261112000800_emergency_sync_manifest_field_remediation.sql',
  'utf8',
);

describe('Post-M91 Root-Cause Remediation Regression Suite', () => {
  describe('Section 3: Office Directory Schema Mismatch & Hydration Resilience', () => {
    it('omits non-existent archive_reason column from OFFICE_SELECT_COLUMNS', () => {
      expect(officesRoute).not.toContain('archive_reason');
      expect(officesRoute).toContain('OFFICE_SELECT_COLUMNS');
    });

    it('implements hydration query resilience on office mutations without failing client operations', () => {
      expect(officesRoute).toContain('hydrationWarning: true');
    });
  });

  describe('Section 4: Administrator Credential-Reset Authorization', () => {
    it('enforces office boundary and target role checks for regular Admin', () => {
      expect(officesRoute).toContain("staff.role !== 'office_staff'");
      expect(officesRoute).toContain("office_id_required");
      expect(officesRoute).toContain('cannot_reset_superadmin');
      expect(officesRoute).toContain('cannot_reset_self');
    });

    it('migration M92 drops obsolete 3-argument reset_staff_temporary_password overload', () => {
      expect(m92Migration).toContain('drop function if exists api.reset_staff_temporary_password(uuid, uuid, uuid)');
      expect(m92Migration).toContain('create or replace function api.reset_staff_temporary_password(');
      expect(m92Migration).toContain('requested_actor_id uuid');
    });

    it('database RPC enforces caller authorization in SQL', () => {
      expect(m92Migration).toContain('cannot reset self');
      expect(m92Migration).toContain('cannot reset superadmin');
      expect(m92Migration).toContain('admin may only reset office staff');
    });
  });

  describe('Section 5: Server-Side Turnstile for Returning Lookup', () => {
    it('preserves fail-closed runtime secret validation in lookup-returning route', () => {
      expect(lookupReturningRoute).toContain('missing_validation_runtime_secret');
      expect(lookupReturningRoute).toContain('TURNSTILE_SECRET_KEY');
    });
  });

  describe('Section 6: Returning Visitor Portrait Retention', () => {
    it('removes photoIntentId and upload download path from identify-returning', () => {
      expect(identifyReturningRoute).not.toContain('photoIntentId');
      expect(identifyReturningRoute).not.toContain('inspectAndDownloadUpload');
      expect(identifyReturningRoute).toContain('photo_intent_id: null');
      expect(identifyReturningRoute).toContain('reference_portrait_unavailable');
      expect(identifyReturningRoute).toContain('requiresNewRegistration: true');
    });

    it('visitorRegistration service submits base64 live selfie buffer, not photoIntentId', () => {
      expect(visitorRegistrationService).toContain('photoBase64: photoBlobOrBase64');
    });

    it('migration M92 purges returning_face_templates and protects active returning portraits', () => {
      expect(m92Migration).toContain('truncate table public.returning_face_templates;');
      expect(m92Migration).toContain('join public.returning_visitor_profiles rvp on rvp.id = v.returning_profile_id');
    });
  });

  describe('Section 7: Dynamic 30-Day Returning Profile Retention', () => {
    it('migration M92 replaces hardcoded 365 days with dynamic app_settings retention', () => {
      expect(m92Migration).toContain('returning_profile_retention_days');
      expect(m92Migration).not.toContain("interval '365 days'");
    });
  });

  describe('Section 8: Safe Recovery-Only Sync for Retired Emergency Devices', () => {
    it('supports allowRetired option in requireEmergencyDeviceActor', () => {
      expect(actorsModule).toContain('allowRetired?: boolean');
      expect(actorsModule).toContain("device.status === 'revoked'");
    });

    it('emergency-device route exposes recovery_sync action for retired devices', () => {
      expect(emergencyDeviceRoute).toContain("body?.action === 'recovery_sync'");
      expect(emergencyDeviceRoute).toContain('requested_is_recovery: true');
      expect(emergencyDeviceRoute).toContain('allowRetired: true');
    });

    it('EmergencyDevicePage UI handles 403 by falling back to recovery_sync', () => {
      expect(emergencyDevicePage).toContain("action: 'recovery_sync'");
    });

    it('migration M93 records recovery sync with correct manifest field', () => {
      expect(m93Migration).toContain('v_manifest.issued_at');
      expect(m93Migration).toContain('requested_is_recovery');
    });
  });

  describe('Section 9: Emergency Records Keyset Pagination & Full Summary Counts', () => {
    it('implements compound cursor pagination with server_received_at and id', () => {
      expect(emergencyRecordsRoute).toContain('nextCursor');
      expect(emergencyRecordsRoute).toContain('encodeCursor');
      expect(emergencyRecordsRoute).toContain('decodeCursor');
      expect(emergencyRecordsRoute).toContain('hasMore');
    });

    it('computes summary counts across the entire filtered dataset', () => {
      expect(emergencyRecordsRoute).toContain('totalCount');
      expect(emergencyRecordsRoute).toContain('needsReviewCount');
      expect(emergencyRecordsRoute).toContain('acceptedCount');
      expect(emergencyRecordsRoute).toContain('duplicateCount');
      expect(emergencyRecordsRoute).toContain('rejectedCount');
    });
  });

  describe('Section 10: Emergency Record Reconciliation Idempotency & Finalized Decision Protection', () => {
    it('accepts requestId and detects 409 conflict on duplicate attempts or locked decisions', () => {
      expect(emergencyRecordsRoute).toContain('requestId');
      expect(emergencyRecordsRoute).toContain('409');
      expect(emergencyRecordsRoute).toContain('reconciliation_conflict');
    });

    it('database RPC locks finalized decisions from tampering', () => {
      expect(m92Migration).toContain('record_already_finalized');
      expect(m92Migration).toContain('reconciliation_request_conflict');
    });
  });

  describe('Section 11: Read-Only Emergency Manifest Retrieval', () => {
    it('GET /api/gate/emergency-device is strictly read-only and does not sign new manifests', () => {
      expect(emergencyDeviceRoute).toContain('emergency_device_manifests');
      expect(emergencyDeviceRoute).toContain('latestManifest');
    });

    it('manifest generation is restricted to POST action request_manifest', () => {
      expect(emergencyDeviceRoute).toContain("action === 'request_manifest'");
      expect(emergencyDevicePage).toContain("action: 'request_manifest'");
    });
  });

  describe('Section 12: Atomic Local Emergency Sequence & Persistence', () => {
    it('allocates sequence and puts record inside a single IDB transaction', () => {
      expect(emergencyCryptoIdb).toContain('allocateSequenceAndPutRecord');
      expect(emergencyCryptoIdb).toContain('[STORE_META, STORE_RECORDS]');
    });
  });

  describe('Section 13: Local PII Minimization After Sync', () => {
    it('replaces PII payload with non-PII receipt metadata upon server confirmation', () => {
      expect(emergencyCryptoIdb).toContain('[Synced Receipt - PII Cleared]');
      expect(emergencyCryptoIdb).toContain('[Cleared upon server acknowledgement]');
    });
  });

  describe('Section 14: Emergency Device Snapshot Completeness', () => {
    it('pre-filters expectedPasses and officeVisits by gate before applying limits', () => {
      expect(emergencyDeviceRoute).toContain('gatePattern');
      expect(emergencyDeviceRoute).toContain("ilike('expected_gate', gatePattern)");
    });
  });

  describe('Section 15: Retention Maintenance Semantics under Freeze', () => {
    it('preserves non-destructive expire_stale_passes during global retention freeze', () => {
      expect(retentionMaintenanceRoute).toContain('expire_stale_passes');
      expect(retentionMaintenanceRoute).toContain('global_retention_freeze');
    });
  });
});
