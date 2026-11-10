import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

interface PurgeRequestBody {
  dryRun?: boolean;
  cursor?: string;
  override?: {
    reason: string;
    categories: Array<'photo' | 'id' | 'vehicle_photo' | 'visitor' | 'returning_profile'>;
  };
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
      .select('image_retention_days, photo_retention_days, id_retention_days, photo_retention_enabled, id_retention_enabled, vehicle_photo_retention_enabled, vehicle_photo_retention_days')
      .eq('singleton', true)
      .maybeSingle();

    if (settingsError) throw settingsError;

    const retentionDays = settingsData?.image_retention_days ?? 7;
    const photoRetentionDays = settingsData?.photo_retention_days ?? settingsData?.image_retention_days ?? 7;
    const idRetentionDays = settingsData?.id_retention_days ?? 30;
    const vehiclePhotoRetentionDays = (settingsData as any)?.vehicle_photo_retention_days ?? settingsData?.image_retention_days ?? 7;
    const now = new Date().toISOString();

    let overrideCategories: Set<string> | null = null;
    if (body.override) {
      if (typeof body.override.reason !== 'string' || body.override.reason.trim().length < 10) {
        return jsonResponse(400, { error: 'invalid_override_reason', message: 'A non-empty audit reason (min 10 chars) is required for Superadmin override' });
      }
      if (!Array.isArray(body.override.categories) || body.override.categories.length === 0) {
        return jsonResponse(400, { error: 'invalid_override_categories', message: 'At least one target category is required for override' });
      }
      overrideCategories = new Set(body.override.categories);
    }

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

    // 3b. Fetch visitors currently on campus (pass status = 'inside')
    const { data: insidePasses, error: insideError } = await admin
      .from('passes')
      .select('visitor_id')
      .eq('status', 'inside');

    if (insideError) throw insideError;
    const insideVisitorIds = new Set((insidePasses || []).map((p) => p.visitor_id as string));

    // 4. Fetch expired unpurged evidence with starvation-free cursor progression
    let lastSeenId: string | null = body.cursor || null;
    let eligibleItems: { id: string; visitor_id: string; bucket_id: string; object_path: string }[] = [];
    let scannedCount = 0;
    const MAX_SCAN = 1000;
    let exhausted = false;

    while (eligibleItems.length < (body.dryRun ? 200 : BATCH_SIZE) && scannedCount < MAX_SCAN) {
      let q = admin
        .from('visitor_evidence')
        .select('id, visitor_id, bucket_id, object_path, expires_at, kind, created_at, verified_at')
        .is('purged_at', null)
        .lte('expires_at', now)
        .order('expires_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(200);

      if (lastSeenId) {
        q = q.gt('id', lastSeenId);
      }

      const { data: pageRows, error: pageErr } = await q;
      if (pageErr) throw pageErr;
      if (!pageRows || pageRows.length === 0) {
        exhausted = true;
        break;
      }

      const lastItem = pageRows[pageRows.length - 1];
      if (!lastItem) break;
      lastSeenId = lastItem.id;
      scannedCount += pageRows.length;

      const photoEnabled = (settingsData as any)?.photo_retention_enabled ?? true;
      const idEnabled = (settingsData as any)?.id_retention_enabled ?? true;
      const vehicleEnabled = (settingsData as any)?.vehicle_photo_retention_enabled ?? true;
      const nowMs = Date.now();

      for (const item of pageRows) {
        const kind = (item as any).kind;
        const isOverridden = overrideCategories ? overrideCategories.has(kind) : false;

        if (!isOverridden) {
          if (kind === 'photo' && !photoEnabled) continue;
          if (kind === 'id' && !idEnabled) continue;
          if (kind === 'vehicle_photo' && !vehicleEnabled) continue;

          let days = 7;
          if (kind === 'photo') days = photoRetentionDays;
          else if (kind === 'id') days = idRetentionDays;
          else if (kind === 'vehicle_photo') days = vehiclePhotoRetentionDays;
          else days = retentionDays;

          if (item.created_at) {
            if (new Date(item.created_at).getTime() > nowMs - days * 86_400_000) continue;
          }
          if (new Date(item.expires_at).getTime() > nowMs) continue;
        }

        // Safeguards: NEVER purge evidence if visitor is inside, on an active pass, or under incident hold
        if (!heldVisitorIds.has(item.visitor_id) && !activePassVisitorIds.has(item.visitor_id) && !insideVisitorIds.has(item.visitor_id)) {
          eligibleItems.push(item);
          if (eligibleItems.length >= (body.dryRun ? 200 : BATCH_SIZE)) break;
        }
      }

      if (pageRows.length < 200) {
        exhausted = true;
        break;
      }
    }

    if (body.dryRun) {
      const distinctVisitors = new Set(eligibleItems.map((item) => item.visitor_id));
      return jsonResponse(200, {
        dryRun: true,
        evidenceDeleted: 0,
        eligibleEvidenceCount: eligibleItems.length,
        visitorsAffected: distinctVisitors.size,
        retentionDays,
        photoRetentionDays,
        idRetentionDays,
        vehiclePhotoRetentionDays,
        overrideApplied: Boolean(body.override),
        hasMore: !exhausted,
      });
    }

    const batch = eligibleItems.slice(0, BATCH_SIZE);
    let successCount = 0;
    let failedCount = 0;
    const affectedVisitorIds = new Set<string>();

    for (const item of batch) {
      const claimId = crypto.randomUUID();
      const { data: claimData, error: claimError } = (await admin
        .schema('api')
        .rpc('claim_evidence_for_purge', {
          requested_evidence_id: item.id,
          requested_claim_id: claimId,
          requested_override: Boolean(body.override),
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
        affectedVisitorIds.add(item.visitor_id);
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
      action: body.override ? 'retention.superadmin_override_purge' : 'image_purge', // action: 'image_purge'
      target_type: 'visitor_evidence',
      target_id: 'batch',
      outcome: failedCount > 0 ? 'partial' : 'success',
      after_state: {
        successCount,
        failedCount,
        hasMore,
        retentionDays,
        override: body.override ? { reason: body.override.reason, categories: body.override.categories } : null,
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
      evidenceDeleted: successCount,
      visitorsAffected: affectedVisitorIds.size,
      failedEvidence: failedCount,
      successCount,
      failedCount,
      orphanDeletedCount: 0,
      orphanFailedCount: 0,
      hasMore: !exhausted || eligibleItems.length > batch.length,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    console.error('Failed to purge images', error);
    return jsonResponse(500, { error: 'failed_to_purge_images' });
  }
}

export { handleRequest };
export default handleRequest;
export { handleRequest as POST };
