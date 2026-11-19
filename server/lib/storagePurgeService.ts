/**
 * server/lib/storagePurgeService.ts
 *
 * Safe, server-only Supabase Storage recursive enumeration, batched deletion,
 * and post-purge verification service for Return-to-Zero system resets.
 *
 * Security & Integrity Invariants:
 * 1. Strictly allowlists only operational buckets: 'visitor-photos' and 'visitor-ids'.
 * 2. Recursively enumerates all nested folder hierarchies up to MAX_DIRECTORY_DEPTH (10 levels).
 * 3. Fails closed with hard error if MAX_DIRECTORY_DEPTH is exceeded (never skips nested files).
 * 4. Correctly distinguishes folder entries (id: null / metadata: null) from actual file objects.
 * 5. Paginated traversal: never assumes the first page contains the complete inventory.
 * 6. Respects Supabase Storage maximum batch size of 1,000 objects per removal request.
 * 7. Checks every response for errors; retries transient non-timeout errors with bounded backoff.
 * 8. Enforces post-deletion re-enumeration verification: fails closed if any file persists or if depth exceeded.
 * 9. Zero leakage of file contents, biometric metadata, or visitor PII in logs or manifests.
 * 10. Enforces 20,000-object safety ceiling across COMBINED inventory of both buckets.
 * 11. Bounded external Storage request execution: each batch removal and list request is bounded by STORAGE_REQUEST_TIMEOUT_MS (15,000ms).
 *     Real AbortSignal cancellation aborts the underlying client-side fetch without mutating process-global fetch.
 * 12. Deletion request timeout is treated as an ambiguous recovery condition: no overlapping retries are started, fails immediately into recovery_required.
 * 13. Worker lease / safety window alignment: Database reset worker lease (RESET_WORKER_LEASE_SECONDS = 60s) strictly exceeds maximum worst-case in-flight Storage execution (~46s total across 3 attempts).
 * 14. Unavoidable External Storage Limitation: An external HTTP/S3 Storage request already accepted by the storage backend before worker revocation cannot be retroactively cancelled over the network. Therefore, recovery lock acquisition strictly rejects resume attempts while lease_expires_at >= clock_timestamp(), guaranteeing that recovery cannot spawn a competing destructive worker while a previous worker may still have an active Storage request in flight.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const ALLOWED_RESET_BUCKETS = ['visitor-photos', 'visitor-ids'] as const;
export type AllowedResetBucket = (typeof ALLOWED_RESET_BUCKETS)[number];

export const MAX_SAFE_STORAGE_INVENTORY = 20_000;
export const STORAGE_REMOVAL_BATCH_SIZE = 1_000;
export const MAX_DIRECTORY_DEPTH = 10;
export const STORAGE_REQUEST_TIMEOUT_MS = 15_000;
export const RESET_WORKER_LEASE_SECONDS = 60;
const MAX_REMOVAL_RETRIES = 3;

export class StorageTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'StorageTimeoutError';
  }
}

export function isTimeoutError(err: any): boolean {
  if (!err) return false;
  if (err instanceof StorageTimeoutError || err?.isTimeout === true) return true;
  const msg = (err?.message || (typeof err === 'string' ? err : '')).toLowerCase();
  const name = (err?.name || '').toLowerCase();
  return (
    name === 'aborterror' ||
    name === 'storagetimeouterror' ||
    name === 'timeouterror' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function composeSignals(sig1?: AbortSignal, sig2?: AbortSignal): AbortSignal | undefined {
  if (!sig1) return sig2;
  if (!sig2) return sig1;
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any([sig1, sig2]);
  }
  const controller = new AbortController();
  const onAbort = (sig: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(sig.reason);
    }
  };
  if (sig1.aborted) return sig1;
  if (sig2.aborted) return sig2;
  sig1.addEventListener('abort', () => onAbort(sig1), { once: true });
  sig2.addEventListener('abort', () => onAbort(sig2), { once: true });
  return controller.signal;
}

export async function executeWithStorageTimeout<T>(
  client: SupabaseClient,
  bucket: AllowedResetBucket,
  operationName: 'list' | 'remove',
  execute: (storage: any, signal: AbortSignal) => Promise<T>,
  options?: {
    timeoutMs?: number;
    parentSignal?: AbortSignal;
  }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? STORAGE_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const parentSignal = options?.parentSignal;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new StorageTimeoutError(`Storage ${operationName} operation timed out after ${timeoutMs}ms in bucket "${bucket}".`));
  }, timeoutMs);

  try {
    const rawStorage = client.storage.from(bucket);
    let scopedStorage = rawStorage;

    if (rawStorage && typeof rawStorage === 'object') {
      const origFetch = (rawStorage as any).fetch || (client.storage as any)?.fetch;
      if (typeof origFetch === 'function') {
        scopedStorage = Object.create(rawStorage);
        (scopedStorage as any).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          const composedSignal = composeSignals(init?.signal ?? undefined, controller.signal);
          return origFetch(input, { ...init, signal: composedSignal });
        };
      }
    }

    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason || new StorageTimeoutError(`Storage ${operationName} operation aborted.`));
      } else {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason || new StorageTimeoutError(`Storage ${operationName} operation timed out after ${timeoutMs}ms in bucket "${bucket}".`));
        }, { once: true });
      }
    });

    const result = await Promise.race([
      execute(scopedStorage, controller.signal),
      abortPromise,
    ]);

    if (timedOut || controller.signal.aborted) {
      throw new StorageTimeoutError(
        `Storage ${operationName} operation timed out after ${timeoutMs}ms in bucket "${bucket}".`
      );
    }

    return result;
  } catch (err: any) {
    if (timedOut || isTimeoutError(err)) {
      throw new StorageTimeoutError(
        `Storage ${operationName} operation timed out after ${timeoutMs}ms in bucket "${bucket}": ${err?.message || String(err)}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface BucketInventoryManifest {
  bucket: AllowedResetBucket;
  files: string[];
  folderCount: number;
  totalBytes?: number;
}

export interface BucketVerificationManifest {
  bucket: AllowedResetBucket;
  remainingCount: number;
  verifiedEmpty: boolean;
}

export interface StorageVerificationRecord {
  verifiedAt: string;
  buckets: Record<AllowedResetBucket, BucketVerificationManifest>;
  verifiedEmpty: boolean;
}

export interface StoragePurgeResult {
  success: boolean;
  inventories: Record<AllowedResetBucket, BucketInventoryManifest>;
  totalFilesDiscovered: number;
  totalFilesDeleted: number;
  verifiedEmpty: boolean;
  verification: StorageVerificationRecord;
  purgedAt: string;
}

/**
 * Validates whether the given bucket is permitted for Return-to-Zero reset.
 */
