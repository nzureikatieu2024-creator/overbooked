"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  adjustmentFactor,
  difficultyFactors,
  planSchedule,
  remainingMinutes,
  type Interval,
  type PlannerTask,
  type SessionRecord,
  type SessionStatus,
  type Shortfall,
} from "@/lib/scheduler";
import { formatDeadline, formatMinutes } from "@/lib/format";
import {
  DEFAULT_SETTINGS,
  type AvailabilityRow,
  type BusyRow,
  type SessionRow,
  type Settings,
  type TaskRow,
  type TaskStats,
} from "@/lib/types";
import TaskPanel, { type NewTask } from "./TaskPanel";
import { AvailabilityPanel, BusyPanel, SettingsPanel } from "./SchedulePanels";
import WeekCalendar from "./WeekCalendar";
import Insights from "./Insights";
import ImportPanel, { type ImportItem, type ImportOutcome } from "./ImportPanel";
import Today from "./Today";

type PlanSummary = {
  sessions: number;
  minutes: number;
  markedMissed: number;
  shortfalls: (Shortfall & { title: string; deadline: string | null })[];
};

const toTask = (t: TaskRow): PlannerTask => ({
  id: t.id,
  title: t.title,
  deadline: t.deadline,
  estimatedHours: Number(t.estimated_hours),
  difficulty: t.difficulty,
  status: t.status,
  createdAt: t.created_at,
});

const toRecord = (s: SessionRow): SessionRecord => ({
  taskId: s.task_id,
  start: Date.parse(s.starts_at),
  end: Date.parse(s.ends_at),
  status: s.status,
  actualMinutes: s.actual_minutes,
});

