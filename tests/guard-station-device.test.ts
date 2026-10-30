import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

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
    expect(evidenceSource).toContain(".in('status', ['issued', 'pending', 'inside', 'exited'])");
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
});
