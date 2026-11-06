import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import confirmArrivalHandler from '../server/routes/office/confirm-arrival.js';
import * as officeLib from '../server/lib/office.js';
import * as supabaseModule from '../server/supabase.js';
import {
  initScannerAudio,
  playSuccessBeep,
  playWarningBeep,
  playErrorBeep,
  isScannerAudioMuted,
  setScannerAudioMuted,
  _resetScannerAudioForTest,
} from '../src/lib/scannerAudio.js';

describe('Office Attendance & Scanner Audio Integration', () => {
  const originalEnv = process.env;
  const testOfficeId = '00000000-0000-4000-8000-000000000001';
  const testVisitId = '00000000-0000-4000-8000-000000000099';

  beforeEach(() => {
    vi.useFakeTimers();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-secret-key-supabase-admin-service-role',
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Web Audio Synthesizer (scannerAudio.ts)', () => {
    let mockOscillatorInstance: any;
    let mockGainInstance: any;

    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator() {
        return mockOscillatorInstance;
      }
      createGain() {
        return mockGainInstance;
      }
      async resume() {
        this.state = 'running';
      }
    }

    beforeEach(() => {
      _resetScannerAudioForTest();
      mockOscillatorInstance = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      mockGainInstance = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };

      (global as any).window = {
        AudioContext: MockAudioContext,
        webkitAudioContext: MockAudioContext,
        localStorage: {
          store: {} as Record<string, string>,
          getItem(k: string) { return this.store[k] ?? null; },
          setItem(k: string, v: string) { this.store[k] = v; },
          removeItem(k: string) { delete this.store[k]; },
          clear() { this.store = {}; },
        },
      };
      (global as any).localStorage = (global as any).window.localStorage;
    });

    it('manages mute toggle state via localStorage', () => {
      setScannerAudioMuted(false);
      expect(isScannerAudioMuted()).toBe(false);

      setScannerAudioMuted(true);
      expect(isScannerAudioMuted()).toBe(true);

      setScannerAudioMuted(false);
      expect(isScannerAudioMuted()).toBe(false);
    });

    it('plays two-tone success chime on successful entry or checkout', () => {
      setScannerAudioMuted(false);
      initScannerAudio();

      expect(() => playSuccessBeep()).not.toThrow();
      expect(mockOscillatorInstance.start).toHaveBeenCalled();
      expect(mockOscillatorInstance.connect).toHaveBeenCalled();
      expect(mockGainInstance.connect).toHaveBeenCalled();
    });

    it('plays pulsating warning tones on unconfirmed office departure', () => {
      setScannerAudioMuted(false);
      initScannerAudio();
      vi.advanceTimersByTime(350);

      expect(() => playWarningBeep()).not.toThrow();
      expect(mockOscillatorInstance.start).toHaveBeenCalled();
    });

    it('plays dissonant error tone on invalid scan', () => {
      setScannerAudioMuted(false);
      initScannerAudio();
      vi.advanceTimersByTime(350);

      expect(() => playErrorBeep()).not.toThrow();
      expect(mockOscillatorInstance.start).toHaveBeenCalled();
    });

    it('suppresses audio output when muted', () => {
      setScannerAudioMuted(true);
      initScannerAudio();
      vi.advanceTimersByTime(350);

      mockOscillatorInstance.start.mockClear();
      playSuccessBeep();
      vi.advanceTimersByTime(350);
      playWarningBeep();
      vi.advanceTimersByTime(350);
      playErrorBeep();

      expect(mockOscillatorInstance.start).not.toHaveBeenCalled();
    });
  });

  describe('Office Arrival Confirmation Endpoint (POST /api/office/confirm-arrival)', () => {
    it('rejects confirmation if office staff is not assigned to the destination office', async () => {
      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: 'staff-user-3',
        email: 'staff3@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: ['00000000-0000-4000-8000-000000000002'], // Assigned to office-2 only
      });

      const mockAdminClient = {
        schema: vi.fn(() => ({
          rpc: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'unauthorized_for_this_office: staff not assigned to destination office' },
          }),
        })),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/office/confirm-arrival', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({
          visitId: testVisitId,
        }),
      });

      const res = await confirmArrivalHandler.fetch(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('unauthorized_for_this_office');
    });

    it('rejects arrival confirmation with 409 if the visitor has not entered campus yet', async () => {
      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: 'staff-user-1',
        email: 'staff1@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [testOfficeId],
      });

      const mockAdminClient = {
        schema: vi.fn(() => ({
          rpc: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'visitor_must_be_inside_campus: visitor has not entered campus gate yet' },
          }),
        })),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/office/confirm-arrival', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({
          visitId: testVisitId,
        }),
      });

      const res = await confirmArrivalHandler.fetch(req);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('visitor_must_be_inside_campus');
    });

    it('successfully confirms arrival when visitor is on campus (status is inside)', async () => {
      vi.spyOn(officeLib, 'requireOfficeStaffActor').mockResolvedValue({
        id: 'staff-user-1',
        email: 'staff1@earist.edu.ph',
        role: 'office_staff',
        assignedOfficeIds: [testOfficeId],
      });

      const mockAdminClient = {
        schema: vi.fn(() => ({
          rpc: vi.fn((fnName: string) => {
            if (fnName === 'confirm_office_arrival') {
              return Promise.resolve({
                data: [
                  {
                    visit_id: testVisitId,
                    attendance_status: 'confirmed',
                    confirmed_at: '2026-11-06T16:00:00Z',
                  },
                ],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        })),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdminClient as any,
        anon: {} as any,
      });

      const req = new Request('http://localhost/api/office/confirm-arrival', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer staff-token',
        },
        body: JSON.stringify({
          visitId: testVisitId,
        }),
      });

      const res = await confirmArrivalHandler.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.attendanceStatus).toBe('confirmed');
    });
  });
});
