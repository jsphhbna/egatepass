-- =============================================================================
-- Migration 87: Extend public.device_type enum with 'emergency_device'
-- Must be committed in its own migration transaction before referencing the enum
-- literal in constraints, indexes, policies, or functions.
-- =============================================================================

alter type public.device_type add value if not exists 'emergency_device';
