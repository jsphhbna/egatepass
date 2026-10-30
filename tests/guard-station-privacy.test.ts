import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Guard Station Privacy & Data Minimization Contracts', () => {
  const feedPath = path.resolve('server/routes/gate/guard-station-feed.ts');
  const feedSource = fs.readFileSync(feedPath, 'utf-8');

  const evidencePath = path.resolve('server/routes/gate/evidence.ts');
  const evidenceSource = fs.readFileSync(evidencePath, 'utf-8');

  const guardPagePath = path.resolve('src/pages/GuardPage.tsx');
  const guardPageSource = fs.readFileSync(guardPagePath, 'utf-8');

  it('1. Guard station feed never queries or exposes visitor contact number', () => {
    // DB query for visitors must NOT select contact_number
    expect(feedSource).not.toMatch(/select\([^)]*contact_number/);
    expect(feedSource).toContain("admin.from('visitors').select('id, full_name, purpose')");

    // Output entry object must NOT map contactNumber
    expect(feedSource).not.toContain('contactNumber:');
    expect(feedSource).not.toContain('contact_number:');
  });

  it('2. Guard Station UI does not display visitor phone or contact number', () => {
    // StationEntry interface must not include contactNumber
    expect(guardPageSource).not.toMatch(/contactNumber:\s*string/);

    // JSX must not contain contact number labels or phone icons
    expect(guardPageSource).not.toContain('Contact Number:');
    expect(guardPageSource).not.toContain('<Phone');
  });

  it('3. Evidence endpoint restricts station access to photo only, portal source, entered status, and same gate', () => {
    // Only photo evidence allowed
    expect(evidenceSource).toContain("if (evidence.kind !== 'photo')");
    expect(evidenceSource).toContain("Guard station cannot access ID evidence");

    // Must be portal pass
    expect(evidenceSource).toContain(".eq('source', 'portal')");

    // Must have recorded entry scan
    expect(evidenceSource).toContain(".not('entry_scanned_at', 'is', null)");

    // Must be in operational entered status (inside, exited)
    expect(evidenceSource).toContain(".in('status', ['inside', 'exited'])");

    // Must be confined to station gate
    expect(evidenceSource).toContain(".eq('gate', stationDevice.gate)");
  });

  it('4. Evidence endpoint denies human guard staff actor and restricts to admin/superadmin', () => {
    // Staff actor role list must not include guard
    expect(evidenceSource).toContain("['admin', 'superadmin'].includes(staff.role)");
    expect(evidenceSource).not.toContain("['guard', 'admin', 'superadmin'].includes(staff.role)");
  });
});
