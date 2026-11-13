import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Office Portal Portrait Preview Retention & Expiry Contract', () => {
  const previewSrc = readFileSync('server/routes/office/portrait-preview.ts', 'utf8');

  it('selects both purged_at and expires_at across all evidence queries', () => {
    // Must select expires_at along with purged_at
    const evidenceSelects = previewSrc.match(/\.select\([^)]*visitor_evidence[^)]*\)/g) || [];
    expect(previewSrc).toContain(".select('purged_at, expires_at')");
    expect(previewSrc).toContain(".select('bucket_id, object_path, purged_at, expires_at')");
  });

  it('enforces 410 photo_expired_under_retention on expired or purged evidence', () => {
    expect(previewSrc).toContain('evMatch.purged_at || (evMatch.expires_at && evMatch.expires_at <= nowIso)');
    expect(previewSrc).toContain('ev.purged_at || (ev.expires_at && ev.expires_at <= nowIso)');
    expect(previewSrc).toContain("error: 'photo_expired_under_retention'");
  });

  it('enforces retention check when visit.visitor_photo_path is set', () => {
    expect(previewSrc).toContain('if (objectPath) {');
    expect(previewSrc).toContain(".from('visitor_evidence')");
    expect(previewSrc).toContain(".eq('object_path', objectPath)");
  });

  it('never treats transient returning verification selfies as permanent evidence', () => {
    // Only selects original registration evidence ordered by created_at ascending
    expect(previewSrc).toContain(".order('created_at', { ascending: true })");
    expect(previewSrc).not.toContain("returning_selfie");
  });
});
