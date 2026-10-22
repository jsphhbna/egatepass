import { describe, expect, it, vi } from 'vitest';
import { ObjectUrlLifecycle } from '../src/hooks/useObjectUrl.js';

describe('FIX: Object URL Lifecycle & Unmount Cleanup', () => {
  it('revokes previous URL A when replaced by URL B', () => {
    const revoked: string[] = [];
    const manager = new ObjectUrlLifecycle((url) => revoked.push(url));

    manager.set('blob:http://localhost/url-a');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/url-a');
    expect(revoked).toEqual([]);

    // Replace with URL B
    manager.set('blob:http://localhost/url-b');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/url-b');
    expect(revoked).toEqual(['blob:http://localhost/url-a']);

    // Setting same URL should not re-revoke
    manager.set('blob:http://localhost/url-b');
    expect(revoked).toEqual(['blob:http://localhost/url-a']);
  });

  it('revokes current URL B when clear() is called', () => {
    const revoked: string[] = [];
    const manager = new ObjectUrlLifecycle((url) => revoked.push(url));

    manager.set('blob:http://localhost/url-b');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/url-b');

    manager.clear();
    expect(manager.getCurrentUrl()).toBeNull();
    expect(revoked).toEqual(['blob:http://localhost/url-b']);

    // Subsequent clear on empty manager is safely idempotent
    manager.clear();
    expect(revoked).toEqual(['blob:http://localhost/url-b']);
  });

  it('revokes current URL upon unmount/dispose() avoiding stale-closure leaks', () => {
    const revoked: string[] = [];
    const manager = new ObjectUrlLifecycle((url) => revoked.push(url));

    // Simulate user capturing photo after initial render
    manager.set('blob:http://localhost/photo-captured-after-mount');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/photo-captured-after-mount');
    expect(revoked).toEqual([]);

    // Component unmount invokes dispose()
    manager.dispose();
    expect(manager.getCurrentUrl()).toBeNull();
    expect(revoked).toEqual(['blob:http://localhost/photo-captured-after-mount']);
  });

  it('isolates photo lifecycle from ID lifecycle: operations on photo do not affect ID and vice versa', () => {
    const photoRevoked: string[] = [];
    const idRevoked: string[] = [];

    const photoLifecycle = new ObjectUrlLifecycle((url) => photoRevoked.push(url));
    const idLifecycle = new ObjectUrlLifecycle((url) => idRevoked.push(url));

    photoLifecycle.set('blob:http://localhost/selfie-v1');
    idLifecycle.set('blob:http://localhost/id-v1');

    expect(photoRevoked).toEqual([]);
    expect(idRevoked).toEqual([]);

    // 1. Retake photo clears photo URL only
    photoLifecycle.clear();
    expect(photoRevoked).toEqual(['blob:http://localhost/selfie-v1']);
    expect(idRevoked).toEqual([]); // ID remains intact!
    expect(idLifecycle.getCurrentUrl()).toBe('blob:http://localhost/id-v1');

    // 2. New selfie captured
    photoLifecycle.set('blob:http://localhost/selfie-v2');
    expect(photoRevoked).toEqual(['blob:http://localhost/selfie-v1']);

    // 3. Retake ID clears ID URL only
    idLifecycle.clear();
    expect(idRevoked).toEqual(['blob:http://localhost/id-v1']);
    expect(photoRevoked).toEqual(['blob:http://localhost/selfie-v1']); // Photo untouched!
    expect(photoLifecycle.getCurrentUrl()).toBe('blob:http://localhost/selfie-v2');

    // 4. New ID captured
    idLifecycle.set('blob:http://localhost/id-v2');

    // 5. Next visitor clears both independently
    photoLifecycle.clear();
    idLifecycle.clear();
    expect(photoRevoked).toEqual(['blob:http://localhost/selfie-v1', 'blob:http://localhost/selfie-v2']);
    expect(idRevoked).toEqual(['blob:http://localhost/id-v1', 'blob:http://localhost/id-v2']);
  });

  it('createFromBlob automatically revokes existing URL and stores new URL', () => {
    const revoked: string[] = [];
    let counter = 0;
    const fakeCreator = vi.fn(() => `blob:http://localhost/auto-${++counter}`);
    const manager = new ObjectUrlLifecycle((url) => revoked.push(url));

    const dummyBlob1 = new Blob(['1']);
    const dummyBlob2 = new Blob(['2']);

    const url1 = manager.createFromBlob(dummyBlob1, fakeCreator);
    expect(url1).toBe('blob:http://localhost/auto-1');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/auto-1');
    expect(revoked).toEqual([]);

    const url2 = manager.createFromBlob(dummyBlob2, fakeCreator);
    expect(url2).toBe('blob:http://localhost/auto-2');
    expect(manager.getCurrentUrl()).toBe('blob:http://localhost/auto-2');
    expect(revoked).toEqual(['blob:http://localhost/auto-1']);

    manager.dispose();
    expect(revoked).toEqual(['blob:http://localhost/auto-1', 'blob:http://localhost/auto-2']);
  });
});
