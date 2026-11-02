-- Migration 49: Distributed Nominatim Rate Limiting and Shared Cache
-- Replaces per-instance in-memory rate limiting with database-backed distributed coordination.
-- Strictly enforces OpenStreetMap / Nominatim 1 request/second usage policy across all serverless instances.

-- 1. Create table for distributed single-slot rate limiting
create table if not exists public.nominatim_rate_limiter (
  id integer primary key default 1 check (id = 1),
  last_request_at timestamptz not null default to_timestamp(0),
  updated_at timestamptz not null default now()
);

alter table public.nominatim_rate_limiter enable row level security;

-- Seed the singleton rate limiter row if not present
insert into public.nominatim_rate_limiter (id, last_request_at, updated_at)
values (1, to_timestamp(0), now())
on conflict (id) do nothing;

-- 2. Create table for shared location search query cache
create table if not exists public.location_search_cache (
  query_hash text primary key,
  query text not null,
  results jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.location_search_cache enable row level security;

create index if not exists idx_location_search_cache_expires_at
  on public.location_search_cache (expires_at);

-- 3. Grants: Service role only
grant select, update on public.nominatim_rate_limiter to service_role;
grant select, insert, update, delete on public.location_search_cache to service_role;

revoke all on public.nominatim_rate_limiter from anon, authenticated;
revoke all on public.location_search_cache from anon, authenticated;

-- 4. Atomic rate limit slot acquisition RPC
create or replace function api.acquire_nominatim_slot(
  p_min_interval_ms integer default 1100
)
returns jsonb
language plpgsql
security definer
set search_path = public, api
as $$
declare
  v_last_request timestamptz;
  v_now timestamptz := clock_timestamp();
  v_elapsed_ms bigint;
  v_wait_ms integer;
  v_acquired boolean := false;
begin
  -- Atomically lock the singleton rate limiter row
  select last_request_at into v_last_request
  from public.nominatim_rate_limiter
  where id = 1
  for update;

  if not found then
    insert into public.nominatim_rate_limiter (id, last_request_at, updated_at)
    values (1, to_timestamp(0), v_now)
    returning last_request_at into v_last_request;
  end if;

  v_elapsed_ms := floor(extract(epoch from (v_now - v_last_request)) * 1000)::bigint;

  if v_elapsed_ms >= p_min_interval_ms then
    update public.nominatim_rate_limiter
    set last_request_at = v_now,
        updated_at = v_now
    where id = 1;
    v_acquired := true;
    v_wait_ms := 0;
  else
    v_acquired := false;
    v_wait_ms := (p_min_interval_ms - v_elapsed_ms)::integer;
  end if;

  return jsonb_build_object(
    'acquired', v_acquired,
    'wait_ms', v_wait_ms,
    'elapsed_ms', v_elapsed_ms
  );
end;
$$;

grant execute on function api.acquire_nominatim_slot(integer) to service_role;
revoke execute on function api.acquire_nominatim_slot(integer) from anon, authenticated;
