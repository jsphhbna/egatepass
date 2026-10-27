/**
 * Guard Offline Synchronization Manager
 *
 * Implements safe, serialized, idempotent synchronization with the backend when
 * network connectivity is restored.
 *
 * Invariants (Root Causes 1, 2, 3, 14):
 * - Single serialized coordinator/mutex prevents overlapping sync and cache refresh.
 * - All application RPCs explicitly target the 'api' schema.
 * - Registrations and events are synchronized in strict chronological order.
 * - Dependent lifecycle events for conflicted passes are blocked.
 * - Unsynchronized local visitors are strictly preserved across server cache snapshots.
 * - Terminal evidence blobs (synced or conflict) are stripped locally.
 */

import { requireSupabase } from '@/lib/supabase';
import {
  getOfflineRegistrations,
  getOfflineEvents,
  updateOfflineRegistrationStatus,
  updateOfflineEventStatus,
  resolvePendingEventsPassId,
  remapCachedVisitorPassId,
  atomicReplaceCachedVisitors,
  purgeStaleLocalData,
  stripTerminalOfflineEvidence,
  setMeta,
  type CachedVisitorPass,
} from './guardIndexedDb';
import { getManilaDateString } from '@/lib/scheduling';

export interface SyncSummary {
  registrationsSynced: number;
  eventsSynced: number;
  conflicts: number;
  errors: number;
}

// =============================================================================
// SERIALIZED COORDINATOR MUTEX (ROOT CAUSE 3)
// =============================================================================
let isCoordinatorBusy = false;
const coordinatorQueue: Array<() => void> = [];

export function isCoordinatorLocked(): boolean {
  return isCoordinatorBusy;
}

export async function acquireCoordinatorLock(): Promise<() => void> {
  while (isCoordinatorBusy) {
    await new Promise<void>((resolve) => coordinatorQueue.push(resolve));
  }
  isCoordinatorBusy = true;
  return () => {
    isCoordinatorBusy = false;
    const next = coordinatorQueue.shift();
    if (next) next();
  };
}

async function fetchEvidenceBlob(evidenceId: string, token: string): Promise<Blob | null> {
  const res = await fetch(`/api/evidence?id=${encodeURIComponent(evidenceId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404 || res.status === 410) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to download evidence ${evidenceId}: HTTP ${res.status}`);
  }
  return res.blob();
}

/**
 * Synchronizes all pending registrations and outbox events to the server in strict serialized order.
 */
