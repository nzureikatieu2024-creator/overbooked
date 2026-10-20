// Overbooked scheduling engine.
// Pure and deterministic: the same inputs always produce the same plan.
// All times are epoch milliseconds; wall-clock values (availability, deadlines)
// are interpreted in the local time zone of the machine running the code.

export type TaskStatus = "active" | "done";
export type SessionStatus = "planned" | "completed" | "missed";

export type PlannerTask = {
  id: string;
  title: string;
  deadline: string | null; // "YYYY-MM-DD", due at the end of that day
  estimatedHours: number;
  difficulty: number; // 1 easy, 2 medium, 3 hard
  status: TaskStatus;
  createdAt: string;
};

export type AvailabilityWindow = {
  weekday: number; // 0 = Sunday … 6 = Saturday
  startTime: string; // "HH:MM" or "HH:MM:SS"
  endTime: string;
};

// kind "session" = a kept study session; anything else is a busy event, which gets a transition buffer after it
export type Interval = { start: number; end: number; kind?: "busy" | "session" };

export type SessionRecord = {
  taskId: string;
  start: number;
  end: number;
  status: SessionStatus;
  actualMinutes: number | null;
};

export type PlannedBlock = {
  taskId: string;
  start: number;
  end: number;
  short?: boolean; // final session shorter than the minimum, because less work was left
};

export type Shortfall = {
  taskId: string;
  minutes: number;
  // below_minimum: the leftover is too small to be a useful session (under SHORT_FINAL_MINUTES)
  reason: "deadline_passed" | "not_enough_time" | "below_minimum";
};

export type PlanInput = {
  now: Date;
  tasks: PlannerTask[];
  availability: AvailabilityWindow[];
  blocked: Interval[]; // busy events and sessions that must be kept
  sessions: SessionRecord[]; // history, used for remaining work
  sessionMinutes: number; // maximum session length
  breakMinutes: number;
  factor: number;
  minSessionMinutes?: number; // default DEFAULT_MIN_SESSION_MINUTES
  bufferMinutes?: number; // free time kept after each busy event, default DEFAULT_BUFFER_MINUTES
};

export type PlanResult = {
  blocks: PlannedBlock[];
  shortfalls: Shortfall[];
  scheduledMinutes: number;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const DEFAULT_MIN_SESSION_MINUTES = 30;
export const DEFAULT_BUFFER_MINUTES = 15;
// A last session may be shorter than the minimum (e.g. 20 min to finish a task), but never under this
export const SHORT_FINAL_MINUTES = 15;
export const NO_DEADLINE_HORIZON_DAYS = 14;
const MAX_HORIZON_DAYS = 120;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2;
export const FACTOR_MIN_SAMPLES = 2;

function ceilTo(ms: number, minutes: number): number {
  const step = minutes * MINUTE;
  return Math.ceil(ms / step) * step;
}

function roundUpMinutes(minutes: number, step = 5): number {
  return Math.ceil(minutes / step) * step;
}

function parseClock(value: string): [number, number] {
  const [h, m] = value.split(":").map(Number);
  return [h, m];
}

/** Exclusive end of a deadline day: local midnight at the start of the next day. */
export function deadlineEnd(deadline: string): number {
  const [y, m, d] = deadline.split("-").map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
}

function sessionMinutes(s: { start: number; end: number }): number {
  return Math.round((s.end - s.start) / MINUTE);
}

/**
 * Adjustment factor = total actual minutes / total planned minutes,
 * over completed sessions with a logged time. Clamped to [0.5, 2].
 * Stays at 1.0 until there are at least FACTOR_MIN_SAMPLES completed sessions.
 */
export function adjustmentFactor(sessions: SessionRecord[]) {
  const done = sessions.filter((s) => s.status === "completed" && s.actualMinutes !== null);
  const planned = done.reduce((sum, s) => sum + sessionMinutes(s), 0);
  const actual = done.reduce((sum, s) => sum + (s.actualMinutes ?? 0), 0);
  const raw = planned > 0 ? actual / planned : 1;
  const active = done.length >= FACTOR_MIN_SAMPLES && planned > 0;
  const factor = active ? Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, raw)) : 1;
  return {
    factor: Math.round(factor * 100) / 100,
    raw: Math.round(raw * 100) / 100,
    samples: done.length,
    plannedMinutes: planned,
    actualMinutes: actual,
    active,
  };
}

export type FactorInfo = ReturnType<typeof adjustmentFactor>;

