/**
 * Lightweight in-memory IndexedDB mock for Vitest unit/integration testing
 */

class MockIDBRequest {
  public result: any = null;
  public error: any = null;
  public onsuccess: ((e: any) => void) | null = null;
  public onerror: ((e: any) => void) | null = null;

  triggerSuccess(result: any) {
    this.result = result;
    if (this.onsuccess) {
      this.onsuccess({ target: this });
    }
  }

  triggerError(err: any) {
    this.error = err;
    if (this.onerror) {
      this.onerror({ target: this });
    }
  }
}

class MockIDBObjectStore {
  constructor(public name: string, public data: Map<string, any>, public keyPath: string = 'id') {}

  put(val: any): MockIDBRequest {
    const req = new MockIDBRequest();
    const key = val[this.keyPath] || val.key || val.id;
    this.data.set(key, val);
    setTimeout(() => req.triggerSuccess(key), 0);
    return req;
  }

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    const val = this.data.get(key);
    setTimeout(() => req.triggerSuccess(val), 0);
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    this.data.delete(key);
    setTimeout(() => req.triggerSuccess(undefined), 0);
    return req;
  }

  clear(): MockIDBRequest {
    const req = new MockIDBRequest();
    this.data.clear();
    setTimeout(() => req.triggerSuccess(undefined), 0);
    return req;
  }

  getAll(): MockIDBRequest {
    const req = new MockIDBRequest();
    const all = Array.from(this.data.values());
    setTimeout(() => req.triggerSuccess(all), 0);
    return req;
  }

  openCursor(): MockIDBRequest {
    const req = new MockIDBRequest();
    const items = Array.from(this.data.entries());
    let idx = 0;

    const advanceCursor = () => {
      if (idx < items.length) {
        const [k, v] = items[idx]!;
        const cursor = {
          value: v,
          key: k,
          delete: () => {
            this.data.delete(k);
          },
          continue: () => {
            idx++;
            advanceCursor();
          },
        };
        req.triggerSuccess(cursor);
      } else {
        req.triggerSuccess(null);
      }
    };

    setTimeout(() => advanceCursor(), 0);
    return req;
  }
}

class MockIDBTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public error: any = null;

  constructor(public db: MockIDBDatabase, public storeNames: string[], public mode: string) {
    setTimeout(() => {
      if (this.oncomplete) this.oncomplete();
    }, 5);
  }

  objectStore(name: string) {
    return this.db.getStore(name);
  }
}

class MockIDBDatabase {
  public stores = new Map<string, Map<string, any>>();
  public keyPaths = new Map<string, string>();

  createObjectStore(name: string, options?: { keyPath?: string }) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
      this.keyPaths.set(name, options?.keyPath || 'id');
    }
    return new MockIDBObjectStore(name, this.stores.get(name)!, options?.keyPath || 'id');
  }

  getStore(name: string) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    const keyPath = this.keyPaths.get(name) || 'id';
    return new MockIDBObjectStore(name, this.stores.get(name)!, keyPath);
  }

  transaction(storeNames: string | string[], mode: string = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new MockIDBTransaction(this, names, mode);
  }
}

export function setupMockIndexedDb() {
  const mockDb = new MockIDBDatabase();
  // Pre-initialize stores
  mockDb.createObjectStore('meta', { keyPath: 'key' });
  mockDb.createObjectStore('cached_visitors', { keyPath: 'id' });
  mockDb.createObjectStore('offline_registrations', { keyPath: 'offlineRegistrationId' });
  mockDb.createObjectStore('offline_events', { keyPath: 'eventId' });

  const mockFactory = {
    open: (name: string, version: number) => {
      const req = new MockIDBRequest();
      setTimeout(() => {
        req.result = mockDb;
        req.triggerSuccess(mockDb);
      }, 0);
      return req;
    },
  };

  (globalThis as any).indexedDB = mockFactory;
  return mockDb;
}