export async function syncAllPending(): Promise<SyncSummary> {
  const releaseLock = await acquireCoordinatorLock();

  const summary: SyncSummary = {
    registrationsSynced: 0,
    eventsSynced: 0,
    conflicts: 0,
    errors: 0,
  };

  try {
    const client = requireSupabase();
    const sessionRes = await client.auth.getSession();
    const token = sessionRes.data.session?.access_token;

    // 1. Synchronize Pending Offline Registrations FIRST in chronological order (Root Cause 2.4 & 3)
    const pendingRegs = await getOfflineRegistrations('pending');
    pendingRegs.sort((a, b) => {
      const tDiff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      if (tDiff !== 0) return tDiff;
      return a.offlineRegistrationId.localeCompare(b.offlineRegistrationId);
    });

    for (const reg of pendingRegs) {
      try {
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'syncing');

        if (!reg.photoBlob) {
          throw new Error('Photo blob missing for offline registration sync');
        }

        // Step A: Upload photo evidence via upload intent (using API schema)
        const photoIntentRes = await client.schema('api').rpc('create_upload_intent', {
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

        // Step B: Upload ID evidence if captured (using API schema)
        let idIntentId: string | null = null;
        if (reg.idBlob) {
          const idIntentRes = await client.schema('api').rpc('create_upload_intent', {
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

        // Step C: Execute authenticated server sync route (or client API schema fallback)
        let syncData: any;
        if (token) {
          const res = await fetch('/api/sync-offline-registration', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              offlineRegistrationId: reg.offlineRegistrationId,
              visitor: reg.visitor,
              action: reg.action,
              occurredAt: reg.occurredAt,
              photoIntentId: photoIntent.intent_id,
              idIntentId: idIntentId,
              rejectionReason: reg.rejectionReason,
            }),
          });
          syncData = await res.json().catch(() => null);
          if (!res.ok) {
            if (res.status === 409) {
              summary.conflicts++;
              await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'conflict', {
                conflictReason: syncData?.reason || 'Server fingerprint conflict',
                syncedAt: new Date().toISOString(),
              });
              await stripTerminalOfflineEvidence();
              continue;
            }
            throw new Error(syncData?.error || `HTTP ${res.status}`);
          }
        } else {
          // Fallback to client RPC via explicit API schema
          const ingestRes = await client.schema('api').rpc('guard_sync_offline_registration', {
            requested_registration_id: reg.offlineRegistrationId,
            requested_visitor: reg.visitor,
            requested_action: reg.action,
            requested_occurred_at: reg.occurredAt,
            requested_photo_intent_id: photoIntent.intent_id,
            requested_photo_byte_size: reg.photoBlob.size,
            requested_photo_sha256: 'client-pending',
            requested_id_intent_id: idIntentId,
            requested_id_byte_size: reg.idBlob ? reg.idBlob.size : null,
            requested_id_sha256: reg.idBlob ? 'client-pending' : null,
            requested_rejection_reason: reg.rejectionReason,
          });
          if (ingestRes.error) throw ingestRes.error;
          syncData = ingestRes.data;
          if (syncData?.status === 'conflict') {
            summary.conflicts++;
            await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'conflict', {
              conflictReason: syncData.reason || 'Server fingerprint conflict',
              syncedAt: new Date().toISOString(),
            });
            await stripTerminalOfflineEvidence();
            continue;
          }
        }

        const canonicalPassId = syncData.passId;

        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'synced', {
          syncedAt: new Date().toISOString(),
          canonicalPassId,
        });

        // Step D: Remap local cache visitor identity and dependent queued offline events to canonical passId
        if (canonicalPassId) {
          await remapCachedVisitorPassId(reg.offlineRegistrationId, canonicalPassId, syncData.publicReference);
          await resolvePendingEventsPassId(reg.offlineRegistrationId, canonicalPassId);
        }

        summary.registrationsSynced++;
      } catch (regErr: any) {
        console.error('Offline registration sync failed:', regErr);
        summary.errors++;
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
          conflictReason: regErr.message || 'Sync failed',
        });
      }
    }

    // 2. Synchronize Pending Offline Lifecycle Events in chronological order (Root Cause 2.4)
    const pendingEvents = await getOfflineEvents('pending');
    pendingEvents.sort((a, b) => {
      const tDiff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      if (tDiff !== 0) return tDiff;
      return a.eventId.localeCompare(b.eventId);
    });

    const conflictedPassIds = new Set<string>();

    for (const evt of pendingEvents) {
      // If a preceding event for this pass encountered a conflict, do NOT submit dependent later events
      if (conflictedPassIds.has(evt.passId)) {
        await updateOfflineEventStatus(evt.eventId, 'conflict', {
          conflictReason: 'preceding_event_conflicted',
          syncedAt: new Date().toISOString(),
        });
        summary.conflicts++;
        continue;
      }

      try {
        await updateOfflineEventStatus(evt.eventId, 'syncing');

        const eventRes = await client.schema('api').rpc('guard_sync_offline_event', {
          requested_event_id: evt.eventId,
          requested_pass_id: evt.passId,
          requested_action: evt.action,
          requested_expected_status: evt.expectedStatus,
          requested_expected_version: evt.expectedVersion ?? null,
          requested_occurred_at: evt.occurredAt,
          requested_reason: evt.reason ?? null,
        });

        if (eventRes.error) {
          throw eventRes.error;
        }

        const resData = eventRes.data;
        if (resData.status === 'conflict') {
          conflictedPassIds.add(evt.passId);
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

    // Enforce local sensitive evidence retention and data purge
    const today = getManilaDateString();
    await purgeStaleLocalData(today);
  } finally {
    releaseLock();
  }

  return summary;
}

/**
 * Downloads and caches today's operationally relevant passes and evidence Blobs into IndexedDB.
 * Serialized via coordinator lock and preserves unsynchronized local visitors.
 */
export async function refreshOperationalCache(): Promise<number> {
  const releaseLock = await acquireCoordinatorLock();

  try {
    const client = requireSupabase();
    const sessionRes = await client.auth.getSession();
    const token = sessionRes.data.session?.access_token;
    if (!token) {
      console.warn('Session token unavailable for recovery cache refresh');
      return 0;
    }

    const allItems: any[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    // Paginated snapshot loop using API schema
    while (hasMore) {
      const pageRes = await client.schema('api').rpc('guard_offline_snapshot_page', {
        requested_cursor: cursor,
        requested_limit: 50,
      });

      if (pageRes.error) throw pageRes.error;
      const pageData = pageRes.data as { items?: any[]; nextCursor?: string | null; hasMore?: boolean } | null;
      if (!pageData || !Array.isArray(pageData.items)) break;

      allItems.push(...pageData.items);
      cursor = pageData.nextCursor ?? null;
      hasMore = Boolean(pageData.hasMore && cursor);
    }

    // Download evidence blobs for visual offline verification
    const passesToCache: CachedVisitorPass[] = [];
    for (const item of allItems) {
      let photoBlob: Blob | null = null;
      let idBlob: Blob | null = null;

      if (item.photoEvidenceId) {
        try {
          photoBlob = await fetchEvidenceBlob(item.photoEvidenceId, token);
        } catch (downloadErr) {
          throw new Error(`Evidence download failed for visitor ${item.visitorName}: ${String(downloadErr)}`);
        }
      }

      if (item.idEvidenceId) {
        try {
          idBlob = await fetchEvidenceBlob(item.idEvidenceId, token);
        } catch (downloadErr) {
          throw new Error(`ID evidence download failed for visitor ${item.visitorName}: ${String(downloadErr)}`);
        }
      }

      passesToCache.push({
        id: item.passId,
        publicReference: item.publicReference,
        visitorId: item.visitorId,
        visitorName: item.visitorName,
        contactNumber: item.contactNumber,
        purpose: item.purpose,
        visitDate: item.visitDate || getManilaDateString(),
        status: item.status,
        passReference: item.publicReference ? `EG-${item.publicReference.slice(0, 8).toUpperCase()}` : item.passId,
        validFrom: item.validFrom,
        validUntil: item.validUntil,
        timeIn: item.timeIn,
        gate: item.gate,
        photoEvidenceId: item.photoEvidenceId,
        idEvidenceId: item.idEvidenceId,
        photoBlob,
        idBlob,
        cachedAt: new Date().toISOString(),
        version: item.version,
      });
    }

    // Atomic replace in IndexedDB transaction - preserves unsynchronized local visitors
    await atomicReplaceCachedVisitors(passesToCache);
    await setMeta('last_cache_refresh_at', new Date().toISOString());
    return passesToCache.length;
  } catch (err) {
    console.warn('Could not refresh operational cache from server:', err);
    throw err;
  } finally {
    releaseLock();
  }
}
