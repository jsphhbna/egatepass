/**
 * Guard Offline Synchronization Manager
 *
 * Implements safe, idempotent synchronization with the backend when
 * network connectivity is restored (Phases 10.1 - 10.6).
 *
 * Invariants:
 * - Never blindly overwrites backend state.
 * - Server-side row-locking and expected-state validation detect conflicts.
 * - Idempotent eventId and offlineRegistrationId ensure retrying never duplicates records.
 * - Clock skew detection detects anomalous timestamps.
 */

import { requireSupabase } from '@/lib/supabase';
import {
  getOfflineRegistrations,
  getOfflineEvents,
  updateOfflineRegistrationStatus,
  updateOfflineEventStatus,
  saveCachedVisitors,
  purgeStaleLocalData,
  setMeta,
  type CachedVisitorPass,
} from './guardIndexedDb';
import { getManilaDateString } from '@/lib/scheduling';

let isSyncRunning = false;

export interface SyncSummary {
  registrationsSynced: number;
  eventsSynced: number;
  conflicts: number;
  errors: number;
}

/**
 * Synchronizes all pending registrations and outbox events to the server.
 */
export async function syncAllPending(): Promise<SyncSummary> {
  if (isSyncRunning) {
    return { registrationsSynced: 0, eventsSynced: 0, conflicts: 0, errors: 0 };
  }
  isSyncRunning = true;

  const summary: SyncSummary = {
    registrationsSynced: 0,
    eventsSynced: 0,
    conflicts: 0,
    errors: 0,
  };

  try {
    const client = requireSupabase();

    // 1. Synchronize Pending Offline Registrations (Phase 10.2)
    const pendingRegs = await getOfflineRegistrations('pending');

    for (const reg of pendingRegs) {
      try {
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'syncing');

        // Step A: Upload photo evidence via upload intent
        const photoIntentRes = await client.rpc('create_upload_intent', {
          requested_source: 'guard_offline',
          requested_kind: 'photo',
          requested_content_type: 'image/webp',
        });

        if (photoIntentRes.error) {
          throw new Error(`Photo intent error: ${photoIntentRes.error.message}`);
        }
        const photoIntent = photoIntentRes.data[0];

        const photoUpload = await client.storage
          .from(photoIntent.bucket_id)
          .upload(photoIntent.object_path, reg.photoBlob, {
            contentType: 'image/webp',
            upsert: true,
          });

        if (photoUpload.error) {
          throw new Error(`Photo upload error: ${photoUpload.error.message}`);
        }

        // Step B: Upload ID evidence if captured
        let idIntentId: string | null = null;
        if (reg.idBlob) {
          const idIntentRes = await client.rpc('create_upload_intent', {
            requested_source: 'guard_offline',
            requested_kind: 'id',
            requested_content_type: 'image/webp',
          });

          if (idIntentRes.error) {
            throw new Error(`ID intent error: ${idIntentRes.error.message}`);
          }
          const idIntent = idIntentRes.data[0];

          const idUpload = await client.storage
            .from(idIntent.bucket_id)
            .upload(idIntent.object_path, reg.idBlob, {
              contentType: 'image/webp',
              upsert: true,
            });

          if (idUpload.error) {
            throw new Error(`ID upload error: ${idUpload.error.message}`);
          }
          idIntentId = idIntent.intent_id;
        }

        // Step C: Execute atomic ingest RPC on server
        const ingestRes = await client.rpc('guard_sync_offline_registration', {
          requested_registration_id: reg.offlineRegistrationId,
          requested_visitor: reg.visitor,
          requested_action: reg.action,
          requested_occurred_at: reg.occurredAt,
          requested_photo_intent_id: photoIntent.intent_id,
          requested_id_intent_id: idIntentId,
          requested_rejection_reason: reg.rejectionReason,
        });

        if (ingestRes.error) {
          throw ingestRes.error;
        }

        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'synced', {
          syncedAt: new Date().toISOString(),
          canonicalPassId: ingestRes.data.passId,
        });
        summary.registrationsSynced++;
      } catch (regErr: any) {
        console.error('Offline registration sync failed:', regErr);
        summary.errors++;
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
          conflictReason: regErr.message || 'Sync failed',
        });
      }
    }

    // 2. Synchronize Pending Offline Lifecycle Events (Phase 10.1)
    const pendingEvents = await getOfflineEvents('pending');

    for (const evt of pendingEvents) {
      try {
        await updateOfflineEventStatus(evt.eventId, 'syncing');

        const eventRes = await client.rpc('guard_sync_offline_event', {
          requested_event_id: evt.eventId,
          requested_pass_id: evt.passId,
          requested_action: evt.action,
          requested_expected_status: evt.expectedStatus,
          requested_occurred_at: evt.occurredAt,
          requested_reason: evt.reason ?? null,
        });

        if (eventRes.error) {
          throw eventRes.error;
        }

        const resData = eventRes.data;
        if (resData.status === 'conflict') {
          summary.conflicts++;
          await updateOfflineEventStatus(evt.eventId, 'conflict', {
            conflictReason: resData.reason || 'Server status conflict',
            syncedAt: new Date().toISOString(),
          });
        } else {
          summary.eventsSynced++;
          await updateOfflineEventStatus(evt.eventId, 'synced', {
            syncedAt: new Date().toISOString(),
          });
        }
      } catch (evtErr: any) {
        console.error('Offline event sync error:', evtErr);
        summary.errors++;
        await updateOfflineEventStatus(evt.eventId, 'pending', {
          conflictReason: evtErr.message || 'Event sync failed',
        });
      }
    }

    // Record last successful sync timestamp
    await setMeta('last_successful_sync_at', new Date().toISOString());

    // Enforce local data purge
    const today = getManilaDateString();
    await purgeStaleLocalData(today);
  } finally {
    isSyncRunning = false;
  }

  return summary;
}

/**
 * Downloads and caches today's operationally relevant passes into IndexedDB.
 */
export async function refreshOperationalCache(): Promise<number> {
  try {
    const client = requireSupabase();
    // Broad search for today's active passes
    const { data, error } = await client.rpc('guard_search_recovery_visitors', {
      query: 'a', // match common vowels/names
      requested_limit: 50,
    });

    if (error) throw error;

    if (Array.isArray(data)) {
      const passesToCache: CachedVisitorPass[] = data.map((item: any) => ({
        id: item.id,
        visitorId: item.visitorId,
        visitorName: item.visitorName,
        contactNumber: item.contactNumber,
        purpose: item.purpose,
        visitDate: item.visitDate || getManilaDateString(),
        status: item.status,
        passReference: item.passReference || item.id,
        validFrom: item.validFrom,
        validUntil: item.validUntil,
        timeIn: item.timeIn,
        scannedAt: item.scannedAt,
        gate: item.gate,
        photoEvidenceId: item.photoEvidenceId,
        idEvidenceId: item.idEvidenceId,
        cachedAt: new Date().toISOString(),
      }));

      await saveCachedVisitors(passesToCache);
      await setMeta('last_cache_refresh_at', new Date().toISOString());
      return passesToCache.length;
    }
  } catch (err) {
    console.warn('Could not refresh operational cache from server:', err);
  }
  return 0;
}
