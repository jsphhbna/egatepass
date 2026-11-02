-- Migration 48: Fix Upload Intent and Visitor Evidence Check Constraints for Vehicle Photo
-- Closes P0 QR Issuance Image Upload Authorization Failure (upload_intents_check violation)

-- 1. Update upload_intents check constraint to support vehicle_photo in visitor-photos
alter table public.upload_intents drop constraint if exists upload_intents_check;
alter table public.upload_intents drop constraint if exists upload_intents_kind_bucket_check;

alter table public.upload_intents add constraint upload_intents_kind_bucket_check
  check (
    (kind = 'photo' and bucket_id = 'visitor-photos') or
    (kind = 'vehicle_photo' and bucket_id = 'visitor-photos') or
    (kind = 'id' and bucket_id = 'visitor-ids')
  );

-- 2. Update visitor_evidence check constraint to support vehicle_photo in visitor-photos
alter table public.visitor_evidence drop constraint if exists visitor_evidence_check;
alter table public.visitor_evidence drop constraint if exists visitor_evidence_kind_bucket_check;

alter table public.visitor_evidence add constraint visitor_evidence_kind_bucket_check
  check (
    (kind = 'photo' and bucket_id = 'visitor-photos') or
    (kind = 'vehicle_photo' and bucket_id = 'visitor-photos') or
    (kind = 'id' and bucket_id = 'visitor-ids')
  );

-- 3. Resolve Advisor 0003: Subquery auth.uid() in visit_vehicle_declarations_staff_select
drop policy if exists visit_vehicle_declarations_staff_select on public.visit_vehicle_declarations;
create policy visit_vehicle_declarations_staff_select on public.visit_vehicle_declarations
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_profiles sp
      where sp.user_id = (select auth.uid())
        and sp.active = true
    )
  );

comment on constraint upload_intents_kind_bucket_check on public.upload_intents is
  'Ensures upload intent kinds route strictly to their authorized buckets (photo/vehicle_photo -> visitor-photos, id -> visitor-ids).';

comment on constraint visitor_evidence_kind_bucket_check on public.visitor_evidence is
  'Ensures visitor evidence records route strictly to their authorized buckets (photo/vehicle_photo -> visitor-photos, id -> visitor-ids).';
