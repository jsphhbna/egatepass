import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolvePostalCode } from '../src/lib/psgc';
import * as supabaseModule from '../src/lib/supabase';

describe('PSGC Reference and Postal Code Resolution Integrity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Exact active official PSA barangay produces verified auto-filled postal code', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'postal_code_reference') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string, val: any) => {
              if (col === 'barangay_psgc_code') {
                return {
                  eq: vi.fn().mockImplementation((col2: string, val2: any) => {
                    return {
                      limit: vi.fn().mockReturnThis(),
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: val === '1380606014' && val2 === true ? {
                          postal_code: '1008',
                          mapping_type: 'exact_barangay',
                        } : null,
                        error: null,
                      }),
                    };
                  }),
                };
              }
              return { select: vi.fn().mockReturnThis() };
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    const res = await resolvePostalCode('1380600000', '1380606014');
    expect(res.postalCode).toBe('1008');
    expect(res.isAutoFilled).toBe(true);
    expect(res.requiresConfirmation).toBe(false);
    expect(res.mappingType).toBe('exact_barangay');
  });

  it('2. Inactive legacy barangays cannot produce automatic postal matches', async () => {
    // When an obsolete synthetic code (e.g. 1380600408) is checked against DB or bundled data
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'postal_code_reference') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string, val: any) => {
              if (col === 'barangay_psgc_code') {
                return {
                  eq: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: null, // Deactivated in DB
                      error: null,
                    }),
                  }),
                };
              }
              if (col === 'psgc_locality_code') {
                return {
                  eq: vi.fn().mockResolvedValue({
                    // City has multiple codes (City of Manila)
                    data: [
                      { postal_code: '1008', mapping_type: 'exact_barangay' },
                      { postal_code: '1000', mapping_type: 'exact_barangay' },
                    ],
                    error: null,
                  }),
                };
              }
              return { select: vi.fn().mockReturnThis() };
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    const res = await resolvePostalCode('1380600000', '1380600408');
    expect(res.isAutoFilled).toBe(false);
    expect(res.requiresConfirmation).toBe(true);
    expect(res.postalCode).toBeNull();
    expect(res.mappingType).toBe('multi_code_city');
  });

  it('3. DB lookup failure fails closed: does NOT silently produce a false verified badge', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string) => {
            if (col === 'barangay_psgc_code') {
              return {
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnThis(),
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'Network connection timeout', code: 'PGRST000' },
                  }),
                }),
              };
            }
            return {
              eq: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'Network connection timeout', code: 'PGRST000' },
              }),
            };
          }),
        };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    // Even if the code matches a bundled entry, DB lookup failure must report service_unavailable
    const res = await resolvePostalCode('1380600000', '1380606014');
    expect(res.isAutoFilled).toBe(false);
    expect(res.requiresConfirmation).toBe(true);
    expect(res.postalCode).toBeNull();
    expect(res.mappingType).toBe('service_unavailable');
    expect(res.message).toContain('Postal lookup service could not be reached');
  });

  it('4. Multi-code city without exact barangay match prompts user confirmation', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'postal_code_reference') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string) => {
              if (col === 'barangay_psgc_code') {
                return {
                  eq: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: null,
                      error: null,
                    }),
                  }),
                };
              }
              if (col === 'psgc_locality_code') {
                return {
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { postal_code: '1000', mapping_type: 'exact_barangay' },
                      { postal_code: '1004', mapping_type: 'exact_barangay' },
                      { postal_code: '1008', mapping_type: 'exact_barangay' },
                    ],
                    error: null,
                  }),
                };
              }
              return { select: vi.fn().mockReturnThis() };
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    const res = await resolvePostalCode('1380600000', '1380606999'); // Unmapped barangay in Manila
    expect(res.isAutoFilled).toBe(false);
    expect(res.requiresConfirmation).toBe(true);
    expect(res.postalCode).toBeNull();
    expect(res.mappingType).toBe('multi_code_city');
  });

  it('5. Unique city-level postal code auto-fills when single code exists', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'postal_code_reference') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string) => {
              if (col === 'barangay_psgc_code') {
                return {
                  eq: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnThis(),
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: null,
                      error: null,
                    }),
                  }),
                };
              }
              if (col === 'psgc_locality_code') {
                return {
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { postal_code: '1550', mapping_type: 'unique_city' },
                    ],
                    error: null,
                  }),
                };
              }
              return { select: vi.fn().mockReturnThis() };
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    const res = await resolvePostalCode('1380700000', '1380700001'); // Mandaluyong City
    expect(res.isAutoFilled).toBe(true);
    expect(res.requiresConfirmation).toBe(false);
    expect(res.postalCode).toBe('1550');
    expect(res.mappingType).toBe('unique_city');
  });
});
