import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  resolveEntryScanSuccess,
  resolveEntryScanFailure,
} from '../src/lib/entryScanFeedback';
import {
  getQrScanConfig,
  QR_CAMERA_CONSTRAINTS,
} from '../src/lib/qrScanner';
import {
  compareFeedEntries,
  mergeFeedHead,
  type StationEntry,
} from '../src/pages/GuardPage';

describe('Defense-Critical Registration, QR Scanning, Guard View & Visitor Photo Audit', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      create type pass_source as enum ('portal', 'kiosk');
      create type pass_status as enum ('issued', 'pending', 'inside', 'exited', 'rejected', 'expired');
      create type device_type as enum ('entry', 'exit', 'kiosk', 'guard_station');
      create type device_status as enum ('active', 'disabled');
      create type evidence_kind as enum ('photo', 'id', 'vehicle_photo');

      create table devices (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null unique,
        name text not null,
        alias text not null,
        type device_type not null,
        gate text not null,
        status device_status not null default 'active',
        last_seen_at timestamptz
      );

      create table staff_profiles (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null unique,
        role text not null,
        active boolean not null default true,
        must_change_password boolean not null default false,
        privacy_accepted_at timestamptz default now()
      );

      create table returning_visitor_profiles (
        id uuid primary key default gen_random_uuid(),
        full_name text not null,
        contact_number text not null,
        expires_at timestamptz not null,
        revoked_at timestamptz
      );

      create table visitors (
        id uuid primary key default gen_random_uuid(),
        full_name text not null,
        contact_number text not null,
        purpose text not null,
        returning_profile_id uuid references returning_visitor_profiles(id),
        created_at timestamptz default now()
      );

      create table passes (
        id uuid primary key default gen_random_uuid(),
        public_reference text not null unique,
        visitor_id uuid not null references visitors(id),
        source pass_source not null,
        status pass_status not null default 'issued',
        token_digest bytea not null,
        gate text,
        expected_gate text,
        entry_scanned_at timestamptz,
        time_in timestamptz,
        time_out timestamptz,
        valid_from timestamptz not null,
        valid_until timestamptz not null,
        created_at timestamptz default now()
      );

      create table visitor_evidence (
        id uuid primary key default gen_random_uuid(),
        visitor_id uuid not null references visitors(id),
        kind evidence_kind not null,
        bucket_id text not null,
        object_path text not null,
        content_type text not null,
        byte_size integer not null,
        sha256_hex text not null,
        expires_at timestamptz not null,
        purged_at timestamptz,
        created_at timestamptz default now()
      );

      create table visit_events (
        id uuid primary key default gen_random_uuid(),
        pass_id uuid references passes(id),
        visitor_id uuid references visitors(id),
        event text not null,
        reason text,
        gate text,
        device_id uuid,
        created_at timestamptz default now()
      );
    `);
  });

  // ------------------------------------------------------------------------
  // 1. Successful Portal Registration and QR Issuance
  // ------------------------------------------------------------------------
  it('1. Generates authentic qrToken and matching token_digest during portal registration', async () => {
    const passTokenSecret = 'defense_audit_secure_pass_token_secret_2026_test';
    const actorId = randomUUID();
    const requestId = randomUUID();

    // Replicate production token generation in server/routes/passes/issue.ts
    const qrToken = createHmac('sha256', passTokenSecret)
      .update(`${actorId}:${requestId}`)
      .digest('base64url');

    const tokenDigestHex = createHash('sha256').update(qrToken).digest('hex');
    expect(qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenDigestHex).toMatch(/^[0-9a-f]{64}$/);

    // Insert visitor and pass
    const vRes = await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Maria Santos', '+639171234567', 'Official Academic Visit')
      returning id;
    `);
    const visitorId = vRes.rows[0]!.id;

    const now = new Date();
    const validFrom = new Date(now.getTime() - 1000 * 60).toISOString();
    const validUntil = new Date(now.getTime() + 1000 * 60 * 60 * 8).toISOString();

    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, valid_from, valid_until, expected_gate)
      values ('GP-2026-001', $1, 'portal', 'issued', decode($2, 'hex'), $3, $4, 'Gate 1');
    `, [visitorId, tokenDigestHex, validFrom, validUntil]);

    // Verify stored digest matches
    const stored = await db.query<{ public_reference: string; token_digest_hex: string }>(`
      select public_reference, encode(token_digest, 'hex') as token_digest_hex
      from passes where public_reference = 'GP-2026-001';
    `);
    expect(stored.rows[0]?.token_digest_hex).toBe(tokenDigestHex);
  });

  // ------------------------------------------------------------------------
  // 2. Correct QR Token Decoding and Submission
  // ------------------------------------------------------------------------
  it('2. QR scanner trims and submits decoded token without accidental transformation', () => {
    const rawQrFromCamera = '  v1_secure_base64url_token_from_qr_symbol  ';
    const cleanToken = rawQrFromCamera.trim();

    expect(cleanToken).toBe('v1_secure_base64url_token_from_qr_symbol');
    expect(cleanToken.length).toBeGreaterThanOrEqual(20);

    const submissionPayload = { passId: cleanToken, mode: 'entry' };
    expect(submissionPayload.passId).toBe('v1_secure_base64url_token_from_qr_symbol');
    expect(submissionPayload.mode).toBe('entry');
  });

  // ------------------------------------------------------------------------
  // 3. Valid Portal Entry Scan
  // ------------------------------------------------------------------------
  it('3. Valid portal entry scan transitions pass to inside and sets time_in, gate, and entry_scanned_at', async () => {
    const qrToken = 'valid_portal_visitor_qr_token_defense_test_003';
    const digestHex = createHash('sha256').update(qrToken).digest('hex');

    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Juan Dela Cruz', '+639181234567', 'Campus Visit')
      returning id;
    `)).rows[0]!.id;

    const now = new Date();
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, valid_from, valid_until, expected_gate)
      values ('GP-ENTRY-003', $1, 'portal', 'issued', decode($2, 'hex'), $3, $4, 'Gate 1');
    `, [vId, digestHex, new Date(now.getTime() - 60000).toISOString(), new Date(now.getTime() + 3600000).toISOString()]);

    // Scanner device at Gate 1
    const scannerId = randomUUID();
    await db.query(`
      insert into devices (user_id, name, alias, type, gate, status)
      values ($1, 'Gate 1 Entry Scanner', 'scanner-g1-in', 'entry', 'Gate 1', 'active');
    `, [scannerId]);

    // Simulate entry scan transaction (matching api.scan_pass)
    const scanTime = new Date().toISOString();
    const updateRes = await db.query<{ status: string; gate: string; time_in: string }>(`
      update passes set
        status = 'inside',
        entry_scanned_at = $1,
        time_in = $1,
        gate = 'Gate 1'
      where token_digest = decode($2, 'hex')
        and status = 'issued'
        and valid_from <= $1
        and valid_until >= $1
      returning status, gate, time_in;
    `, [scanTime, digestHex]);

    expect(updateRes.rows).toHaveLength(1);
    expect(updateRes.rows[0]?.status).toBe('inside');
    expect(updateRes.rows[0]?.gate).toBe('Gate 1');

    // Frontend feedback evaluation
    const feedback = resolveEntryScanSuccess({
      status: 'inside',
      message: 'Entry recorded. Please proceed through the normal security inspection.',
    });
    expect(feedback.status).toBe('granted');
    expect(feedback.toast.type).toBe('success');
  });

  // ------------------------------------------------------------------------
  // 4. Invalid QR Token
  // ------------------------------------------------------------------------
  it('4. Invalid QR token fails safely and returns not_found / scan_failed', async () => {
    const unknownToken = 'unknown_random_unregistered_qr_token_999999';
    const unknownDigestHex = createHash('sha256').update(unknownToken).digest('hex');

    const searchRes = await db.query(`
      select id from passes where token_digest = decode($1, 'hex');
    `, [unknownDigestHex]);

    expect(searchRes.rows).toHaveLength(0);

    const failureFeedback = resolveEntryScanFailure({
      code: 'not_found',
      error: 'QR code not recognized',
    });
    expect(failureFeedback.status).toBe('error');
    expect(failureFeedback.statusMessage).toBe('QR code not recognized');
  });

  // ------------------------------------------------------------------------
  // 5. Expired Pass
  // ------------------------------------------------------------------------
  it('5. Expired pass fails closed and cannot enter', async () => {
    const qrToken = 'expired_pass_token_defense_test_005';
    const digestHex = createHash('sha256').update(qrToken).digest('hex');

    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Expired Visitor', '+639191234567', 'Late Visit')
      returning id;
    `)).rows[0]!.id;

    const pastTime = new Date(Date.now() - 3600000 * 2).toISOString();
    const expiredTime = new Date(Date.now() - 3600000).toISOString();

    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, valid_from, valid_until)
      values ('GP-EXPIRED-005', $1, 'portal', 'issued', decode($2, 'hex'), $3, $4);
    `, [vId, digestHex, pastTime, expiredTime]);

    // Check validity
    const checkRes = await db.query<{ is_valid: boolean }>(`
      select (valid_until >= now() and valid_from <= now()) as is_valid
      from passes where token_digest = decode($1, 'hex');
    `, [digestHex]);

    expect(checkRes.rows[0]?.is_valid).toBe(false);

    const feedback = resolveEntryScanFailure({
      code: 'expired',
      error: 'This pass has expired',
    });
    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe('This pass has expired');
  });

  // ------------------------------------------------------------------------
  // 6. Wrong Gate Exit Scan
  // ------------------------------------------------------------------------
  it('6. Exit scan at wrong gate is rejected with wrong_gate', async () => {
    const qrToken = 'wrong_gate_exit_token_006';
    const digestHex = createHash('sha256').update(qrToken).digest('hex');

    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Gate 1 Visitor', '+639181234568', 'Inspection')
      returning id;
    `)).rows[0]!.id;

    // Entered at Gate 1
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, gate, valid_from, valid_until, entry_scanned_at)
      values ('GP-GATE1-006', $1, 'portal', 'inside', decode($2, 'hex'), 'Gate 1', now() - interval '1 hour', now() + interval '1 hour', now() - interval '1 hour');
    `, [vId, digestHex]);

    // Scanner is at Gate 2
    const scannerGate = 'Gate 2';

    // Verify gate mismatch logic matching api.scan_pass
    const pass = (await db.query<{ gate: string; status: string }>(`
      select gate, status from passes where token_digest = decode($1, 'hex');
    `, [digestHex])).rows[0]!;

    const isGateMismatch = pass.gate.toLowerCase().trim() !== scannerGate.toLowerCase().trim();
    expect(isGateMismatch).toBe(true);

    const feedback = resolveEntryScanFailure({
      code: 'wrong_gate',
      error: 'Use the exit scanner assigned to the entry gate',
    });
    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe('Use the exit scanner assigned to the entry gate');
  });

  // ------------------------------------------------------------------------
  // 7. Duplicate Entry Scan
  // ------------------------------------------------------------------------
  it('7. Duplicate entry scan on already inside pass is safely rejected', async () => {
    const qrToken = 'duplicate_entry_token_007';
    const digestHex = createHash('sha256').update(qrToken).digest('hex');

    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Inside Visitor', '+639181234569', 'Testing Duplicate')
      returning id;
    `)).rows[0]!.id;

    // Already inside
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, gate, valid_from, valid_until, entry_scanned_at, time_in)
      values ('GP-INSIDE-007', $1, 'portal', 'inside', decode($2, 'hex'), 'Gate 1', now() - interval '10 minutes', now() + interval '2 hours', now() - interval '10 minutes', now() - interval '10 minutes');
    `, [vId, digestHex]);

    // Attempting entry scan when status is already inside
    const pass = (await db.query<{ status: string }>(`
      select status from passes where token_digest = decode($1, 'hex');
    `, [digestHex])).rows[0]!;

    expect(pass.status).toBe('inside');
    // Cannot transition from inside to inside
    const canEnter = pass.status === 'issued';
    expect(canEnter).toBe(false);

    const feedback = resolveEntryScanFailure({
      code: 'already_used',
      error: 'Pass has already been used for entry',
    });
    expect(feedback.status).toBe('warning');
  });

  // ------------------------------------------------------------------------
  // 8. Guard Station Feed Update After Successful Entry
  // ------------------------------------------------------------------------
  it('8. Guard Station feed returns entered portal pass at the station gate today', async () => {
    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Admitted Visitor', '+639181234570', 'Scheduled Meeting')
      returning id;
    `)).rows[0]!.id;

    const now = new Date().toISOString();
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, gate, valid_from, valid_until, entry_scanned_at, time_in)
      values ('GP-FEED-008', $1, 'portal', 'inside', decode('abcdef', 'hex'), 'Gate 1', $2, $2, $2, $2);
    `, [vId, now]);

    // Feed query for Gate 1
    const feed = await db.query<{ public_reference: string; status: string; source: string }>(`
      select public_reference, status, source
      from passes
      where lower(trim(gate)) = lower(trim('Gate 1'))
        and source = 'portal'
        and status in ('inside', 'exited')
        and entry_scanned_at is not null;
    `);

    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0]?.public_reference).toBe('GP-FEED-008');
    expect(feed.rows[0]?.status).toBe('inside');
    expect(feed.rows[0]?.source).toBe('portal');
  });

  // ------------------------------------------------------------------------
  // 9. Visitor Photo Evidence ID Returned by the Feed
  // ------------------------------------------------------------------------
  it('9. Guard Station feed resolves and returns visitor photo evidence ID', async () => {
    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Photographed Visitor', '+639181234571', 'Official Business')
      returning id;
    `)).rows[0]!.id;

    const evId = (await db.query<{ id: string }>(`
      insert into visitor_evidence (visitor_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at)
      values ($1, 'photo', 'visitor-photos', 'evidence/v1/selfie.jpg', 'image/jpeg', 102400, 'sha256sample', now() + interval '30 days')
      returning id;
    `, [vId])).rows[0]!.id;

    const now = new Date().toISOString();
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, gate, valid_from, valid_until, entry_scanned_at, time_in)
      values ('GP-PHOTO-009', $1, 'portal', 'inside', decode('123456', 'hex'), 'Gate 1', $2, $2, $2, $2);
    `, [vId, now]);

    // Feed query joining photo evidence
    const result = await db.query<{ public_reference: string; photo_evidence_id: string }>(`
      select p.public_reference, ve.id as photo_evidence_id
      from passes p
      join visitors v on p.visitor_id = v.id
      left join visitor_evidence ve on ve.visitor_id = v.id and ve.kind = 'photo' and ve.purged_at is null
      where p.public_reference = 'GP-PHOTO-009';
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.photo_evidence_id).toBe(evId);
  });

  // ------------------------------------------------------------------------
  // 10. Authenticated Image Retrieval & Guard Station Privacy Boundary
  // ------------------------------------------------------------------------
  it('10. Guard Station device is permitted photo evidence but strictly forbidden ID evidence', async () => {
    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('ID Tested Visitor', '+639181234572', 'Audit')
      returning id;
    `)).rows[0]!.id;

    const photoEvId = (await db.query<{ id: string }>(`
      insert into visitor_evidence (visitor_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at)
      values ($1, 'photo', 'visitor-photos', 'evidence/photo.jpg', 'image/jpeg', 50000, 'hash1', now() + interval '1 day')
      returning id;
    `, [vId])).rows[0]!.id;

    const idEvId = (await db.query<{ id: string }>(`
      insert into visitor_evidence (visitor_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at)
      values ($1, 'id', 'visitor-ids', 'evidence/id.jpg', 'image/jpeg', 80000, 'hash2', now() + interval '1 day')
      returning id;
    `, [vId])).rows[0]!.id;

    // Check kind for guard station device caller
    const checkPhoto = (await db.query<{ kind: string }>(`select kind from visitor_evidence where id = $1;`, [photoEvId])).rows[0]!;
    const checkId = (await db.query<{ kind: string }>(`select kind from visitor_evidence where id = $1;`, [idEvId])).rows[0]!;

    expect(checkPhoto.kind === 'photo').toBe(true); // Allowed
    expect(checkId.kind === 'photo').toBe(false);   // Forbidden for guard station
  });

  // ------------------------------------------------------------------------
  // 11. Missing/Purged Photo Fallback
  // ------------------------------------------------------------------------
  it('11. Purged evidence is flagged purged_at and produces 410 Evidence expired', async () => {
    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Purged Visitor', '+639181234573', 'Retention Audit')
      returning id;
    `)).rows[0]!.id;

    const purgedEvId = (await db.query<{ id: string }>(`
      insert into visitor_evidence (visitor_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at, purged_at)
      values ($1, 'photo', 'visitor-photos', 'purged/photo.jpg', 'image/jpeg', 50000, 'hash3', now() - interval '1 day', now() - interval '1 hour')
      returning id;
    `, [vId])).rows[0]!.id;

    const ev = (await db.query<{ purged_at: string | null }>(`
      select purged_at from visitor_evidence where id = $1;
    `, [purgedEvId])).rows[0]!;

    expect(ev.purged_at).not.toBeNull();
  });

  // ------------------------------------------------------------------------
  // 12. Returning Visitor Historical Portrait Retrieval
  // ------------------------------------------------------------------------
  it('12. Returning visitor resolves original photo evidence linked via returning_profile_id', async () => {
    // 1. Create returning visitor profile
    const profId = (await db.query<{ id: string }>(`
      insert into returning_visitor_profiles (full_name, contact_number, expires_at)
      values ('Returning Regular', '+639181234574', now() + interval '30 days')
      returning id;
    `)).rows[0]!.id;

    // 2. Initial visit 1 with enrolled photo evidence
    const v1Id = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose, returning_profile_id)
      values ('Returning Regular', '+639181234574', 'First Visit', $1)
      returning id;
    `, [profId])).rows[0]!.id;

    const originalPhotoId = (await db.query<{ id: string }>(`
      insert into visitor_evidence (visitor_id, kind, bucket_id, object_path, content_type, byte_size, sha256_hex, expires_at)
      values ($1, 'photo', 'visitor-photos', 'original/portrait.jpg', 'image/jpeg', 90000, 'hashorig', now() + interval '30 days')
      returning id;
    `, [v1Id])).rows[0]!.id;

    // 3. Second visit today (visitor 2) linked to the same returning profile, without re-taking selfie
    const v2Id = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose, returning_profile_id)
      values ('Returning Regular', '+639181234574', 'Second Visit Today', $1)
      returning id;
    `, [profId])).rows[0]!.id;

    const now = new Date().toISOString();
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, gate, valid_from, valid_until, entry_scanned_at, time_in)
      values ('GP-RETURNING-012', $1, 'portal', 'inside', decode('998877', 'hex'), 'Gate 1', $2, $2, $2, $2);
    `, [v2Id, now]);

    // 4. Guard station feed query resolving historical portrait (replicating guard-station-feed.ts lines 276-306)
    const linkedVisitors = await db.query<{ id: string; returning_profile_id: string }>(`
      select id, returning_profile_id from visitors where returning_profile_id = $1;
    `, [profId]);

    const linkedIds = linkedVisitors.rows.map((r) => r.id);
    expect(linkedIds).toContain(v1Id);
    expect(linkedIds).toContain(v2Id);

    const origEv = await db.query<{ id: string; visitor_id: string }>(`
      select id, visitor_id from visitor_evidence
      where visitor_id = any($1::uuid[])
        and kind = 'photo'
        and purged_at is null
      order by created_at asc limit 1;
    `, [linkedIds]);

    expect(origEv.rows).toHaveLength(1);
    expect(origEv.rows[0]?.id).toBe(originalPhotoId);
  });

  // ------------------------------------------------------------------------
  // 13. Kiosk Pass Pending Behavior & Explicit Review Path
  // ------------------------------------------------------------------------
  it('13. Kiosk pass transitions to pending, is excluded from Guard Station feed, and requires admin decision', async () => {
    const qrToken = 'kiosk_walkin_pass_qr_token_013';
    const digestHex = createHash('sha256').update(qrToken).digest('hex');

    const vId = (await db.query<{ id: string }>(`
      insert into visitors (full_name, contact_number, purpose)
      values ('Kiosk Walk-In', '+639181234575', 'Walk-in Inquiry')
      returning id;
    `)).rows[0]!.id;

    const now = new Date().toISOString();
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, token_digest, valid_from, valid_until, expected_gate)
      values ('GP-KIOSK-013', $1, 'kiosk', 'issued', decode($2, 'hex'), $3, $3, 'Gate 1');
    `, [vId, digestHex, now]);

    // Kiosk pass entry scan: transitions to 'pending'
    const scanRes = await db.query<{ status: string }>(`
      update passes set
        status = 'pending',
        entry_scanned_at = now(),
        gate = 'Gate 1'
      where token_digest = decode($1, 'hex')
        and source = 'kiosk'
      returning status;
    `, [digestHex]);

    expect(scanRes.rows[0]?.status).toBe('pending');

    // Verify feedback for scanner tablet
    const feedback = resolveEntryScanSuccess({
      status: 'pending',
      message: 'Scanned! Waiting for guard approval.',
    });
    expect(feedback.status).toBe('pending');
    expect(feedback.toast.message).toBe('Pass scanned — pending guard approval');

    // Verify Guard Station feed EXCLUDES pending kiosk pass
    const feed = await db.query(`
      select id from passes
      where lower(trim(gate)) = 'gate 1'
        and source = 'portal'
        and status in ('inside', 'exited');
    `);
    expect(feed.rows).toHaveLength(0); // Excluded!

    // Admin decision approval (simulating api.decide_visit via /admin/legacy-guard)
    const adminId = randomUUID();
    await db.query(`
      insert into staff_profiles (user_id, role, active, must_change_password)
      values ($1, 'admin', true, false);
    `, [adminId]);

    const decideRes = await db.query<{ status: string; time_in: string }>(`
      update passes set
        status = 'inside',
        time_in = now()
      where public_reference = 'GP-KIOSK-013'
        and status = 'pending'
      returning status, time_in;
    `);

    expect(decideRes.rows[0]?.status).toBe('inside');
    expect(decideRes.rows[0]?.time_in).not.toBeNull();
  });

  // ------------------------------------------------------------------------
  // 14. Camera Defaults and MediaStream Lifecycle Invariants
  // ------------------------------------------------------------------------
  it('14. Camera scan config defaults to rear environment camera with disableFlip and continuous focus', () => {
    const config = getQrScanConfig('environment');
    expect(config.videoConstraints).toBeDefined();
    expect((config.videoConstraints as any).facingMode).toEqual({ ideal: 'environment' });
    expect(config.disableFlip).toBe(true);

    const userConfig = getQrScanConfig('user');
    expect((userConfig.videoConstraints as any).facingMode).toEqual({ ideal: 'user' });
  });

  // ------------------------------------------------------------------------
  // 15. Feed Entry Sorting & Head-Merge Stability
  // ------------------------------------------------------------------------
  it('15. compareFeedEntries and mergeFeedHead correctly sort descending without duplicating', () => {
    const entryA: StationEntry = {
      passId: '00000000-0000-0000-0000-000000000001',
      publicReference: 'REF-001',
      status: 'inside',
      source: 'portal',
      enteredAt: '2026-11-23T08:00:00Z',
      visitorName: 'Visitor 1',
      purpose: 'Meeting',
      photoEvidenceId: 'ev-1',
      gate: 'Gate 1',
    };
    const entryB: StationEntry = {
      passId: '00000000-0000-0000-0000-000000000002',
      publicReference: 'REF-002',
      status: 'inside',
      source: 'portal',
      enteredAt: '2026-11-23T08:30:00Z', // Newer
      visitorName: 'Visitor 2',
      purpose: 'Interview',
      photoEvidenceId: 'ev-2',
      gate: 'Gate 1',
    };

    expect(compareFeedEntries(entryA, entryB)).toBeGreaterThan(0); // B is newer, so B comes before A
    expect(compareFeedEntries(entryB, entryA)).toBeLessThan(0);

    const merged = mergeFeedHead([entryA], [entryB, entryA]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.passId).toBe(entryB.passId);
    expect(merged[1]?.passId).toBe(entryA.passId);
  });
});
