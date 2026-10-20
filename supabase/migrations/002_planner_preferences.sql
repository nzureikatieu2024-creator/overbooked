-- Overbooked migration 002: study preferences, non-blocking events, archived tasks
-- SAFE / ADDITIVE ONLY: adds nullable or defaulted columns. Nothing is dropped,
-- renamed or rewritten; existing rows keep their current behaviour
-- (every existing busy event stays blocking, no task becomes archived).
-- Row Level Security is unchanged: the existing per-row policies (user_id = auth.uid())
-- already cover new columns. Safe to run more than once.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.

-- Minimum study session length and transition buffer after busy events (minutes)
alter table public.planner_settings
  add column if not exists min_session_minutes integer not null default 30
    check (min_session_minutes between 15 and 120);
alter table public.planner_settings
  add column if not exists buffer_minutes integer not null default 15
    check (buffer_minutes between 0 and 120);

-- false = shown in the calendar for information only; never blocks study time
alter table public.busy_events
  add column if not exists blocking boolean not null default true;

-- Archived tasks are hidden and not planned, but keep their study history
alter table public.tasks
  add column if not exists archived_at timestamptz;