export default function Planner() {
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [busy, setBusy] = useState<BusyRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Keep "now" fresh so overdue/upcoming labels stay correct
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadSessions = useCallback(async () => {
    const { data, error } = await supabase
      .from("study_sessions")
      .select("id, task_id, starts_at, ends_at, status, actual_minutes")
      .order("starts_at");
    if (error) throw error;
    setSessions((data ?? []) as SessionRow[]);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      try {
        const since = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
        const [t, a, b, s] = await Promise.all([
          supabase
            .from("tasks")
            .select("id, title, deadline, estimated_hours, difficulty, status, created_at")
            .order("created_at", { ascending: false }),
          supabase.from("availability").select("id, weekday, start_time, end_time").order("weekday").order("start_time"),
          supabase.from("busy_events").select("id, title, starts_at, ends_at").gte("ends_at", since).order("starts_at"),
          supabase.from("planner_settings").select("session_minutes, break_minutes").maybeSingle(),
        ]);
        for (const r of [t, a, b, s]) if (r.error) throw r.error;
        setTasks((t.data ?? []) as TaskRow[]);
        setAvailability((a.data ?? []) as AvailabilityRow[]);
        setBusy((b.data ?? []) as BusyRow[]);
        if (s.data) setSettings(s.data as Settings);
        await loadSessions();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, [supabase, loadSessions]);

  // ── Derived numbers ─────────────────────────────

  const records = useMemo(() => sessions.map(toRecord), [sessions]);
  const factorInfo = useMemo(() => adjustmentFactor(records), [records]);
  const byDifficulty = useMemo(() => {
    const difficulty = new Map(tasks.map((t) => [t.id, t.difficulty]));
    return difficultyFactors(records, (id) => difficulty.get(id));
  }, [records, tasks]);

  const stats = useMemo(() => {
    const map = new Map<string, TaskStats>();
    for (const t of tasks) {
      const own = sessions.filter((s) => s.task_id === t.id);
      const remaining = remainingMinutes(toTask(t), records, factorInfo.factor);
      const minutes = (s: SessionRow) => Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);
      const plannedAhead = own
        .filter((s) => s.status === "planned" && Date.parse(s.ends_at) > now)
        .reduce((sum, s) => sum + minutes(s), 0);
      const completed = own.filter((s) => s.status === "completed");
      map.set(t.id, {
        remaining,
        plannedAhead,
        logged: completed.reduce((sum, s) => sum + (s.actual_minutes ?? minutes(s)), 0),
        plannedCompleted: completed.reduce((sum, s) => sum + minutes(s), 0),
        overdue: own.filter((s) => s.status === "planned" && Date.parse(s.ends_at) <= now).length,
        unscheduled: Math.max(0, remaining - plannedAhead),
      });
    }
    return map;
  }, [tasks, sessions, records, factorInfo.factor, now]);

  const hasPlan = sessions.length > 0;
  const upcoming = sessions.filter((s) => s.status === "planned" && Date.parse(s.ends_at) > now);
  const overdueCount = sessions.filter((s) => s.status === "planned" && Date.parse(s.ends_at) <= now).length;
  const unscheduledTotal = [...stats.values()].reduce((sum, s) => sum + s.unscheduled, 0);
  // Upcoming study blocks that now collide with a busy event (e.g. after a calendar import)
  const conflictCount = upcoming.filter((s) => {
    const start = Date.parse(s.starts_at);
    const end = Date.parse(s.ends_at);
    return busy.some((b) => Date.parse(b.starts_at) < end && start < Date.parse(b.ends_at));
  }).length;

  // ── Tasks ───────────────────────────────────────

  async function addTask(input: NewTask): Promise<boolean> {
    setError(null);
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        title: input.title,
        deadline: input.deadline || null,
        estimated_hours: input.estimatedHours,
        difficulty: input.difficulty,
      })
      .select("id, title, deadline, estimated_hours, difficulty, status, created_at")
      .single();
    if (error) {
      setError(error.message);
      return false;
    }
    setTasks((prev) => [data as TaskRow, ...prev]);
    return true;
  }

  async function toggleTask(task: TaskRow) {
    setError(null);
    const status = task.status === "done" ? "active" : "done";
    const { error } = await supabase.from("tasks").update({ status }).eq("id", task.id);
    if (error) return setError(error.message);
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t)));
    if (status === "done") {
      // A finished task no longer needs its upcoming study blocks
      const ids = sessions
        .filter((s) => s.task_id === task.id && s.status === "planned" && Date.parse(s.starts_at) > Date.now())
        .map((s) => s.id);
      if (ids.length) {
        const { error: delError } = await supabase.from("study_sessions").delete().in("id", ids);
        if (delError) return setError(delError.message);
        setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
      }
    }
  }

  async function deleteTask(task: TaskRow) {
    if (!window.confirm(`Delete “${task.title}” and its study sessions?`)) return;
    setError(null);
    const { error } = await supabase.from("tasks").delete().eq("id", task.id);
    if (error) return setError(error.message);
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    setSessions((prev) => prev.filter((s) => s.task_id !== task.id));
  }

  // ── Sessions ────────────────────────────────────

  async function updateSession(id: string, status: SessionStatus, actualMinutes: number | null) {
    setError(null);
    const { error } = await supabase
      .from("study_sessions")
      .update({ status, actual_minutes: actualMinutes })
      .eq("id", id);
    if (error) return setError(error.message);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status, actual_minutes: actualMinutes } : s)));
  }

  // ── Auto-Plan / Replan ──────────────────────────

  async function runPlan() {
    setError(null);
    setSummary(null);
    if (availability.length === 0) {
      setError("Add your weekly study availability first, so Overbooked knows when you can study.");
      return;
    }
    if (!tasks.some((t) => t.status === "active")) {
      setError("Add at least one open task to plan.");
      return;
    }

    setPlanning(true);
    try {
      const at = new Date();
      const nowMs = at.getTime();

      // 1. Past planned sessions that were never marked count as missed.
      const overdueIds = sessions
        .filter((s) => s.status === "planned" && Date.parse(s.ends_at) <= nowMs)
        .map((s) => s.id);
      if (overdueIds.length) {
        const { error } = await supabase.from("study_sessions").update({ status: "missed" }).in("id", overdueIds);
        if (error) throw error;
      }

      // 2. Completed and missed sessions are kept; upcoming planned ones are rebuilt.
      const replaceIds = sessions
        .filter((s) => s.status === "planned" && Date.parse(s.ends_at) > nowMs)
        .map((s) => s.id);
      const kept = sessions.filter((s) => !replaceIds.includes(s.id));

      const blocked: Interval[] = [
        ...busy.map((b) => ({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at) })),
        ...kept.map((s) => ({ start: Date.parse(s.starts_at), end: Date.parse(s.ends_at) })),
      ].filter((i) => i.end > nowMs);

      const result = planSchedule({
        now: at,
        tasks: tasks.map(toTask),
        availability: availability.map((a) => ({
          weekday: a.weekday,
          startTime: a.start_time,
          endTime: a.end_time,
        })),
        blocked,
        sessions: kept.map(toRecord),
        sessionMinutes: settings.session_minutes,
        breakMinutes: settings.break_minutes,
        factor: factorInfo.factor,
      });

      // 3. Persist: remove the old upcoming plan, then save the new one.
      if (replaceIds.length) {
        const { error } = await supabase.from("study_sessions").delete().in("id", replaceIds);
        if (error) throw error;
      }
      if (result.blocks.length) {
        const { error } = await supabase.from("study_sessions").insert(
          result.blocks.map((b) => ({
            task_id: b.taskId,
            starts_at: new Date(b.start).toISOString(),
            ends_at: new Date(b.end).toISOString(),
          })),
        );
        if (error) throw error;
      }

      await loadSessions();
      setNow(Date.now());

      const byId = new Map(tasks.map((t) => [t.id, t]));
      setSummary({
        sessions: result.blocks.length,
        minutes: result.scheduledMinutes,
        markedMissed: overdueIds.length,
        shortfalls: result.shortfalls.map((s) => ({
          ...s,
          title: byId.get(s.taskId)?.title ?? "Task",
          deadline: byId.get(s.taskId)?.deadline ?? null,
        })),
      });
    } catch (e) {
      setError(messageOf(e));
      await loadSessions().catch(() => undefined);
    } finally {
      setPlanning(false);
    }
  }

  // ── Availability, busy events, settings ─────────

  async function addAvailability(weekday: number, start: string, end: string) {
    setError(null);
    const { data, error } = await supabase
      .from("availability")
      .insert({ weekday, start_time: start, end_time: end })
      .select("id, weekday, start_time, end_time")
      .single();
    if (error) return setError(error.message);
    setAvailability((prev) => sortAvailability([...prev, data as AvailabilityRow]));
  }

  async function addAvailabilityPreset() {
    setError(null);
    const rows = [
      ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_time: "17:00", end_time: "20:00" })),
      { weekday: 6, start_time: "10:00", end_time: "13:00" },
      { weekday: 0, start_time: "10:00", end_time: "13:00" },
    ];
    const { data, error } = await supabase
      .from("availability")
      .insert(rows)
      .select("id, weekday, start_time, end_time");
    if (error) return setError(error.message);
    setAvailability((prev) => sortAvailability([...prev, ...((data ?? []) as AvailabilityRow[])]));
  }

  async function deleteAvailability(id: string) {
    setError(null);
    const { error } = await supabase.from("availability").delete().eq("id", id);
    if (error) return setError(error.message);
    setAvailability((prev) => prev.filter((a) => a.id !== id));
  }

  async function addBusy(title: string, start: Date, end: Date, weeks: number) {
    setError(null);
    const rows = Array.from({ length: weeks }, (_, i) => {
      // Shift by calendar days so wall-clock time stays the same across DST changes
      const s = new Date(start);
      const e = new Date(end);
      s.setDate(s.getDate() + 7 * i);
      e.setDate(e.getDate() + 7 * i);
      return { title, starts_at: s.toISOString(), ends_at: e.toISOString() };
    });
    const { data, error } = await supabase
      .from("busy_events")
      .insert(rows)
      .select("id, title, starts_at, ends_at");
    if (error) return setError(error.message);
    setBusy((prev) => [...prev, ...((data ?? []) as BusyRow[])].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
  }

  async function deleteBusy(id: string) {
    setError(null);
    const { error } = await supabase.from("busy_events").delete().eq("id", id);
    if (error) return setError(error.message);
    setBusy((prev) => prev.filter((b) => b.id !== id));
  }

  // ── Calendar import (.ics) ───────────────────────
  // external_uid is only read here, so the rest of the app keeps working
  // even before the schema update that adds the column has been run.

  async function loadImportedKeys(from: number): Promise<Set<string> | null> {
    const { data, error } = await supabase
      .from("busy_events")
      .select("external_uid")
      .not("external_uid", "is", null)
      .gte("ends_at", new Date(from).toISOString());
    if (error) return null;
    return new Set((data ?? []).map((r) => (r as { external_uid: string }).external_uid));
  }

  async function importBusy(items: ImportItem[]): Promise<ImportOutcome> {
    setError(null);
    const inserted: BusyRow[] = [];
    for (let i = 0; i < items.length; i += 500) {
      const { data, error } = await supabase
        .from("busy_events")
        .upsert(
          items.slice(i, i + 500).map((it) => ({
            title: it.title,
            starts_at: new Date(it.start).toISOString(),
            ends_at: new Date(it.end).toISOString(),
            external_uid: it.key,
          })),
          { onConflict: "user_id,external_uid", ignoreDuplicates: true },
        )
        .select("id, title, starts_at, ends_at");
      if (error) {
        if (inserted.length) addBusyRows(inserted);
        return { error: importErrorMessage(error.message) };
      }
      inserted.push(...((data ?? []) as BusyRow[]));
    }
    addBusyRows(inserted);
    return { inserted: inserted.length, existing: items.length - inserted.length };
  }

  async function removeImported(): Promise<number | null> {
    setError(null);
    const { data, error } = await supabase
      .from("busy_events")
      .delete()
      .not("external_uid", "is", null)
      .gte("ends_at", new Date().toISOString())
      .select("id");
    if (error) {
      setError(importErrorMessage(error.message));
      return null;
    }
    const ids = new Set((data ?? []).map((r) => (r as { id: string }).id));
    setBusy((prev) => prev.filter((b) => !ids.has(b.id)));
    return ids.size;
  }

  function addBusyRows(rows: BusyRow[]) {
    setBusy((prev) => [...prev, ...rows].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
  }

  async function saveSettings(next: Settings) {
    setError(null);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return setError("Your session expired. Please log in again.");
    const { error } = await supabase
      .from("planner_settings")
      .upsert({ user_id: auth.user.id, ...next, updated_at: new Date().toISOString() });
    if (error) return setError(error.message);
    setSettings(next);
  }

  // ── Render ──────────────────────────────────────

  return (
    <div className="container app-shell">
      <div className="page-title">
        <div>
          <h1>Your study plan</h1>
          <p>Add what&apos;s due, set when you&apos;re free, and let Overbooked plan the rest.</p>
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loaded ? (
        <Today now={now} sessions={sessions} busy={busy} tasks={tasks} stats={stats} />
      ) : (
        <div className="today today-loading" aria-hidden="true" />
      )}

      <div className="grid-2">
        <TaskPanel
          tasks={tasks}
          stats={stats}
          loaded={loaded}
          onAdd={addTask}
          onToggle={toggleTask}
          onDelete={deleteTask}
          factor={factorInfo}
          byDifficulty={byDifficulty}
        />

        <div className="stack">
          <section className="card" aria-labelledby="plan-heading">
            <div className="card-head">
              <h2 id="plan-heading">Plan</h2>
              <span className="sub">
                {settings.session_minutes}m sessions · {settings.break_minutes}m breaks
              </span>
            </div>
            <div className="plan-bar">
              <div className="stats">
                <div className="stat">
                  <div className="v">{formatMinutes(upcoming.reduce((sum, s) => sum + minutesOf(s), 0))}</div>
                  <div className="k">planned ahead</div>
                </div>
                <div className="stat">
                  <div className="v" style={unscheduledTotal > 0 ? { color: "var(--warning)" } : undefined}>
                    {formatMinutes(unscheduledTotal)}
                  </div>
                  <div className="k">not scheduled</div>
                </div>
                <div className="stat">
                  <div className="v">×{factorInfo.factor.toFixed(2)}</div>
                  <div className="k">time factor</div>
                </div>
              </div>
              <button type="button" className="btn btn-primary" onClick={runPlan} disabled={planning || !loaded}>
                {planning ? "Planning…" : hasPlan ? "Replan" : "Auto-Plan"}
              </button>
            </div>

            {conflictCount > 0 && (
              <p className="notice" style={{ marginTop: 14 }}>
                {conflictCount} upcoming session{conflictCount === 1 ? " overlaps" : "s overlap"} a busy event. Click
                Replan to move {conflictCount === 1 ? "it" : "them"}.
              </p>
            )}

            {overdueCount > 0 && !summary && (
              <p className="notice" style={{ marginTop: 14 }}>
                {overdueCount} past session{overdueCount === 1 ? "" : "s"} not marked yet. Mark them in the calendar,
                or click Replan to count them as missed and reschedule the work.
              </p>
            )}

            {summary && (
              <div className="plan-result" role="status">
                <p className="notice">
                  Saved {summary.sessions} study session{summary.sessions === 1 ? "" : "s"} (
                  {formatMinutes(summary.minutes)}).
                  {summary.markedMissed > 0 &&
                    ` ${summary.markedMissed} past unmarked session${summary.markedMissed === 1 ? " was" : "s were"} counted as missed.`}
                </p>
                {summary.shortfalls.length > 0 ? (
                  <div className="error">
                    <strong>This work cannot fit in your available time:</strong>
                    <ul>
                      {summary.shortfalls.map((s) => (
                        <li key={s.taskId}>
                          {s.title}: {formatMinutes(s.minutes)}{" "}
                          {s.reason === "deadline_passed"
                            ? "— the deadline has already passed"
                            : s.deadline
                              ? `before ${formatDeadline(s.deadline)}`
                              : "in the next 14 days"}
                        </li>
                      ))}
                    </ul>
                    <p style={{ marginTop: 6 }}>
                      Add more availability, remove busy events, or lower the estimate, then Replan.
                    </p>
                  </div>
                ) : (
                  <p className="hint">Everything fits before its deadline.</p>
                )}
              </div>
            )}
          </section>

          <AvailabilityPanel
            rows={availability}
            onAdd={addAvailability}
            onPreset={addAvailabilityPreset}
            onDelete={deleteAvailability}
          />
          <BusyPanel rows={busy} now={now} onAdd={addBusy} onDelete={deleteBusy} />
          <ImportPanel
            busy={busy}
            loadImportedKeys={loadImportedKeys}
            onImport={importBusy}
            onRemoveImported={removeImported}
          />
          <SettingsPanel settings={settings} onSave={saveSettings} />
        </div>
      </div>

      {loaded && (
        <WeekCalendar
          now={now}
          sessions={sessions}
          busy={busy}
          tasks={tasks}
          onUpdate={updateSession}
        />
      )}

      {loaded && <Insights tasks={tasks} stats={stats} factor={factorInfo} byDifficulty={byDifficulty} />}
    </div>
  );
}

function minutesOf(s: SessionRow): number {
  return Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);
}

function sortAvailability(rows: AvailabilityRow[]): AvailabilityRow[] {
  return [...rows].sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
}

function importErrorMessage(message: string): string {
  if (/external_uid|on conflict|ON CONFLICT|schema cache/i.test(message)) {
    return "Calendar import needs a one-time database update: run supabase/schema.sql in the Supabase SQL Editor, then try again.";
  }
  return message;
}

function messageOf(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong. Please try again.";
}