export function assertAllowedBucket(bucket: string): asserts bucket is AllowedResetBucket {
  if (!ALLOWED_RESET_BUCKETS.includes(bucket as AllowedResetBucket)) {
    throw new Error(`Bucket "${bucket}" is not authorized for Return-to-Zero purge.`);
  }
}

/**
 * Distinguishes folder entries from file entries according to Supabase Storage conventions.
 * In Supabase Storage API, folder entries have `id: null` and `metadata: null`.
 * File entries have a non-null UUID `id` or metadata object.
 */
export function isFolderEntry(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  // Explicit folder indicator from mocks or v2 API
  if (item.isFolder === true) return true;
  // Supabase storage v1 list(): folders have item.id === null
  if (item.id === null) return true;
  // If item.id is a non-empty string, it is definitely a file
  if (typeof item.id === 'string' && item.id.length > 0) return false;
  // If item has metadata populated as an object, it is a file
  if (item.metadata !== null && typeof item.metadata === 'object' && Object.keys(item.metadata).length > 0) {
    return false;
  }
  // If id is undefined and metadata is null/undefined: check name ending or lack of extension
  if (item.id === undefined) {
    if (typeof item.name === 'string' && item.name.endsWith('/')) return true;
    if (item.metadata === null) return true;
  }
  return false;
}

/**
 * Recursively enumerates all files and nested folders in an allowlisted bucket.
 * Handles pagination and nested folder hierarchies up to MAX_DIRECTORY_DEPTH levels.
 * Fails closed with a hard error if maximum directory depth is exceeded or if combined inventory exceeds threshold.
 */
