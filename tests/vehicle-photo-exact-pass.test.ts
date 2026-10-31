import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import evidenceRoute from '../server/routes/gate/evidence';

vi.mock('../server/actors.js', () => ({
  getVerifiedSessionContext: vi.fn(),
  HttpError: class HttpError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
      super(code);
      this.status = status;
      this.code = code;
    }
  },
  recordReconciliation: vi.fn(),
}));

vi.mock('../server/supabase.js', () => ({
  getServerSupabaseClients: vi.fn(),
}));

import { getVerifiedSessionContext } from '../server/actors.js';
import { getServerSupabaseClients } from '../server/supabase.js';

describe('Vehicle Photo Exact-Pass Confinement Security (Section 6)', () => {
  const evidencePath = path.resolve('server/routes/gate/evidence.ts');
  const evidenceSource = fs.readFileSync(evidencePath, 'utf-8');

  it('1. Verifies static architectural constraints for vehicle photo exact-pass confinement', () => {
    // 1. Must query visit_vehicle_declarations for vehicle_photo_evidence_id
    expect(evidenceSource).toContain("from('visit_vehicle_declarations')");
    expect(evidenceSource).toContain(".eq('vehicle_photo_evidence_id', evidenceId.data)");

    // 2. Must verify decl visitor_id matches evidence visitor_id and pass_id is present
    expect(evidenceSource).toContain("decl.visitor_id !== evidence.visitor_id");

    // 3. Must query passes for exact decl.pass_id
    expect(evidenceSource).toContain(".from('passes')");
    expect(evidenceSource).toContain(".eq('id', decl.pass_id)");

    // 4. Must enforce exact pass gate matches station device gate
    expect(evidenceSource).toContain("exactPass.gate !== stationDevice.gate");

    // 5. Must enforce exact pass is in inside/exited status and entry_scanned_at is present
    expect(evidenceSource).toContain("!exactPass.entry_scanned_at");
    expect(evidenceSource).toContain("!['inside', 'exited'].includes(exactPass.status)");
  });

  describe('Behavioral Execution: Route Level Exact-Pass Confinement', () => {
    const stationUserId = '11111111-1111-4111-a111-111111111111';
    const evidenceUuid = '22222222-2222-4222-a222-222222222222';
    const visitorUuid = '33333333-3333-4333-a333-333333333333';
    const passAUuid = '44444444-4444-4444-a444-444444444444';
    const passBUuid = '55555555-5555-4555-a555-555555555555';

    function setupMockDb(opts: {
      stationGate: string;
      evidenceKind: string;
      declPassId: string | null;
      passGate: string;
      passStatus: string;
      passEntryScanned: string | null;
      passVisitorId?: string;
    }) {
      (getVerifiedSessionContext as any).mockResolvedValue({
        user: { id: stationUserId },
        isAnonymous: false,
        isRecoverySession: false,
      });

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'staff_profiles') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            };
          }
          if (table === 'devices') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      user_id: stationUserId,
                      status: 'active',
                      type: 'guard_station',
                      gate: opts.stationGate,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'visitor_evidence') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      visitor_id: visitorUuid,
                      bucket_id: 'visitor-evidence',
                      object_path: 'vehicle/photo.jpg',
                      content_type: 'image/jpeg',
                      expires_at: new Date(Date.now() + 86400000).toISOString(),
                      purged_at: null,
                      kind: opts.evidenceKind,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'visit_vehicle_declarations') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.declPassId
                      ? {
                          id: 'decl-uuid-1',
                          pass_id: opts.declPassId,
                          visitor_id: visitorUuid,
                        }
                      : null,
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'passes') {
            return {
              select: () => ({
                eq: (_field: string, passId: string) => ({
                  maybeSingle: async () => {
                    if (passId === opts.declPassId) {
                      return {
                        data: {
                          id: passId,
                          visitor_id: opts.passVisitorId ?? visitorUuid,
                          gate: opts.passGate,
                          source: 'portal',
                          entry_scanned_at: opts.passEntryScanned,
                          status: opts.passStatus,
                        },
                        error: null,
                      };
                    }
                    return { data: null, error: null };
                  },
                }),
              }),
            };
          }
          if (table === 'incident_holds') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        },
        storage: {
          from: () => ({
            download: async () => ({
              data: new Blob(['fake-image-bytes'], { type: 'image/jpeg' }),
              error: null,
            }),
          }),
        },
      };

      (getServerSupabaseClients as any).mockReturnValue({ admin: mockAdmin });
    }

    it('denies vehicle photo if station is at Gate 1 but the exact pass was scanned at Gate 2', async () => {
      setupMockDb({
        stationGate: 'Gate 1',
        evidenceKind: 'vehicle_photo',
        declPassId: passAUuid,
        passGate: 'Gate 2', // Mismatch!
        passStatus: 'inside',
        passEntryScanned: new Date().toISOString(),
      });

      const req = new Request(`https://egatepass.tech/api/gate/evidence?id=${evidenceUuid}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-token' },
      });

      const res = await evidenceRoute.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('Vehicle photo is not operationally accessible at this station');
    });

    it('denies vehicle photo if exact pass has not entered yet (status is issued, entry_scanned_at is null)', async () => {
      setupMockDb({
        stationGate: 'Gate 1',
        evidenceKind: 'vehicle_photo',
        declPassId: passAUuid,
        passGate: 'Gate 1',
        passStatus: 'issued', // Not inside/exited
        passEntryScanned: null,
      });

      const req = new Request(`https://egatepass.tech/api/gate/evidence?id=${evidenceUuid}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-token' },
      });

      const res = await evidenceRoute.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('Vehicle photo is not operationally accessible at this station');
    });

    it('denies vehicle photo if visitor has another pass inside, but this declaration is not bound to that pass', async () => {
      // Split identity attack: Pass B's vehicle photo requested, but declaration is for Pass B which is at Gate 2
      setupMockDb({
        stationGate: 'Gate 1',
        evidenceKind: 'vehicle_photo',
        declPassId: passBUuid, // Vehicle declaration is bound to Pass B
        passGate: 'Gate 2',
        passStatus: 'inside',
        passEntryScanned: new Date().toISOString(),
      });

      const req = new Request(`https://egatepass.tech/api/gate/evidence?id=${evidenceUuid}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-token' },
      });

      const res = await evidenceRoute.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('Vehicle photo is not operationally accessible at this station');
    });

    it('allows vehicle photo when exact pass bound to declaration has entered at this station gate', async () => {
      setupMockDb({
        stationGate: 'Gate 1',
        evidenceKind: 'vehicle_photo',
        declPassId: passAUuid,
        passGate: 'Gate 1', // Match!
        passStatus: 'inside',
        passEntryScanned: new Date().toISOString(),
      });

      const req = new Request(`https://egatepass.tech/api/gate/evidence?id=${evidenceUuid}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer mock-token' },
      });

      const res = await evidenceRoute.fetch(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('fake-image-bytes');
    });
  });
});
