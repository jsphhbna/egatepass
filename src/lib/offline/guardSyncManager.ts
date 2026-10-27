/**
 * Guard Offline Synchronization Manager
 *
 * Implements safe, serialized, idempotent synchronization with the backend when
 * network connectivity is restored.
 *
 * Invariants (Post-Closure Verification Repair Pass):
 * 1. Single unified coordinator pipeline: runOfflineMaintenance() executes in strict order:
 *    - recoverInterruptedSyncStates()
 *    - synchronize pending registrations
 *    - atomic canonicalization (finalizeOfflineRegistrationSync)
 *    - synchronize eligible lifecycle events (causal dependencies enforced)
 *    - refresh authoritative operational snapshot (sync before snapshot)
 *    - local retention & purge
 * 2. Never persist transient 'syncing' as durable state; maintain in-memory tracking under lock.
 * 3. Enforce registration -> event causal dependency:
 *    - pending registration holds dependent event pending
 *    - conflict registration marks dependent event registration_sync_conflicted
 *    - preceding event conflict marks subsequent events preceding_event_conflicted
 * 4. Bound every network operation (createBoundedAbortSignal for PostgREST/RPC, fetchWithTimeout, withTimeout for Storage).
 * 5. Retry-safe upload checkpointing on offline registrations.
 * 6. Remove broken tokenless registration fallback with fake hashes.
 */

import { requireSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getOfflineRegistrations,
  getOfflineEvents,
  updateOfflineRegistrationStatus,
  updateOfflineEventStatus,
  atomicReplaceCachedVisitors,
  purgeStaleLocalData,
  stripTerminalOfflineEvidence,
  setMeta,
  finalizeOfflineRegistrationSync,
  recoverInterruptedSyncStates,
  updateOfflineRegistrationCheckpoint,
  clearOfflineRegistrationCheckpoints,
  type CachedVisitorPass,
  type OfflineRegistrationRecord,
  type UploadCheckpoint,
} from './guardIndexedDb';
import { getManilaDateString } from '@/lib/scheduling';
import { fetchWithTimeout, createBoundedAbortSignal, withTimeout } from '@/lib/fetchWithTimeout';

export interface SyncSummary {
  registrationsSynced: number;
  eventsSynced: number;
  conflicts: number;
  errors: number;
}

export interface MaintenanceResult {
  summary: SyncSummary;
  refreshedPasses: number;
  recoveredRecords: {
    recoveredRegistrations: number;
    recoveredEvents: number;
  };
}

// =============================================================================
// SERIALIZED COORDINATOR MUTEX
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
  const res = await fetchWithTimeout(`/api/evidence?id=${encodeURIComponent(evidenceId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 10000);
  if (res.status === 404 || res.status === 410) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to download evidence ${evidenceId}: HTTP ${res.status}`);
  }
  return res.blob();
}

/**
 * Uploads evidence with bounded timeout and retry-safe checkpointing.
 */
