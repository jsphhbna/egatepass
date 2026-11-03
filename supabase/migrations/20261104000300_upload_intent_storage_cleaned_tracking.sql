-- Migration: 20261104000300_upload_intent_storage_cleaned_tracking.sql
-- Adds persistent storage cleanup completion tracking to public.upload_intents:
-- 1. storage_cleaned_at nullable timestamptz column to record confirmed physical removal.
-- 2. Partial index on (expires_at) where storage_cleaned_at is null and visitor_id is null
--    for efficient, batch-starvation-free retention cleanup queries.

alter table public.upload_intents
  add column if not exists storage_cleaned_at timestamptz default null;

comment on column public.upload_intents.storage_cleaned_at is
  'Timestamp when storage object removal was confirmed for an expired upload intent. NULL indicates storage cleanup has not yet been confirmed.';

create index if not exists upload_intents_uncleaned_retention_idx
  on public.upload_intents (expires_at)
  where storage_cleaned_at is null and visitor_id is null;
