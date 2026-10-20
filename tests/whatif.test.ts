import { test } from "node:test";
import assert from "node:assert/strict";
import { planSchedule, type PlanInput, type PlannerTask } from "../lib/scheduler.ts";
import { applyChanges, estimateWithExtra, simulate, type Change } from "../lib/whatif.ts";
import { assessRisks } from "../lib/risk.ts";
import { buildPlanInput } from "../lib/plan-input.ts";
import type { SessionRow, TaskRow } from "../lib/types.ts";

// Monday 6 January 2025, 08:00 local time
const now = new Date(2025, 0, 6, 8, 0);
const at = (day: number, h: number, m = 0) => new Date(2025, 0, day, h, m).getTime();

function task(over: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: "t1",
    title: "Essay",
    deadline: "2025-01-08",
    estimatedHours: 4,
    difficulty: 2,
    status: "active",
    createdAt: "2025-01-01T00:00:00Z",
    ...over,
  };
}

// Weekdays 09:00–12:00 → 3h per day
const base = (): PlanInput => ({
  now,
  tasks: [task(), task({ id: "t2", title: "Slides", deadline: "2025-01-10", estimatedHours: 2 })],
  availability: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "12:00" })),
  blocked: [{ start: at(7, 9), end: at(7, 10) }],
  sessions: [{ taskId: "t1", start: at(3, 9), end: at(3, 10), status: "completed", actualMinutes: 60 }],
  sessionMinutes: 50,
  breakMinutes: 10,
  factor: 1,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

const loseTuesday: Change = { id: "c1", kind: "lose_time", date: "2025-01-07", start: "00:00", end: "00:00", allDay: true };

test("simulate never mutates the saved plan input", () => {
  const input = base();
  const snapshot = structuredClone(input);
  deepFreeze(input); // any write to the input would throw in strict mode
  const changes = deepFreeze<Change[]>([loseTuesday, { id: "c2", kind: "extra_work", taskId: "t1", hours: 2 }]);
  simulate(input, changes);
  assert.deepEqual(input, snapshot);
  assert.equal(input.now.getTime(), now.getTime());
});

test("with no changes the scenario equals the plan Replan would make", () => {
  const input = base();
  const r = simulate(input, []);
  assert.deepEqual(r.scenario, planSchedule(base()));
  assert.deepEqual(r.original, r.scenario);
  assert.equal(r.lostMinutes, 0);
  assert.ok(r.tasks.every((t) => !t.impacted));
  assert.equal(r.suggestions.length, 0);
});

test("losing a day of study time is reflected in free time and deadlines", () => {
  const r = simulate(base(), [loseTuesday]);
  // Tuesday had 3h of availability; 09:00–10:00 is busy plus a 15-minute buffer → 1h 45m actually lost
  assert.equal(r.lostMinutes, 105);
  // Essay: 4h estimate − 1h logged = 3h left, due end of Wed. Mon 3h fits originally.
  const essay = r.tasks.find((t) => t.taskId === "t1")!;
  assert.equal(essay.unscheduled[0], 0);
  assert.ok(r.scenario.blocks.every((b) => b.end <= at(7, 0) || b.start >= at(8, 0)));
});

test("extra work raises remaining time exactly and reports what no longer fits", () => {
  const input = base();
  const r = simulate(input, [{ id: "c", kind: "extra_work", taskId: "t1", hours: 5 }]);
  const essay = r.tasks.find((t) => t.taskId === "t1")!;
  assert.deepEqual(essay.needed, [180, 480]);
  // Before end of Wednesday: Mon 3h + Tue 2h + Wed 3h = 8h, minus breaks → not all 8h fit
  assert.ok(essay.unscheduled[1] > 0);
  assert.equal(r.unscheduled[1], r.scenario.shortfalls.reduce((s, x) => s + x.minutes, 0));
  assert.ok(essay.impacted);
  // Suggestions are computed with the real planner: a later deadline that actually fits
  const ext = r.suggestions.find((s) => s.kind === "extend_deadline" && s.taskId === "t1");
  assert.ok(ext && ext.kind === "extend_deadline");
  const moved = applyChanges(input, [{ id: "c", kind: "extra_work", taskId: "t1", hours: 5 }]);
  moved.tasks = moved.tasks.map((t) => (t.id === "t1" ? { ...t, deadline: ext.newDeadline } : t));
  assert.equal(planSchedule(moved).shortfalls.find((s) => s.taskId === "t1"), undefined);
  assert.ok(r.suggestions.some((s) => s.kind === "find_time" && s.taskId === "t1" && s.minutes === essay.unscheduled[1]));
});

test("extra hours account for the time factor", () => {
  assert.equal(estimateWithExtra(2, 1.5, 1.5), 3);
  assert.equal(estimateWithExtra(2, 1, 1), 3);
});

test("risk: impossible, at risk and tight are explained with real minutes", () => {
  const input = base();
  input.tasks = [
    task({ id: "past", title: "Old", deadline: "2025-01-03" }),
    task({ id: "huge", title: "Thesis", deadline: "2025-01-07", estimatedHours: 10 }),
    task({ id: "soon", title: "Quiz prep", deadline: "2025-01-06", estimatedHours: 2.5 }),
  ];
  input.sessions = [];
  const report = assessRisks(input, planSchedule(input));
  const byId = Object.fromEntries(report.risks.map((r) => [r.taskId, r]));
  assert.equal(byId.past.level, "impossible");
  assert.equal(byId.past.free, 0);
  // Thesis: 10h needed, but Mon 3h + Tue 1h 45m (1h busy + 15m buffer) = 4h 45m free before its deadline
  assert.equal(byId.huge.level, "impossible");
  assert.equal(byId.huge.free, 285);
  assert.equal(byId.huge.needed, 600);
  // Quiz prep: 2.5h in Monday's 3h window → fits, but less than one 50-minute session to spare
  assert.equal(byId.soon.level, "tight");
  assert.equal(byId.soon.slack, 30);
  assert.equal(report.risks[0].level, "impossible");
});

