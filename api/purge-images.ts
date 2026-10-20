import { HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

interface PurgeRequestBody {
  dryRun?: boolean;
}

interface ClaimResult {
  claimed: boolean;
  evidence_id?: string;
  visitor_id?: string;
  bucket_id?: string;
  object_path?: string;
  claim_id?: string;
  claimed_at?: string;
  reason?: string;
}

interface FinalizeResult {
  success: boolean;
  finalized: boolean;
  match_status: 'matched' | 'terminal_conflict' | 'claim_mismatch' | 'not_claimed' | 'expired_claim' | 'not_found' | 'claim_released' | 'invalid_argument';
  purged?: boolean;
  purged_at?: string;
  claim_released?: boolean;
  reason?: string;
}

const BATCH_SIZE = 50;

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  const token = readBearerToken(request);
  if (!token) return jsonResponse(401, { error: 'authentication_required' });

  let body: PurgeRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    return jsonResponse(400, { error: 'invalid_json_body' });
  }

  try {
    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['superadmin']);

    const { data: settingsData, error: settingsError } = await admin
      .from('app_settings')
      .select('image_retention_days')
      .eq('singleton', true)
      .maybeSingle();

    if (settingsError) throw settingsError;

    const retentionDays = settingsData?.image_retention_days ?? 7;
    const now = new Date().toISOString();

    // 1. Fetch active incident holds by visitor_id
    const { data: activeVisitorHolds, error: visitorHoldsError } = await admin
      .from('incident_holds')
      .select('visitor_id')
      .eq('active', true)
      .not('visitor_id', 'is', null);

    if (visitorHoldsError) throw visitorHoldsError;
    const heldVisitorIds = new Set((activeVisitorHolds || []).map((h) => h.visitor_id as string));

    // 2. Fetch active incident holds by pass_id (resolve pass.visitor_id)
    const { data: activePassHolds, error: passHoldsError } = await admin
      .from('incident_holds')
      .select('pass_id, passes ( visitor_id )')
      .eq('active', true)
      .not('pass_id', 'is', null);

    if (passHoldsError) throw passHoldsError;
    for (const h of activePassHolds || []) {
      const passVisitorId = (h as any).passes?.visitor_id;
      if (passVisitorId) {
        heldVisitorIds.add(passVisitorId);
      }
    }

    // 3. Fetch active or future passes that protect evidence
    const { data: activePasses, error: passesError } = await admin
      .from('passes')
      .select('visitor_id, status, valid_until')
      .or(`status.in.(inside,pending),and(status.eq.issued,valid_until.gt.${now})`);

    if (passesError) throw passesError;
    const activePassVisitorIds = new Set((activePasses || []).map((p) => p.visitor_id as string));

    // 4. Fetch expired unpurged evidence
    const { data: evidenceRows, error: evidenceError } = await admin
      .from('visitor_evidence')
      .select('id, visitor_id, bucket_id, object_path')
      .is('purged_at', null)
      .lte('expires_at', now)
      .order('expires_at', { ascending: true })
      .limit(200);

    if (evidenceError) throw evidenceError;

    const eligibleItems = (evidenceRows || []).filter(
      (item) => !heldVisitorIds.has(item.visitor_id) && !activePassVisitorIds.has(item.visitor_id)
    );

    if (body.dryRun) {
      const distinctVisitors = new Set(eligibleItems.map((item) => item.visitor_id));
      const capped = (evidenceRows || []).length >= 200;
      return jsonResponse(200, {
        visitorsAffected: distinctVisitors.size,
        retentionDays,
        hasMore: capped,
      });
    }

    const batch = eligibleItems.slice(0, BATCH_SIZE);
    let successCount = 0;
    let failedCount = 0;

    for (const item of batch) {
      const claimId = crypto.randomUUID();
      const { data: claimData, error: claimError } = (await admin
        .schema('api')
        .rpc('claim_evidence_for_purge', {
          requested_evidence_id: item.id,
          requested_claim_id: claimId,
        })) as { data: ClaimResult | null; error: any };

      if (claimError) {
        failedCount++;
        await recordReconciliation(
          admin,
          'image_purge_claim_rpc_failed',
          'visitor_evidence',
          item.id,
          claimError.message || 'claim_rpc_error',
          { visitorId: item.visitor_id }
        );
        continue;
      }

      if (!claimData || claimData.claimed !== true) {
        // Evidence is either held by an incident hold, belongs to an active pass, or already purged/claimed
        continue;
      }

      // Claim identity validation: ensure object deletion only follows the verified bucket and path returned by claim
      const targetBucket = claimData.bucket_id;
      const targetPath = claimData.object_path;
      if (!targetBucket || !targetPath || targetBucket !== item.bucket_id || targetPath !== item.object_path) {
        failedCount++;
        await recordReconciliation(
          admin,
          'image_purge_claim_identity_mismatch',
          'visitor_evidence',
          item.id,
          'claim_identity_mismatch',
          {
            expectedBucket: item.bucket_id,
            expectedPath: item.object_path,
            claimedBucket: targetBucket,
            claimedPath: targetPath,
          }
        );
        // Safely release the mismatched claim
        await admin.schema('api').rpc('finalize_evidence_purge', {
          requested_evidence_id: item.id,
          requested_claim_id: claimId,
          requested_success: false,
        });
        continue;
      }

      let storageDeleted = false;
      try {
        const { error: storageError } = await admin.storage
          .from(targetBucket)
          .remove([targetPath]);

        if (storageError) {
          throw storageError;
        }
        storageDeleted = true;
      } catch (err: unknown) {
        console.error(`Failed to delete storage asset ${targetBucket}/${targetPath}:`, err);
        await recordReconciliation(
          admin,
          'image_purge_storage_failed',
          'visitor_evidence',
          item.id,
          err instanceof Error ? err.message : 'storage_removal_failed',
          {
            bucketId: targetBucket,
            objectPath: targetPath,
          },
        );
      }

      const { data: finalizeData, error: finalizeError } = (await admin
        .schema('api')
        .rpc('finalize_evidence_purge', {
          requested_evidence_id: item.id,
          requested_claim_id: claimId,
          requested_success: storageDeleted,
        })) as { data: FinalizeResult | null; error: any };

      if (finalizeError || !finalizeData || finalizeData.finalized !== true || (storageDeleted && finalizeData.match_status !== 'matched')) {
        failedCount++;
        await recordReconciliation(
          admin,
          'image_purge_finalize_rpc_failed',
          'visitor_evidence',
          item.id,
          finalizeError?.message || finalizeData?.reason || 'finalize_purge_error',
          {
            claimId,
            bucketId: targetBucket,
            objectPath: targetPath,
            storageDeleted,
            finalizeData,
          },
        );
      } else if (storageDeleted && finalizeData.purged === true) {
        successCount++;
      } else {
        failedCount++;
      }
    }

    const hasMore = eligibleItems.length > batch.length;

    let auditPending = false;
    let reconciliationRecorded = false;

    const { error: auditError } = await admin.from('audit_events').insert({
      actor_id: actor.id,
      actor_kind: 'staff',
      actor_role: actor.role,
      action: 'image_purge',
      target_type: 'visitor_evidence',
      target_id: 'batch',
      outcome: failedCount > 0 ? 'partial' : 'success',
      after_state: {
        successCount,
        failedCount,
        hasMore,
        retentionDays,
      },
    });

    if (auditError) {
      auditPending = true;
      console.error('Audit event failed for image_purge batch', auditError);
      reconciliationRecorded = await recordReconciliation(
        admin,
        'image_purge.audit_failed',
        'visitor_evidence',
        'batch',
        auditError.message || 'audit_insert_failed',
        { successCount, failedCount, hasMore }
      );
    }

    const opResult = auditPending ? 'partial' : (failedCount > 0 ? 'partial' : 'success');

    return jsonResponse(200, {
      result: opResult,
      auditPending,
      reconciliationRecorded,
      successCount,
      failedCount,
      orphanDeletedCount: 0,
      orphanFailedCount: 0,
      hasMore,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    console.error('Failed to purge images', error);
    return jsonResponse(500, { error: 'failed_to_purge_images' });
  }
}

export default handleRequest;
export { handleRequest as POST };
