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
  public indexNames = {
    contains: (_name: string) => true,
  };

  createIndex(_name: string, _keyPath: string, _options?: any) {
    return {};
  }

  constructor(
    public name: string,
    public data: Map<string, any>,
    public keyPath: string = 'id',
    public tx?: MockIDBTransaction
  ) {}

  put(val: any): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    const key = val[this.keyPath] || val.key || val.id;
    this.data.set(key, val);
    setTimeout(() => {
      req.triggerSuccess(key);
      if (this.tx) this.tx.donePending();
    }, 0);
    return req;
  }

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    const val = this.data.get(key);
    setTimeout(() => {
      req.triggerSuccess(val);
      if (this.tx) this.tx.donePending();
    }, 0);
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    this.data.delete(key);
    setTimeout(() => {
      req.triggerSuccess(undefined);
      if (this.tx) this.tx.donePending();
    }, 0);
    return req;
  }

  clear(): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    this.data.clear();
    setTimeout(() => {
      req.triggerSuccess(undefined);
      if (this.tx) this.tx.donePending();
    }, 0);
    return req;
  }

  getAll(): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    const all = Array.from(this.data.values());
    setTimeout(() => {
      req.triggerSuccess(all);
      if (this.tx) this.tx.donePending();
    }, 0);
    return req;
  }

  openCursor(): MockIDBRequest {
    const req = new MockIDBRequest();
    if (this.tx) this.tx.addPending();
    const items = Array.from(this.data.entries());
    let idx = 0;

    const advanceCursor = () => {
      if (idx < items.length) {
        const [k, v] = items[idx]!;
        const cursor = {
          value: v,
          key: k,
          update: (newVal: any) => {
            this.data.set(k, newVal);
            cursor.value = newVal;
          },
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
        if (this.tx) this.tx.donePending();
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
  private pendingRequests = 0;
  private timer: any = null;

  constructor(public db: MockIDBDatabase, public storeNames: string[], public mode: string) {
    this.scheduleCheck();
  }

  addPending() {
    this.pendingRequests++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  donePending() {
    this.pendingRequests--;
    this.scheduleCheck();
  }

  scheduleCheck() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.pendingRequests <= 0) {
        if (this.oncomplete) this.oncomplete();
      }
    }, 15);
  }

  objectStore(name: string) {
    return new MockIDBObjectStore(name, this.db.getStoreMap(name), this.db.keyPaths.get(name) || 'id', this);
  }

  abort() {
    if (this.timer) clearTimeout(this.timer);
    this.error = new Error('Transaction aborted');
    if (this.onerror) this.onerror({ target: this });
  }
}

class MockIDBDatabase {
  public stores = new Map<string, Map<string, any>>();
  public keyPaths = new Map<string, string>();
  public version = 2;

  get objectStoreNames() {
    return {
      contains: (name: string) => this.stores.has(name),
    };
  }

  createObjectStore(name: string, options?: { keyPath?: string }) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
      this.keyPaths.set(name, options?.keyPath || 'id');
    }
    return new MockIDBObjectStore(name, this.stores.get(name)!, options?.keyPath || 'id');
  }

  getStoreMap(name: string) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return this.stores.get(name)!;
  }

  getStore(name: string) {
    const keyPath = this.keyPaths.get(name) || 'id';
    return new MockIDBObjectStore(name, this.getStoreMap(name), keyPath);
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
