import { describe, it, expect } from 'vitest';
import { deepFreeze, shouldReuseUploadedIntentForIssue } from '../src/services/visitorRegistration';

describe('Priority 3: Deep Freeze and Idempotency Protection', () => {
  it('1. deepFreeze recursively freezes nested objects and arrays', () => {
    const payload = {
      requestId: 'test-req-id',
      visitor: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        nested: {
          deepKey: 'deepValue',
          arr: [1, 2, { three: 3 }],
        },
      },
      psgc: {
        region: { code: '1300000000', name: 'NCR' },
      },
    };

    const frozen = deepFreeze(payload);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.visitor)).toBe(true);
    expect(Object.isFrozen(frozen.visitor.nested)).toBe(true);
    expect(Object.isFrozen(frozen.visitor.nested.arr)).toBe(true);
    expect(Object.isFrozen(frozen.visitor.nested.arr[2])).toBe(true);
    expect(Object.isFrozen(frozen.psgc)).toBe(true);
    expect(Object.isFrozen(frozen.psgc.region)).toBe(true);

    // Modifying deep property should throw in strict mode
    expect(() => {
      (frozen.visitor.nested as any).deepKey = 'mutated';
    }).toThrow(TypeError);

    expect(() => {
      (frozen.visitor.nested.arr as any)[0] = 999;
    }).toThrow(TypeError);
  });

  it('2. shouldReuseUploadedIntentForIssue returns true for ambiguous and existing_pass_conflict phases', () => {
    const checkpoint = {
      intentId: 'intent-123',
      uploaded: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
    };

    const ambiguousTx: any = {
      phase: 'ambiguous',
      photoIntentId: 'intent-123',
      photoCheckpoint: checkpoint,
    };

    const conflictTx: any = {
      phase: 'existing_pass_conflict',
      photoIntentId: 'intent-123',
      photoCheckpoint: checkpoint,
    };

    const dispatchedTx: any = {
      phase: 'dispatched',
      photoIntentId: 'intent-123',
      photoCheckpoint: checkpoint,
    };

    expect(shouldReuseUploadedIntentForIssue(ambiguousTx, checkpoint, 'intent-123')).toBe(true);
    expect(shouldReuseUploadedIntentForIssue(conflictTx, checkpoint, 'intent-123')).toBe(true);
    expect(shouldReuseUploadedIntentForIssue(dispatchedTx, checkpoint, 'intent-123')).toBe(true);
  });

  it('3. shouldReuseUploadedIntentForIssue returns false if not uploaded', () => {
    const unuploadedCheckpoint = {
      intentId: 'intent-123',
      uploaded: false,
    };

    const tx: any = {
      phase: 'ambiguous',
    };

    expect(shouldReuseUploadedIntentForIssue(tx, unuploadedCheckpoint, 'intent-123')).toBe(false);
  });
});
