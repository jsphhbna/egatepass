-- Ensure service_role does not retain DELETE privilege on public.maintenance_state
revoke delete on table public.maintenance_state from service_role;
