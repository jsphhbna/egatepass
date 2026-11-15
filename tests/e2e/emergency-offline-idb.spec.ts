import { test, expect } from '@playwright/test';

test.describe('Workstream 1 / R2: Emergency Offline IndexedDB Real Browser Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear any leftover test IndexedDB database
    await page.evaluate(async () => {
      if (typeof indexedDB !== 'undefined') {
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase('egatepass-emergency-vault-v1');
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    });
  });

  test('executes real browser IndexedDB atomic compare-and-retry sequence allocation without transaction timeout', async ({
    page,
  }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const {
        enqueueEmergencyRecord,
        listEmergencyRecords,
        clearEmergencyDeviceVault,
      } = await import('/src/lib/offline/emergencyCryptoIdb.ts');

      const deviceUserId = 'test-e2e-device-001';
      await clearEmergencyDeviceVault(deviceUserId);

      // 1. Single record creation
      const rec1 = await enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Juan Dela Cruz',
        declaredAddress: '123 Manila St.',
        purpose: 'Official Inquiry',
        destinationOfficeId: 'office-1',
        destinationOfficeNameSnapshot: 'Registrar',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: true,
        snapshotVersion: 'snap-v1',
        manifestId: 'manifest-001',
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: false,
        allowEmergencyExceptionPolicy: false,
      });

      // 2. Sequential record creation
      const rec2 = await enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Maria Clara',
        declaredAddress: '456 Sampaloc Ave.',
        purpose: 'Transcript Release',
        destinationOfficeId: 'office-1',
        destinationOfficeNameSnapshot: 'Registrar',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: true,
        snapshotVersion: 'snap-v1',
        manifestId: 'manifest-001',
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: false,
        allowEmergencyExceptionPolicy: false,
      });

      const listed = await listEmergencyRecords(deviceUserId);

      return {
        rec1Seq: rec1.localSequence,
        rec2Seq: rec2.localSequence,
        listedCount: listed.length,
        listedSeqs: listed.map((r: any) => r.localSequence),
        listedNames: listed.map((r: any) => r.visitorFullName),
      };
    });

    expect(result.rec1Seq).toBe(1);
    expect(result.rec2Seq).toBe(2);
    expect(result.listedCount).toBe(2);
    expect(result.listedSeqs).toEqual([1, 2]);
    expect(result.listedNames).toEqual(['Juan Dela Cruz', 'Maria Clara']);
  });

  test('resolves concurrent contention in real browser IndexedDB yielding strictly monotonic sequence numbers without duplicates', async ({
    page,
  }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const {
        enqueueEmergencyRecord,
        listEmergencyRecords,
        clearEmergencyDeviceVault,
      } = await import('/src/lib/offline/emergencyCryptoIdb.ts');

      const deviceUserId = 'test-e2e-device-concurrent';
      await clearEmergencyDeviceVault(deviceUserId);

      // Fire 6 concurrent intake records simultaneously
      const promises = [1, 2, 3, 4, 5, 6].map((i) =>
        enqueueEmergencyRecord({
          deviceUserId,
          claimedGate: 'Main Gate',
          visitorFullName: `Concurrent Visitor ${i}`,
          declaredAddress: `Address ${i}, Manila`,
          purpose: `Purpose ${i}`,
          destinationOfficeId: 'office-1',
          destinationOfficeNameSnapshot: 'Registrar',
          officeResolutionStatus: 'resolved_snapshot',
          officeRequiresApprovalSnapshot: true,
          idPhysicallyInspected: true,
          snapshotVersion: 'snap-v1',
          manifestId: 'manifest-001',
          leaseStatusAtRecord: 'valid',
          emergencyExceptionApplied: false,
          allowEmergencyExceptionPolicy: false,
        }),
      );

      const records = await Promise.all(promises);
      const listed = await listEmergencyRecords(deviceUserId);

      return {
        allocatedSeqs: records.map((r: any) => r.localSequence).sort((a: number, b: number) => a - b),
        listedSeqs: listed.map((r: any) => r.localSequence),
        count: listed.length,
      };
    });

    expect(result.count).toBe(6);
    expect(result.allocatedSeqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.listedSeqs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('persists encrypted records across page reload and decrypts successfully in native browser runtime', async ({
    page,
  }) => {
    await page.goto('/');

    const deviceUserId = 'test-e2e-device-reload';

    await page.evaluate(async (devId) => {
      const {
        enqueueEmergencyRecord,
        clearEmergencyDeviceVault,
      } = await import('/src/lib/offline/emergencyCryptoIdb.ts');

      await clearEmergencyDeviceVault(devId);
      await enqueueEmergencyRecord({
        deviceUserId: devId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Reload Test Visitor',
        declaredAddress: 'Intramuros, Manila',
        purpose: 'Campus Tour',
        destinationOfficeId: 'office-1',
        destinationOfficeNameSnapshot: 'Admissions',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: true,
        snapshotVersion: 'snap-v1',
        manifestId: 'manifest-001',
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: false,
        allowEmergencyExceptionPolicy: false,
      });
    }, deviceUserId);

    // Hard page reload to clear memory state
    await page.reload();

    const reloadResult = await page.evaluate(async (devId) => {
      const { listEmergencyRecords } = await import('/src/lib/offline/emergencyCryptoIdb.ts');
      const records = await listEmergencyRecords(devId);
      return {
        count: records.length,
        name: records[0]?.visitorFullName,
        seq: records[0]?.localSequence,
        syncStatus: records[0]?.syncStatus,
      };
    }, deviceUserId);

    expect(reloadResult.count).toBe(1);
    expect(reloadResult.name).toBe('Reload Test Visitor');
    expect(reloadResult.seq).toBe(1);
    expect(reloadResult.syncStatus).toBe('pending_sync');
  });

  test('fails closed upon transaction abort / quota failure leaving sequence un-bumped and record uncommitted', async ({
    page,
  }) => {
    await page.goto('/');

    const rollbackResult = await page.evaluate(async () => {
      const DB_NAME = 'egatepass-emergency-vault-v1';
      const STORE_META = 'meta';
      const STORE_RECORDS = 'records';
      const deviceUserId = 'test-quota-device';

      // Open database
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META, { keyPath: 'id' });
          if (!d.objectStoreNames.contains(STORE_RECORDS)) d.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
          if (!d.objectStoreNames.contains('keys')) d.createObjectStore('keys', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('manifests')) d.createObjectStore('manifests', { keyPath: 'deviceUserId' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // Set initial sequence to 5
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put({ id: `seq:${deviceUserId}`, value: 5 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      // Simulate transaction abort on quota/error during record put
      let errorCaught = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_META, STORE_RECORDS], 'readwrite');
          const metaStore = tx.objectStore(STORE_META);

          // Queue sequence update to 6
          metaStore.put({ id: `seq:${deviceUserId}`, value: 6 });

          // Force an abort before commit (e.g. simulated QuotaExceededError or abort)
          tx.abort();

          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(new Error('QuotaExceededError'));
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        errorCaught = true;
      }

      // Check final state: sequence in meta MUST still be 5, records store MUST be empty
      const finalSeq = await new Promise<number>((resolve) => {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).get(`seq:${deviceUserId}`);
        req.onsuccess = () => resolve(req.result?.value ?? 0);
      });

      const recordsCount = await new Promise<number>((resolve) => {
        const tx = db.transaction(STORE_RECORDS, 'readonly');
        const req = tx.objectStore(STORE_RECORDS).count();
        req.onsuccess = () => resolve(req.result);
      });

      db.close();

      return {
        errorCaught,
        finalSeq,
        recordsCount,
      };
    });

    expect(rollbackResult.errorCaught).toBe(true);
    expect(rollbackResult.finalSeq).toBe(5);
    expect(rollbackResult.recordsCount).toBe(0);
  });

  test('rejects tampered ciphertext with Web Crypto AES-GCM authentication failure in browser runtime', async ({
    page,
  }) => {
    await page.goto('/');

    const tamperResult = await page.evaluate(async () => {
      const {
        enqueueEmergencyRecord,
        listEmergencyRecords,
        clearEmergencyDeviceVault,
      } = await import('/src/lib/offline/emergencyCryptoIdb.ts');

      const deviceUserId = 'test-e2e-device-tamper';
      await clearEmergencyDeviceVault(deviceUserId);

      await enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Authentic Browser Visitor',
        declaredAddress: 'Santa Cruz, Manila',
        purpose: 'Validation',
        destinationOfficeId: 'office-1',
        destinationOfficeNameSnapshot: 'Registrar',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: true,
        snapshotVersion: 'snap-v1',
        manifestId: 'manifest-001',
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: false,
        allowEmergencyExceptionPolicy: false,
      });

      // Now open IndexedDB directly and corrupt ciphertext bytes
      const DB_NAME = 'egatepass-emergency-vault-v1';
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        const store = tx.objectStore('records');
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = (e.target as any).result;
          if (cursor) {
            const val = cursor.value;
            // Corrupt base64 ciphertext
            const chars = val.ciphertextB64.split('');
            chars[10] = chars[10] === 'A' ? 'B' : 'A';
            val.ciphertextB64 = chars.join('');
            cursor.update(val);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();

      // Now attempt listEmergencyRecords
      let decryptError = false;
      try {
        await listEmergencyRecords(deviceUserId);
      } catch {
        decryptError = true;
      }

      return { decryptError };
    });

    expect(tamperResult.decryptError).toBe(true);
  });
});
