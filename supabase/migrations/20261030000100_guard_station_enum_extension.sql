-- Migration 38: Extend device_type enum to include guard_station
-- Section 46: Keep this migration primarily for enum extension.

alter type public.device_type add value if not exists 'guard_station';
