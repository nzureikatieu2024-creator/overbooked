// Deadline risk: compares each task's remaining work with the study time that
// actually exists before its deadline. Every warning is built from real numbers
// (minutes of work, free time, competing deadlines), never from a heuristic text.

import { deadlineEnd, effectiveBlocked, freeIntervals, remainingMinutes, type PlanInput, type PlanResult } from "./scheduler.ts";

const MINUTE = 60_000;

export type RiskLevel = "impossible" | "at_risk" | "tight" | "unplanned";

export type Risk = {
  taskId: string;
  title: string;
  deadline: string;
  level: RiskLevel;
  needed: number; // minutes of remaining work
  free: number; // free study minutes between now and the deadline
  earlierWork: number; // minutes needed by tasks due on or before this deadline, planned first
  earlierTitles: string[];
  shortfall: number; // minutes that do not fit
  slack: number; // free − (earlier work + needed); negative = overbooked
  passed: boolean; // the deadline is already over
  unplanned: number; // minutes not covered by the saved plan
};

export type RiskReport = {
  risks: Risk[]; // ordered by severity, then deadline
  checked: number; // open tasks with a deadline and work left
  noAvailability: boolean;
};

const ORDER: Record<RiskLevel, number> = { impossible: 0, at_risk: 1, tight: 2, unplanned: 3 };

/**
 * @param input  the same input Replan would use (see buildPlanInput)
 * @param plan   planSchedule(input): the plan Replan would produce right now
 * @param savedUnscheduled  minutes per task not covered by the saved plan
 */
export function assessRisks(input: PlanInput, plan: PlanResult, savedUnscheduled: Map<string, number> = new Map()): RiskReport {
  const now = input.now.getTime();
  const blocked = effectiveBlocked(input); // busy events + transition buffers, as the planner sees them
  const open = input.tasks
    .filter((t) => t.status === "active" && t.deadline)
    .map((t) => ({ task: t, needed: remainingMinutes(t, input.sessions, input.factor), end: deadlineEnd(t.deadline!) }))
    .filter((x) => x.needed > 0)
    .sort((a, b) => a.end - b.end);

  const risks: Risk[] = [];
  for (const x of open) {
    const free =
      x.end <= now
        ? 0
        : Math.round(freeIntervals(input.availability, blocked, now, x.end).reduce((s, i) => s + i.end - i.start, 0) / MINUTE);
    // Earliest deadline first: everything still schedulable and due on or before this
    // deadline competes for the same time (past deadlines are never scheduled)
    const earlier = open.filter((o) => o !== x && o.end <= x.end && o.end > now);
    const earlierWork = earlier.reduce((s, o) => s + o.needed, 0);
    // Leftovers too small for a session are not a deadline risk
    const shortfall = plan.shortfalls.find((s) => s.taskId === x.task.id && s.reason !== "below_minimum")?.minutes ?? 0;
    const slack = free - earlierWork - x.needed;

    let level: RiskLevel | null = null;
    if (x.end <= now || x.needed > free) level = "impossible";
    else if (shortfall > 0) level = "at_risk";
    else if (slack < input.sessionMinutes) level = "tight";
    else if ((savedUnscheduled.get(x.task.id) ?? 0) > 0) level = "unplanned";

    if (level) {
      risks.push({
        taskId: x.task.id,
        title: x.task.title,
        deadline: x.task.deadline!,
        level,
        needed: x.needed,
        free,
        earlierWork,
        earlierTitles: earlier.map((o) => o.task.title),
        shortfall: level === "impossible" ? Math.max(shortfall, x.needed - free) : shortfall,
        slack,
        passed: x.end <= now,
        unplanned: savedUnscheduled.get(x.task.id) ?? 0,
      });
    }
  }

  risks.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.deadline.localeCompare(b.deadline));
  return { risks, checked: open.length, noAvailability: input.availability.length === 0 };
}
