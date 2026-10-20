import { HttpError, recordReconciliation, requireStaffActor } from '../server/actors.js';
import { jsonResponse, readBearerToken } from '../server/http.js';
import { getServerSupabaseClients } from '../server/supabase.js';

interface PurgeRequestBody {
  dryRun?: boolean;
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

    const { data: settingsData } = await admin
      .from('app_settings')
      .select('image_retention_days')
      .eq('singleton', true)
      .maybeSingle();

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

    // 2. Fetch active incident holds by pass_id (M4-F02: resolve pass.visitor_id)
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
      return jsonResponse(200, {
        visitorsAffected: distinctVisitors.size,
        retentionDays,
      });
    }

    const batch = eligibleItems.slice(0, BATCH_SIZE);
    let successCount = 0;
    let failedCount = 0;

    for (const item of batch) {
      // Re-check TOCTOU hold / active pass right before physical Storage removal
      const { data: currentHolds } = await admin
        .from('incident_holds')
        .select('id')
        .eq('active', true)
        .eq('visitor_id', item.visitor_id)
        .limit(1);

      if (currentHolds && currentHolds.length > 0) {
        continue;
      }

      const { data: currentActive } = await admin
        .from('passes')
        .select('id')
        .eq('visitor_id', item.visitor_id)
        .or(`status.in.(inside,pending),and(status.eq.issued,valid_until.gt.${new Date().toISOString()})`)
        .limit(1);

      if (currentActive && currentActive.length > 0) {
        continue;
      }

      let storageDeleted = false;
      try {
        const { error: storageError } = await admin.storage
          .from(item.bucket_id)
          .remove([item.object_path]);

        if (storageError) {
          throw storageError;
        }
        storageDeleted = true;
      } catch (err: unknown) {
        console.error(`Failed to delete storage asset ${item.bucket_id}/${item.object_path}:`, err);
        await recordReconciliation(
          admin,
          'image_purge_storage_failed',
          'visitor_evidence',
          item.id,
          err instanceof Error ? err.message : 'storage_removal_failed',
          {
            bucketId: item.bucket_id,
            objectPath: item.object_path,
          },
        );
      }

      if (storageDeleted) {
        const { error: updateError } = await admin
          .from('visitor_evidence')
          .update({ purged_at: new Date().toISOString() })
          .eq('id', item.id);

        if (updateError) {
          failedCount++;
          await recordReconciliation(
            admin,
            'image_purge_db_mark_failed',
            'visitor_evidence',
            item.id,
            updateError.message || 'db_update_purged_failed',
            {
              bucketId: item.bucket_id,
              objectPath: item.object_path,
            },
          );
        } else {
          successCount++;
        }
      } else {
        failedCount++;
      }
    }

    const hasMore = eligibleItems.length > batch.length;

    try {
      await admin.from('audit_events').insert({
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
    } catch (auditErr) {
      console.error('Audit event failed for image_purge batch', auditErr);
      await recordReconciliation(
        admin,
        'image_purge.audit_failed',
        'visitor_evidence',
        'batch',
        auditErr instanceof Error ? auditErr.message : 'audit_insert_failed',
        { successCount, failedCount, hasMore }
      );
    }

    return jsonResponse(200, {
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
