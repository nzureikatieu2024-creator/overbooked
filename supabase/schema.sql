-- Overbooked database schema
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: tables use "if not exists" and policies are dropped first.

-- ─────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title           text not null check (char_length(trim(title)) between 1 and 200),
  deadline        date,                                   -- optional; due at end of this day
  estimated_hours numeric(5,2) not null default 2 check (estimated_hours > 0 and estimated_hours <= 200),
  difficulty      smallint not null default 2 check (difficulty between 1 and 3),  -- 1 easy, 2 medium, 3 hard
  status          text not null default 'active' check (status in ('active', 'done')),
  created_at      timestamptz not null default now()
);

-- Recurring weekly study availability (local wall-clock time)
create table if not exists public.availability (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),  -- 0 = Sunday … 6 = Saturday
  start_time time not null,
  end_time   time not null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

-- Specific busy events, e.g. university classes
create table if not exists public.busy_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null default 'Busy' check (char_length(title) <= 200),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- Generated study blocks
create table if not exists public.study_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id        uuid not null references public.tasks (id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'planned' check (status in ('planned', 'completed', 'missed')),
  actual_minutes integer check (actual_minutes between 0 and 1440),
  created_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- One row per user: session length and break preferences
create table if not exists public.planner_settings (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  session_minutes  integer not null default 50 check (session_minutes between 15 and 240),
  break_minutes    integer not null default 10 check (break_minutes between 0 and 120),
  updated_at       timestamptz not null default now()
);

-- Calendar import (.ics): one key per imported occurrence (event UID + original start),
-- so importing the same file twice never creates duplicates. NULL for events added by hand.
alter table public.busy_events add column if not exists external_uid text check (char_length(external_uid) <= 1000);
create unique index if not exists busy_events_user_external_uid_idx on public.busy_events (user_id, external_uid);

-- Study preferences, non-blocking events and archived tasks (also in migrations/002_planner_preferences.sql)
alter table public.planner_settings add column if not exists min_session_minutes integer not null default 30 check (min_session_minutes between 15 and 120);
alter table public.planner_settings add column if not exists buffer_minutes integer not null default 15 check (buffer_minutes between 0 and 120);
alter table public.busy_events add column if not exists blocking boolean not null default true;
alter table public.tasks add column if not exists archived_at timestamptz;

create index if not exists tasks_user_idx          on public.tasks (user_id);
create index if not exists availability_user_idx   on public.availability (user_id);
create index if not exists busy_events_user_idx    on public.busy_events (user_id, starts_at);
create index if not exists study_sessions_user_idx on public.study_sessions (user_id, starts_at);
create index if not exists study_sessions_task_idx on public.study_sessions (task_id);

-- ─────────────────────────────────────────────
-- Access: logged-in users only, never anonymous
-- ─────────────────────────────────────────────

revoke all on public.tasks, public.availability, public.busy_events,
              public.study_sessions, public.planner_settings from anon;
grant select, insert, update, delete on public.tasks, public.availability, public.busy_events,
              public.study_sessions, public.planner_settings to authenticated;

-- ─────────────────────────────────────────────
-- Row Level Security: every row belongs to auth.uid()
-- ─────────────────────────────────────────────

alter table public.tasks            enable row level security;
alter table public.availability     enable row level security;
alter table public.busy_events      enable row level security;
alter table public.study_sessions   enable row level security;
alter table public.planner_settings enable row level security;

-- tasks
drop policy if exists "tasks_select_own" on public.tasks;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;
create policy "tasks_select_own" on public.tasks for select to authenticated using (user_id = auth.uid());
create policy "tasks_insert_own" on public.tasks for insert to authenticated with check (user_id = auth.uid());
create policy "tasks_update_own" on public.tasks for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "tasks_delete_own" on public.tasks for delete to authenticated using (user_id = auth.uid());

-- availability
drop policy if exists "availability_select_own" on public.availability;
drop policy if exists "availability_insert_own" on public.availability;
drop policy if exists "availability_update_own" on public.availability;
drop policy if exists "availability_delete_own" on public.availability;
create policy "availability_select_own" on public.availability for select to authenticated using (user_id = auth.uid());
create policy "availability_insert_own" on public.availability for insert to authenticated with check (user_id = auth.uid());
create policy "availability_update_own" on public.availability for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "availability_delete_own" on public.availability for delete to authenticated using (user_id = auth.uid());

-- busy_events
drop policy if exists "busy_select_own" on public.busy_events;
drop policy if exists "busy_insert_own" on public.busy_events;
drop policy if exists "busy_update_own" on public.busy_events;
drop policy if exists "busy_delete_own" on public.busy_events;
create policy "busy_select_own" on public.busy_events for select to authenticated using (user_id = auth.uid());
create policy "busy_insert_own" on public.busy_events for insert to authenticated with check (user_id = auth.uid());
create policy "busy_update_own" on public.busy_events for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "busy_delete_own" on public.busy_events for delete to authenticated using (user_id = auth.uid());

-- study_sessions: also require that the linked task belongs to the same user
drop policy if exists "sessions_select_own" on public.study_sessions;
drop policy if exists "sessions_insert_own" on public.study_sessions;
drop policy if exists "sessions_update_own" on public.study_sessions;
drop policy if exists "sessions_delete_own" on public.study_sessions;
create policy "sessions_select_own" on public.study_sessions for select to authenticated using (user_id = auth.uid());
create policy "sessions_insert_own" on public.study_sessions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid())
  );
create policy "sessions_update_own" on public.study_sessions for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = auth.uid())
  );
create policy "sessions_delete_own" on public.study_sessions for delete to authenticated using (user_id = auth.uid());

-- planner_settings
drop policy if exists "settings_select_own" on public.planner_settings;
drop policy if exists "settings_insert_own" on public.planner_settings;
drop policy if exists "settings_update_own" on public.planner_settings;
drop policy if exists "settings_delete_own" on public.planner_settings;
create policy "settings_select_own" on public.planner_settings for select to authenticated using (user_id = auth.uid());
create policy "settings_insert_own" on public.planner_settings for insert to authenticated with check (user_id = auth.uid());
create policy "settings_update_own" on public.planner_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "settings_delete_own" on public.planner_settings for delete to authenticated using (user_id = auth.uid());
