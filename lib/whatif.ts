// What-if simulator: re-runs the real planner on a modified copy of the inputs.
// Pure and side-effect free: it never touches the database and never mutates
// the input it receives, so a scenario is always a safe preview.

import {
  deadlineEnd,
  effectiveBlocked,
  freeIntervals,
  planSchedule,
  remainingMinutes,
  type Interval,
  type PlanInput,
  type PlanResult,
} from "./scheduler.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_EXTENSION_DAYS = 14;

export type Change =
  // Study time lost on one date, e.g. an extra shift. start/end are "HH:MM"; allDay ignores them.
  | { id: string; kind: "lose_time"; date: string; start: string; end: string; allDay: boolean }
  // A task needs more time than its remaining work suggests, in hours of remaining work.
  | { id: string; kind: "extra_work"; taskId: string; hours: number };

export type TaskOutcome = {
  taskId: string;
  title: string;
  deadline: string | null;
  needed: [number, number]; // remaining minutes: original, scenario
  unscheduled: [number, number];
  finish: [number | null, number | null]; // end of the last planned block
  impossible: [boolean, boolean]; // deadline passed
  impacted: boolean;
};

export type Suggestion =
  | { kind: "extend_deadline"; taskId: string; title: string; days: number; newDeadline: string }
  | { kind: "find_time"; taskId: string; title: string; minutes: number; before: string | null }
  | { kind: "deadline_passed"; taskId: string; title: string; minutes: number };

export type SimulationResult = {
  original: PlanResult;
  scenario: PlanResult;
  tasks: TaskOutcome[];
  unscheduled: [number, number]; // total minutes that do not fit
  freeMinutes: [number, number]; // usable study time until the planning horizon
  lostMinutes: number; // study time the scenario actually removes
  suggestions: Suggestion[];
};

/** Converts a "lose time" change into the interval it blocks, in local time. */
export function changeInterval(c: Extract<Change, { kind: "lose_time" }>): Interval {
  const [y, m, d] = c.date.split("-").map(Number);
  if (c.allDay) return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
  const [sh, sm] = c.start.split(":").map(Number);
  const [eh, em] = c.end.split(":").map(Number);
  return { start: new Date(y, m - 1, d, sh, sm).getTime(), end: new Date(y, m - 1, d, eh, em).getTime() };
}

/**
 * Extra hours of remaining work → new estimate. Remaining work is
 * estimate × factor − logged, so the estimate grows by hours ÷ factor.
 */
export function estimateWithExtra(estimatedHours: number, extraHours: number, factor: number): number {
  return Math.round((estimatedHours + extraHours / (factor || 1)) * 100) / 100;
}

/** Returns a new planner input with the changes applied; `base` is left untouched. */
export function applyChanges(base: PlanInput, changes: Change[]): PlanInput {
  const extra = new Map<string, number>();
  const blocked: Interval[] = base.blocked.map((b) => ({ ...b }));
  for (const c of changes) {
    if (c.kind === "lose_time") {
      const i = changeInterval(c);
      if (i.end > i.start) blocked.push(i);
    } else if (c.hours > 0) {
      extra.set(c.taskId, (extra.get(c.taskId) ?? 0) + c.hours);
    }
  }
  return {
    ...base,
    now: new Date(base.now.getTime()),
    tasks: base.tasks.map((t) =>
      extra.has(t.id) ? { ...t, estimatedHours: estimateWithExtra(t.estimatedHours, extra.get(t.id)!, base.factor) } : { ...t },
    ),
    availability: base.availability.map((a) => ({ ...a })),
    blocked,
    sessions: base.sessions.map((s) => ({ ...s })),
  };
}

function lastFinish(plan: PlanResult, taskId: string): number | null {
  let end: number | null = null;
  for (const b of plan.blocks) if (b.taskId === taskId) end = Math.max(end ?? 0, b.end);
  return end;
}

function shortfallOf(plan: PlanResult, taskId: string) {
  return plan.shortfalls.find((s) => s.taskId === taskId);
}