/** The same actual ÷ planned factor, computed separately for easy, medium and hard tasks. */
export function difficultyFactors(
  sessions: SessionRecord[],
  difficultyOf: (taskId: string) => number | undefined,
): Record<number, FactorInfo> {
  const out: Record<number, FactorInfo> = {};
  for (const d of [1, 2, 3]) out[d] = adjustmentFactor(sessions.filter((s) => difficultyOf(s.taskId) === d));
  return out;
}

export type EstimateSuggestion = {
  hours: number; // suggested estimate, rounded to 0.25 h
  difficultyFactor: number;
  overallFactor: number;
  samples: number;
};

/**
 * Optional, difficulty-aware estimate. Plans already multiply every estimate by the
 * overall factor, so the suggestion only corrects for the difference between this
 * difficulty and the overall average: estimate × difficulty factor ÷ overall factor.
 * Returns null until this difficulty has enough completed sessions, or when the
 * suggestion would not change the estimate.
 */
export function suggestEstimate(
  hours: number,
  difficulty: number,
  byDifficulty: Record<number, FactorInfo>,
  overall: FactorInfo,
): EstimateSuggestion | null {
  const own = byDifficulty[difficulty];
  if (!own?.active || !(hours > 0)) return null;
  const overallFactor = overall.active ? overall.factor : 1;
  const raw = (hours * own.factor) / overallFactor;
  const suggested = Math.min(200, Math.max(0.25, Math.round(raw * 4) / 4));
  if (suggested === Math.round(hours * 4) / 4) return null;
  return { hours: suggested, difficultyFactor: own.factor, overallFactor, samples: own.samples };
}

