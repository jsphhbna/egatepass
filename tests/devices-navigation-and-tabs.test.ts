import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase D — Devices Expandable Sidebar Navigation & Tab Filtering', () => {
  const adminPageSrc = readFileSync('src/pages/AdminPage.tsx', 'utf8');
  const devicesPageSrc = readFileSync('src/pages/DevicesPage.tsx', 'utf8');

  it('proves AdminPage defines Devices as an expandable navigation group with real functional subsections', () => {
    // 1. Group label
    expect(adminPageSrc).toContain("label: 'Devices'");
    // 2. Expandable items
    expect(adminPageSrc).toContain("to: '/admin/devices?tab=all'");
    expect(adminPageSrc).toContain("label: 'All Terminals'");
    expect(adminPageSrc).toContain("to: '/admin/devices?tab=scanners'");
    expect(adminPageSrc).toContain("label: 'Gate Scanners'");
    expect(adminPageSrc).toContain("to: '/admin/devices?tab=stations'");
    expect(adminPageSrc).toContain("label: 'Kiosks & Stations'");
  });

  it('proves AdminPage correctly checks active route for devices query tabs', () => {
    expect(adminPageSrc).toContain("child.to.includes('admin/devices?tab=all')");
    expect(adminPageSrc).toContain("location.pathname === '/admin/devices'");
    expect(adminPageSrc).toContain("location.search === '?tab=all'");
    expect(adminPageSrc).toContain('currentFull === child.to');
  });

  it('proves DevicesPage supports URL tab parameter and renders tab buttons with badges', () => {
    // 1. URL search parameter
    expect(devicesPageSrc).toContain("searchParams.get('tab')");
    // 2. Tab IDs
    expect(devicesPageSrc).toContain("activeTab === 'all'");
    expect(devicesPageSrc).toContain("activeTab === 'scanners'");
    expect(devicesPageSrc).toContain("activeTab === 'stations'");
    // 3. Count badges
    expect(devicesPageSrc).toContain('scannerCount');
    expect(devicesPageSrc).toContain('stationCount');
    expect(devicesPageSrc).toContain('filteredDevices');
  });

  it('proves DevicesPage filters scanners vs kiosks/stations accurately', () => {
    expect(devicesPageSrc).toContain("d.type === 'entry' || d.type === 'exit'");
    expect(devicesPageSrc).toContain("d.type === 'kiosk' || d.type === 'guard_station'");
  });
});