function horizonOf(input: PlanInput): number {
  const now = input.now.getTime();
  const ends = input.tasks
    .filter((t) => t.status === "active")
    .map((t) => (t.deadline ? deadlineEnd(t.deadline) : now + 14 * DAY));
  return Math.min(Math.max(now, ...ends), now + 120 * DAY);
}

function freeMinutes(input: PlanInput, to: number): number {
  return Math.round(
    freeIntervals(input.availability, effectiveBlocked(input), input.now.getTime(), to).reduce((sum, i) => sum + i.end - i.start, 0) /
      MINUTE,
  );
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** Smallest deadline extension (in days) that lets this task fit in the scenario, if any within two weeks. */
function deadlineExtension(input: PlanInput, taskId: string): number | null {
  const task = input.tasks.find((t) => t.id === taskId);
  if (!task?.deadline) return null;
  for (let days = 1; days <= MAX_EXTENSION_DAYS; days++) {
    const moved = { ...input, tasks: input.tasks.map((t) => (t.id === taskId ? { ...t, deadline: addDays(task.deadline!, days) } : t)) };
    if (!shortfallOf(planSchedule(moved), taskId)) return days;
  }
  return null;
}

export function simulate(base: PlanInput, changes: Change[]): SimulationResult {
  const scenarioInput = applyChanges(base, changes);
  // Plan a copy of the base too, so not even the planner sees the caller's objects
  const originalInput = applyChanges(base, []);
  const original = planSchedule(originalInput);
  const scenario = planSchedule(scenarioInput);

  // applyChanges keeps task order, so index i is the same task in both inputs
  const tasks: TaskOutcome[] = originalInput.tasks
    .map((t, i) => ({ t, s: scenarioInput.tasks[i] }))
    .filter(({ t }) => t.status === "active")
    .map(({ t, s }) => {
      const so = shortfallOf(original, t.id);
      const ss = shortfallOf(scenario, t.id);
      const outcome: TaskOutcome = {
        taskId: t.id,
        title: t.title,
        deadline: t.deadline,
        needed: [remainingMinutes(t, originalInput.sessions, base.factor), remainingMinutes(s, scenarioInput.sessions, base.factor)],
        unscheduled: [so?.minutes ?? 0, ss?.minutes ?? 0],
        finish: [lastFinish(original, t.id), lastFinish(scenario, t.id)],
        impossible: [so?.reason === "deadline_passed", ss?.reason === "deadline_passed"],
        impacted: false,
      };
      outcome.impacted =
        outcome.unscheduled[1] !== outcome.unscheduled[0] ||
        outcome.needed[1] !== outcome.needed[0] ||
        outcome.finish[1] !== outcome.finish[0];
      return outcome;
    })
    .filter((t) => t.needed[0] > 0 || t.needed[1] > 0);

  const horizon = Math.max(horizonOf(originalInput), horizonOf(scenarioInput));
  const free: [number, number] = [freeMinutes(originalInput, horizon), freeMinutes(scenarioInput, horizon)];

  const suggestions: Suggestion[] = [];
  for (const t of tasks) {
    if (t.unscheduled[1] === 0) continue;
    if (t.impossible[1]) {
      suggestions.push({ kind: "deadline_passed", taskId: t.taskId, title: t.title, minutes: t.unscheduled[1] });
      continue;
    }
    suggestions.push({ kind: "find_time", taskId: t.taskId, title: t.title, minutes: t.unscheduled[1], before: t.deadline });
    const days = deadlineExtension(scenarioInput, t.taskId);
    if (days !== null && t.deadline) {
      suggestions.push({ kind: "extend_deadline", taskId: t.taskId, title: t.title, days, newDeadline: addDays(t.deadline, days) });
    }
  }

  return {
    original,
    scenario,
    tasks,
    unscheduled: [
      original.shortfalls.reduce((sum, s) => sum + s.minutes, 0),
      scenario.shortfalls.reduce((sum, s) => sum + s.minutes, 0),
    ],
    freeMinutes: free,
    lostMinutes: Math.max(0, free[0] - free[1]),
    suggestions,
  };
}
