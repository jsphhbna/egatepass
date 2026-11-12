import { describe, it, expect, vi } from 'vitest';
import issuePassHandler from '../server/routes/passes/issue.js';
import requestOfficeVisitHandler from '../server/routes/passes/request-office-visit.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { createEmailVerificationProofToken } from '../server/lib/office.js';
import { randomUUID } from 'node:crypto';

vi.mock('../server/actors.js', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    getVerifiedSessionContext: vi.fn(),
  };
});

import { getVerifiedSessionContext } from '../server/actors.js';

describe('Pass generation & office visit request with seeded Postgres UUIDs', () => {
  function createChainableQuery(
    table: string,
    actorId: string,
    officeId: string,
    photoIntentId: string,
    idIntentId: string,
    reqId: string,
    requiresApproval = true,
    personnelId = '22222222-0000-0000-0000-000000000010'
  ) {
    let lastEqCol: string | null = null;
    let lastEqVal: any = null;

    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn((col: string, val: any) => {
        lastEqCol = col;
        lastEqVal = val;
        return builder;
      }),
      is: vi.fn(() => builder),
      in: vi.fn(() => builder),
      gt: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => {
        if (table === 'offices') {
          return {
            data: {
              id: officeId,
              name: 'Admissions and Testing Office',
              active: true,
              publication_status: 'published',
              requires_approval_before_pass: requiresApproval,
              archived_at: null,
            },
            error: null,
          };
        }
        if (table === 'office_personnel') {
          return {
            data: {
              id: personnelId,
              name: 'Mr. Jose Antonio Garcia',
              office_id: officeId,
              active: true,
            },
            error: null,
          };
        }
        if (table === 'upload_intents') {
          const isId = lastEqVal === idIntentId;
          return {
            data: {
              id: lastEqVal,
              owner_id: actorId,
              source: 'portal',
              kind: isId ? 'id' : 'photo',
              bucket_id: isId ? 'visitor-ids' : 'visitor-photos',
              object_path: isId ? 'id.jpg' : 'photo.jpg',
              content_type: 'image/jpeg',
              max_bytes: 5242880,
              status: 'pending',
              expires_at: new Date(Date.now() + 600000).toISOString(),
            },
            error: null,
          };
        }
        if (table === 'portal_identity_verification_attempts') {
          return {
            data: {
              id: randomUUID(),
              owner_id: actorId,
              request_id: reqId,
              photo_intent_id: photoIntentId,
              id_intent_id: idIntentId,
              outcome: 'matched',
              expires_at: new Date(Date.now() + 600000).toISOString(),
            },
            error: null,
          };
        }
        if (table === 'passes' || table === 'office_visits') {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      single: vi.fn(async () => {
        return { data: null, error: null };
      }),
    };
    return builder;
  }

  it('successfully routes pass request with seeded officeId when office requires approval', async () => {
    const actorId = randomUUID();
    const seededOfficeId = '11111111-0000-0000-0000-000000000007';
    const photoIntentId = randomUUID();
    const idIntentId = randomUUID();
    const reqId = randomUUID();

    (getVerifiedSessionContext as any).mockResolvedValue({
      user: { id: actorId, is_anonymous: true },
      isAnonymous: true,
      isRecoverySession: false,
    });

    const mockAdmin: any = {
      from: vi.fn((table: string) => createChainableQuery(table, actorId, seededOfficeId, photoIntentId, idIntentId, reqId, true)),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn().mockResolvedValue({
            data: {
              arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
            },
            error: null,
          }),
        })),
      },
      schema: vi.fn((schemaName: string) => {
        return {
          rpc: vi.fn((fnName: string, params: any) => {
            if (fnName === 'consume_rate_limit') {
              return Promise.resolve({ data: true, error: null });
            }
            if (fnName === 'create_specific_person_visit_request') {
              return Promise.resolve({
                data: [{
                  visit_id: randomUUID(),
                  request_id: params.requested_request_id,
                  approval_status: 'pending',
                  attendance_status: 'awaiting_entry',
                  encrypted_tracking_token: 'iv:tag:ciphertext',
                  pass_id: null,
                  public_reference: null,
                  valid_from: null,
                  valid_until: null,
                  decision_source: null,
                  office_requires_approval_snapshot: true,
                }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, client: mockAdmin });

    process.env.PASS_TOKEN_SECRET = '01234567890123456789012345678901';
    process.env.RATE_LIMIT_HMAC_SECRET = '01234567890123456789012345678901';
    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.OFFICE_VISIT_HMAC_SECRET = '01234567890123456789012345678901';

    const req = new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dummy-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: reqId,
        source: 'portal',
        registrationMode: 'new',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          purpose: 'Inquiry',
          visitDate: '2026-11-12',
        },
        officeId: seededOfficeId,
        arrivalMode: 'no_vehicle',
        psgc: {
          version: '2026-q3',
          regionCode: '1300000000',
          cityCode: '1380600000',
          barangayCode: '1380600408',
        },
        photoIntentId,
        idIntentId,
      }),
    });

    const res = await (issuePassHandler as any).fetch(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.approvalRequired).toBe(true);
    expect(body.officeName).toBe('Admissions and Testing Office');
  });

  it('successfully generates immediate pass with seeded officeId when office does not require approval', async () => {
    const actorId = randomUUID();
    const seededOfficeId = '11111111-0000-0000-0000-000000000007';
    const photoIntentId = randomUUID();
    const idIntentId = randomUUID();
    const reqId = randomUUID();
    const publicRef = randomUUID();

    (getVerifiedSessionContext as any).mockResolvedValue({
      user: { id: actorId, is_anonymous: true },
      isAnonymous: true,
      isRecoverySession: false,
    });

    const mockAdmin: any = {
      from: vi.fn((table: string) => createChainableQuery(table, actorId, seededOfficeId, photoIntentId, idIntentId, reqId, false)),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn().mockResolvedValue({
            data: {
              arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
            },
            error: null,
          }),
        })),
      },
      schema: vi.fn((schemaName: string) => {
        return {
          rpc: vi.fn((fnName: string, params: any) => {
            if (fnName === 'consume_rate_limit') {
              return Promise.resolve({ data: true, error: null });
            }
            if (fnName === 'issue_online_pass_v6') {
              return {
                single: vi.fn().mockResolvedValue({
                  data: {
                    pass_id: publicRef,
                    public_reference: publicRef,
                    valid_from: '2026-11-12T08:00:00Z',
                    valid_until: '2026-11-12T17:00:00Z',
                  },
                  error: null,
                }),
              };
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, client: mockAdmin });

    const req = new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dummy-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: reqId,
        source: 'portal',
        registrationMode: 'new',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          purpose: 'Inquiry',
          visitDate: '2026-11-12',
        },
        officeId: seededOfficeId,
        arrivalMode: 'no_vehicle',
        psgc: {
          version: '2026-q3',
          regionCode: '1300000000',
          cityCode: '1380600000',
          barangayCode: '1380600408',
        },
        photoIntentId,
        idIntentId,
      }),
    });

    const res = await (issuePassHandler as any).fetch(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.passId).toBe(publicRef);
    expect(body.publicReference).toBe(publicRef);
    expect(body.qrToken).toBeDefined();
  });

  it('successfully accepts request-office-visit with seeded officeId and personnelId', async () => {
    const actorId = randomUUID();
    const seededOfficeId = '11111111-0000-0000-0000-000000000007';
    const seededPersonnelId = '22222222-0000-0000-0000-000000000010';
    const photoIntentId = randomUUID();
    const idIntentId = randomUUID();
    const reqId = randomUUID();

    (getVerifiedSessionContext as any).mockResolvedValue({
      user: { id: actorId, is_anonymous: true },
      isAnonymous: true,
      isRecoverySession: false,
    });

    const mockAdmin: any = {
      from: vi.fn((table: string) => createChainableQuery(table, actorId, seededOfficeId, photoIntentId, idIntentId, reqId, true, seededPersonnelId)),
      storage: {
        from: vi.fn(() => ({
          download: vi.fn().mockResolvedValue({
            data: {
              arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
            },
            error: null,
          }),
        })),
      },
      schema: vi.fn((schemaName: string) => {
        return {
          rpc: vi.fn((fnName: string, params: any) => {
            if (fnName === 'consume_rate_limit') {
              return Promise.resolve({ data: true, error: null });
            }
            if (fnName === 'create_specific_person_visit_request') {
              return Promise.resolve({
                data: [{
                  visit_id: randomUUID(),
                  request_id: params.requested_request_id,
                  approval_status: 'pending',
                  attendance_status: 'awaiting_entry',
                  encrypted_tracking_token: 'iv:tag:ciphertext',
                  pass_id: null,
                  public_reference: null,
                  valid_from: null,
                  valid_until: null,
                  decision_source: null,
                  office_requires_approval_snapshot: true,
                }],
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
    };

    setServerSupabaseClientsForTest({ admin: mockAdmin, client: mockAdmin });
    process.env.OFFICE_VISIT_HMAC_SECRET = '01234567890123456789012345678901';

    const req = new Request('http://localhost/api/request-office-visit', {
      method: 'POST',
      headers: {
        authorization: 'Bearer dummy-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: reqId,
        source: 'portal',
        registrationMode: 'new',
        visitType: 'specific_person',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09171234567',
          email: 'visitor@example.com',
          purpose: 'Meeting Admissions Officer',
          visitDate: '2026-11-12',
        },
        officeId: seededOfficeId,
        personnelId: seededPersonnelId,
        requestedPersonName: 'Mr. Jose Antonio Garcia',
        specificPurpose: 'Admissions Inquiry',
        emailVerificationToken: createEmailVerificationProofToken('visitor@example.com', actorId),
        arrivalMode: 'no_vehicle',
        psgc: {
          version: '2026-q3',
          regionCode: '1300000000',
          cityCode: '1380600000',
          barangayCode: '1380600408',
        },
        photoIntentId,
        idIntentId,
      }),
    });

    const res = await (requestOfficeVisitHandler as any).fetch(req);
    const body = await res.json();
    console.log('Request Office Visit status:', res.status, 'body:', body);
    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.approvalRequired).toBe(true);
    expect(body.officeName).toBe('Admissions and Testing Office');
  });
});
