-- Migration 104: Forward-Only Unambiguous Returning Profile Linkage Repair
-- Safely associates historical visitors with their corresponding returning profile
-- IF AND ONLY IF the relationship is unique, unambiguous, and satisfies all identity factors:
-- 1. visitors.returning_profile_id IS NULL
-- 2. visitors.contact_number = returning_visitor_profiles.contact_number_e164
-- 3. Exact normalized full name match (first + last, or first + middle + last)
-- 4. PSGC city code matches whenever populated on both records
-- 5. Exactly one returning profile matches the visitor, AND exactly one visitor matches the profile.
-- Any ambiguous or multi-match records are strictly left untouched (fail safe).

do $$
declare
  v_repaired_count integer := 0;
begin
  with unambiguous_pairs as (
    select
      v.id as visitor_id,
      p.id as profile_id,
      count(*) over (partition by v.id) as profiles_for_visitor_count,
      count(*) over (partition by p.id) as visitors_for_profile_count
    from public.visitors v
    join public.returning_visitor_profiles p
      on v.contact_number = p.contact_number_e164
     and (
       lower(regexp_replace(btrim(v.full_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(p.first_name || ' ' || coalesce(p.middle_name || ' ', '') || p.last_name), '\s+', ' ', 'g'))
       or lower(regexp_replace(btrim(v.full_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(p.first_name || ' ' || p.last_name), '\s+', ' ', 'g'))
     )
     and (v.psgc_city_code is null or p.psgc_city_code is null or v.psgc_city_code = p.psgc_city_code)
    where v.returning_profile_id is null
  )
  update public.visitors v
  set returning_profile_id = up.profile_id
  from unambiguous_pairs up
  where v.id = up.visitor_id
    and up.profiles_for_visitor_count = 1
    and up.visitors_for_profile_count = 1;

  get diagnostics v_repaired_count = row_count;
  raise notice 'Unambiguous returning profile linkage repair: linked % visitor records.', v_repaired_count;
end $$;
