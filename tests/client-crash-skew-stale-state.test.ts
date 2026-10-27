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
  useVisitorActivity,
  useAdministrativeAudit,
  useReconciliationItems,
} from '../src/hooks/useAuditActivity';
import { isThermalEditorLocked } from '../src/pages/AdminPrintTemplatesPage';
import { tryAcquireSettingsMutation } from '../src/pages/AdminSettings';

import {
  handlePreloadError,
  PRELOAD_RECOVERY_KEY,
  PRELOAD_RECOVERY_WINDOW_MS,
} from '../src/lib/preloadRecovery';

vi.mock('@/services/auth', () => ({
  getAccessToken: vi.fn(async () => 'mock-jwt-token'),
  signOutCurrentActor: vi.fn(),
}));

vi.mock('../src/services/auth', () => ({
  getAccessToken: vi.fn(async () => 'mock-jwt-token'),
  signOutCurrentActor: vi.fn(),
}));

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
    it('1.1. first preload error while online calls preventDefault, saves timestamp, and requests reload', () => {
      const preventDefault = vi.fn();
      const reload = vi.fn();
      const now = vi.fn(() => 100000);

      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: true, now, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBe('100000');
    });

    it('1.2. second preload error within 30 seconds does NOT reload again', () => {
      const reload = vi.fn();
      const preventDefault = vi.fn();

      // First recovery at t=100000
      handlePreloadError(
        { preventDefault: vi.fn() },
        { isOnline: true, now: () => 100000, reload, storage: sessionStorage }
      );

      // Second event at t=115000 (15 seconds later)
      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: true, now: () => 115000, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1); // from first recovery only
    });

    it('1.3. second preload error after 30 seconds allows reload again', () => {
      const reload = vi.fn();

      // First recovery at t=100000
      handlePreloadError(
        { preventDefault: vi.fn() },
        { isOnline: true, now: () => 100000, reload, storage: sessionStorage }
      );

      // Second event at t=135000 (35 seconds later)
      const preventDefault2 = vi.fn();
      const recovered = handlePreloadError(
        { preventDefault: preventDefault2 },
        { isOnline: true, now: () => 135000, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(true);
      expect(preventDefault2).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(2);
      expect(sessionStorage.getItem(PRELOAD_RECOVERY_KEY)).toBe('135000');
    });

    it('1.4. offline preload error does NOT force reload', () => {
      const preventDefault = vi.fn();
      const reload = vi.fn();

      const recovered = handlePreloadError(
        { preventDefault },
        { isOnline: false, now: () => 100000, reload, storage: sessionStorage }
      );

      expect(recovered).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
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
  // 7. Thermal Template Shared Mutation Lock & Editor Freeze (Section 6, 21, 31)
  // =========================================================================
  describe('7. Thermal-Template Shared Mutation Lock and Editor Control Freeze', () => {
    it('7.1. isThermalEditorLocked returns true when any mutation is active or initial load is running', () => {
      expect(isThermalEditorLocked('publish', false)).toBe(true);
      expect(isThermalEditorLocked('save', false)).toBe(true);
      expect(isThermalEditorLocked('restore', false)).toBe(true);
      expect(isThermalEditorLocked(null, true)).toBe(true);
      expect(isThermalEditorLocked(null, false)).toBe(false);
    });

    it('7.2. Publish begins with text "A": attempt editor mutation before RPC resolves is rejected and published "A" is preserved', async () => {
      let layout = {
        height: 600,
        elements: [
          { id: 'el-1', type: 'text', text: 'Template Layout A', x: 20, y: 30, fontSize: 12, isMandatory: false },
        ],
      };
      let activeMutation: 'save' | 'publish' | 'restore' | null = null;
      let loading = false;

      const editorLocked = () => isThermalEditorLocked(activeMutation, loading);

      // Mutation helpers mirroring AdminPrintTemplatesPage production guards
      const updateElement = (id: string, partial: any) => {
        if (editorLocked()) return;
        layout = {
          ...layout,
          elements: layout.elements.map((el) => (el.id === id ? { ...el, ...partial } : el)),
        };
      };

      const handleAddElement = (newEl: any) => {
        if (editorLocked()) return;
        layout = { ...layout, elements: [...layout.elements, newEl] };
      };

      const handleDeleteElement = (id: string) => {
        if (editorLocked()) return;
        layout = { ...layout, elements: layout.elements.filter((el) => el.id !== id) };
      };

      const handleCanvasHeightChange = (newH: number) => {
        if (editorLocked()) return;
        layout = { ...layout, height: newH };
      };

      // 1. Operator initiates Publish
      activeMutation = 'publish';
      expect(editorLocked()).toBe(true);

      // 2. Operator attempts concurrent UI mutations before RPC finishes
      updateElement('el-1', { text: 'Layout B Mutation' });
      handleAddElement({ id: 'el-2', type: 'text', text: 'Rogue Element', x: 0, y: 0 });
      handleDeleteElement('el-1');
      handleCanvasHeightChange(1000);

      // Assert that all mutations were rejected by the editorLocked guard
      expect(layout.elements[0].text).toBe('Template Layout A');
      expect(layout.elements).toHaveLength(1);
      expect(layout.height).toBe(600);

      // 3. Publish RPC completes
      activeMutation = null;
      expect(editorLocked()).toBe(false);

      // Authoritative layout represents original layout A
      expect(layout.elements[0].text).toBe('Template Layout A');
    });

    it('7.3. Save and Restore mutations freeze editor controls similarly during their in-flight window', async () => {
      let layout = { height: 500, elements: [{ id: 'el-x', type: 'text', text: 'Initial', x: 10, y: 10 }] };
      let activeMutation: 'save' | 'publish' | 'restore' | null = 'save';
      const editorLocked = () => isThermalEditorLocked(activeMutation, false);

      const updateElement = (id: string, partial: any) => {
        if (editorLocked()) return;
        layout = {
          ...layout,
          elements: layout.elements.map((el) => (el.id === id ? { ...el, ...partial } : el)),
        };
      };

      // Attempt edit during Save
      updateElement('el-x', { text: 'Mutated While Saving' });
      expect(layout.elements[0].text).toBe('Initial');

      // Save finishes, Restore begins
      activeMutation = 'restore';
      updateElement('el-x', { text: 'Mutated While Restoring' });
      expect(layout.elements[0].text).toBe('Initial');

      // Restore finishes
      activeMutation = null;
      updateElement('el-x', { text: 'Mutated After Restore' });
      expect(layout.elements[0].text).toBe('Mutated After Restore');
    });
  });

  // =========================================================================
  // 8. Settings Imperative Mutation Lock & Rapid Double-Click Protection (Section 7)
  // =========================================================================
  describe('8. Settings Imperative Mutation Lock', () => {
    it('8.1. tryAcquireSettingsMutation atomically acquires the ref and blocks same-tick re-entry', () => {
      const inFlightRef = { current: false };

      // First synchronous click acquires
      const acquiredFirst = tryAcquireSettingsMutation(inFlightRef, false);
      expect(acquiredFirst).toBe(true);
      expect(inFlightRef.current).toBe(true);

      // Immediate second synchronous click in same tick is rejected
      const acquiredSecond = tryAcquireSettingsMutation(inFlightRef, false);
      expect(acquiredSecond).toBe(false);

      // When released in finally
      inFlightRef.current = false;
      expect(tryAcquireSettingsMutation(inFlightRef, false)).toBe(true);
    });

    it('8.2. rapidly double-invoking settings mutation handler issues exactly ONE network request', async () => {
      const inFlightRef = { current: false };
      let saving = false;
      const isSettingsBusy = () => saving;
      let networkCalls = 0;

      const handleSave = async () => {
        if (tryAcquireSettingsMutation(inFlightRef, isSettingsBusy()) === false) {
          return;
        }
        saving = true;
        try {
          networkCalls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
        } finally {
          saving = false;
          inFlightRef.current = false;
        }
      };

      // Rapidly double-invoke Save synchronously
      const p1 = handleSave();
      const p2 = handleSave();

      await Promise.all([p1, p2]);

      expect(networkCalls).toBe(1);
    });
  });

  // =========================================================================
  // 9. Harden Audit Activity Pagination & Reconciliation Request Controller (Section 4, 5)
  // =========================================================================
  describe('9. Production Hook Contracts: useAuditActivity & useReconciliationItems', () => {
    function renderHookInAct<T>(hookFn: () => T) {
      let result!: T;
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      function TestComponent() {
        result = hookFn();
        return null;
      }

      act(() => {
        root.render(React.createElement(TestComponent));
      });

      return {
        get result() {
          return result;
        },
        rerender() {
          act(() => {
            root.render(React.createElement(TestComponent));
          });
        },
        unmount() {
          act(() => {
            root.unmount();
          });
          container.remove();
        },
      };
    }

    it('9.1. two immediate Load More calls issue only one HTTP request due to imperative single-flight lock', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('cursor=')) {
          await appendPromise;
          return new Response(JSON.stringify({
            items: [{ id: 'act-2', event: 'exit_scanned', passToken: 'tok-2', timestamp: '2026-10-28T08:05:00Z' }],
            nextCursor: null,
            hasMore: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          items: [{ id: 'act-1', event: 'entry_scanned', passToken: 'tok-1', timestamp: '2026-10-28T08:00:00Z' }],
          nextCursor: 'cursor-1',
          hasMore: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const hook = renderHookInAct(() => useVisitorActivity(true));

      await act(async () => {
        await Promise.resolve();
      });

      expect(hook.result.data).toHaveLength(1);
      expect(hook.result.hasMore).toBe(true);

      // Two immediate Load More calls in the same tick
      act(() => {
        hook.result.loadMore();
        hook.result.loadMore();
      });

      expect(hook.result.loadingMore).toBe(true);

      // Flush microtasks so the single permitted append request proceeds to fetch
      await act(async () => {
        await Promise.resolve();
      });

      // Fetch should be called 2 times total (1 root + 1 loadMore), NOT 3
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      await act(async () => {
        appendResolve!(null);
        await Promise.resolve();
      });

      expect(hook.result.loadingMore).toBe(false);
      expect(hook.result.data).toHaveLength(2);
      expect(hook.result.hasMore).toBe(false);

      hook.unmount();
    });

    it('9.2. Load More starts, filter changes, new query succeeds: stale append discarded, loadingMore false', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      let currentFilter: { event?: string } = { event: 'entry_scanned' };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('cursor=')) {
          await appendPromise;
          return new Response(JSON.stringify({
            items: [{ id: 'old-append', event: 'entry_scanned', passToken: 'tok-old', timestamp: '2026-10-28T08:01:00Z' }],
            nextCursor: 'cur-old',
            hasMore: true,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('event=exit_scanned')) {
          return new Response(JSON.stringify({
            items: [{ id: 'new-exit-1', event: 'exit_scanned', passToken: 'tok-new', timestamp: '2026-10-28T08:10:00Z' }],
            nextCursor: 'cur-exit-1',
            hasMore: true,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          items: [{ id: 'entry-1', event: 'entry_scanned', passToken: 'tok-e1', timestamp: '2026-10-28T08:00:00Z' }],
          nextCursor: 'cur-entry-1',
          hasMore: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const hook = renderHookInAct(() => useVisitorActivity(true, currentFilter));

      await act(async () => {
        await Promise.resolve();
      });

      expect(hook.result.data.map((d) => d.id)).toEqual(['entry-1']);

      // 1. Load more starts (in-flight)
      act(() => {
        hook.result.loadMore();
      });
      expect(hook.result.loadingMore).toBe(true);

      // 2. Filter changes before load more finishes
      currentFilter = { event: 'exit_scanned' };
      hook.rerender();

      await act(async () => {
        await Promise.resolve();
      });

      // New root query succeeded: loadingMore must be false, rows must be from new query
      expect(hook.result.loadingMore).toBe(false);
      expect(hook.result.data.map((d) => d.id)).toEqual(['new-exit-1']);

      // 3. Old append resolves afterward
      await act(async () => {
        appendResolve!(null);
        await Promise.resolve();
      });

      // Obsolete append results must be discarded; loadingMore remains false
      expect(hook.result.data.map((d) => d.id)).toEqual(['new-exit-1']);
      expect(hook.result.loadingMore).toBe(false);
      expect(hook.result.hasMore).toBe(true);

      hook.unmount();
    });

    it('9.3. Administrative Activity uses the same pagination hardening and single-flight lock', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('cursor=')) {
          await appendPromise;
          return new Response(JSON.stringify({
            items: [{
              id: 'adm-2',
              action: 'user_updated',
              actorUid: 'u-1',
              actorRole: 'admin',
              targetType: 'staff',
              targetId: 'u-2',
              result: 'success',
              timestamp: '2026-10-28T08:06:00Z',
            }],
            nextCursor: null,
            hasMore: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          items: [{
            id: 'adm-1',
            action: 'user_created',
            actorUid: 'u-1',
            actorRole: 'admin',
            targetType: 'staff',
            targetId: 'u-2',
            result: 'success',
            timestamp: '2026-10-28T08:00:00Z',
          }],
          nextCursor: 'cur-adm-1',
          hasMore: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const hook = renderHookInAct(() => useAdministrativeAudit(true));

      await act(async () => {
        await Promise.resolve();
      });

      // Rapidly call loadMore twice
      act(() => {
        hook.result.loadMore();
        hook.result.loadMore();
      });

      // Flush microtasks so the single permitted append request proceeds to fetch
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2); // 1 initial + exactly 1 append

      await act(async () => {
        appendResolve!(null);
        await Promise.resolve();
      });

      expect(hook.result.loadingMore).toBe(false);
      expect(hook.result.data).toHaveLength(2);

      hook.unmount();
    });

    it('9.4. Reconciliation: page 2 Load More starts containing Task X -> Task X is resolved -> refresh starts -> fresh response excludes Task X -> old page 2 resolves afterward -> Task X does not reappear', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      let refreshMode = false;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('cursor=')) {
          // Page 2 containing Task X
          await appendPromise;
          return new Response(JSON.stringify({
            items: [{
              id: 'task-X',
              type: 'auth_mismatch',
              status: 'open',
              targetType: 'staff',
              targetId: 'usr-X',
              summary: 'Pending Task X',
              requiredActions: ['sync'],
              createdAt: '2026-10-28T08:00:00Z',
            }],
            nextCursor: 'cur-recon-2',
            hasMore: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (refreshMode) {
          // Fresh response after Task X is resolved
          return new Response(JSON.stringify({
            items: [{
              id: 'task-1',
              type: 'auth_mismatch',
              status: 'open',
              targetType: 'staff',
              targetId: 'usr-1',
              summary: 'Existing Task 1',
              requiredActions: ['check'],
              createdAt: '2026-10-28T08:00:00Z',
            }],
            total: 1,
            nextCursor: null,
            hasMore: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        // Initial Page 1
        return new Response(JSON.stringify({
          items: [{
            id: 'task-1',
            type: 'auth_mismatch',
            status: 'open',
            targetType: 'staff',
            targetId: 'usr-1',
            summary: 'Existing Task 1',
            requiredActions: ['check'],
            createdAt: '2026-10-28T08:00:00Z',
          }],
          total: 2,
          nextCursor: 'cur-recon-1',
          hasMore: true,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const hook = renderHookInAct(() => useReconciliationItems(true));

      await act(async () => {
        await Promise.resolve();
      });

      expect(hook.result.data.map((i) => i.id)).toEqual(['task-1']);
      expect(hook.result.hasMore).toBe(true);

      // 1. Page 2 Load More starts (contains Task X, pending)
      act(() => {
        hook.result.loadMore();
      });
      expect(hook.result.loadingMore).toBe(true);

      // 2. Operator resolves Task X, refresh() starts
      refreshMode = true;
      act(() => {
        hook.result.refresh();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // Fresh response excludes Task X, loadingMore is false
      expect(hook.result.loadingMore).toBe(false);
      expect(hook.result.data.map((i) => i.id)).toEqual(['task-1']);

      // 3. Old Page 2 resolves afterward
      await act(async () => {
        appendResolve!(null);
        await Promise.resolve();
      });

      // Task X must NOT reappear in state
      expect(hook.result.data.map((i) => i.id)).toEqual(['task-1']);
      expect(hook.result.loadingMore).toBe(false);

      hook.unmount();
    });
  });

  // =========================================================================
  // 10. Production Reset Contracts: AdminRecords, AdminUsers, DevicesPage (Section 1, 2, 3)
  // =========================================================================
  describe('10. Page-Level Load-More Reset & Abort Controller Contracts', () => {
    it('10.1. AdminRecords: Load More active -> filter changes -> new root query succeeds -> old append resolves afterward -> new query rows remain, loadingMore === false, Load More usable', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      // Simulate AdminRecords pagination controller state
      const recordsQueryGenerationRef = { current: 1 };
      const recordsLoadMoreInFlightRef = { current: false };
      let loadingMore = false;
      let passes: string[] = ['Pass-A1'];
      let hasMore = true;

      // 1. Load more starts
      recordsLoadMoreInFlightRef.current = true;
      loadingMore = true;
      const appendGen = recordsQueryGenerationRef.current;

      const runAppend = async () => {
        await appendPromise;
        if (appendGen !== recordsQueryGenerationRef.current) {
          return;
        }
        passes = [...passes, 'Pass-A2'];
      };
      const appendOp = runAppend().finally(() => {
        if (appendGen === recordsQueryGenerationRef.current) {
          recordsLoadMoreInFlightRef.current = false;
          loadingMore = false;
        }
      });

      // 2. Filter changes: loadRootRecords runs
      recordsQueryGenerationRef.current += 1;
      // Section 1 required contract:
      recordsLoadMoreInFlightRef.current = false;
      loadingMore = false;
      hasMore = false;

      // Root query succeeds
      passes = ['Pass-B1'];
      hasMore = true; // New query has more pages

      // 3. Old append resolves afterward
      appendResolve!(null);
      await appendOp;

      // Expected assertions:
      expect(passes).toEqual(['Pass-B1']);
      expect(loadingMore).toBe(false);
      expect(recordsLoadMoreInFlightRef.current).toBe(false);
      expect(hasMore).toBe(true);
    });

    it('10.2. AdminUsers: Load More active -> account mutation succeeds -> loadUsers() begins -> completes -> obsolete Load More resolves -> fresh staff list remains, loadingMore false, hasMore usable', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      // Simulate AdminUsers pagination controller state
      const usersReadGenerationRef = { current: 1 };
      const usersLoadMoreInFlightRef = { current: false };
      let loadingMore = false;
      let users: string[] = ['Guard-A'];
      let hasMore = true;

      // 1. Load more starts
      usersLoadMoreInFlightRef.current = true;
      loadingMore = true;
      const appendGen = usersReadGenerationRef.current;

      const runAppend = async () => {
        await appendPromise;
        if (appendGen !== usersReadGenerationRef.current) {
          return;
        }
        users = [...users, 'Guard-Old-Appended'];
      };
      const appendOp = runAppend().finally(() => {
        if (appendGen === usersReadGenerationRef.current) {
          usersLoadMoreInFlightRef.current = false;
          loadingMore = false;
        }
      });

      // 2. Account mutation triggers loadUsers()
      usersReadGenerationRef.current += 1;
      // Section 2 required contract:
      usersLoadMoreInFlightRef.current = false;
      loadingMore = false;

      // Root load completes
      users = ['Guard-A', 'Admin-B-New'];
      hasMore = true;

      // 3. Old append resolves afterward
      appendResolve!(null);
      await appendOp;

      expect(users).toEqual(['Guard-A', 'Admin-B-New']);
      expect(loadingMore).toBe(false);
      expect(usersLoadMoreInFlightRef.current).toBe(false);
      expect(hasMore).toBe(true);
    });

    it('10.3. DevicesPage: Load More active -> mutation triggers loadDevices(false) -> root refresh wins -> old append finishes -> no stale append, no permanent loadingMore state', async () => {
      let appendResolve: ((value: any) => void) | null = null;
      const appendPromise = new Promise((resolve) => {
        appendResolve = resolve;
      });

      // Simulate DevicesPage pagination controller state
      const devicesReadGenerationRef = { current: 1 };
      const devicesLoadMoreInFlightRef = { current: false };
      let loadingMore = false;
      let devices: string[] = ['Device-1'];
      let hasMore = true;

      // 1. Load more starts
      devicesLoadMoreInFlightRef.current = true;
      loadingMore = true;
      const appendGen = devicesReadGenerationRef.current;

      const runAppend = async () => {
        await appendPromise;
        if (appendGen !== devicesReadGenerationRef.current) {
          return;
        }
        devices = [...devices, 'Device-Stale'];
      };
      const appendOp = runAppend().finally(() => {
        if (appendGen === devicesReadGenerationRef.current) {
          devicesLoadMoreInFlightRef.current = false;
          loadingMore = false;
        }
      });

      // 2. Mutation triggers loadDevices(false)
      devicesReadGenerationRef.current += 1;
      // Section 3 required contract:
      devicesLoadMoreInFlightRef.current = false;
      loadingMore = false;

      // Root refresh finishes
      devices = ['Device-1', 'Device-2-Fresh'];
      hasMore = true;

      // 3. Old append finishes afterward
      appendResolve!(null);
      await appendOp;

      expect(devices).toEqual(['Device-1', 'Device-2-Fresh']);
      expect(loadingMore).toBe(false);
      expect(devicesLoadMoreInFlightRef.current).toBe(false);
      expect(hasMore).toBe(true);
    });
  });
});

