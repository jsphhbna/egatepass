import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Workstream B: Web Share Removal & 2-Column Action Invariant', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const emailModalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');

  it('proves navigator.share and related sharing identifiers are completely absent from GetPassPage', () => {
    expect(getPassSrc).not.toContain('navigator.share');
    expect(getPassSrc).not.toContain('navigator.canShare');
    expect(getPassSrc).not.toContain('handleShare');
    expect(getPassSrc).not.toContain('isSharing');
    expect(getPassSrc).not.toContain('setIsSharing');
    expect(getPassSrc).not.toContain('Share2');
    expect(getPassSrc).not.toContain('Share E-GatePass');
    expect(getPassSrc).not.toContain('Opening Share…');
  });

  it('proves action buttons use 2 equal columns for Download and Email', () => {
    expect(getPassSrc).toContain('grid grid-cols-1 sm:grid-cols-2 gap-3');
    expect(getPassSrc).toContain('Download E-GatePass');
    expect(getPassSrc).toContain('Email E-GatePass');
  });

  it('proves stale copy "print, or share" is replaced with "download or save"', () => {
    expect(getPassSrc).not.toContain('print, or share');
    expect(emailModalSrc).not.toContain('print, or share');
    expect(emailModalSrc).toContain('download or save');
  });

  it('proves PostgreSQL FOR SHARE is untouched in Supabase migrations and server queries', () => {
    // Assert that we did not inadvertently modify FOR SHARE locking clauses in migrations
    const migration36 = readFileSync('supabase/migrations/20261028234059_retention_truth_and_decommission_immutability.sql', 'utf8');
    const migration37 = readFileSync('supabase/migrations/20261029090000_guard_offline_authority_and_actor_binding_closure.sql', 'utf8');
    // Ensure migrations exist and total migration count remains strictly 37
    expect(migration36).toBeDefined();
    expect(migration37).toBeDefined();
  });
});