export async function enumerateBucketRecursive(
  client: SupabaseClient,
  bucket: AllowedResetBucket,
  currentCombinedCount = 0,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<BucketInventoryManifest> {
  assertAllowedBucket(bucket);

  const discoveredFiles = new Set<string>();
  const visitedPrefixes = new Set<string>();
  let folderCount = 0;

  // Queue of folder prefixes to explore: queue item is [prefix, depth]
  const queue: Array<[string, number]> = [['', 0]];

  while (queue.length > 0) {
    const [currentPrefix, depth] = queue.shift()!;
    if (visitedPrefixes.has(currentPrefix)) continue;
    visitedPrefixes.add(currentPrefix);

    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new Error(
        `Maximum folder depth (${MAX_DIRECTORY_DEPTH}) exceeded at prefix "${currentPrefix}" in bucket "${bucket}". Aborting purge to prevent incomplete data deletion.`
      );
    }

    let offset = 0;
    const PAGE_LIMIT = 1000;
    let pageHasMore = true;
    const seenNamesInPrefix = new Set<string>();

    while (pageHasMore) {
      let data: any[] | null = null;
      let error: any = null;

      try {
        const res = await executeWithStorageTimeout<{ data: any[] | null; error: any }>(
          client,
          bucket,
          'list',
          (storage) => storage.list(currentPrefix, {
            limit: PAGE_LIMIT,
            offset,
            sortBy: { column: 'name', order: 'asc' },
          }),
          { parentSignal: options?.signal, timeoutMs: options?.timeoutMs }
        );
        data = res.data;
        error = res.error;
      } catch (err: any) {
        if (isTimeoutError(err)) {
          throw (err instanceof StorageTimeoutError ? err : new StorageTimeoutError(err?.message || String(err)));
        }
        throw new Error(
          `Storage list operation threw exception in bucket "${bucket}" at prefix "${currentPrefix}": ${err?.message || err}`
        );
      }

      if (error) {
        if (isTimeoutError(error)) {
          throw new StorageTimeoutError(
            `Storage list operation failed in bucket "${bucket}" at prefix "${currentPrefix}": ${error.message || JSON.stringify(error)}`
          );
        }
        throw new Error(
          `Storage list operation failed in bucket "${bucket}" at prefix "${currentPrefix}": ${error.message || JSON.stringify(error)}`
        );
      }

      if (!data || !Array.isArray(data) || data.length === 0) {
        break;
      }

      // Detect repeated page loop (e.g. if storage backend ignores offset)
      let newlySeenCount = 0;
      for (const item of data) {
        if (!item || !item.name) continue;
        if (!seenNamesInPrefix.has(item.name)) {
          seenNamesInPrefix.add(item.name);
          newlySeenCount++;
        }
      }

      for (const item of data) {
        if (!item || !item.name) continue;

        // Skip current directory alias if returned
        if (item.name === '.' || item.name === '..') continue;

        const relativeName = item.name;
        // Compute full path relative to bucket root
        const fullPath = currentPrefix ? `${currentPrefix}/${relativeName}` : relativeName;

        if (isFolderEntry(item)) {
          folderCount++;
          if (!visitedPrefixes.has(fullPath)) {
            queue.push([fullPath, depth + 1]);
          }
        } else {
          discoveredFiles.add(fullPath);
          if (currentCombinedCount + discoveredFiles.size > MAX_SAFE_STORAGE_INVENTORY) {
            throw new Error(
              `Combined storage inventory safety threshold exceeded: total discovered objects across allowlisted buckets exceeds ${MAX_SAFE_STORAGE_INVENTORY}.`
            );
          }
        }
      }

      if (data.length < PAGE_LIMIT || newlySeenCount === 0) {
        pageHasMore = false;
      } else {
        offset += data.length;
      }
    }
  }

  return {
    bucket,
    files: Array.from(discoveredFiles),
    folderCount,
  };
}

/**
 * Removes an array of object paths in batches of at most 1,000 objects.
 * Retries failed batches up to MAX_REMOVAL_RETRIES times with exponential backoff.
 * Ambiguous deletion timeouts fail fast into recovery without overlapping retries.
 */
export async function deleteStorageObjectsInBatches(
  client: SupabaseClient,
  bucket: AllowedResetBucket,
  paths: string[],
  checkWorkerOwnership?: () => Promise<void>,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ deletedCount: number; errors: string[] }> {
  assertAllowedBucket(bucket);

  if (paths.length === 0) {
    return { deletedCount: 0, errors: [] };
  }

  let totalDeleted = 0;
  const errors: string[] = [];

  for (let i = 0; i < paths.length; i += STORAGE_REMOVAL_BATCH_SIZE) {
    if (checkWorkerOwnership) {
      await checkWorkerOwnership();
    }
    const batch = paths.slice(i, i + STORAGE_REMOVAL_BATCH_SIZE);
    let success = false;
    let lastErrorMsg = '';

    for (let attempt = 1; attempt <= MAX_REMOVAL_RETRIES; attempt++) {
      let isTimeout = false;
      try {
        const { data, error } = await executeWithStorageTimeout<{ data: any[] | null; error: any }>(
          client,
          bucket,
          'remove',
          (storage) => storage.remove(batch),
          { parentSignal: options?.signal, timeoutMs: options?.timeoutMs }
        );

        if (error) {
          lastErrorMsg = error.message || JSON.stringify(error);
          if (isTimeoutError(error)) {
            isTimeout = true;
          }
        } else if (data && Array.isArray(data)) {
          totalDeleted += data.length;
          success = true;
          break;
        } else {
          // Fallback if data is null but no error
          totalDeleted += batch.length;
          success = true;
          break;
        }
      } catch (err: any) {
        lastErrorMsg = err?.message || String(err);
        if (isTimeoutError(err)) {
          isTimeout = true;
        }
      }

      // Requirement 4: Treat ambiguous timeout on deletion request as a recovery condition.
      // Do NOT start overlapping retries while an earlier request may already have been accepted by Storage.
      // Throw/abort into recovery_required.
      if (isTimeout) {
        const timeoutMsg = `Storage deletion request timed out after ${options?.timeoutMs ?? STORAGE_REQUEST_TIMEOUT_MS}ms for batch of ${batch.length} files in bucket "${bucket}". Ambiguous deletion state requires recovery without overlapping retries: ${lastErrorMsg}`;
        errors.push(timeoutMsg);
        throw new StorageTimeoutError(timeoutMsg);
      }

      if (attempt < MAX_REMOVAL_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 150));
      }
    }

    if (!success) {
      const msg = `Failed to remove batch of ${batch.length} files in bucket "${bucket}" after ${MAX_REMOVAL_RETRIES} attempts: ${lastErrorMsg}`;
      errors.push(msg);
      throw new Error(msg);
    }
  }

  return { deletedCount: totalDeleted, errors };
}

