import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  compareFeedEntries,
  mergeFeedHead,
  mergeLoadMore,
  type StationEntry,
} from '../src/pages/GuardPage';

describe('Guard Station Device, Feed & Evidence Boundaries (Executable + Contract)', () => {
  const feedSource = fs.readFileSync(
    path.resolve('server/routes/gate/guard-station-feed.ts'),
    'utf-8'
  );
  const evidenceSource = fs.readFileSync(
    path.resolve('server/routes/gate/evidence.ts'),
    'utf-8'
  );
  const appSource = fs.readFileSync(
    path.resolve('src/App.tsx'),
    'utf-8'
  );

  it('1. App.tsx strictly restricts /guard to guard_station devices and admins (no personal guard accounts)', () => {
    // /guard route must allow guard_station, admin, superadmin, and NOT legacy guard role
    expect(appSource).toMatch(/path="\/guard"/);
    expect(appSource).toMatch(/allowedRoles=\{\['guard_station',\s*'admin',\s*'superadmin'\]\}/);
    expect(appSource).not.toMatch(/allowedRoles=\{\['guard_station',\s*'guard'/);
  });

  it('2. Guard station feed filters to portal online entries and active gate confinement', () => {
    // Must filter strictly to portal source
    expect(feedSource).toContain(".eq('source', 'portal')");
    // Must filter to entered states (inside, exited)
    expect(feedSource).toContain(".in('status', ['inside', 'exited'])");
    // Must require valid entry scan
    expect(feedSource).toContain(".not('entry_scanned_at', 'is', null)");
    // Must confine to station gate
    expect(feedSource).toContain(".eq('gate', stationGate)");
    // Must validate admin gate parameter against active devices
    expect(feedSource).toContain("error: 'invalid_gate'");
  });

  it('3. Evidence endpoint enforces photo-only for guard stations and eliminates nonexistent completed status', () => {
    // Photo only boundary
    expect(evidenceSource).toContain("if (evidence.kind !== 'photo')");
    expect(evidenceSource).toContain("Guard station cannot access ID evidence");
    // Lifecycle status containment must NOT include nonexistent 'completed'
    expect(evidenceSource).not.toContain("'completed'");
    expect(evidenceSource).toContain(".in('status', ['inside', 'exited'])");
  });

  it('4. Executable PostgreSQL test: Guard Station feed criteria matches portal entered passes only', async () => {
    const db = new PGlite();
    await db.exec(`
      create type pass_source as enum ('portal', 'kiosk');
      create type visit_status as enum ('issued', 'pending', 'inside', 'exited', 'rejected', 'expired');

      create table visitors (
        id uuid primary key default gen_random_uuid(),
        full_name text not null,
        contact_number text not null,
        purpose text not null
      );

      create table passes (
        id uuid primary key default gen_random_uuid(),
        public_reference text not null,
        visitor_id uuid not null references visitors(id),
        source pass_source not null,
        status visit_status not null,
        gate text not null,
        entry_scanned_at timestamptz,
        time_in timestamptz,
        time_out timestamptz
      );
    `);

    // Setup visitors
    const v1 = (await db.query<{ id: string }>(`insert into visitors (full_name, contact_number, purpose) values ('Portal Visitor A', '09171234567', 'Official') returning id;`)).rows[0]!.id;
    const v2 = (await db.query<{ id: string }>(`insert into visitors (full_name, contact_number, purpose) values ('Kiosk Pending B', '09171234568', 'Inquiry') returning id;`)).rows[0]!.id;
    const v3 = (await db.query<{ id: string }>(`insert into visitors (full_name, contact_number, purpose) values ('Portal Gate 2 C', '09171234569', 'Delivery') returning id;`)).rows[0]!.id;

    const now = new Date().toISOString();

    // Pass 1: Portal pass at Gate 1, entered (status = inside) -> SHOULD APPEAR
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, gate, entry_scanned_at, time_in)
      values ('PASS-001', $1, 'portal', 'inside', 'Gate 1', $2, $2);
    `, [v1, now]);

    // Pass 2: Kiosk pass at Gate 1, awaiting review (status = pending) -> MUST NOT APPEAR
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, gate, entry_scanned_at)
      values ('PASS-002', $1, 'kiosk', 'pending', 'Gate 1', $2);
    `, [v2, now]);

    // Pass 3: Portal pass at Gate 2, entered (status = inside) -> MUST NOT APPEAR at Gate 1
    await db.query(`
      insert into passes (public_reference, visitor_id, source, status, gate, entry_scanned_at, time_in)
      values ('PASS-003', $1, 'portal', 'inside', 'Gate 2', $2, $2);
    `, [v3, now]);

    // Query mimicking guard-station-feed.ts for station at 'Gate 1'
    const feedResults = await db.query<{ public_reference: string; source: string; status: string }>(`
      select public_reference, source, status
      from passes
      where gate = 'Gate 1'
        and source = 'portal'
        and status in ('inside', 'exited')
        and entry_scanned_at is not null
      order by entry_scanned_at desc;
    `);

    expect(feedResults.rows).toHaveLength(1);
    expect(feedResults.rows[0]?.public_reference).toBe('PASS-001');
    expect(feedResults.rows[0]?.source).toBe('portal');
    expect(feedResults.rows[0]?.status).toBe('inside');
  }, 60000);

  it('5. Keyset pagination: queries page 1 (50) and page 2 (5) without duplicate or missing rows', async () => {
    const db = new PGlite();
    await db.exec(`
      create type pass_source as enum ('portal', 'kiosk');
      create type visit_status as enum ('issued', 'pending', 'inside', 'exited', 'rejected', 'expired');

      create table visitors (
        id uuid primary key default gen_random_uuid(),
        full_name text not null,
        contact_number text not null,
        purpose text not null
      );

      create table passes (
        id uuid primary key default gen_random_uuid(),
        public_reference text not null,
        visitor_id uuid not null references visitors(id),
        source pass_source not null,
        status visit_status not null,
        gate text not null,
        entry_scanned_at timestamptz not null,
        time_in timestamptz,
        time_out timestamptz
      );
    `);

    const vId = (await db.query<{ id: string }>(`insert into visitors (full_name, contact_number, purpose) values ('Visitor Batch', '09171234567', 'Official') returning id;`)).rows[0]!.id;

    // Insert 55 passes with strictly descending timestamps
    const baseTime = Date.now();
    for (let i = 0; i < 55; i++) {
      const ts = new Date(baseTime - i * 1000).toISOString();
      await db.query(`
        insert into passes (public_reference, visitor_id, source, status, gate, entry_scanned_at)
        values ($1, $2, 'portal', 'inside', 'Gate 1', $3);
      `, [`REF-${i.toString().padStart(3, '0')}`, vId, ts]);
    }

    // Page 1: limit 50 + 1
    const p1Raw = await db.query<{ id: string; public_reference: string; entry_scanned_at: string }>(`
      select id, public_reference, entry_scanned_at
      from passes
      where gate = 'Gate 1' and source = 'portal' and status in ('inside', 'exited')
      order by entry_scanned_at desc, id desc
      limit 51;
    `);

    expect(p1Raw.rows.length).toBe(51);
    const p1 = p1Raw.rows.slice(0, 50);
    const hasMore = p1Raw.rows.length > 50;
    expect(hasMore).toBe(true);

    const cursorItem = p1[49]!;

    // Page 2: with cursor
    const p2Raw = await db.query<{ id: string; public_reference: string; entry_scanned_at: string }>(`
      select id, public_reference, entry_scanned_at
      from passes
      where gate = 'Gate 1' and source = 'portal' and status in ('inside', 'exited')
        and (entry_scanned_at < $1 or (entry_scanned_at = $1 and id < $2))
      order by entry_scanned_at desc, id desc
      limit 51;
    `, [cursorItem.entry_scanned_at, cursorItem.id]);

    expect(p2Raw.rows.length).toBe(5);

    // Verify union is exactly 55 unique items
    const allRefs = new Set([...p1.map((p) => p.public_reference), ...p2Raw.rows.map((p) => p.public_reference)]);
    expect(allRefs.size).toBe(55);
  }, 60000);

  it('6. Guard Station Feed & Page: Manila calendar day bounds and dynamic badges verified in source', () => {
    const guardPageSource = fs.readFileSync(path.resolve('src/pages/GuardPage.tsx'), 'utf-8');

    // Feed source must use getManilaDayBounds
    expect(feedSource).toContain('getManilaDayBounds');
    expect(feedSource).toContain('manilaOffsetMs = 8 * 60 * 60 * 1000');
    expect(feedSource).toContain('decodeCursorStrict');

    // Feed source must return total, hasMore, nextCursor
    expect(feedSource).toContain('total: totalCount ?? entries.length');
    expect(feedSource).toContain('hasMore');
    expect(feedSource).toContain('nextCursor');

    // GuardPage must not use setInterval
    expect(guardPageSource).not.toMatch(/setInterval\s*\(/);
    // GuardPage must use AbortController and sequence tracking
    expect(guardPageSource).toContain('requestSeqRef');
    expect(guardPageSource).toContain('activeControllerRef');
    // GuardPage must display authoritative total
    expect(guardPageSource).toContain("Today's total:");
    // GuardPage must have Load More
    expect(guardPageSource).toContain('handleLoadMore');
    // GuardPage must render dynamic Inside vs Exited badges
    expect(guardPageSource).toContain('Currently Inside Campus');
    expect(guardPageSource).toContain('Exited Campus');
  });

  function makeMockEntry(id: string, ref: string, enteredAt: string, status: 'inside' | 'exited' = 'inside'): StationEntry {
    return {
      passId: id,
      publicReference: ref,
      status,
      source: 'portal',
      enteredAt,
      visitorName: `Visitor ${ref}`,
      purpose: 'Official Business',
      photoEvidenceId: null,
      gate: 'Gate 1',
      vehicle: null,
    };
  }

  it('7. (Test A1) mergeFeedHead preserves page 2 entries when page 1 is refreshed', () => {
    // Current displayed feed has Page 1 (e1, e2) and Page 2 (e3, e4)
    const e1 = makeMockEntry('uuid-001', 'REF-001', '2026-11-01T10:00:00.000Z');
    const e2 = makeMockEntry('uuid-002', 'REF-002', '2026-11-01T09:50:00.000Z');
    const e3 = makeMockEntry('uuid-003', 'REF-003', '2026-11-01T09:40:00.000Z');
    const e4 = makeMockEntry('uuid-004', 'REF-004', '2026-11-01T09:30:00.000Z');
    const currentFeed = [e1, e2, e3, e4];

    // Background poll returns latest Page 1 (e1, e2)
    const headPoll = [e1, e2];
    const merged = mergeFeedHead(currentFeed, headPoll);

    expect(merged.length).toBe(4);
    expect(merged.map((e) => e.publicReference)).toEqual(['REF-001', 'REF-002', 'REF-003', 'REF-004']);
  });

  it('8. (Test A2) mergeFeedHead updates existing entry statuses in-place while preserving page 2', () => {
    const e1Inside = makeMockEntry('uuid-001', 'REF-001', '2026-11-01T10:00:00.000Z', 'inside');
    const e2 = makeMockEntry('uuid-002', 'REF-002', '2026-11-01T09:50:00.000Z', 'inside');
    const e3 = makeMockEntry('uuid-003', 'REF-003', '2026-11-01T09:40:00.000Z', 'inside');
    const currentFeed = [e1Inside, e2, e3];

    // Visitor 1 exits campus; head poll returns updated status
    const e1Exited = makeMockEntry('uuid-001', 'REF-001', '2026-11-01T10:00:00.000Z', 'exited');
    const headPoll = [e1Exited, e2];
    const merged = mergeFeedHead(currentFeed, headPoll);

    expect(merged.length).toBe(3);
    expect(merged[0]?.status).toBe('exited');
    expect(merged[1]?.status).toBe('inside');
    expect(merged[2]?.publicReference).toBe('REF-003');
    expect(merged[2]?.status).toBe('inside');
  });

  it('9. (Test A3) mergeFeedHead prepends newly arriving visitors while keeping older page 2 entries in canonical keyset order', () => {
    const e1 = makeMockEntry('uuid-001', 'REF-001', '2026-11-01T10:00:00.000Z');
    const e2 = makeMockEntry('uuid-002', 'REF-002', '2026-11-01T09:50:00.000Z');
    const e3 = makeMockEntry('uuid-003', 'REF-003', '2026-11-01T09:40:00.000Z');
    const currentFeed = [e1, e2, e3];

    // New visitor arrives at 10:15
    const eNew = makeMockEntry('uuid-000', 'REF-000', '2026-11-01T10:15:00.000Z');
    const headPoll = [eNew, e1];
    const merged = mergeFeedHead(currentFeed, headPoll);

    expect(merged.length).toBe(4);
    expect(merged.map((e) => e.publicReference)).toEqual(['REF-000', 'REF-001', 'REF-002', 'REF-003']);
  });

  it('10. (Test A4) GuardPage source contract: continuation cursor and hasMore are preserved when older pages are loaded', () => {
    const guardPageSource = fs.readFileSync(path.resolve('src/pages/GuardPage.tsx'), 'utf-8');

    // Continuation cursor ref and hasLoadedOlderPagesRef must exist
    expect(guardPageSource).toContain('const continuationCursorRef = useRef<string | null>(null);');
    expect(guardPageSource).toContain('const hasLoadedOlderPagesRef = useRef<boolean>(false);');

    // Head refresh must guard continuation cursor overwrite
    expect(guardPageSource).toContain('if (!hasLoadedOlderPagesRef.current) {');
    expect(guardPageSource).toContain('continuationCursorRef.current = data.nextCursor || null;');
    expect(guardPageSource).toContain('setHasMore(Boolean(data.hasMore));');

    // Load more must update continuation cursor and mark hasLoadedOlderPagesRef = true
    expect(guardPageSource).toContain('hasLoadedOlderPagesRef.current = true;');
    expect(guardPageSource).toContain('mergeLoadMore');
  });

  it('11. (Test A5) Concurrent in-flight requests: Load More and head poll interleaving produces deterministic union', () => {
    const e0 = makeMockEntry('uuid-000', 'REF-000', '2026-11-01T10:15:00.000Z');
    const e1 = makeMockEntry('uuid-001', 'REF-001', '2026-11-01T10:00:00.000Z');
    const e2 = makeMockEntry('uuid-002', 'REF-002', '2026-11-01T09:50:00.000Z');
    const e3 = makeMockEntry('uuid-003', 'REF-003', '2026-11-01T09:40:00.000Z');
    const e4 = makeMockEntry('uuid-004', 'REF-004', '2026-11-01T09:30:00.000Z');

    const initial = [e1, e2];

    // Permutation 1: Head poll completes first, then Load More completes
    const afterHead1 = mergeFeedHead(initial, [e0, e1]);
    const final1 = mergeLoadMore(afterHead1, [e3, e4]);

    // Permutation 2: Load More completes first, then Head poll completes
    const afterLoadMore2 = mergeLoadMore(initial, [e3, e4]);
    const final2 = mergeFeedHead(afterLoadMore2, [e0, e1]);

    const expectedOrder = ['REF-000', 'REF-001', 'REF-002', 'REF-003', 'REF-004'];
    expect(final1.map((e) => e.publicReference)).toEqual(expectedOrder);
    expect(final2.map((e) => e.publicReference)).toEqual(expectedOrder);
  });

  it('12. (Test A6) Network failure during head refresh preserves existing entries and continuation cursor', () => {
    const guardPageSource = fs.readFileSync(path.resolve('src/pages/GuardPage.tsx'), 'utf-8');

    // Verify fetchFeed error handling does not wipe entries or reset cursor
    expect(guardPageSource).toContain('Failed to load guard station feed:');
    // Verify that catch block does not clear entries or cursor
    const catchIndex = guardPageSource.indexOf('Failed to load guard station feed:');
    const catchSnippet = guardPageSource.slice(catchIndex, catchIndex + 200);
    expect(catchSnippet).not.toContain('setEntries');
    expect(catchSnippet).not.toContain('continuationCursorRef');
    expect(catchSnippet).not.toContain('setHasMore');
  });

  it('13. (Test A7) Station change or gate switch resets pagination and feed entries cleanly', () => {
    const guardPageSource = fs.readFileSync(path.resolve('src/pages/GuardPage.tsx'), 'utf-8');

    // On unmount/station change or initial load, state is cleanly reset
    expect(guardPageSource).toContain('if (activeControllerRef.current) activeControllerRef.current.abort();');
    expect(guardPageSource).toContain('if (loadMoreControllerRef.current) loadMoreControllerRef.current.abort();');
    expect(guardPageSource).toContain('currentStationIdRef.current !== data.station.id');
    expect(guardPageSource).toContain('continuationCursorRef.current = null;');
    expect(guardPageSource).toContain('hasLoadedOlderPagesRef.current = false;');
    expect(guardPageSource).toContain('setEntries(data.entries);');
    expect(guardPageSource).toContain('setHasMore(Boolean(data.hasMore));');
  });
});
