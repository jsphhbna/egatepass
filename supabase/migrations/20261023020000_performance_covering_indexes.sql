-- =========================================================================
-- E-GatePass Forward Migration: Performance Covering Indexes
-- Migration Version: 20261023020000
-- =========================================================================
-- Purpose:
-- Add covering indexes on unindexed foreign keys across high-traffic tables
-- (passes, visit_events, upload_intents, incident_holds, visitors) to
-- optimize referential integrity cascades, prevent table-level share locks
-- during parent mutations, and accelerate join/filter queries.
-- =========================================================================

-- 1. passes table FK covering indexes
CREATE INDEX IF NOT EXISTS passes_decided_by_idx
  ON public.passes (decided_by)
  WHERE decided_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS passes_entry_device_id_idx
  ON public.passes (entry_device_id)
  WHERE entry_device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS passes_exit_device_id_idx
  ON public.passes (exit_device_id)
  WHERE exit_device_id IS NOT NULL;

-- 2. visit_events table FK covering indexes
CREATE INDEX IF NOT EXISTS visit_events_visitor_id_idx
  ON public.visit_events (visitor_id)
  WHERE visitor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS visit_events_guard_id_idx
  ON public.visit_events (guard_id)
  WHERE guard_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS visit_events_device_id_idx
  ON public.visit_events (device_id)
  WHERE device_id IS NOT NULL;

-- 3. upload_intents table FK covering index
CREATE INDEX IF NOT EXISTS upload_intents_visitor_id_idx
  ON public.upload_intents (visitor_id)
  WHERE visitor_id IS NOT NULL;

-- 4. incident_holds table FK covering indexes
CREATE INDEX IF NOT EXISTS incident_holds_created_by_idx
  ON public.incident_holds (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS incident_holds_released_by_idx
  ON public.incident_holds (released_by)
  WHERE released_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS incident_holds_pass_id_idx
  ON public.incident_holds (pass_id)
  WHERE pass_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS incident_holds_visitor_id_idx
  ON public.incident_holds (visitor_id)
  WHERE visitor_id IS NOT NULL;

-- 5. visitors table FK covering index
CREATE INDEX IF NOT EXISTS visitors_created_by_device_id_idx
  ON public.visitors (created_by_device_id)
  WHERE created_by_device_id IS NOT NULL;
