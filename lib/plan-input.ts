// Builds the exact planner input that Replan uses, from database rows.
// Shared by Replan, the What-if simulator and deadline risk checks so all three
// always agree. Pure: never mutates the rows it is given.

import { adjustmentFactor, type Interval, type PlanInput, type PlannerTask, type SessionRecord } from "./scheduler.ts";
import { isBlocking, type AvailabilityRow, type BusyRow, type SessionRow, type Settings, type TaskRow } from "./types.ts";

export const toTask = (t: TaskRow): PlannerTask => ({
  id: t.id,
  title: t.title,
  deadline: t.deadline,
  estimatedHours: Number(t.estimated_hours),
  difficulty: t.difficulty,
  status: t.status,
  createdAt: t.created_at,
});

export const toRecord = (s: SessionRow): SessionRecord => ({
  taskId: s.task_id,
  start: Date.parse(s.starts_at),
  end: Date.parse(s.ends_at),
  status: s.status,
  actualMinutes: s.actual_minutes,
});

export type PlanData = {
  tasks: TaskRow[];
  availability: AvailabilityRow[];
  busy: BusyRow[];
  sessions: SessionRow[];
  settings: Settings;
};

export type BuiltPlan = {
  input: PlanInput;
  overdueIds: string[]; // past planned sessions never marked: Replan counts them as missed
  replaceIds: string[]; // upcoming planned sessions: Replan rebuilds them
};

export function buildPlanInput(data: PlanData, at: Date): BuiltPlan {
  const nowMs = at.getTime();
  const isUpcomingPlanned = (s: SessionRow) => s.status === "planned" && Date.parse(s.ends_at) > nowMs;

  const overdueIds = data.sessions.filter((s) => s.status === "planned" && Date.parse(s.ends_at) <= nowMs).map((s) => s.id);
  const replaceIds = data.sessions.filter(isUpcomingPlanned).map((s) => s.id);
  // Completed and missed sessions are kept; upcoming planned ones are rebuilt.
  const kept = data.sessions.filter((s) => !isUpcomingPlanned(s));

  // Non-blocking (informational) events never block study time; busy events get a transition buffer
  const blocked: Interval[] = [
    ...data.busy.filter(isBlocking).map((b) => ({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at), kind: "busy" as const })),
    ...kept.map((s) => ({ start: Date.parse(s.starts_at), end: Date.parse(s.ends_at), kind: "session" as const })),
  ].filter((i) => i.end > nowMs);

  return {
    input: {
      now: at,
      tasks: data.tasks.filter((t) => !t.archived_at).map(toTask), // archived tasks are never planned
      availability: data.availability.map((a) => ({ weekday: a.weekday, startTime: a.start_time, endTime: a.end_time })),
      blocked,
      sessions: kept.map(toRecord),
      sessionMinutes: data.settings.session_minutes,
      breakMinutes: data.settings.break_minutes,
      minSessionMinutes: data.settings.min_session_minutes,
      bufferMinutes: data.settings.buffer_minutes,
      factor: adjustmentFactor(data.sessions.map(toRecord)).factor,
    },
    overdueIds,
    replaceIds,
  };
}