/**
 * Executes a complete, verified purge across all allowlisted buckets:
 * 1. Enumerates all nested files across visitor-photos and visitor-ids, enforcing combined 20k limit.
 * 2. Deletes files in batches of <= 1,000 objects with worker fencing validation.
 * 3. Re-enumerates both buckets to verify 0 files remain (fails closed if depth exceeded or files persist).
 * 4. Fails closed if any file persists or if verification enumeration fails.
 * 5. Returns structured StorageVerificationRecord capturing verified empty state for both buckets.
 */
export async function purgeAndVerifyStorageBuckets(
  client: SupabaseClient,
  checkWorkerOwnership?: () => Promise<void>,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<StoragePurgeResult> {
  const inventories: Record<AllowedResetBucket, BucketInventoryManifest> = {
    'visitor-photos': { bucket: 'visitor-photos', files: [], folderCount: 0 },
    'visitor-ids': { bucket: 'visitor-ids', files: [], folderCount: 0 },
  };

  let totalDiscovered = 0;

  // Step 1: Enumerate both buckets with combined 20k threshold enforcement
  for (const bucket of ALLOWED_RESET_BUCKETS) {
    if (checkWorkerOwnership) {
      await checkWorkerOwnership();
    }
    const inv = await enumerateBucketRecursive(client, bucket, totalDiscovered, options);
    inventories[bucket] = inv;
    totalDiscovered += inv.files.length;
    if (totalDiscovered > MAX_SAFE_STORAGE_INVENTORY) {
      throw new Error(
        `Combined storage inventory safety threshold exceeded: total discovered objects (${totalDiscovered}) exceeds ${MAX_SAFE_STORAGE_INVENTORY}.`
      );
    }
  }

  // Step 2: Delete discovered objects
  let totalDeleted = 0;
  for (const bucket of ALLOWED_RESET_BUCKETS) {
    const inv = inventories[bucket];
    if (inv.files.length > 0) {
      const delRes = await deleteStorageObjectsInBatches(client, bucket, inv.files, checkWorkerOwnership, options);
      totalDeleted += delRes.deletedCount;
    }
  }

  // Step 3: Verify post-deletion state by enumerating again
  const postVerificationBuckets: Record<AllowedResetBucket, { remainingCount: number; verifiedEmpty: boolean }> = {} as any;

  for (const bucket of ALLOWED_RESET_BUCKETS) {
    if (checkWorkerOwnership) {
      await checkWorkerOwnership();
    }
    const postInv = await enumerateBucketRecursive(client, bucket, 0, options);
    postVerificationBuckets[bucket] = {
      remainingCount: postInv.files.length,
      verifiedEmpty: postInv.files.length === 0,
    };
    if (postInv.files.length > 0) {
      throw new Error(
        `Storage verification failed: ${postInv.files.length} file(s) still remain in bucket "${bucket}" after deletion.`
      );
    }
  }

  const verification: StorageVerificationRecord = {
    verifiedAt: new Date().toISOString(),
    buckets: {
      'visitor-photos': {
        bucket: 'visitor-photos',
        remainingCount: postVerificationBuckets['visitor-photos']?.remainingCount ?? 0,
        verifiedEmpty: (postVerificationBuckets['visitor-photos']?.remainingCount ?? 0) === 0,
      },
      'visitor-ids': {
        bucket: 'visitor-ids',
        remainingCount: postVerificationBuckets['visitor-ids']?.remainingCount ?? 0,
        verifiedEmpty: (postVerificationBuckets['visitor-ids']?.remainingCount ?? 0) === 0,
      },
    },
    verifiedEmpty: true,
  };

  return {
    success: true,
    inventories,
    totalFilesDiscovered: totalDiscovered,
    totalFilesDeleted: totalDeleted,
    verifiedEmpty: true,
    verification,
    purgedAt: verification.verifiedAt,
  };
}
