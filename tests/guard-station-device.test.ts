import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Guard Station Device & Role Deprecation Contract', () => {
  const createUserSource = fs.readFileSync(
    path.resolve('server/routes/system/create-user.ts'),
    'utf-8'
  );
  const createDeviceSource = fs.readFileSync(
    path.resolve('server/routes/device/create-device.ts'),
    'utf-8'
  );
  const guardStationFeedSource = fs.readFileSync(
    path.resolve('server/routes/gate/guard-station-feed.ts'),
    'utf-8'
  );
  const evidenceSource = fs.readFileSync(
    path.resolve('server/routes/gate/evidence.ts'),
    'utf-8'
  );

  it('1. Personal Guard staff accounts are disabled (legacy_guard_role_disabled)', () => {
    expect(createUserSource).toMatch(/legacy_guard_role_disabled/);
    expect(createUserSource).toMatch(/role === ['"]guard['"]/);
  });

  it('2. Device enrollment explicitly allows guard_station device type', () => {
    expect(createDeviceSource).toMatch(/guard_station/);
    expect(createDeviceSource).toMatch(/z\.enum\(\[['"]entry['"],\s*['"]exit['"],\s*['"]kiosk['"],\s*['"]guard_station['"]\]\)/);
  });

  it('3. Guard Station Feed enforces same-gate confinement', () => {
    // Assert query filters by station gate
    expect(guardStationFeedSource).toMatch(/stationGate/);
    expect(guardStationFeedSource).toMatch(/\.eq\(['"]gate['"],\s*stationGate\)/);
    // Excludes ID evidence from response (photo evidence only)
    expect(guardStationFeedSource).not.toMatch(/id_evidence_id/);
  });

  it('4. Evidence endpoint enforces same-gate confinement and photo-only access for guard_station', () => {
    expect(evidenceSource).toMatch(/stationDevice\.gate/);
    expect(evidenceSource).toMatch(/evidence\.kind !== ['"]photo['"]/);
  });
});
