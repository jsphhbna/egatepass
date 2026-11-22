import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { compareFeedEntries, mergeFeedHead, type StationEntry } from '../src/pages/GuardPage';

describe('Guard Station Realtime, Meeting Details, and Time In Contract', () => {
  const feedSource = fs.readFileSync(path.resolve('server/routes/gate/guard-station-feed.ts'), 'utf-8');
  const guardPageSource = fs.readFileSync(path.resolve('src/pages/GuardPage.tsx'), 'utf-8');
  const evidenceSource = fs.readFileSync(path.resolve('server/routes/gate/evidence.ts'), 'utf-8');
  const migrationSource = fs.readFileSync(path.resolve('supabase/migrations/20261117000100_guard_station_realtime_and_case_insensitive_gate.sql'), 'utf-8');

  it('1. Migration establishes guard_station RLS policies and Realtime publication on passes and visit_events', () => {
    expect(migrationSource).toContain('create policy "passes_select_guard_station"');
    expect(migrationSource).toContain('create policy "visit_events_select_guard_station"');
    expect(migrationSource).toContain("type = 'guard_station'::public.device_type");
    expect(migrationSource).toContain('lower(trim(d.gate)) = lower(trim(passes.gate))');
    expect(migrationSource).toContain('alter publication supabase_realtime add table public.visit_events');
    expect(migrationSource).toContain('lower(trim(target.gate)) is distinct from lower(trim(scanner.gate))');
  });

  it('2. Guard station feed queries office_visits, offices, and office_personnel', () => {
    // Queries office_visits for scanned passes
    expect(feedSource).toContain(".from('office_visits')");
    expect(feedSource).toContain(".select('pass_id, office_id, personnel_id, visit_type, purpose, requested_person_name, attendance_status, approval_status')");
    
    // Resolves office names and personnel names
    expect(feedSource).toContain(".from('offices')");
    expect(feedSource).toContain(".from('office_personnel')");

    // Maps officeVisit into entries response
    expect(feedSource).toContain('officeVisit: ov');
    expect(feedSource).toContain('officeName');
    expect(feedSource).toContain('hostPersonName');
    expect(feedSource).toContain('timeIn: p.time_in || p.entry_scanned_at');
    expect(feedSource).toContain('timeOut: p.time_out || null');
  });

  it('3. Evidence route enforces gate-bound photo access without leaking ID documents', () => {
    expect(evidenceSource).toContain("if (evidence.kind !== 'photo')");
    expect(evidenceSource).toContain("Guard station cannot access ID evidence");
    expect(evidenceSource).toMatch(/\.(eq|ilike)\('gate',\s*stationDevice\.gate\)/);
  });

  it('4. GuardPage subscribes to Supabase Realtime CDC on passes and visit_events', () => {
    expect(guardPageSource).toContain("channel('guard-station-feed-live')");
    expect(guardPageSource).toContain("table: 'passes'");
    expect(guardPageSource).toContain("table: 'visit_events'");
    expect(guardPageSource).toContain('void fetchFeed(true)');
  });

  it('5. GuardPage displays prominent Time In and Meeting / Office Details in Hero and list views', () => {
    // Hero Card displays Time In
    expect(guardPageSource).toContain('Time In');
    expect(guardPageSource).toContain('latestEntry?.timeIn || latestEntry?.enteredAt');
    
    // Hero Card displays Meeting / Office Details
    expect(guardPageSource).toContain('Meeting / Office Details');
    expect(guardPageSource).toContain('Designated Office:');
    expect(guardPageSource).toContain('Person to Meet:');
    expect(guardPageSource).toContain('Attendance Status:');
    expect(guardPageSource).toContain('latestEntry.officeVisit.officeName');

    // Recent entries list displays Time In and Office badge
    expect(guardPageSource).toContain('entry.officeVisit?.officeName');
    expect(guardPageSource).toContain('Time In: {entry.timeIn || entry.enteredAt');
  });

  it('6. Executable PGlite test: passes, visitors, office_visits and personnel join cleanly', async () => {
    const db = new PGlite();
    await db.exec(`
      create type pass_source as enum ('portal', 'kiosk');
      create type pass_status as enum ('issued', 'pending', 'inside', 'exited', 'rejected', 'expired');
      create type visit_type_enum as enum ('general', 'specific_person');
      create type office_attendance_status as enum ('awaiting_entry', 'awaiting_office_confirmation', 'confirmed', 'completed', 'exited_unconfirmed');

      create table visitors (
        id uuid primary key default gen_random_uuid(),
        full_name text not null,
        purpose text not null
      );

      create table offices (
        id uuid primary key default gen_random_uuid(),
        name text not null
      );

      create table office_personnel (
        id uuid primary key default gen_random_uuid(),
        office_id uuid not null references offices(id),
        name text not null,
        title text
      );

      create table passes (
        id uuid primary key default gen_random_uuid(),
        public_reference text not null,
        visitor_id uuid not null references visitors(id),
        source pass_source not null,
        status pass_status not null,
        gate text not null,
        entry_scanned_at timestamptz not null,
        time_in timestamptz not null,
        time_out timestamptz
      );

      create table office_visits (
        id uuid primary key default gen_random_uuid(),
        pass_id uuid not null references passes(id),
        office_id uuid not null references offices(id),
        personnel_id uuid references office_personnel(id),
        visit_type visit_type_enum not null,
        purpose text not null,
        requested_person_name text,
        attendance_status office_attendance_status not null,
        approval_status text not null default 'approved'
      );
    `);

    // Insert test entities
    const officeRes = await db.query<{ id: string }>(`insert into offices (name) values ('Admissions and Testing Office') returning id;`);
    const officeId = officeRes.rows[0]!.id;

    const personnelRes = await db.query<{ id: string }>(`insert into office_personnel (office_id, name, title) values ($1, 'Prof. Maria Santos', 'Department Head') returning id;`, [officeId]);
    const personnelId = personnelRes.rows[0]!.id;

    const visitorRes = await db.query<{ id: string }>(`insert into visitors (full_name, purpose) values ('Maryjoy Cagande', 'Meeting') returning id;`);
    const visitorId = visitorRes.rows[0]!.id;

    const now = new Date().toISOString();
    const passRes = await db.query<{ id: string }>(`
      insert into passes (public_reference, visitor_id, source, status, gate, entry_scanned_at, time_in)
      values ('REF-MARYJOY-01', $1, 'portal', 'inside', 'Back Gate', $2, $2)
      returning id;
    `, [visitorId, now]);
    const passId = passRes.rows[0]!.id;

    await db.query(`
      insert into office_visits (pass_id, office_id, personnel_id, visit_type, purpose, attendance_status)
      values ($1, $2, $3, 'specific_person', 'Meeting', 'awaiting_office_confirmation');
    `, [passId, officeId, personnelId]);

    // Query joined structure exactly as the feed does
    const passRow = (await db.query<{ id: string; visitor_id: string; time_in: string; gate: string }>(`
      select id, visitor_id, time_in, gate from passes where gate = 'Back Gate' and status in ('inside', 'exited');
    `)).rows[0]!;
    expect(passRow).toBeDefined();

    const ovRow = (await db.query<{ office_id: string; personnel_id: string; visit_type: string; attendance_status: string }>(`
      select office_id, personnel_id, visit_type, attendance_status from office_visits where pass_id = $1;
    `, [passRow.id])).rows[0]!;
    expect(ovRow).toBeDefined();

    const oName = (await db.query<{ name: string }>(`select name from offices where id = $1;`, [ovRow.office_id])).rows[0]!.name;
    const pName = (await db.query<{ name: string; title: string }>(`select name, title from office_personnel where id = $1;`, [ovRow.personnel_id])).rows[0]!;

    expect(oName).toBe('Admissions and Testing Office');
    expect(pName.name).toBe('Prof. Maria Santos');
    expect(pName.title).toBe('Department Head');
    expect(ovRow.attendance_status).toBe('awaiting_office_confirmation');
  });

  it('7. Feed sorting and merging contract handles entries with meeting details', () => {
    const e1: StationEntry = {
      passId: 'p-1',
      publicReference: 'REF-1',
      status: 'inside',
      source: 'portal',
      enteredAt: '2026-11-17T08:00:00Z',
      timeIn: '2026-11-17T08:00:00Z',
      timeOut: null,
      visitorName: 'Visitor 1',
      purpose: 'Meeting',
      photoEvidenceId: 'ev-1',
      gate: 'Back Gate',
      officeVisit: {
        officeName: 'Admissions and Testing Office',
        hostPersonName: 'Prof. Maria Santos',
        hostPersonTitle: 'Department Head',
        visitType: 'specific_person',
        attendanceStatus: 'awaiting_office_confirmation',
        approvalStatus: 'approved',
        purpose: 'Meeting',
      },
    };

    const e2: StationEntry = {
      passId: 'p-2',
      publicReference: 'REF-2',
      status: 'inside',
      source: 'portal',
      enteredAt: '2026-11-17T08:30:00Z',
      timeIn: '2026-11-17T08:30:00Z',
      timeOut: null,
      visitorName: 'Visitor 2',
      purpose: 'Inquiry',
      photoEvidenceId: null,
      gate: 'Back Gate',
      officeVisit: null,
    };

    const merged = mergeFeedHead([e1], [e2]);
    expect(merged.length).toBe(2);
    // e2 entered later (08:30 > 08:00), so it must be first
    expect(merged[0]?.passId).toBe('p-2');
    expect(merged[1]?.passId).toBe('p-1');
    expect(merged[1]?.officeVisit?.officeName).toBe('Admissions and Testing Office');
  });
});
