import type { SessionStatus, TaskStatus } from "./scheduler";

// Row shapes as returned by Supabase
export type TaskRow = {
  id: string;
  title: string;
  deadline: string | null;
  estimated_hours: number;
  difficulty: number;
  status: TaskStatus;
  created_at: string;
  archived_at?: string | null; // needs migration 002; undefined before it is run
};

export type AvailabilityRow = {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
};

export type BusyRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  blocking?: boolean; // false = informational only; undefined (before migration 002) = blocking
};

export type SessionRow = {
  id: string;
  task_id: string;
  starts_at: string;
  ends_at: string;
  status: SessionStatus;
  actual_minutes: number | null;
};

export type Settings = {
  session_minutes: number; // maximum session length
  break_minutes: number;
  min_session_minutes: number;
  buffer_minutes: number; // kept free after busy events
};

export const DEFAULT_SETTINGS: Settings = { session_minutes: 50, break_minutes: 10, min_session_minutes: 30, buffer_minutes: 15 };

export const isBlocking = (b: BusyRow) => b.blocking !== false;
export const isArchived = (t: TaskRow) => Boolean(t.archived_at);

export type TaskStats = {
  remaining: number; // minutes still needed (estimate × factor − logged)
  plannedAhead: number; // minutes in upcoming planned sessions
  logged: number; // actual minutes on completed sessions
  plannedCompleted: number; // planned length of completed sessions
  overdue: number; // planned sessions already in the past, not yet marked
  unscheduled: number; // remaining − plannedAhead
};