async function uploadRegistrationEvidence(
  client: SupabaseClient,
  regId: string,
  kind: 'photo' | 'id',
  blob: Blob,
  existingCheckpoint?: UploadCheckpoint | null
): Promise<UploadCheckpoint> {
  let checkpoint: UploadCheckpoint;

  // 1. Reuse existing non-expired checkpoint if present
  const isCheckpointValid = (cp?: UploadCheckpoint | null): boolean => {
    return Boolean(
      cp &&
      cp.expiresAt &&
      !Number.isNaN(new Date(cp.expiresAt).getTime()) &&
      new Date(cp.expiresAt).getTime() > Date.now()
    );
  };

  if (isCheckpointValid(existingCheckpoint)) {
    checkpoint = { ...existingCheckpoint! };
  } else {
    // Create new upload intent via bounded RPC
    const rpcCall = client
      .schema('api')
      .rpc('create_upload_intent', {
        requested_source: 'guard_offline',
        requested_kind: kind,
        requested_content_type: 'image/webp',
      });
    const intentRes = await (typeof (rpcCall as any).abortSignal === 'function'
      ? (rpcCall as any).abortSignal(createBoundedAbortSignal(10000))
      : rpcCall);

    if (intentRes.error) {
      throw new Error(`${kind} intent error: ${intentRes.error.message}`);
    }
    const intentData = Array.isArray(intentRes.data) ? intentRes.data[0] : intentRes.data;
    if (!intentData?.intent_id) {
      throw new Error(`Failed to allocate ${kind} upload intent`);
    }

    checkpoint = {
      intentId: intentData.intent_id,
      bucketId: intentData.bucket_id,
      objectPath: intentData.object_path,
      contentType: 'image/webp',
      maxBytes: intentData.max_bytes || 5242880,
      expiresAt: intentData.expires_at,
      uploaded: false,
    };

    // Persist checkpoint BEFORE initiating Storage upload
    await updateOfflineRegistrationCheckpoint(regId, kind, checkpoint);
  }

  // 2. Upload to Storage if not already confirmed uploaded
  if (!checkpoint.uploaded) {
    try {
      const uploadRes = await withTimeout(
        client.storage.from(checkpoint.bucketId).upload(checkpoint.objectPath, blob, {
          contentType: checkpoint.contentType,
          upsert: false,
        }),
        15000,
        `${kind} upload timed out after 15s`
      );

      if (uploadRes.error) {
        const errMsg = uploadRes.error.message?.toLowerCase() || '';
        const statusCode = (uploadRes.error as any).statusCode || (uploadRes.error as any).status;
        if (
          statusCode === 409 ||
          errMsg.includes('already exists') ||
          errMsg.includes('duplicate') ||
          errMsg.includes('resourcealreadyexists')
        ) {
          // Object already committed from a prior attempt
          checkpoint.uploaded = true;
          await updateOfflineRegistrationCheckpoint(regId, kind, checkpoint);
        } else {
          throw new Error(`${kind} upload error: ${uploadRes.error.message}`);
        }
      } else {
        checkpoint.uploaded = true;
        await updateOfflineRegistrationCheckpoint(regId, kind, checkpoint);
      }
    } catch (err: any) {
      const errMsg = err?.message?.toLowerCase() || '';
      if (
        errMsg.includes('already exists') ||
        errMsg.includes('resourcealreadyexists') ||
        errMsg.includes('409')
      ) {
        checkpoint.uploaded = true;
        await updateOfflineRegistrationCheckpoint(regId, kind, checkpoint);
      } else {
        throw err;
      }
    }
  }

  return checkpoint;
}

/**
 * Internal unlocked helper: Refreshes the operational cache snapshot from the server.
 * Precondition: caller holds coordinator lock.
 */
