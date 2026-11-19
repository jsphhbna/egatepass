/**
 * server/lib/storagePurgeService.ts
 *
 * Safe, server-only Supabase Storage recursive enumeration, batched deletion,
 * and post-purge verification service for Return-to-Zero system resets.
 *
 * Security & Integrity Invariants:
 * 1. Strictly allowlists only operational buckets: 'visitor-photos' and 'visitor-ids'.
 * 2. Recursively enumerates all nested folder hierarchies (supports arbitrary folder nesting).
 * 3. Correctly distinguishes folder entries (id: null / metadata: null) from actual file objects.
 * 4. Paginated traversal: never assumes the first page contains the complete inventory.
 * 5. Respects Supabase Storage maximum batch size of 1,000 objects per removal request.
 * 6. Checks every response for errors; retries transient errors with bounded backoff.
 * 7. Enforces post-deletion re-enumeration verification: fails closed if any file remains.
 * 8. Zero leakage of file contents, biometric metadata, or visitor PII in logs or manifests.
 * 9. Fails closed if total inventory exceeds safe processing threshold (e.g. 20,000 objects).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const ALLOWED_RESET_BUCKETS = ['visitor-photos', 'visitor-ids'] as const;
export type AllowedResetBucket = (typeof ALLOWED_RESET_BUCKETS)[number];

export const MAX_SAFE_STORAGE_INVENTORY = 20_000;
export const STORAGE_REMOVAL_BATCH_SIZE = 1_000;
const MAX_DIRECTORY_DEPTH = 10;
const MAX_REMOVAL_RETRIES = 3;

export interface BucketInventoryManifest {
  bucket: AllowedResetBucket;
  files: string[];
  folderCount: number;
  totalBytes?: number;
}

export interface StoragePurgeResult {
  success: boolean;
  inventories: Record<AllowedResetBucket, BucketInventoryManifest>;
  totalFilesDiscovered: number;
  totalFilesDeleted: number;
  verifiedEmpty: boolean;
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
 */
export async function enumerateBucketRecursive(
  client: SupabaseClient,
  bucket: AllowedResetBucket
): Promise<BucketInventoryManifest> {
  assertAllowedBucket(bucket);

  const storage = client.storage.from(bucket);
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
      console.warn(`Maximum folder depth reached at prefix "${currentPrefix}" in bucket "${bucket}"`);
      continue;
    }

    let offset = 0;
    const PAGE_LIMIT = 1000;
    let pageHasMore = true;
    const seenNamesInPrefix = new Set<string>();

    while (pageHasMore) {
      let data: any[] | null = null;
      let error: any = null;

      try {
        const res = await storage.list(currentPrefix, {
          limit: PAGE_LIMIT,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        });
        data = res.data;
        error = res.error;
      } catch (err: any) {
        throw new Error(
          `Storage list operation threw exception in bucket "${bucket}" at prefix "${currentPrefix}": ${err?.message || err}`
        );
      }

      if (error) {
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
          if (discoveredFiles.size > MAX_SAFE_STORAGE_INVENTORY) {
            throw new Error(
              `Storage inventory safety threshold exceeded: bucket "${bucket}" contains more than ${MAX_SAFE_STORAGE_INVENTORY} objects.`
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
 */
export async function deleteStorageObjectsInBatches(
  client: SupabaseClient,
  bucket: AllowedResetBucket,
  paths: string[]
): Promise<{ deletedCount: number; errors: string[] }> {
  assertAllowedBucket(bucket);

  if (paths.length === 0) {
    return { deletedCount: 0, errors: [] };
  }

  const storage = client.storage.from(bucket);
  let totalDeleted = 0;
  const errors: string[] = [];

  for (let i = 0; i < paths.length; i += STORAGE_REMOVAL_BATCH_SIZE) {
    const batch = paths.slice(i, i + STORAGE_REMOVAL_BATCH_SIZE);
    let success = false;
    let lastErrorMsg = '';

    for (let attempt = 1; attempt <= MAX_REMOVAL_RETRIES; attempt++) {
      try {
        const { data, error } = await storage.remove(batch);
        if (error) {
          lastErrorMsg = error.message || JSON.stringify(error);
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
 * 1. Enumerates all nested files across visitor-photos and visitor-ids.
 * 2. Deletes files in batches of <= 1,000 objects.
 * 3. Re-enumerates both buckets to verify 0 files remain.
 * 4. Fails closed if any file persists or if verification enumeration fails.
 */
export async function purgeAndVerifyStorageBuckets(
  client: SupabaseClient
): Promise<StoragePurgeResult> {
  const inventories: Record<AllowedResetBucket, BucketInventoryManifest> = {
    'visitor-photos': { bucket: 'visitor-photos', files: [], folderCount: 0 },
    'visitor-ids': { bucket: 'visitor-ids', files: [], folderCount: 0 },
  };

  let totalDiscovered = 0;

  // Step 1: Enumerate both buckets
  for (const bucket of ALLOWED_RESET_BUCKETS) {
    const inv = await enumerateBucketRecursive(client, bucket);
    inventories[bucket] = inv;
    totalDiscovered += inv.files.length;
  }

  // Step 2: Delete discovered objects
  let totalDeleted = 0;
  for (const bucket of ALLOWED_RESET_BUCKETS) {
    const inv = inventories[bucket];
    if (inv.files.length > 0) {
      const delRes = await deleteStorageObjectsInBatches(client, bucket, inv.files);
      totalDeleted += delRes.deletedCount;
    }
  }

  // Step 3: Verify post-deletion state by enumerating again
  for (const bucket of ALLOWED_RESET_BUCKETS) {
    const postInv = await enumerateBucketRecursive(client, bucket);
    if (postInv.files.length > 0) {
      throw new Error(
        `Storage verification failed: ${postInv.files.length} file(s) still remain in bucket "${bucket}" after deletion.`
      );
    }
  }

  return {
    success: true,
    inventories,
    totalFilesDiscovered: totalDiscovered,
    totalFilesDeleted: totalDeleted,
    verifiedEmpty: true,
    purgedAt: new Date().toISOString(),
  };
}
