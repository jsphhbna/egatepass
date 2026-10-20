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

    // 1. Fetch active incident holds
    const { data: activeHolds, error: holdsError } = await admin
      .from('incident_holds')
      .select('visitor_id')
      .eq('active', true)
      .not('visitor_id', 'is', null);

    if (holdsError) throw holdsError;
    const heldVisitorIds = new Set((activeHolds || []).map((h) => h.visitor_id as string));

    // 2. Fetch active/future passes that protect evidence
    const { data: activePasses, error: passesError } = await admin
      .from('passes')
      .select('visitor_id, status, valid_until')
      .or(`status.in.(inside,pending),and(status.eq.issued,valid_until.gt.${now})`);

    if (passesError) throw passesError;
    const activePassVisitorIds = new Set((activePasses || []).map((p) => p.visitor_id as string));

    // 3. Fetch expired unpurged evidence
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
        } else {
          successCount++;
        }
      } else {
        failedCount++;
      }
    }

    const hasMore = eligibleItems.length > batch.length;

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
