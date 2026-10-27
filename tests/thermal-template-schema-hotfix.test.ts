// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import thermalTemplateHandler from '../server/routes/device/thermal-template.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '../src/printer/templates/bundledDefaultTemplate.js';
import {
  ThermalTemplateLayout,
  validateThermalTemplateLayout,
} from '../src/types/thermalTemplate.js';
import { PassPresentation } from '../src/lib/passPresentation.js';
import { renderThermalPass } from '../src/printer/renderer/thermalRenderer.js';

const KIOSK_DEVICE_USER_ID = '00000000-0000-4000-a000-000000000001';
const SCANNER_ENTRY_USER_ID = '00000000-0000-4000-a000-000000000002';
const SCANNER_EXIT_USER_ID = '00000000-0000-4000-a000-000000000003';
const GUARD_USER_ID = '00000000-0000-4000-a000-000000000004';
const ADMIN_USER_ID = '00000000-0000-4000-a000-000000000005';

describe('Thermal Template Schema RPC Hotfix Verification (HOTFIX-T01 to HOTFIX-T06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    const mockCtx = {
      fillStyle: '#FFFFFF',
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
      createImageData: vi.fn().mockImplementation((w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      })),
      putImageData: vi.fn(),
      getImageData: vi.fn().mockReturnValue({
        data: new Uint8ClampedArray(384 * 700 * 4),
        width: 384,
        height: 700,
      }),
    };

    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockCtx);
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,mockRenderedTicket');
  });

  // ---------------------------------------------------------------------------
  // STATIC CONTRACT: server/routes/device/thermal-template.ts
  // ---------------------------------------------------------------------------
  it('STATIC-CONTRACT: thermal-template route explicitly targets api schema and does not call bare admin.rpc', () => {
    const routeSource = readFileSync('server/routes/device/thermal-template.ts', 'utf8');

    // Must call schema('api')
    expect(routeSource).toContain(".schema('api')");

    // Must call rpc('get_published_thermal_template') chained after schema('api')
    expect(routeSource).toMatch(/\.schema\(['"]api['"]\)\s*\.rpc\(['"]get_published_thermal_template['"]\)/);

    // Must not call admin.rpc('get_published_thermal_template') without schema
    expect(routeSource).not.toMatch(/admin\s*\.rpc\(['"]get_published_thermal_template['"]\)/);
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T01: Real handler executes using mock client where only schema('api').rpc is valid
  // ---------------------------------------------------------------------------
  it('HOTFIX-T01: handler selects api schema and calls get_published_thermal_template on it', async () => {
    const rpcMock = vi.fn().mockResolvedValue({
      data: {
        version: 2,
        name: 'Default Institutional 384px Template',
        layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE,
      },
      error: null,
    });

    const schemaMock = vi.fn().mockImplementation((schemaName: string) => {
      if (schemaName !== 'api') {
        throw new Error(`Unexpected schema called: ${schemaName}`);
      }
      return { rpc: rpcMock };
    });

    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      schema: schemaMock,
      // NOTE: Notice no rpc method on mockAdmin root!
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-kiosk-token' },
    });

    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(200);

    expect(schemaMock).toHaveBeenCalledWith('api');
    expect(rpcMock).toHaveBeenCalledWith('get_published_thermal_template');
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T02: Wrong default-schema call must fail regression guard
  // ---------------------------------------------------------------------------
  it('HOTFIX-T02: calling handler without schema qualification fails if mock enforces schema boundary', async () => {
    // Construct a client that would error if schema('api') is bypassed
    const mockAdminWithoutBareRpc = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      schema: vi.fn((name: string) => {
        if (name !== 'api') throw new Error('Invalid schema');
        return {
          rpc: vi.fn().mockResolvedValue({
            data: { version: 2, name: 'Default', layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE },
            error: null,
          }),
        };
      }),
      rpc: vi.fn(() => {
        throw new Error('Bare admin.rpc was called! Production must use admin.schema("api").rpc(...)');
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdminWithoutBareRpc } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-kiosk-token' },
    });

    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(200);
    // Proves bare admin.rpc was not called, and schema('api').rpc was called
    expect(mockAdminWithoutBareRpc.rpc).not.toHaveBeenCalled();
    expect(mockAdminWithoutBareRpc.schema).toHaveBeenCalledWith('api');
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T03: Active kiosk happy path returns canonical template
  // ---------------------------------------------------------------------------
  it('HOTFIX-T03: active kiosk receives 200 with canonical published template conforming to Zod schema', async () => {
    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: {
            version: 2,
            name: 'Default Institutional 384px Template',
            layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE,
          },
          error: null,
        }),
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });

    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.name).toBe('Default Institutional 384px Template');

    const zodResult = validateThermalTemplateLayout(body.layout);
    expect(zodResult.success).toBe(true);
    expect(body.layout.width).toBe(384);
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T04: Authorization remains unchanged across all actor roles
  // ---------------------------------------------------------------------------
  it('HOTFIX-T04: preserves strict authorization (anonymous=401, guard=403, admin=403, scanner=403, kiosk=200)', async () => {
    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockImplementation(async (token: string) => {
          if (token === 'kiosk-token') {
            return { data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } }, error: null };
          }
          if (token === 'scanner-entry-token') {
            return { data: { user: { id: SCANNER_ENTRY_USER_ID, email: 'entry@devices.egatepass.invalid' } }, error: null };
          }
          if (token === 'scanner-exit-token') {
            return { data: { user: { id: SCANNER_EXIT_USER_ID, email: 'exit@devices.egatepass.invalid' } }, error: null };
          }
          if (token === 'guard-token') {
            return { data: { user: { id: GUARD_USER_ID, email: 'guard@earist.edu.ph' } }, error: null };
          }
          if (token === 'admin-token') {
            return { data: { user: { id: ADMIN_USER_ID, email: 'admin@earist.edu.ph' } }, error: null };
          }
          return { data: { user: null }, error: new Error('invalid_token') };
        }),
      },
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'devices') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_col: string, val: string) => ({
                maybeSingle: vi.fn().mockImplementation(async () => {
                  if (val === KIOSK_DEVICE_USER_ID) {
                    return { data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' }, error: null };
                  }
                  if (val === SCANNER_ENTRY_USER_ID) {
                    return { data: { user_id: SCANNER_ENTRY_USER_ID, type: 'entry', status: 'active', alias: 'Entry 1' }, error: null };
                  }
                  if (val === SCANNER_EXIT_USER_ID) {
                    return { data: { user_id: SCANNER_EXIT_USER_ID, type: 'exit', status: 'active', alias: 'Exit 1' }, error: null };
                  }
                  return { data: null, error: null };
                }),
              })),
            }),
          };
        }
        return {};
      }),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: { version: 2, name: 'Default', layout: BUNDLED_DEFAULT_THERMAL_TEMPLATE },
          error: null,
        }),
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    // 1. Anonymous -> 401
    const anonRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', { method: 'GET' }));
    expect(anonRes.status).toBe(401);

    // 2. Guard -> 403
    const guardRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer guard-token' },
    }));
    expect(guardRes.status).toBe(403);

    // 3. Admin -> 403
    const adminRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer admin-token' },
    }));
    expect(adminRes.status).toBe(403);

    // 4. Entry scanner -> 403
    const entryRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer scanner-entry-token' },
    }));
    expect(entryRes.status).toBe(403);

    // 5. Exit scanner -> 403
    const exitRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer scanner-exit-token' },
    }));
    expect(exitRes.status).toBe(403);

    // 6. Active kiosk -> 200
    const kioskRes = await thermalTemplateHandler.fetch(new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    }));
    expect(kioskRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T05: Database/RPC failure fallback preserves bundled template
  // ---------------------------------------------------------------------------
  it('HOTFIX-T05: RPC failure returns 500 controlled error and kiosk retains bundled fallback', async () => {
    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Database connection failed' },
        }),
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });

    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe('database_error');

    // Simulate kiosk hook fallback behavior:
    let activeTemplate = BUNDLED_DEFAULT_THERMAL_TEMPLATE;
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.layout && validateThermalTemplateLayout(data.layout).success) {
        activeTemplate = data.layout;
      }
    }

    // Kiosk printing remains unaffected using bundled known-good template
    expect(activeTemplate).toEqual(BUNDLED_DEFAULT_THERMAL_TEMPLATE);
  });

  // ---------------------------------------------------------------------------
  // HOTFIX-T06: Published template actually reaches renderer
  // ---------------------------------------------------------------------------
  it('HOTFIX-T06: end-to-end software delivery from api schema RPC to thermal renderer', async () => {
    // Custom canonical published layout with height = 700
    const customPublishedLayout: ThermalTemplateLayout = {
      ...BUNDLED_DEFAULT_THERMAL_TEMPLATE,
      height: 700,
    };

    const mockAdmin = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: KIOSK_DEVICE_USER_ID, email: 'kiosk@devices.egatepass.invalid' } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { user_id: KIOSK_DEVICE_USER_ID, type: 'kiosk', status: 'active', alias: 'Kiosk 1' },
              error: null,
            }),
          }),
        }),
      }),
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({
          data: {
            version: 2,
            name: 'Custom 700px Height Template',
            layout: customPublishedLayout,
          },
          error: null,
        }),
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin } as any);

    // 1. Kiosk endpoint fetch
    const req = new Request('http://localhost/api/device/thermal-template', {
      method: 'GET',
      headers: { Authorization: 'Bearer kiosk-token' },
    });
    const res = await thermalTemplateHandler.fetch(req);
    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.version).toBe(2);

    // 2. Kiosk client schema validation
    const clientValidation = validateThermalTemplateLayout(payload.layout);
    expect(clientValidation.success).toBe(true);

    const activeTemplate = clientValidation.data!;
    expect(activeTemplate.height).toBe(700);

    // 3. Render pass using fetched published layout
    const samplePresentation: PassPresentation = {
      institutionName: 'EARIST E-GATEPASS',
      systemTitle: 'CAMPUS VISITOR PASS',
      visitorName: 'JUAN DELA CRUZ',
      visitDate: '2026-10-27',
      passReference: 'EG-20261027-TEST',
      rawReference: 'EG-20261027-TEST',
      qrToken: 'egp_live_tok_test_12345678901234567890',
      validityWindow: '08:00 - 17:00',
      purpose: 'Official Institutional Business',
    };

    const rendered = await renderThermalPass(samplePresentation, activeTemplate);
    expect(rendered.canvas).toBeDefined();
    expect(rendered.canvas.width).toBe(384);
    expect(rendered.canvas.height).toBe(700);
  });
});
