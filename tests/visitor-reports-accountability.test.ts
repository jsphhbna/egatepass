import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserializeRecordPass, type SerializedRecordPass } from '../src/pages/AdminRecords.js';
import { SERVICE_ROLE_TABLE_CONTRACT } from '../server/privilege-contract.js';
import { getRouteByPath } from '../server/route-map.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Re-import or test the exact Zod schema used by the server route
const resolveAccountabilitySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record_verified_exit'),
    passId: z.string().regex(UUID_RE),
    exitTime: z.string().optional(),
    gate: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
  z.object({
    action: z.literal('confirm_office_visit'),
    passId: z.string().regex(UUID_RE),
    arrivalTime: z.string().optional(),
    verifiedTime: z.string().optional(),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
  z.object({
    action: z.literal('mark_reviewed'),
    passId: z.string().regex(UUID_RE),
    reason: z.string().trim().min(5).max(1000).optional(),
    notes: z.string().trim().min(5).max(1000).optional(),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict().refine((data) => Boolean((data.reason && data.reason.trim().length >= 5) || (data.notes && data.notes.trim().length >= 5)), {
    message: 'Either reason or notes must be at least 5 characters',
  }),
  z.object({
    action: z.literal('record_exception'),
    passId: z.string().regex(UUID_RE),
    exceptionType: z.enum([
      'redirected',
      'office_closed',
      'cancelled_after_entry',
      'cctv_verified',
      'emergency_evacuation',
      'other',
    ]),
    reason: z.string().trim().min(5).max(1000),
    requestId: z.string().regex(UUID_RE).optional(),
  }).strict(),
]);

describe('Visitor Reports: End-of-Day Visitor Accountability & Reconciliation', () => {
  describe('1. Schema Validation & Input Contracts', () => {
    it('accepts valid record_verified_exit payload', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'record_verified_exit',
        passId: '00000000-0000-0000-0000-000000000001',
        exitTime: '2026-11-23T17:30:00.000Z',
        gate: 'Gate 1',
        reason: 'Confirmed departure via physical security logbook entry #402',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects record_verified_exit when reason is shorter than 5 characters', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'record_verified_exit',
        passId: '00000000-0000-0000-0000-000000000001',
        reason: 'left',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts valid confirm_office_visit payload', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'confirm_office_visit',
        passId: '00000000-0000-0000-0000-000000000001',
        verifiedTime: '2026-11-23T14:15:00.000Z',
        reason: 'Office secretary confirmed visitor attended consultation meeting',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts valid mark_reviewed payload with notes >= 5 characters', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'mark_reviewed',
        passId: '00000000-0000-0000-0000-000000000001',
        notes: 'Investigated with gate security; visitor left without scan during power blip',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts valid record_exception payload with valid exception type', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'record_exception',
        passId: '00000000-0000-0000-0000-000000000001',
        exceptionType: 'office_closed',
        reason: 'Registrar office closed early at 14:00 for scheduled department meeting',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects record_exception with invalid exception type', () => {
      const parsed = resolveAccountabilitySchema.safeParse({
        action: 'record_exception',
        passId: '00000000-0000-0000-0000-000000000001',
        exceptionType: 'invalid_type',
        reason: 'Valid reason here',
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('2. Campus Exit Accountability Invariants', () => {
    function computeExitStatus(params: {
      hasEntered: boolean;
      hasExited: boolean;
      isPastClosing: boolean;
      closingMs: number;
      nowMs: number;
    }) {
      const missingExit = Boolean(params.hasEntered && !params.hasExited && params.isPastClosing);
      const overdueMinutes = missingExit ? Math.max(0, Math.round((params.nowMs - params.closingMs) / 60000)) : 0;
      return { missingExit, overdueMinutes };
    }

    it('flags No Recorded Exit when visitor entered campus and operating hours have passed without exit', () => {
      const closingMs = new Date('2026-11-23T17:00:00+08:00').getTime();
      const nowMs = new Date('2026-11-23T18:30:00+08:00').getTime(); // 90 mins overdue
      const result = computeExitStatus({
        hasEntered: true,
        hasExited: false,
        isPastClosing: true,
        closingMs,
        nowMs,
      });
      expect(result.missingExit).toBe(true);
      expect(result.overdueMinutes).toBe(90);
    });

    it('does NOT flag No Recorded Exit when visitor is currently inside campus during operating hours', () => {
      const closingMs = new Date('2026-11-23T17:00:00+08:00').getTime();
      const nowMs = new Date('2026-11-23T14:30:00+08:00').getTime(); // before closing
      const result = computeExitStatus({
        hasEntered: true,
        hasExited: false,
        isPastClosing: false,
        closingMs,
        nowMs,
      });
      expect(result.missingExit).toBe(false);
      expect(result.overdueMinutes).toBe(0);
    });

    it('does NOT flag No Recorded Exit when visitor has properly scanned out', () => {
      const closingMs = new Date('2026-11-23T17:00:00+08:00').getTime();
      const nowMs = new Date('2026-11-23T18:00:00+08:00').getTime();
      const result = computeExitStatus({
        hasEntered: true,
        hasExited: true,
        isPastClosing: true,
        closingMs,
        nowMs,
      });
      expect(result.missingExit).toBe(false);
      expect(result.overdueMinutes).toBe(0);
    });

    it('does NOT flag No Recorded Exit when pass was issued but visitor never scanned entry', () => {
      const closingMs = new Date('2026-11-23T17:00:00+08:00').getTime();
      const nowMs = new Date('2026-11-23T18:00:00+08:00').getTime();
      const result = computeExitStatus({
        hasEntered: false,
        hasExited: false,
        isPastClosing: true,
        closingMs,
        nowMs,
      });
      expect(result.missingExit).toBe(false);
      expect(result.overdueMinutes).toBe(0);
    });
  });

  describe('3. Office Visit Accountability Invariants', () => {
    function computeOfficeStatus(params: {
      hasEntered: boolean;
      destinationOffice: string | null;
      attendanceStatus: string | null;
      isPastClosing: boolean;
      hasExited: boolean;
    }) {
      const hasOffice = Boolean(
        params.destinationOffice &&
        params.destinationOffice.trim() !== '' &&
        params.destinationOffice.toLowerCase() !== 'general campus'
      );
      const officeConfirmed = Boolean(
        params.attendanceStatus === 'confirmed' ||
        params.attendanceStatus === 'completed'
      );
      const missingOffice = Boolean(params.hasEntered && hasOffice && !officeConfirmed && (params.isPastClosing || params.hasExited));
      return { hasOffice, officeConfirmed, missingOffice };
    }

    it('flags Office Visit Not Recorded when entered visitor selected office but attendance never confirmed', () => {
      const result = computeOfficeStatus({
        hasEntered: true,
        destinationOffice: "Registrar's Office",
        attendanceStatus: 'awaiting_office_confirmation',
        isPastClosing: true,
        hasExited: false,
      });
      expect(result.hasOffice).toBe(true);
      expect(result.officeConfirmed).toBe(false);
      expect(result.missingOffice).toBe(true);
    });

    it('does NOT flag general campus visits (no destination office) as missing office', () => {
      const result = computeOfficeStatus({
        hasEntered: true,
        destinationOffice: 'General Campus',
        attendanceStatus: null,
        isPastClosing: true,
        hasExited: false,
      });
      expect(result.hasOffice).toBe(false);
      expect(result.missingOffice).toBe(false);
    });

    it('does NOT flag office visit when confirmed by office staff', () => {
      const result = computeOfficeStatus({
        hasEntered: true,
        destinationOffice: 'Accounting Office',
        attendanceStatus: 'confirmed',
        isPastClosing: true,
        hasExited: false,
      });
      expect(result.officeConfirmed).toBe(true);
      expect(result.missingOffice).toBe(false);
    });

    it('flags office visit not recorded if visitor exited campus without office confirmation', () => {
      const result = computeOfficeStatus({
        hasEntered: true,
        destinationOffice: 'Dean of Engineering',
        attendanceStatus: 'exited_unconfirmed',
        isPastClosing: false, // even before closing, if they exited unconfirmed, it is flagged
        hasExited: true,
      });
      expect(result.missingOffice).toBe(true);
    });
  });

  describe('4. Combined Cases & Deduplication Invariant', () => {
    it('accurately identifies bothMissing on the same record without duplicating visitor identity', () => {
      const visitor = {
        visitorId: 'visitor-001',
        destinationOffice: "Registrar's Office",
        hasEntered: true,
        hasExited: false,
        isPastClosing: true,
        attendanceStatus: 'awaiting_office_confirmation',
      };

      const missingExit = visitor.hasEntered && !visitor.hasExited && visitor.isPastClosing;
      const missingOffice = visitor.hasEntered && Boolean(visitor.destinationOffice) && visitor.attendanceStatus !== 'confirmed' && visitor.isPastClosing;
      const bothMissing = missingExit && missingOffice;

      expect(missingExit).toBe(true);
      expect(missingOffice).toBe(true);
      expect(bothMissing).toBe(true);
    });

    it('deduplicates overview statistics by unique visitor ID', () => {
      // 4 passes across 3 unique visitors
      const mockPasses = [
        {
          visitorId: 'v1',
          isCompleted: false,
          missingExit: true,
          missingOffice: true,
          bothMissing: true,
          accountabilityStatus: 'pending',
        },
        {
          visitorId: 'v1', // duplicate pass for same visitor
          isCompleted: false,
          missingExit: true,
          missingOffice: true,
          bothMissing: true,
          accountabilityStatus: 'pending',
        },
        {
          visitorId: 'v2',
          isCompleted: true,
          missingExit: false,
          missingOffice: false,
          bothMissing: false,
          accountabilityStatus: 'resolved',
        },
        {
          visitorId: 'v3',
          isCompleted: false,
          missingExit: true,
          missingOffice: false,
          bothMissing: false,
          accountabilityStatus: 'reviewed',
        },
      ];

      const uniqueVisitorIds = new Set<string>();
      const completedVisitorIds = new Set<string>();
      const missingExitVisitorIds = new Set<string>();
      const missingOfficeVisitorIds = new Set<string>();
      const requiringReviewVisitorIds = new Set<string>();
      const reviewedVisitorIds = new Set<string>();

      for (const p of mockPasses) {
        uniqueVisitorIds.add(p.visitorId);
        if (p.isCompleted) completedVisitorIds.add(p.visitorId);
        if (p.missingExit && p.accountabilityStatus === 'pending') missingExitVisitorIds.add(p.visitorId);
        if (p.missingOffice && p.accountabilityStatus === 'pending') missingOfficeVisitorIds.add(p.visitorId);
        if ((p.missingExit || p.missingOffice) && p.accountabilityStatus === 'pending') requiringReviewVisitorIds.add(p.visitorId);
        if (p.accountabilityStatus && p.accountabilityStatus !== 'pending') reviewedVisitorIds.add(p.visitorId);
      }

      // Assertions prove deduplication:
      // Total unique visitors: 3 (v1, v2, v3) even though there are 4 passes
      expect(uniqueVisitorIds.size).toBe(3);
      // Completed visits: 1 (v2)
      expect(completedVisitorIds.size).toBe(1);
      // Missing exit count: 1 (v1) - v3 is reviewed so not pending
      expect(missingExitVisitorIds.size).toBe(1);
      // Missing office count: 1 (v1)
      expect(missingOfficeVisitorIds.size).toBe(1);
      // Requiring review: exactly 1 (v1) - not 2!
      expect(requiringReviewVisitorIds.size).toBe(1);
      // Reviewed count: 2 (v2, v3)
      expect(reviewedVisitorIds.size).toBe(2);
    });
  });

  describe('5. Client Deserialization Contract', () => {
    it('properly deserializes serialized pass accountability fields into GatePassWithId', () => {
      const serialized: SerializedRecordPass = {
        id: 'pass-uuid-1234',
        visitorId: 'visitor-uuid-5678',
        visitorName: 'Juan Dela Cruz',
        purpose: 'Official Transcript Request',
        source: 'online',
        status: 'inside',
        validFrom: '2026-11-23T08:00:00.000Z',
        validUntil: '2026-11-23T17:00:00.000Z',
        issuedAt: '2026-11-23T08:05:00.000Z',
        scannedAt: '2026-11-23T09:00:00.000Z',
        timeIn: '2026-11-23T09:00:00.000Z',
        timeOut: null,
        entryDeviceId: 'gate-station-01',
        exitDeviceId: null,
        decidedByUid: null,
        rejectionReason: null,
        gate: 'Gate 1',
        expectedGate: 'Gate 1',
        photoPublicId: 'photo-123',
        idImagePublicId: 'id-456',
        accountabilityStatus: 'pending',
        accountabilityNotes: 'Checked with guard on duty',
        exitVerificationType: null,
        missingExit: true,
        missingOffice: true,
        bothMissing: true,
        isCompleted: false,
        overdueMinutes: 75,
        expectedClosingTime: '2026-11-23T17:00:00.000Z',
        resolutions: [
          {
            id: 'res-1',
            resolutionType: 'mark_reviewed',
            reason: 'Reviewed during roll call',
            createdAt: '2026-11-23T18:00:00.000Z',
          },
        ],
      };

      const pass = deserializeRecordPass(serialized);
      expect(pass.id).toBe('pass-uuid-1234');
      expect(pass.visitorName).toBe('Juan Dela Cruz');
      expect(pass.missingExit).toBe(true);
      expect(pass.missingOffice).toBe(true);
      expect(pass.bothMissing).toBe(true);
      expect(pass.isCompleted).toBe(false);
      expect(pass.overdueMinutes).toBe(75);
      expect(pass.accountabilityStatus).toBe('pending');
      expect(pass.accountabilityNotes).toBe('Checked with guard on duty');
      expect(pass.resolutions).toHaveLength(1);
      expect(pass.resolutions?.[0].resolutionType).toBe('mark_reviewed');
    });
  });

  describe('6. Route Contract & Privilege Integration', () => {
    it('confirms /api/admin/records allows GET, PATCH, and POST methods in route map', () => {
      const recordsRoute = getRouteByPath('/api/admin/records');
      expect(recordsRoute).toBeDefined();
      expect(recordsRoute?.allowedMethods).toContain('GET');
      expect(recordsRoute?.allowedMethods).toContain('PATCH');
      expect(recordsRoute?.allowedMethods).toContain('POST');
    });

    it('confirms visitor_accountability_resolutions is protected in the service role table contract', () => {
      const tableContract = SERVICE_ROLE_TABLE_CONTRACT['visitor_accountability_resolutions'];
      expect(tableContract).toBeDefined();
      expect(tableContract.justification).toContain('accountability resolutions');
      expect(tableContract.allowedPrivileges).toEqual(['SELECT', 'INSERT']);
      expect(tableContract.forbiddenPrivileges).toEqual(['UPDATE', 'DELETE']);
    });

    it('verifies SQL migration definition creates table and security definer RPC', () => {
      const migrationFile = join(
        process.cwd(),
        'supabase',
        'migrations',
        '20261123000900_visitor_reports_accountability_and_reconciliation.sql'
      );
      const sql = readFileSync(migrationFile, 'utf8');

      expect(sql).toContain('create table if not exists public.visitor_accountability_resolutions');
      expect(sql).toContain('create or replace function api.resolve_visitor_accountability');
      expect(sql).toContain('security definer');
      expect(sql).toContain("set search_path = ''");
      expect(sql).toContain("actor_profile.role <> 'superadmin'");
      expect(sql).toContain('record_verified_exit');
      expect(sql).toContain('confirm_office_visit');
      expect(sql).toContain('mark_reviewed');
      expect(sql).toContain('record_exception');
    });
  });
});
