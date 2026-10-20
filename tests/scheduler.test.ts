import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjustmentFactor,
  difficultyFactors,
  planSchedule,
  remainingMinutes,
  suggestEstimate,
  type PlannerTask,
  type SessionRecord,
} from "../lib/scheduler.ts";

const MIN = 60_000;
// Monday 6 January 2025, 08:00 local time
const now = new Date(2025, 0, 6, 8, 0);
const at = (day: number, h: number, m = 0) => new Date(2025, 0, day, h, m).getTime();

function task(over: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: "t1",
    title: "Essay",
    deadline: null,
    estimatedHours: 2,
    difficulty: 2,
    status: "active",
    createdAt: "2025-01-01T00:00:00Z",
    ...over,
  };
}

// Weekdays 09:00–12:00
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "12:00" }));

const base = {
  now,
  availability: weekdays,
  blocked: [],
  sessions: [] as SessionRecord[],
  sessionMinutes: 50,
  breakMinutes: 10,
  factor: 1,
};

test("splits a task into sessions with breaks inside availability", () => {
  const r = planSchedule({ ...base, tasks: [task()] });
  assert.equal(r.scheduledMinutes, 120);
  assert.deepEqual(
    r.blocks.map((b) => [b.start, b.end]),
    [
      [at(6, 9), at(6, 9, 50)],
      // 120 min = 50 + 45 + 25: the middle block is shortened so no tiny tail remains
      [at(6, 10), at(6, 10, 45)],
      [at(6, 10, 55), at(6, 11, 20)],
    ],
  );
  assert.equal(r.shortfalls.length, 0);
});

test("never overlaps busy events", () => {
  const busy = { start: at(6, 9, 30), end: at(6, 11) };
  const r = planSchedule({ ...base, blocked: [busy], tasks: [task({ estimatedHours: 1 })] });
  for (const b of r.blocks) assert.ok(b.end <= busy.start || b.start >= busy.end);
  assert.equal(r.scheduledMinutes, 60);
});

test("reports work that cannot fit before the deadline", () => {
  // Due Monday: only 3h of availability that day, 10h needed
  const r = planSchedule({ ...base, tasks: [task({ deadline: "2025-01-06", estimatedHours: 10 })] });
  assert.ok(r.blocks.every((b) => b.end <= at(7, 0)));
  assert.equal(r.shortfalls.length, 1);
  assert.equal(r.shortfalls[0].reason, "not_enough_time");
  assert.equal(r.scheduledMinutes + r.shortfalls[0].minutes, 600);
});

test("earliest deadline goes first", () => {
  const later = task({ id: "later", deadline: "2025-01-10", estimatedHours: 1 });
  const sooner = task({ id: "sooner", deadline: "2025-01-07", estimatedHours: 1 });
  const r = planSchedule({ ...base, tasks: [later, sooner] });
  assert.equal(r.blocks[0].taskId, "sooner");
});

test("deadline already passed is flagged, not scheduled", () => {
  const r = planSchedule({ ...base, tasks: [task({ deadline: "2025-01-03" })] });
  assert.equal(r.blocks.length, 0);
  assert.equal(r.shortfalls[0].reason, "deadline_passed");
});

test("completed time is subtracted and factor is applied", () => {
  const sessions: SessionRecord[] = [
    { taskId: "t1", start: 0, end: 60 * MIN, status: "completed", actualMinutes: 90 },
    { taskId: "t1", start: 0, end: 60 * MIN, status: "completed", actualMinutes: 90 },
  ];
  const f = adjustmentFactor(sessions);
  assert.equal(f.factor, 1.5);
  // 4h estimate × 1.5 = 360 min, minus 180 logged = 180
  assert.equal(remainingMinutes(task({ estimatedHours: 4 }), sessions, f.factor), 180);
});

test("factor stays 1 with fewer than two samples and is clamped", () => {
  const one: SessionRecord[] = [{ taskId: "t1", start: 0, end: 60 * MIN, status: "completed", actualMinutes: 300 }];
  assert.equal(adjustmentFactor(one).factor, 1);
  assert.equal(adjustmentFactor([...one, ...one]).factor, 2);
});

test("is deterministic", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", deadline: "2025-01-09" })];
  assert.deepEqual(planSchedule({ ...base, tasks }), planSchedule({ ...base, tasks }));
});

test("imported busy events block study time like manual ones", () => {
  // e.g. a calendar class imported from an .ics file, Monday 09:00–11:00
  const imported = { start: at(6, 9), end: at(6, 11) };
  const r = planSchedule({ ...base, blocked: [imported], tasks: [task({ estimatedHours: 1 })] });
  assert.equal(r.blocks[0].start, at(6, 11)); // first free minute after the imported event
  assert.equal(r.scheduledMinutes, 60);
  for (const b of r.blocks) assert.ok(b.end <= imported.start || b.start >= imported.end);
});

test("difficulty suggestion corrects only for the difference from the overall factor", () => {
  const hard = (actual: number): SessionRecord => ({ taskId: "h", start: 0, end: 60 * MIN, status: "completed", actualMinutes: actual });
  const easy = (actual: number): SessionRecord => ({ taskId: "e", start: 0, end: 60 * MIN, status: "completed", actualMinutes: actual });
  const sessions = [hard(90), hard(90), easy(60), easy(60)];
  const overall = adjustmentFactor(sessions); // 300 / 240 = 1.25
  const byDiff = difficultyFactors(sessions, (id) => (id === "h" ? 3 : id === "e" ? 1 : undefined));
  assert.equal(overall.factor, 1.25);
  assert.equal(byDiff[3].factor, 1.5);
  assert.equal(byDiff[2].active, false);

  // 2h × 1.5 ÷ 1.25 = 2.4h → 2.5h; planning then applies ×1.25, giving ~3h like past hard work
  const s = suggestEstimate(2, 3, byDiff, overall);
  assert.equal(s?.hours, 2.5);
  // Not enough medium history: no suggestion, never a guess
  assert.equal(suggestEstimate(2, 2, byDiff, overall), null);
});
