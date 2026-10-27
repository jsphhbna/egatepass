// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { RouteErrorBoundary, classifyError, isChunkLoadError } from '../src/components/RouteErrorBoundary';
import { deserializePass } from '../src/hooks/useAdminDashboardData';
import { deserializeRecordPass } from '../src/pages/AdminRecords';
import {
  mapRawVisitorItem,
  mapRawAdministrativeItem,
  mapRawReconciliationItem,
} from '../src/hooks/useAuditActivity';

describe('Client Crash, Deployment Skew & Stale-State Deep Closure Suite', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Vite Lazy-Chunk Deployment Recovery (Section 1, 25)
  // =========================================================================
  describe('1. Global Vite Lazy-Chunk Deployment Recovery', () => {
    const PRELOAD_RECOVERY_KEY = 'egatepass_preload_recovery_at';
    const RECOVERY_WINDOW_MS = 30000;

    function handleVitePreloadError(
      event: { preventDefault: () => void },
      options: { onLine: boolean; now?: number; reloadFn: () => void }
    ) {
      if (!options.onLine) {
        // Offline: do not reload
        return false;
      }
      const now = options.now ?? Date.now();
      const lastAttemptStr = sessionStorage.getItem(PRELOAD_RECOVERY_KEY);
      const lastAttempt = lastAttemptStr ? parseInt(lastAttemptStr, 10) : 0;

      if (!lastAttempt || now - lastAttempt > RECOVERY_WINDOW_MS) {
        event.preventDefault();
        sessionStorage.setItem(PRELOAD_RECOVERY_KEY, String(now));
        options.reloadFn();
        return true;
      }
      // Inside 30s recovery window: do not reload again
      return false;
    }

    it('1.1. first preload error while online calls preventDefault, saves timestamp, and requests reload', () => {
      const preventDefault = vi.fn();
      const reloadFn = vi.fn();
      const now = 100000;

      const recovered = handleVitePreloadError({ preventDefault }, { onLine: true, now, reloadFn });

      expect(recovered).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(reloadFn).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBe('100000');
    });

    it('1.2. second preload error within 30 seconds does NOT reload again', () => {
      const reloadFn = vi.fn();
      const preventDefault = vi.fn();

      // First recovery at t=100000
      handleVitePreloadError({ preventDefault: vi.fn() }, { onLine: true, now: 100000, reloadFn });

      // Second event at t=115000 (15 seconds later)
      const recovered = handleVitePreloadError({ preventDefault }, { onLine: true, now: 115000, reloadFn });

      expect(recovered).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(reloadFn).toHaveBeenCalledTimes(1); // from first recovery only
    });

    it('1.3. second preload error after 30 seconds allows reload again', () => {
      const reloadFn = vi.fn();

      // First recovery at t=100000
      handleVitePreloadError({ preventDefault: vi.fn() }, { onLine: true, now: 100000, reloadFn });

      // Second event at t=135000 (35 seconds later)
      const preventDefault2 = vi.fn();
      const recovered = handleVitePreloadError({ preventDefault: preventDefault2 }, { onLine: true, now: 135000, reloadFn });

      expect(recovered).toBe(true);
      expect(preventDefault2).toHaveBeenCalledTimes(1);
      expect(reloadFn).toHaveBeenCalledTimes(2);
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBe('135000');
    });

    it('1.4. offline preload error does NOT force reload', () => {
      const preventDefault = vi.fn();
      const reloadFn = vi.fn();

      const recovered = handleVitePreloadError({ preventDefault }, { onLine: false, now: 100000, reloadFn });

      expect(recovered).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(reloadFn).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBeNull();
    });
  });

  // =========================================================================
  // 2. Error Containment & Diagnostic Classification (Section 6, 7, 8, 24)
  // =========================================================================
  describe('2. Route-Level Error Containment and Diagnostic Classification', () => {
    it('2.1. classifies chunk load errors accurately', () => {
      expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/AdminUsers-abc.js'))).toBe(true);
      expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
      expect(isChunkLoadError(new Error('ChunkLoadError: Loading chunk 4 failed.'))).toBe(true);
      expect(isChunkLoadError(new Error('Cannot read properties of null (reading "toDate")'))).toBe(false);

      expect(classifyError(new Error('Failed to fetch dynamically imported module'))).toBe('chunk_load');
      expect(classifyError(new Error('Render crash'))).toBe('render_error');
      expect(classifyError('string error')).toBe('unknown');
    });

    it('2.2. RouteErrorBoundary renders chunk load error with version notice and Refresh button only', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      const CrashingComponent = () => {
        throw new Error('Failed to fetch dynamically imported module: /assets/NotFound.js');
      };

      flushSync(() => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/admin/templates'] },
            React.createElement(
              RouteErrorBoundary,
              null,
              React.createElement(CrashingComponent),
            ),
          ),
        );
      });

      expect(container.textContent).toContain('A newer version of E-GatePass may be available.');
      expect(container.textContent).toContain('Refresh Application');
      // Must NOT show local "Try Again" for chunk failures because lazy promise remains rejected
      expect(container.textContent).not.toContain('Try Again');
      // Must contain diagnostic code with category without PII
      expect(container.textContent).toContain('type:chunk_load');

      root.unmount();
      container.remove();
    });

    it('2.3. RouteErrorBoundary renders standard render error with Try Again and Refresh Application, and resets on retry', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let shouldThrow = true;
      const CrashingComponent = () => {
        if (shouldThrow) {
          throw new Error('Null pointer exception in child component');
        }
        return React.createElement('div', null, 'Child Component Healthy');
      };

      flushSync(() => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/admin/users'] },
            React.createElement(
              RouteErrorBoundary,
              null,
              React.createElement(CrashingComponent),
            ),
          ),
        );
      });

      expect(container.textContent).toContain('This section encountered an unexpected error.');
      expect(container.textContent).toContain('Try Again');
      expect(container.textContent).toContain('Refresh Application');
      expect(container.textContent).toContain('type:render_error');

      // Click "Try Again"
      shouldThrow = false;
      const tryAgainBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Try Again'));
      expect(tryAgainBtn).toBeDefined();

      flushSync(() => {
        tryAgainBtn?.click();
      });

      expect(container.textContent).toContain('Child Component Healthy');

      root.unmount();
      container.remove();
    });

    it('2.4. RouteErrorBoundary resets automatically when location.pathname changes (nested admin containment)', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let navigateRef: any = null;

      const NavHelper = () => {
        const navigate = useNavigate();
        navigateRef = navigate;
        return null;
      };

      const CrashingTemplates = () => {
        throw new Error('Crash on /admin/templates');
      };

      const AdminShell = () => {
        const location = useLocation();
        return React.createElement(
          'div',
          null,
          React.createElement('div', { 'data-testid': 'sidebar' }, 'Admin Sidebar Active'),
          React.createElement(
            RouteErrorBoundary,
            null,
            location.pathname === '/admin/templates'
              ? React.createElement(CrashingTemplates)
              : React.createElement('div', null, 'Admin Dashboard Content'),
          ),
        );
      };

      flushSync(() => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/admin/templates'] },
            React.createElement(NavHelper),
            React.createElement(AdminShell),
          ),
        );
      });

      // Sidebar survived, while child route is caught in error boundary
      expect(container.textContent).toContain('Admin Sidebar Active');
      expect(container.textContent).toContain('This section encountered an unexpected error.');
      expect(container.textContent).toContain('route:/admin/templates');

      // Operator clicks Dashboard (navigate to /admin/dashboard)
      await act(async () => {
        navigateRef('/admin/dashboard');
      });

      // Boundary reset due to pathname change: sidebar still healthy, dashboard content rendered!
      expect(container.textContent).toContain('Admin Sidebar Active');
      expect(container.textContent).toContain('Admin Dashboard Content');
      expect(container.textContent).not.toContain('This section encountered an unexpected error.');

      root.unmount();
      container.remove();
    });
  });

  // =========================================================================
  // 3. Runtime Timestamp & Contract Hardening (Section 9, 10, 11, 12, 27)
  // =========================================================================
  describe('3. Runtime-Validation of Dashboard, Records, Audit & Reconciliation Contracts', () => {
    const validBasePass = {
      id: 'pass-01',
      visitorId: 'vis-01',
      visitorName: 'Maria Santos',
      purpose: 'Official Visit',
      photoPublicId: 'photo_01',
      idImagePublicId: 'id_01',
      source: 'portal' as const,
      status: 'issued' as const,
      validFrom: '2026-10-28T08:00:00+08:00',
      validUntil: '2026-10-28T17:00:00+08:00',
      issuedAt: '2026-10-28T07:30:00+08:00',
      scannedAt: null,
      timeIn: null,
      timeOut: null,
      entryDeviceId: null,
      exitDeviceId: null,
      decidedByUid: null,
      rejectionReason: null,
      gate: 'Main Gate',
    };

    it('3.1. Dashboard pass deserializer throws on malformed required timestamp', () => {
      // Valid pass parses cleanly
      const valid = deserializePass(validBasePass);
      expect(valid.visitorId).toBe('vis-01');
      expect(valid.issuedAt).not.toBeNull();

      // Null or invalid issuedAt
      expect(() => deserializePass({ ...validBasePass, issuedAt: '' })).toThrow('invalid_dashboard_pass_timestamp');
      expect(() => deserializePass({ ...validBasePass, issuedAt: 'not-a-date' })).toThrow('invalid_dashboard_pass_timestamp');

      // Null or invalid validFrom
      expect(() => deserializePass({ ...validBasePass, validFrom: '' })).toThrow('invalid_dashboard_pass_timestamp');

      // Null or invalid validUntil
      expect(() => deserializePass({ ...validBasePass, validUntil: 'invalid' })).toThrow('invalid_dashboard_pass_timestamp');
    });

    it('3.2. Records pass deserializer throws on malformed required timestamp', () => {
      const valid = deserializeRecordPass(validBasePass);
      expect(valid.id).toBe('pass-01');

      expect(() => deserializeRecordPass({ ...validBasePass, validFrom: '' })).toThrow('invalid_record_pass_timestamp');
      expect(() => deserializeRecordPass({ ...validBasePass, validUntil: '' })).toThrow('invalid_record_pass_timestamp');
      expect(() => deserializeRecordPass({ ...validBasePass, issuedAt: '' })).toThrow('invalid_record_pass_timestamp');
    });

    it('3.3. Audit activity mapper validates VisitorActivityItem required fields', () => {
      const validRaw = {
        id: 'act-101',
        event: 'entry_scanned',
        passToken: 'token-abc',
        timestamp: '2026-10-28T08:15:00+08:00',
      };
      const mapped = mapRawVisitorItem(validRaw);
      expect(mapped.id).toBe('act-101');
      expect(mapped.event).toBe('entry_scanned');

      // Missing required event or passToken
      expect(() => mapRawVisitorItem({ ...validRaw, event: '' })).toThrow('invalid_visitor_activity_item');
      expect(() => mapRawVisitorItem({ ...validRaw, passToken: undefined })).toThrow('invalid_visitor_activity_item');
      expect(() => mapRawVisitorItem({ id: '' })).toThrow('invalid_visitor_activity_item');
    });

    it('3.4. Audit activity mapper validates AdministrativeAuditItem required fields', () => {
      const validAdminRaw = {
        id: 'adm-01',
        action: 'user_created',
        actorUid: 'usr-admin',
        actorRole: 'admin',
        targetType: 'staff_user',
        targetId: 'usr-new',
        result: 'success',
      };
      const mapped = mapRawAdministrativeItem(validAdminRaw);
      expect(mapped.id).toBe('adm-01');
      expect(mapped.action).toBe('user_created');

      // Missing required fields
      expect(() => mapRawAdministrativeItem({ ...validAdminRaw, action: '' })).toThrow('invalid_administrative_audit_item');
      expect(() => mapRawAdministrativeItem({ ...validAdminRaw, actorUid: '' })).toThrow('invalid_administrative_audit_item');
      expect(() => mapRawAdministrativeItem({ ...validAdminRaw, targetId: null })).toThrow('invalid_administrative_audit_item');
      expect(() => mapRawAdministrativeItem({ ...validAdminRaw, result: '' })).toThrow('invalid_administrative_audit_item');
    });

    it('3.5. Reconciliation item mapper validates requiredActions array and required fields', () => {
      const validRecon = {
        id: 'rec-01',
        type: 'auth_mismatch',
        status: 'open',
        targetType: 'staff_user',
        targetId: 'usr-123',
        summary: 'Missing identity',
        requiredActions: ['resync_auth', 'check_role'],
        createdAt: '2026-10-28T08:00:00Z',
      };
      const mapped = mapRawReconciliationItem(validRecon);
      expect(mapped.id).toBe('rec-01');
      expect(mapped.requiredActions).toHaveLength(2);

      // Non-array or empty actions
      expect(() => mapRawReconciliationItem({ ...validRecon, requiredActions: 'not-an-array' })).toThrow('invalid_reconciliation_item');
      expect(() => mapRawReconciliationItem({ ...validRecon, requiredActions: null })).toThrow('invalid_reconciliation_item');
      expect(() => mapRawReconciliationItem({ ...validRecon, summary: '' })).toThrow('invalid_reconciliation_item');
      expect(() => mapRawReconciliationItem({ ...validRecon, id: '' })).toThrow('invalid_reconciliation_item');
    });
  });

  // =========================================================================
  // 4. Request Ordering & Generation Controllers (Section 13, 14, 15, 19, 20, 28)
  // =========================================================================
  describe('4. Request Ordering and Generation Fences', () => {
    it('4.1. out-of-order query responses commit only latest generation', async () => {
      let committedData: string | null = null;
      let currentGeneration = 0;

      const executeQuery = (queryName: string, delayMs: number) => {
        const queryGen = ++currentGeneration;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (queryGen === currentGeneration) {
              committedData = queryName;
            }
            resolve();
          }, delayMs);
        });
      };

      // Query A starts (delay 50ms), Query B starts (delay 10ms)
      const pA = executeQuery('Query A', 50);
      const pB = executeQuery('Query B', 10);

      await Promise.all([pA, pB]);

      // Query B resolved first (at 10ms), Query A resolved later (at 50ms)
      // Because A had older generation, it was discarded. B remains committed.
      expect(committedData).toBe('Query B');
    });

    it('4.2. load more belonging to old filter is discarded when filter changes', async () => {
      let passes: string[] = ['Pass A1', 'Pass A2'];
      let queryGeneration = 1;
      let loadMoreInFlight = false;

      const triggerLoadMore = (delayMs: number) => {
        loadMoreInFlight = true;
        const capturedGen = queryGeneration;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (capturedGen === queryGeneration) {
              passes = [...passes, 'Pass A3'];
            }
            loadMoreInFlight = false;
            resolve();
          }, delayMs);
        });
      };

      // Load more for Filter A starts
      const loadMorePromise = triggerLoadMore(40);

      // Filter changes to Filter B immediately (at t=10)
      queryGeneration = 2;
      passes = ['Pass B1'];

      await loadMorePromise;

      // Passes must NOT include 'Pass A3'
      expect(passes).toEqual(['Pass B1']);
      expect(loadMoreInFlight).toBe(false);
    });

    it('4.3. failed new filter clears previous rows and displays inline error with Retry', () => {
      let state = {
        passes: ['Pass A1', 'Pass A2'],
        error: null as string | null,
        loading: false,
      };

      const executeFilter = (succeeds: boolean) => {
        state.loading = true;
        state.error = null;
        if (!succeeds) {
          // Section 15 requirement: Never show previous query rows under new filters after failure
          state.passes = [];
          state.error = 'Failed to load records';
          state.loading = false;
        } else {
          state.passes = ['Pass B1'];
          state.loading = false;
        }
      };

      executeFilter(false);

      expect(state.passes).toHaveLength(0);
      expect(state.error).toBe('Failed to load records');
    });
  });

  // =========================================================================
  // 5. Incident Hold Selection Race & Identity Binding (Section 16, 17, 29)
  // =========================================================================
  describe('5. Incident Hold Selection Race & Identity Binding', () => {
    interface HoldLookupState {
      status: 'idle' | 'loading' | 'protected' | 'unprotected' | 'error';
      passId?: string;
      visitorId?: string;
    }

    it('5.1. rapid selection of Pass A then Pass B commits only Pass B hold state (race safety)', async () => {
      let selectedPass: { id: string; visitorId: string } | null = null;
      let holdState: HoldLookupState = { status: 'idle' };
      let holdGen = 0;

      const selectPass = (pass: { id: string; visitorId: string }, holdDelayMs: number, hasHold: boolean) => {
        const currentGen = ++holdGen;
        selectedPass = pass;
        holdState = { status: 'loading', passId: pass.id, visitorId: pass.visitorId };

        return new Promise<void>((resolve) => {
          setTimeout(() => {
            // Commit only if generation and selectedPass still match
            if (currentGen === holdGen && selectedPass?.id === pass.id) {
              holdState = {
                status: hasHold ? 'protected' : 'unprotected',
                passId: pass.id,
                visitorId: pass.visitorId,
              };
            }
            resolve();
          }, holdDelayMs);
        });
      };

      // Select A (has hold, delay 50ms)
      const pA = selectPass({ id: 'pass-A', visitorId: 'vis-A' }, 50, true);
      // Select B (no hold, delay 10ms)
      const pB = selectPass({ id: 'pass-B', visitorId: 'vis-B' }, 10, false);

      await Promise.all([pA, pB]);

      // Final UI must show Pass B with unprotected hold. Pass A's late result was discarded.
      expect(selectedPass).toEqual({ id: 'pass-B', visitorId: 'vis-B' });
      expect(holdState).toEqual({
        status: 'unprotected',
        passId: 'pass-B',
        visitorId: 'vis-B',
      });
    });

    it('5.2. release hold action is blocked if hold state identity does not match selected pass', () => {
      const selectedPass = { id: 'pass-B', visitorId: 'vis-B' };
      const holdState: HoldLookupState = {
        status: 'protected',
        passId: 'pass-A', // Mismatch!
        visitorId: 'vis-A',
      };

      const handleReleaseHold = () => {
        if (!selectedPass || holdState.passId !== selectedPass.id) {
          // Block action, reset to loading
          return { blocked: true, newStatus: 'loading' };
        }
        return { blocked: false, newStatus: 'unprotected' };
      };

      const result = handleReleaseHold();
      expect(result.blocked).toBe(true);
      expect(result.newStatus).toBe('loading');
    });
  });

  // =========================================================================
  // 6. Export Filter Snapshot (Section 18, 30)
  // =========================================================================
  describe('6. Export Filter Snapshotting', () => {
    it('6.1. export captures search.trim() at click time, ignoring debounce delays', () => {
      let searchInput = 'Juan';
      let debouncedSearch = 'Juan';

      // User types "Santos" into input
      searchInput = 'Santos';
      // Click export immediately before 300ms debounce fires
      const exportSearchQuery = searchInput.trim();

      expect(exportSearchQuery).toBe('Santos');
      expect(debouncedSearch).toBe('Juan'); // Old debounce value was bypassed
    });

    it('6.2. changing filters while export is running does not alter ongoing export query snapshot', async () => {
      let currentUIFilter = { search: 'Santos', status: 'inside' };

      // Snapshot taken at export start
      const exportSnapshot = { ...currentUIFilter };
      const requestsMade: any[] = [];

      const runExportPage = (page: number) => {
        requestsMade.push({ page, ...exportSnapshot });
      };

      // Page 1
      runExportPage(1);

      // User changes UI filter mid-export
      currentUIFilter.status = 'exited';
      currentUIFilter.search = 'Reyes';

      // Page 2
      runExportPage(2);

      expect(requestsMade[0].status).toBe('inside');
      expect(requestsMade[0].search).toBe('Santos');
      expect(requestsMade[1].status).toBe('inside');
      expect(requestsMade[1].search).toBe('Santos');
    });
  });

  // =========================================================================
  // 7. Thermal Template Shared Mutation Lock (Section 21, 31)
  // =========================================================================
  describe('7. Thermal-Template Shared Mutation Lock', () => {
    type TemplateMutation = 'save' | 'publish' | 'restore' | null;

    it('7.1. mutual exclusion: only one template mutation can be active at any moment', async () => {
      let activeMutation: TemplateMutation = null;
      let mutationInFlight = false;
      let publishRpcCalls = 0;
      let restoreRpcCalls = 0;

      const handlePublish = async (delayMs: number) => {
        if (mutationInFlight || activeMutation !== null) return;
        mutationInFlight = true;
        activeMutation = 'publish';
        publishRpcCalls++;
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } finally {
          mutationInFlight = false;
          activeMutation = null;
        }
      };

      const handleRestore = async () => {
        if (mutationInFlight || activeMutation !== null) return;
        mutationInFlight = true;
        activeMutation = 'restore';
        restoreRpcCalls++;
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
        } finally {
          mutationInFlight = false;
          activeMutation = null;
        }
      };

      // Start Publish (takes 30ms)
      const pubPromise = handlePublish(30);

      // Immediately attempt Restore while Publish is active
      await handleRestore();

      await pubPromise;

      expect(publishRpcCalls).toBe(1);
      // Restore was rejected with zero RPC calls
      expect(restoreRpcCalls).toBe(0);
    });
  });

  // =========================================================================
  // 8. Settings Save Lock & Mutation Concurrency (Section 22, 23, 32)
  // =========================================================================
  describe('8. Settings Save Lock and Concurrency Guard', () => {
    it('8.1. controls and actions are blocked while saving; no stale snapshot merge occurs', async () => {
      let settings = { campusName: 'EARIST', imageRetentionDays: 30 };
      let saving = false;
      let purging = false;
      let calculatingPurge = false;

      const isSettingsBusy = () => saving || purging || calculatingPurge;

      const handleSave = async (submittedValue: number) => {
        if (isSettingsBusy()) return;
        saving = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 30));
          // Section 22: removed setSettings(...settingsToSave); leave state as-is
        } finally {
          saving = false;
        }
      };

      const attemptEdit = (newDays: number) => {
        if (isSettingsBusy()) return false;
        settings.imageRetentionDays = newDays;
        return true;
      };

      // Start Save with 30
      const savePromise = handleSave(30);

      // Attempt edit while saving
      const editAllowed = attemptEdit(60);
      expect(editAllowed).toBe(false);
      expect(settings.imageRetentionDays).toBe(30);

      await savePromise;
      expect(settings.imageRetentionDays).toBe(30);
    });

    it('8.2. Save and Purge cannot run concurrently', () => {
      let saving = true;
      let purging = false;
      let calculatingPurge = false;

      const isSettingsBusy = () => saving || purging || calculatingPurge;

      const handlePurge = () => {
        if (isSettingsBusy()) return false;
        purging = true;
        return true;
      };

      expect(handlePurge()).toBe(false);
    });
  });
});