/** Minutes still to study = estimate × factor − minutes already logged as completed. */
export function remainingMinutes(task: PlannerTask, sessions: SessionRecord[], factor: number): number {
  if (task.status === "done") return 0;
  const logged = sessions
    .filter((s) => s.taskId === task.id && s.status === "completed")
    .reduce((sum, s) => sum + (s.actualMinutes ?? sessionMinutes(s)), 0);
  const needed = task.estimatedHours * 60 * factor - logged;
  return needed > 0 ? roundUpMinutes(needed) : 0;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function subtractIntervals(free: Interval[], blocked: Interval[]): Interval[] {
  const blocks = mergeIntervals(blocked);
  const out: Interval[] = [];
  for (const f of free) {
    let pieces: Interval[] = [{ ...f }];
    for (const b of blocks) {
      if (b.end <= f.start || b.start >= f.end) continue;
      const next: Interval[] = [];
      for (const p of pieces) {
        if (b.end <= p.start || b.start >= p.end) {
          next.push(p);
          continue;
        }
        if (b.start > p.start) next.push({ start: p.start, end: b.start });
        if (b.end < p.end) next.push({ start: b.end, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

/** Expand weekly availability into dated free intervals between `from` and `to`. */
export function freeIntervals(
  availability: AvailabilityWindow[],
  blocked: Interval[],
  from: number,
  to: number,
): Interval[] {
  const raw: Interval[] = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < to) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    const d = cursor.getDate();
    for (const w of availability) {
      if (w.weekday !== cursor.getDay()) continue;
      const [sh, sm] = parseClock(w.startTime);
      const [eh, em] = parseClock(w.endTime);
      const start = Math.max(new Date(y, m, d, sh, sm).getTime(), from);
      const end = Math.min(new Date(y, m, d, eh, em).getTime(), to);
      if (end > start) raw.push({ start, end });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return subtractIntervals(mergeIntervals(raw), blocked);
}

function compareTasks(a: PlannerTask, b: PlannerTask): number {
  const da = a.deadline ? deadlineEnd(a.deadline) : Infinity;
  const db = b.deadline ? deadlineEnd(b.deadline) : Infinity;
  if (da !== db) return da - db; // earliest deadline first
  if (a.difficulty !== b.difficulty) return b.difficulty - a.difficulty; // harder first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const v = Math.round(Number(value ?? fallback));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function minSessionOf(input: Pick<PlanInput, "minSessionMinutes">): number {
  return clamp(input.minSessionMinutes, DEFAULT_MIN_SESSION_MINUTES, SHORT_FINAL_MINUTES, 120);
}

/** Busy events extended by the transition buffer; kept study sessions are left as they are. */
export function effectiveBlocked(input: Pick<PlanInput, "blocked" | "bufferMinutes">): Interval[] {
  const buffer = clamp(input.bufferMinutes, DEFAULT_BUFFER_MINUTES, 0, 120) * MINUTE;
  return input.blocked.map((b) => (b.kind === "session" ? { ...b } : { start: b.start, end: b.end + buffer, kind: b.kind }));
}

/**
 * Length of the next session for a task with `remaining` minutes left, given `room`
 * minutes free in the current slot. 0 = nothing useful fits here.
 * - Sessions are at least `min` long, except a final session of at least `shortFinal`.
 * - A tail under `shortFinal` is folded into this session (up to `max + shortFinal`) or
 *   the split is shifted so the rest is a real session.
 */
export function chunkLength(remaining: number, room: number, max: number, min: number, shortFinal: number): number {
  if (remaining < shortFinal) return 0;
  if (room < Math.min(remaining, min)) return 0;
  const len = Math.min(max, remaining, room);
  const tail = remaining - len;
  if (tail === 0) return len;
  if (tail < shortFinal && remaining <= max + shortFinal && room >= remaining) return remaining;
  if (tail < min) {
    const shifted = len - (min - tail); // leaves exactly one minimum session
    if (shifted >= min) return shifted;
    if (tail >= shortFinal) return len; // the rest becomes a short final session
    const toShortFinal = len - (shortFinal - tail);
    if (toShortFinal >= min) return toShortFinal;
  }
  return len;
}

/**
 * Earliest-deadline-first greedy planner.
 * Each task fills the earliest free time before its deadline in sessions of
 * at most `sessionMinutes` and at least `minSessionMinutes`, with `breakMinutes`
 * reserved after every session and `bufferMinutes` kept free after busy events.
 * Work that does not fit is reported as a shortfall, never silently dropped.
 */
export function planSchedule(input: PlanInput): PlanResult {
  const now = ceilTo(input.now.getTime(), 15);
  const minLen = minSessionOf(input);
  const shortFinal = Math.min(SHORT_FINAL_MINUTES, minLen);
  const sessionLen = Math.max(minLen, Math.round(input.sessionMinutes));
  const breakLen = Math.max(0, Math.round(input.breakMinutes));
  const maxEnd = now + MAX_HORIZON_DAYS * DAY;
  const noDeadlineEnd = now + NO_DEADLINE_HORIZON_DAYS * DAY;

  const tasks = input.tasks.filter((t) => t.status === "active").sort(compareTasks);
  const limitFor = (t: PlannerTask) =>
    Math.min(t.deadline ? deadlineEnd(t.deadline) : noDeadlineEnd, maxEnd);
  const horizon = tasks.reduce((max, t) => Math.max(max, limitFor(t)), now);

  const blocked = effectiveBlocked(input);
  const free = freeIntervals(input.availability, blocked, now, horizon);
  const blocks: PlannedBlock[] = [];
  const shortfalls: Shortfall[] = [];

  for (const task of tasks) {
    let remaining = remainingMinutes(task, input.sessions, input.factor);
    if (remaining === 0) continue;
    const limit = limitFor(task);
    if (limit <= now) {
      shortfalls.push({ taskId: task.id, minutes: remaining, reason: "deadline_passed" });
      continue;
    }

    for (const slot of free) {
      if (remaining === 0) break;
      while (remaining > 0) {
        const start = ceilTo(slot.start, 5);
        const usableEnd = Math.min(slot.end, limit);
        const room = Math.floor((usableEnd - start) / MINUTE);
        const len = chunkLength(remaining, room, sessionLen, minLen, shortFinal);
        if (len === 0) break;
        const end = start + len * MINUTE;
        blocks.push(len < minLen ? { taskId: task.id, start, end, short: true } : { taskId: task.id, start, end });
        remaining -= len;
        slot.start = end + breakLen * MINUTE;
      }
    }

    if (remaining > 0) {
      // A leftover too small for any session is reported separately, never shown as scheduled
      const reason = remaining < shortFinal ? "below_minimum" : "not_enough_time";
      shortfalls.push({ taskId: task.id, minutes: remaining, reason });
    }
  }

  blocks.sort((a, b) => a.start - b.start);
  assertNoOverlap(blocks, blocked);

  return {
    blocks,
    shortfalls,
    scheduledMinutes: blocks.reduce((sum, b) => sum + sessionMinutes(b), 0),
  };
}

function assertNoOverlap(blocks: PlannedBlock[], blocked: Interval[]): void {
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start < blocks[i - 1].end) throw new Error("Planner produced overlapping sessions");
  }
  for (const b of blocks) {
    for (const x of blocked) {
      if (b.start < x.end && x.start < b.end) throw new Error("Planner overlapped a busy period");
    }
  }
}