async function internalRefreshOperationalCache(
  client: SupabaseClient,
  token: string | undefined
): Promise<number> {
  if (!token) {
    console.warn('Session token unavailable for recovery cache refresh');
    return 0;
  }

  const allItems: any[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  // Paginated snapshot loop using API schema with bounded AbortSignal (10s per page)
  while (hasMore) {
    const rpcCall = client
      .schema('api')
      .rpc('guard_offline_snapshot_page', {
        requested_cursor: cursor,
        requested_limit: 50,
      });
    const pageRes = await (typeof (rpcCall as any).abortSignal === 'function'
      ? (rpcCall as any).abortSignal(createBoundedAbortSignal(10000))
      : rpcCall);

    if (pageRes.error) throw pageRes.error;
    const pageData = pageRes.data as { items?: any[]; nextCursor?: string | null; hasMore?: boolean } | null;
    if (!pageData || !Array.isArray(pageData.items)) break;

    allItems.push(...pageData.items);
    cursor = pageData.nextCursor ?? null;
    hasMore = Boolean(pageData.hasMore && cursor);
  }

  // Download evidence blobs for visual offline verification (bounded 10s per fetch)
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
}

/**
 * Single, unified offline maintenance pipeline (Section 4).
 * Holds coordinator lock once and executes:
 * 1. recoverInterruptedSyncStates()
 * 2. synchronize pending offline registrations (do not persist durable 'syncing')
 * 3. atomically canonicalize successful registrations (finalizeOfflineRegistrationSync)
 * 4. synchronize eligible lifecycle events in chronological/per-pass causal order
 * 5. refresh authoritative operational snapshot (sync-before-snapshot)
 * 6. local retention & evidence cleanup
 * 7. releases lock
 */
export async function runOfflineMaintenance(): Promise<MaintenanceResult> {
  const releaseLock = await acquireCoordinatorLock();

  const summary: SyncSummary = {
    registrationsSynced: 0,
    eventsSynced: 0,
    conflicts: 0,
    errors: 0,
  };
  let refreshedPasses = 0;
  let recoveredRecords = { recoveredRegistrations: 0, recoveredEvents: 0 };

  try {
    // Step 1: Recover any records stranded in 'syncing' by a previous crash (Section 2)
    recoveredRecords = await recoverInterruptedSyncStates();

    const client = requireSupabase();
    const sessionRes = await client.auth.getSession();
    const token = sessionRes.data.session?.access_token;

    // Step 2 & 3: Synchronize Pending Offline Registrations FIRST in chronological order
    const pendingRegs = await getOfflineRegistrations('pending');
    pendingRegs.sort((a, b) => {
      const tDiff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      if (tDiff !== 0) return tDiff;
      return a.offlineRegistrationId.localeCompare(b.offlineRegistrationId);
    });

    for (const reg of pendingRegs) {
      // If Guard session has no usable access token, leave pending (Section 6)
      if (!token) {
        console.warn('Guard session token unavailable for registration sync. Leaving pending.');
        summary.errors++;
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
          conflictReason: 'Guard session unavailable: authentication required to sync registration',
        });
        continue;
      }

      try {
        if (!reg.photoBlob) {
          throw new Error('Photo blob missing for offline registration sync');
        }

        // Upload photo evidence with retry-safe checkpointing (Section 5)
        const photoCheckpoint = await uploadRegistrationEvidence(
          client,
          reg.offlineRegistrationId,
          'photo',
          reg.photoBlob,
          reg.photoUploadCheckpoint
        );

        // Upload ID evidence if captured with retry-safe checkpointing
        let idIntentId: string | null = null;
        if (reg.idBlob) {
          const idCheckpoint = await uploadRegistrationEvidence(
            client,
            reg.offlineRegistrationId,
            'id',
            reg.idBlob,
            reg.idUploadCheckpoint
          );
          idIntentId = idCheckpoint.intentId;
        }

        // Call authoritative server sync route with 15s bounded timeout
        const res = await fetchWithTimeout(
          '/api/sync-offline-registration',
          {
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
              photoIntentId: photoCheckpoint.intentId,
              idIntentId,
              rejectionReason: reg.rejectionReason,
            }),
          },
          15000
        );

        const syncData = await res.json().catch(() => null);

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

          if (res.status === 422) {
            const recoverableErrors = ['invalid_upload_intent', 'missing_uploaded_object', 'invalid_uploaded_content'];
            if (recoverableErrors.includes(syncData?.error)) {
              // Recoverable evidence failure: clear checkpoints, keep blobs, keep pending for fresh re-upload next cycle
              await clearOfflineRegistrationCheckpoints(reg.offlineRegistrationId);
              summary.errors++;
              await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
                conflictReason: syncData?.error || 'Recoverable evidence rejection',
              });
              continue;
            }

            // Other 422: authoritative deterministic domain failure (e.g. invalid date / business rule)
            summary.conflicts++;
            await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'conflict', {
              conflictReason: syncData?.error || 'Deterministic registration domain validation failure',
              syncedAt: new Date().toISOString(),
            });
            await stripTerminalOfflineEvidence();
            continue;
          }

          if (res.status === 400) {
            // Deterministic payload / schema / RPC domain failure that cannot succeed by retrying identical data
            summary.conflicts++;
            await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'conflict', {
              conflictReason: syncData?.error || 'Deterministic registration validation error',
              syncedAt: new Date().toISOString(),
            });
            await stripTerminalOfflineEvidence();
            continue;
          }

          if (res.status === 401 || res.status === 403) {
            summary.errors++;
            await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
              conflictReason: 'Authentication required',
            });
            continue;
          }

          if (res.status >= 500) {
            summary.errors++;
            await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
              conflictReason: syncData?.error || `Server error (${res.status})`,
            });
            continue;
          }

          throw new Error(syncData?.error || `HTTP ${res.status}`);
        }

        const canonicalPassId = syncData?.canonicalPassId || syncData?.passId || syncData?.pass_id;
        if (!canonicalPassId) {
          throw new Error('Registration sync succeeded but did not return canonical passId');
        }

        const canonicalRef =
          syncData?.canonicalReference || syncData?.publicReference || syncData?.public_reference;

        // Step 3: Atomic canonicalization across registrations, cached_visitors, and offline_events (Section 1)
        await finalizeOfflineRegistrationSync({
          offlineRegistrationId: reg.offlineRegistrationId,
          canonicalPassId,
          canonicalReference: canonicalRef,
          syncedAt: new Date().toISOString(),
        });

        summary.registrationsSynced++;
      } catch (regErr: any) {
        console.error('Offline registration sync failed:', regErr);
        summary.errors++;
        // Keep durable record as pending (Section 2)
        await updateOfflineRegistrationStatus(reg.offlineRegistrationId, 'pending', {
          conflictReason: regErr.message || 'Sync failed',
        });
      }
    }

    // Step 4: Synchronize Pending Offline Lifecycle Events in chronological order (Section 3)
    const pendingEvents = await getOfflineEvents('pending');
    pendingEvents.sort((a, b) => {
      const tDiff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
      if (tDiff !== 0) return tDiff;
      return a.eventId.localeCompare(b.eventId);
    });

    // Build lookup of current registrations to check parent status
    const currentRegs = await getOfflineRegistrations();
    const regById = new Map<string, OfflineRegistrationRecord>(
      currentRegs.map((r) => [r.offlineRegistrationId, r])
    );

    const conflictedPassIds = new Set<string>();
    const unresolvedPassIds = new Set<string>();

    for (const evt of pendingEvents) {
      let targetPassId = evt.passId;

      // Check if event refers to an offline-created registration
      if (regById.has(evt.passId)) {
        const parentReg = regById.get(evt.passId)!;

        if (parentReg.syncStatus === 'pending' || parentReg.syncStatus === 'syncing') {
          // Parent registration is still pending due to network/transient failure:
          // DO NOT call lifecycle RPC; leave event pending for next cycle (Section 3)
          unresolvedPassIds.add(evt.passId);
          continue;
        }

        if (parentReg.syncStatus === 'conflict') {
          // Parent registration is in conflict: DO NOT call lifecycle RPC; mark event conflict
          await updateOfflineEventStatus(evt.eventId, 'conflict', {
            conflictReason: 'registration_sync_conflicted',
            syncedAt: new Date().toISOString(),
          });
          conflictedPassIds.add(evt.passId);
          summary.conflicts++;
          continue;
        }

        if (parentReg.syncStatus === 'synced' && parentReg.canonicalPassId) {
          targetPassId = parentReg.canonicalPassId;
        }
      }

      // Check per-pass causal conflict rule
      if (conflictedPassIds.has(targetPassId) || conflictedPassIds.has(evt.passId)) {
        await updateOfflineEventStatus(evt.eventId, 'conflict', {
          conflictReason: 'preceding_event_conflicted',
          syncedAt: new Date().toISOString(),
        });
        summary.conflicts++;
        continue;
      }

      // Check per-pass causal unresolved predecessor rule
      if (unresolvedPassIds.has(targetPassId) || unresolvedPassIds.has(evt.passId)) {
        // Predecessor event on this pass is unresolved (timed out / ambiguous / pending).
        // Leave this event pending and DO NOT call guard_sync_offline_event.
        continue;
      }

      try {
        const rpcCall = client
          .schema('api')
          .rpc('guard_sync_offline_event', {
            requested_event_id: evt.eventId,
            requested_pass_id: targetPassId,
            requested_action: evt.action,
            requested_expected_status: evt.expectedStatus,
            requested_expected_version: evt.expectedVersion ?? null,
            requested_occurred_at: evt.occurredAt,
            requested_reason: evt.reason ?? null,
          });
        const eventRes = await (typeof (rpcCall as any).abortSignal === 'function'
          ? (rpcCall as any).abortSignal(createBoundedAbortSignal(10000))
          : rpcCall);

        if (eventRes.error) {
          throw eventRes.error;
        }

        const resData = eventRes.data;
        if (resData.status === 'conflict') {
          conflictedPassIds.add(targetPassId);
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
        // Leave durable record as pending (Section 2)
        await updateOfflineEventStatus(evt.eventId, 'pending', {
          conflictReason: evtErr.message || 'Event sync failed',
        });
        unresolvedPassIds.add(targetPassId);
        unresolvedPassIds.add(evt.passId);
      }
    }

    // Step 5: Refresh authoritative operational snapshot (sync before snapshot - Section 4)
    refreshedPasses = await internalRefreshOperationalCache(client, token);

    // Step 6: Local retention & evidence cleanup
    const today = getManilaDateString();
    await purgeStaleLocalData(today);
    await setMeta('last_successful_sync_at', new Date().toISOString());
  } finally {
    releaseLock();
  }

  return {
    summary,
    refreshedPasses,
    recoveredRecords,
  };
}

/**
 * Backward-compatible export: synchronizes pending items via the unified maintenance pipeline.
 */
export async function syncAllPending(): Promise<SyncSummary> {
  const result = await runOfflineMaintenance();
  return result.summary;
}

/**
 * Backward-compatible export: refreshes cache via the unified maintenance pipeline.
 */
export async function refreshOperationalCache(): Promise<number> {
  const result = await runOfflineMaintenance();
  return result.refreshedPasses;
}
