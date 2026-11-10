-- Migration 83: Compound Keyset Index for Unpurged Visitor Evidence Purge & Retention
-- Accelerates deterministic compound keyset cursor pagination (expires_at ASC, id ASC)
-- on candidate unpurged evidence during automated and manual retention maintenance.

create index if not exists visitor_evidence_expiry_id_idx
  on public.visitor_evidence (expires_at asc, id asc)
  where purged_at is null;
