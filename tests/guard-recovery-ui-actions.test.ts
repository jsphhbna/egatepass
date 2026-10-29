/** @vitest-environment happy-dom */
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveCachedVisitors,
  getOfflineEvents,
  type CachedVisitorPass,
} from '@/lib/offline/guardIndexedDb';
import { GuardVisitorRecoveryTab } from '@/components/guard/GuardVisitorRecoveryTab';

// Mock Supabase
vi.mock('@/lib/supabase', () => {
  const client: any = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
    schema: () => client,
    rpc: vi.fn(),
  };
  return {
    requireSupabase: () => client,
  };
});

describe('GuardVisitorRecoveryTab UI Actions Actor-Binding (P0 Invariant)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setupMockIndexedDb();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function triggerSearch(query: string) {
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(input, query);
      } else {
        input.value = query;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Wait for the 300ms debounce in useEffect
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
  }

  it('offline Approve Entry creates event strictly bound to actorId and action approve_entry', async () => {
    const actorId = 'guard-officer-a';
    const passId = 'pass-recovery-approve-1';

    const testPass: CachedVisitorPass = {
      actorId,
      id: passId,
      passId,
      publicReference: 'EG-APPROV01',
      passReference: 'EG-APPROV01',
      visitorId: 'vis-app-1',
      visitorName: 'Approve Test Visitor',
      contactNumber: '09171112222',
      purpose: 'Meeting',
      visitDate: '2026-10-27',
      status: 'issued',
      version: 1,
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      cachedAt: new Date().toISOString(),
    };

    await saveCachedVisitors(actorId, [testPass]);

    await act(async () => {
      root.render(
        React.createElement(GuardVisitorRecoveryTab, {
          isBackendOnline: false,
          actorId,
        })
      );
    });

    await triggerSearch('Approve Test');

    // Find Approve Entry button
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Approve Entry')
    );
    expect(approveBtn).toBeDefined();

    await act(async () => {
      approveBtn!.click();
    });

    // Assert offline event was queued with mandatory actorId and action 'approve_entry'
    const events = await getOfflineEvents(actorId);
    expect(events.length).toBe(1);
    expect(events[0]?.actorId).toBe(actorId);
    expect(events[0]?.passId).toBe(passId);
    expect(events[0]?.action).toBe('approve_entry');
    expect(events[0]?.expectedStatus).toBe('issued');
  });

  it('offline Reject Entry creates event strictly bound to actorId and action reject_entry with reason', async () => {
    const actorId = 'guard-officer-a';
    const passId = 'pass-recovery-reject-2';

    const testPass: CachedVisitorPass = {
      actorId,
      id: passId,
      passId,
      publicReference: 'EG-REJECT02',
      passReference: 'EG-REJECT02',
      visitorId: 'vis-rej-2',
      visitorName: 'Reject Test Visitor',
      contactNumber: '09173334444',
      purpose: 'Inquiry',
      visitDate: '2026-10-27',
      status: 'issued',
      version: 1,
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      cachedAt: new Date().toISOString(),
    };

    await saveCachedVisitors(actorId, [testPass]);

    await act(async () => {
      root.render(
        React.createElement(GuardVisitorRecoveryTab, {
          isBackendOnline: false,
          actorId,
        })
      );
    });

    await triggerSearch('Reject Test');

    // Click Reject button to open modal
    const rejectBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Reject'
    );
    expect(rejectBtn).toBeDefined();

    await act(async () => {
      rejectBtn!.click();
    });

    // Modal textarea
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, 'Invalid identification presented');
      } else {
        textarea!.value = 'Invalid identification presented';
      }
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      textarea!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Click Confirm Rejection
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Confirm Rejection')
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
    });

    // Assert offline event was queued with actorId and action 'reject_entry'
    const events = await getOfflineEvents(actorId);
    expect(events.length).toBe(1);
    expect(events[0]?.actorId).toBe(actorId);
    expect(events[0]?.passId).toBe(passId);
    expect(events[0]?.action).toBe('reject_entry');
    expect(events[0]?.reason).toBe('Invalid identification presented');
  });

  it('offline Record Exit creates event strictly bound to actorId and action record_exit', async () => {
    const actorId = 'guard-officer-a';
    const passId = 'pass-recovery-exit-3';

    const testPass: CachedVisitorPass = {
      actorId,
      id: passId,
      passId,
      publicReference: 'EG-EXIT0003',
      passReference: 'EG-EXIT0003',
      visitorId: 'vis-exit-3',
      visitorName: 'Exit Test Visitor',
      contactNumber: '09175556666',
      purpose: 'Departure',
      visitDate: '2026-10-27',
      status: 'inside',
      version: 2,
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      timeIn: '2026-10-27T09:00:00+08:00',
      cachedAt: new Date().toISOString(),
    };

    await saveCachedVisitors(actorId, [testPass]);

    await act(async () => {
      root.render(
        React.createElement(GuardVisitorRecoveryTab, {
          isBackendOnline: false,
          actorId,
        })
      );
    });

    await triggerSearch('Exit Test');

    // Record Exit button
    const exitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Record Exit')
    );
    expect(exitBtn).toBeDefined();

    await act(async () => {
      exitBtn!.click();
    });

    // Assert offline event was queued with actorId and action 'record_exit'
    const events = await getOfflineEvents(actorId);
    expect(events.length).toBe(1);
    expect(events[0]?.actorId).toBe(actorId);
    expect(events[0]?.passId).toBe(passId);
    expect(events[0]?.action).toBe('record_exit');
    expect(events[0]?.expectedStatus).toBe('inside');
  });
});
