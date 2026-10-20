"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  adjustmentFactor,
  difficultyFactors,
  planSchedule,
  remainingMinutes,
  type SessionStatus,
  type Shortfall,
} from "@/lib/scheduler";
import { buildPlanInput, toRecord, toTask, type PlanData } from "@/lib/plan-input";
import { assessRisks } from "@/lib/risk";
import { changeInterval, estimateWithExtra, type Change } from "@/lib/whatif";
import { formatDeadline, formatMinutes } from "@/lib/format";
import {
  DEFAULT_SETTINGS,
  isArchived,
  isBlocking,
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
import RiskPanel from "./RiskPanel";
import WhatIfPanel from "./WhatIfPanel";

type PlanSummary = {
  sessions: number;
  minutes: number;
  markedMissed: number;
  shortfalls: (Shortfall & { title: string; deadline: string | null })[];
};

export default function Planner() {
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [busy, setBusy] = useState<BusyRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // true once database migration 002 is present (non-blocking events, archive, min session, buffer)
  const [advanced, setAdvanced] = useState(false);
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

  const loadAll = useCallback(async () => {
    setLoadError(null);
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

        // Columns added by migration 002 are read separately, so the app keeps working before it is run
        const [ta, bb, se] = await Promise.all([
          supabase.from("tasks").select("id, archived_at").not("archived_at", "is", null),
          supabase.from("busy_events").select("id").eq("blocking", false).gte("ends_at", since),
          supabase.from("planner_settings").select("min_session_minutes, buffer_minutes").maybeSingle(),
        ]);
        const hasV2 = !ta.error && !bb.error && !se.error;
        const archived = new Map(hasV2 ? (ta.data ?? []).map((r) => [r.id as string, r.archived_at as string]) : []);
        const infoOnly = new Set(hasV2 ? (bb.data ?? []).map((r) => r.id as string) : []);

        setAdvanced(hasV2);
        setTasks(((t.data ?? []) as TaskRow[]).map((row) => ({ ...row, archived_at: archived.get(row.id) ?? null })));
        setAvailability((a.data ?? []) as AvailabilityRow[]);
        setBusy(((b.data ?? []) as BusyRow[]).map((row) => ({ ...row, blocking: !infoOnly.has(row.id) })));
        setSettings({ ...DEFAULT_SETTINGS, ...(s.data ?? {}), ...(hasV2 && se.data ? se.data : {}) } as Settings);
        await loadSessions();
        setLoaded(true);
      } catch (e) {
        // Never show empty lists as if there were no data: keep a clear error with a retry
        setLoadError(messageOf(e));
      }
  }, [supabase, loadSessions]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ── Derived numbers ─────────────────────────────

  // Archived tasks keep their history but are hidden from planning, Today, risk and What-if
  const activeTasks = useMemo(() => tasks.filter((t) => !isArchived(t)), [tasks]);
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
    return busy.some((b) => isBlocking(b) && Date.parse(b.starts_at) < end && start < Date.parse(b.ends_at));
  }).length;

  const planData = useMemo<PlanData>(
    () => ({ tasks: activeTasks, availability, busy, sessions, settings }),
    [activeTasks, availability, busy, sessions, settings],
  );

  // Deadline risk: the plan Replan would make right now, compared with real free time
  const riskReport = useMemo(() => {
    if (!loaded) return null;
    try {
      const { input } = buildPlanInput(planData, new Date(now));
      const saved = new Map([...stats].map(([id, s]) => [id, s.unscheduled]));
      return assessRisks(input, planSchedule(input), saved);
    } catch {
      return null;
    }
  }, [loaded, planData, stats, now]);

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

  /** Removes a task's future planned sessions (never completed or missed ones). */
  async function dropUpcoming(taskId: string | null): Promise<boolean> {
    const ids = sessions
      .filter((s) => (taskId === null || s.task_id === taskId) && s.status === "planned" && Date.parse(s.starts_at) > Date.now())
      .map((s) => s.id);
    if (!ids.length) return true;
    const { error } = await supabase.from("study_sessions").delete().in("id", ids);
    if (error) {
      setError(error.message);
      return false;
    }
    setSessions((prev) => prev.filter((s) => !ids.includes(s.id)));
    return true;
  }

  async function archiveTask(task: TaskRow, archive: boolean) {
    setError(null);
    const archived_at = archive ? new Date().toISOString() : null;
    const { error } = await supabase.from("tasks").update({ archived_at }).eq("id", task.id);
    if (error) return setError(error.message);
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, archived_at } : t)));
    // Archived work no longer needs future study blocks; its completed history stays
    if (archive) await dropUpcoming(task.id);
  }

  async function archiveDone() {
    const done = activeTasks.filter((t) => t.status === "done");
    if (!done.length) return;
    if (!window.confirm(`Archive ${done.length} completed task${done.length === 1 ? "" : "s"}? Their study history is kept and you can restore them any time.`)) return;
    setError(null);
    const archived_at = new Date().toISOString();
    const ids = done.map((t) => t.id);
    const { error } = await supabase.from("tasks").update({ archived_at }).in("id", ids);
    if (error) return setError(error.message);
    setTasks((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, archived_at } : t)));
  }

  async function clearUpcomingPlan() {
    const count = upcoming.length;
    if (!count) return;
    if (!window.confirm(`Remove ${count} upcoming planned session${count === 1 ? "" : "s"}? Tasks, completed and missed sessions are kept. Click Auto-Plan afterwards to build a fresh plan.`)) return;
    setError(null);
    setSummary(null);
    await dropUpcoming(null);
  }

  async function deleteTask(task: TaskRow) {
    const history = sessions.filter((s) => s.task_id === task.id && s.status !== "planned");
    const logged = history.filter((s) => s.status === "completed").reduce((sum, s) => sum + (s.actual_minutes ?? minutesOf(s)), 0);
    const warning = history.length
      ? `\n\nThis also permanently deletes ${history.length} past session${history.length === 1 ? "" : "s"}${logged ? ` (${formatMinutes(logged)} of logged study time)` : ""}, which your time factor is based on.${advanced ? " Choose Archive instead to keep them." : ""}`
      : "";
    if (!window.confirm(`Permanently delete “${task.title}”?${warning}`)) return;
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

  // `override` lets Apply scenario plan with rows it has just saved, before React state updates.
  async function runPlan(override: Partial<PlanData> = {}): Promise<boolean> {
    const data: PlanData = { tasks: activeTasks, availability, busy, sessions, settings, ...override };
    setError(null);
    setSummary(null);
    if (data.availability.length === 0) {
      setError("Add your weekly study availability first, so Overbooked knows when you can study.");
      return false;
    }
    if (!data.tasks.some((t) => t.status === "active")) {
      setError("Add at least one open task to plan.");
      return false;
    }

    setPlanning(true);
    try {
      const { input, overdueIds, replaceIds } = buildPlanInput(data, new Date());

      // 1. Past planned sessions that were never marked count as missed.
      if (overdueIds.length) {
        const { error } = await supabase.from("study_sessions").update({ status: "missed" }).in("id", overdueIds);
        if (error) throw error;
      }

      // 2. Completed and missed sessions are kept; upcoming planned ones are rebuilt.
      const result = planSchedule(input);

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

      const byId = new Map(data.tasks.map((t) => [t.id, t]));
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
      return true;
    } catch (e) {
      setError(messageOf(e));
      await loadSessions().catch(() => undefined);
      return false;
    } finally {
      setPlanning(false);
    }
  }

  // ── What-if: only runs when the user explicitly applies a scenario ──

  async function applyScenario(changes: Change[]): Promise<boolean> {
    setError(null);
    let nextTasks = tasks;
    let nextBusy = busy;

    const lost = changes.filter((c): c is Extract<Change, { kind: "lose_time" }> => c.kind === "lose_time");
    if (lost.length) {
      const { data, error } = await supabase
        .from("busy_events")
        .insert(
          lost.map((c) => {
            const i = changeInterval(c);
            return { title: "Unavailable (what-if)", starts_at: new Date(i.start).toISOString(), ends_at: new Date(i.end).toISOString() };
          }),
        )
        .select("id, title, starts_at, ends_at");
      if (error) {
        setError(error.message);
        return false;
      }
      nextBusy = [...busy, ...((data ?? []) as BusyRow[])].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      setBusy(nextBusy);
    }

    const extra = new Map<string, number>();
    for (const c of changes) if (c.kind === "extra_work") extra.set(c.taskId, (extra.get(c.taskId) ?? 0) + c.hours);
    for (const [taskId, hours] of extra) {
      const task = nextTasks.find((t) => t.id === taskId);
      if (!task) continue;
      const estimated_hours = Math.min(200, estimateWithExtra(Number(task.estimated_hours), hours, factorInfo.factor));
      const { error } = await supabase.from("tasks").update({ estimated_hours }).eq("id", taskId);
      if (error) {
        setError(error.message);
        return false;
      }
      nextTasks = nextTasks.map((t) => (t.id === taskId ? { ...t, estimated_hours } : t));
    }
    setTasks(nextTasks);

    return runPlan({ tasks: nextTasks, busy: nextBusy });
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
            ...(advanced ? { blocking: it.blocking } : {}),
          })),
          { onConflict: "user_id,external_uid", ignoreDuplicates: true },
        )
        .select(advanced ? "id, title, starts_at, ends_at, blocking" : "id, title, starts_at, ends_at");
      if (error) {
        if (inserted.length) addBusyRows(inserted);
        return { error: importErrorMessage(error.message) };
      }
      // The column list is chosen at runtime, so the typed parser can't infer the row shape
      inserted.push(...((data ?? []) as unknown as BusyRow[]));
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

  async function setManyNonBlocking(ids: string[]): Promise<boolean> {
    setError(null);
    const { error } = await supabase.from("busy_events").update({ blocking: false }).in("id", ids);
    if (error) {
      setError(error.message);
      return false;
    }
    setBusy((prev) => prev.map((b) => (ids.includes(b.id) ? { ...b, blocking: false } : b)));
    return true;
  }

  function addBusyRows(rows: BusyRow[]) {
    setBusy((prev) => [...prev, ...rows].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
  }

  async function saveSettings(next: Settings): Promise<boolean> {
    setError(null);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setError("Your session expired. Please log in again.");
      return false;
    }
    const row: Record<string, unknown> = {
      user_id: auth.user.id,
      session_minutes: next.session_minutes,
      break_minutes: next.break_minutes,
      updated_at: new Date().toISOString(),
    };
    if (advanced) Object.assign(row, { min_session_minutes: next.min_session_minutes, buffer_minutes: next.buffer_minutes });
    const { error } = await supabase.from("planner_settings").upsert(row);
    if (error) {
      setError(error.message);
      return false;
    }
    setSettings(advanced ? next : { ...next, min_session_minutes: settings.min_session_minutes, buffer_minutes: settings.buffer_minutes });
    return true;
  }

  async function setBusyBlocking(id: string, blocking: boolean) {
    setError(null);
    const { error } = await supabase.from("busy_events").update({ blocking }).eq("id", id);
    if (error) return setError(error.message);
    setBusy((prev) => prev.map((b) => (b.id === id ? { ...b, blocking } : b)));
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

      {loadError && (
        <div className="error-card" role="alert">
          <div>
            <strong>Your plan couldn&apos;t be loaded.</strong>
            <p>{loadError}</p>
            <p className="hint">Your data is safe and nothing was changed. Check your connection and try again.</p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={loadAll}>
            Try again
          </button>
        </div>
      )}

      {error && (
        <div className="error error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)} aria-label="Dismiss message">
            Dismiss
          </button>
        </div>
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
          onArchive={advanced ? archiveTask : undefined}
          onArchiveDone={advanced ? archiveDone : undefined}
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
              <button type="button" className="btn btn-primary" onClick={() => runPlan()} disabled={planning || !loaded}>
                {planning ? "Planning…" : hasPlan ? "Replan" : "Auto-Plan"}
              </button>
            </div>
            {upcoming.length > 0 && (
              <div className="plan-tools">
                <span className="hint">
                  Replan rebuilds upcoming sessions and keeps completed and missed ones.
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearUpcomingPlan} disabled={planning}>
                  Clear upcoming plan
                </button>
              </div>
            )}

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
                {summary.shortfalls.some((s) => s.reason === "below_minimum") && (
                  <p className="hint">
                    {summary.shortfalls
                      .filter((s) => s.reason === "below_minimum")
                      .map((s) => `${s.title}: ${formatMinutes(s.minutes)} left`)
                      .join(" · ")}{" "}
                    — too short for a study session, so not scheduled. Finish it in a spare moment and mark it done.
                  </p>
                )}
                {summary.shortfalls.some((s) => s.reason !== "below_minimum") ? (
                  <div className="error">
                    <strong>This work cannot fit in your available time:</strong>
                    <ul>
                      {summary.shortfalls.filter((s) => s.reason !== "below_minimum").map((s) => (
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

          {riskReport && <RiskPanel report={riskReport} sessionMinutes={settings.session_minutes} hasPlan={hasPlan} />}

          <AvailabilityPanel
            rows={availability}
            onAdd={addAvailability}
            onPreset={addAvailabilityPreset}
            onDelete={deleteAvailability}
          />
          <BusyPanel
            rows={busy}
            now={now}
            onAdd={addBusy}
            onDelete={deleteBusy}
            onSetBlocking={advanced ? setBusyBlocking : undefined}
          />
          <ImportPanel
            busy={busy}
            loadImportedKeys={loadImportedKeys}
            onImport={importBusy}
            onRemoveImported={removeImported}
            advanced={advanced}
            onMakeInfoOnly={setManyNonBlocking}
          />
          <SettingsPanel settings={settings} onSave={saveSettings} advanced={advanced} />
        </div>
      </div>

      {loaded && (
        <WhatIfPanel
          data={planData}
          now={now}
          planning={planning}
          onApply={applyScenario}
        />
      )}

      {loaded && (
        <WeekCalendar
          now={now}
          sessions={sessions}
          busy={busy}
          tasks={tasks}
          availability={availability}
          minSessionMinutes={settings.min_session_minutes}
          onUpdate={updateSession}
          onSetBlocking={advanced ? setBusyBlocking : undefined}
        />
      )}

      {loaded && <Insights tasks={activeTasks} stats={stats} factor={factorInfo} byDifficulty={byDifficulty} />}
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