test("risk: competing earlier deadline makes a feasible task at risk", () => {
  const input = base();
  input.blocked = [];
  input.sessions = [];
  input.tasks = [
    task({ id: "a", title: "A", deadline: "2025-01-06", estimatedHours: 2 }),
    task({ id: "b", title: "B", deadline: "2025-01-07", estimatedHours: 4.5 }),
  ];
  const report = assessRisks(input, planSchedule(input));
  const b = report.risks.find((r) => r.taskId === "b")!;
  // B alone needs 4.5h of the 6h free, but A (due first) takes 2h
  assert.equal(b.level, "at_risk");
  assert.equal(b.free, 360);
  assert.equal(b.earlierWork, 120);
  assert.deepEqual(b.earlierTitles, ["A"]);
  assert.ok(b.shortfall > 0);
});

test("risk: nothing reported when everything fits comfortably", () => {
  const input = base();
  input.tasks = [task({ estimatedHours: 1, deadline: "2025-01-10" })];
  assert.equal(assessRisks(input, planSchedule(input)).risks.length, 0);
});

test("buildPlanInput keeps finished sessions, rebuilds upcoming ones and does not mutate rows", () => {
  const rows: TaskRow[] = [
    { id: "t1", title: "Essay", deadline: null, estimated_hours: 2, difficulty: 2, status: "active", created_at: "2025-01-01" },
  ];
  const sessions: SessionRow[] = [
    { id: "s1", task_id: "t1", starts_at: new Date(at(3, 9)).toISOString(), ends_at: new Date(at(3, 10)).toISOString(), status: "completed", actual_minutes: 60 },
    { id: "s2", task_id: "t1", starts_at: new Date(at(6, 7)).toISOString(), ends_at: new Date(at(6, 7, 50)).toISOString(), status: "planned", actual_minutes: null },
    { id: "s3", task_id: "t1", starts_at: new Date(at(6, 9)).toISOString(), ends_at: new Date(at(6, 9, 50)).toISOString(), status: "planned", actual_minutes: null },
  ];
  const data = deepFreeze({ tasks: rows, availability: [], busy: [], sessions, settings: { session_minutes: 50, break_minutes: 10 } });
  const built = buildPlanInput(data, now);
  assert.deepEqual(built.overdueIds, ["s2"]);
  assert.deepEqual(built.replaceIds, ["s3"]);
  assert.equal(built.input.sessions.length, 2);
  assert.equal(built.input.tasks[0].estimatedHours, 2);
});

test("simulator, risk and plan-input modules have no database access", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["whatif.ts", "risk.ts", "plan-input.ts"]) {
    const source = await readFile(new URL(`../lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /supabase|fetch\(|localStorage/i, `${file} must stay a pure preview`);
  }
});

test("non-blocking (info only) events never block planning; blocking ones do", () => {
  const day = (h: number) => new Date(at(6, h)).toISOString();
  const data = {
    tasks: [{ id: "t1", title: "Essay", deadline: null, estimated_hours: 1, difficulty: 2, status: "active" as const, created_at: "2025-01-01" }],
    availability: [{ id: "a", weekday: 1, start_time: "09:00", end_time: "12:00" }],
    busy: [
      // All-day "Week 1" banner, imported as info only
      { id: "b1", title: "Week 1", starts_at: new Date(2025, 0, 6).toISOString(), ends_at: new Date(2025, 0, 7).toISOString(), blocking: false },
    ],
    sessions: [],
    settings: { session_minutes: 50, break_minutes: 10, min_session_minutes: 30, buffer_minutes: 15 },
  };
  const info = planSchedule(buildPlanInput(data, now).input);
  assert.equal(info.blocks[0].start, at(6, 9));

  const blocking = planSchedule(buildPlanInput({ ...data, busy: [{ ...data.busy[0], blocking: true }] }, now).input);
  assert.ok(blocking.blocks.every((b) => b.start >= at(7, 0)), "a blocking all-day event takes the whole day");

  // Rows from before migration 002 (no blocking column) keep blocking, as they always did
  const legacy = { id: "b2", title: "Class", starts_at: day(9), ends_at: day(10) };
  const before = planSchedule(buildPlanInput({ ...data, busy: [legacy] }, now).input);
  assert.equal(before.blocks[0].start, at(6, 10, 15)); // after the class + 15-minute buffer
});

test("archived tasks are not planned", () => {
  const rows = [
    { id: "t1", title: "Test task", deadline: null, estimated_hours: 1, difficulty: 2, status: "active" as const, created_at: "2025-01-01", archived_at: "2025-01-05T00:00:00Z" },
  ];
  const data = { tasks: rows, availability: [{ id: "a", weekday: 1, start_time: "09:00", end_time: "12:00" }], busy: [], sessions: [], settings: { session_minutes: 50, break_minutes: 10, min_session_minutes: 30, buffer_minutes: 15 } };
  assert.equal(planSchedule(buildPlanInput(data, now).input).blocks.length, 0);
});
