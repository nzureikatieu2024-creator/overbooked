"use client";

import { useState } from "react";
import { WEEKDAYS, formatClock, formatDay, isAllDay, localDateTime, todayISO, trimClock } from "@/lib/format";
import { isBlocking, type AvailabilityRow, type BusyRow, type Settings } from "@/lib/types";

// Weekdays listed Monday first
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function Section({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="card section" open={defaultOpen}>
      <summary>
        <h2>{title}</h2>
        <span className="hint">
          {summary} <span className="chev" aria-hidden="true">›</span>
        </span>
      </summary>
      {children}
    </details>
  );
}

export function AvailabilityPanel({
  rows,
  onAdd,
  onPreset,
  onDelete,
}: {
  rows: AvailabilityRow[];
  onAdd: (weekday: number, start: string, end: string) => Promise<void>;
  onPreset: () => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [weekday, setWeekday] = useState("1");
  const [start, setStart] = useState("17:00");
  const [end, setEnd] = useState("20:00");
  const [err, setErr] = useState<string | null>(null);

  const totalMinutes = rows.reduce((sum, r) => sum + clockMinutes(r.end_time) - clockMinutes(r.start_time), 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!start || !end || end <= start) return setErr("End time must be after start time.");
    setErr(null);
    await onAdd(Number(weekday), start, end);
  }

  const ordered = [...rows].sort(
    (a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) || a.start_time.localeCompare(b.start_time),
  );

  return (
    <Section
      title="Preferred study hours"
      summary={rows.length ? `${Math.round((totalMinutes / 60) * 10) / 10}h / week` : "Not set"}
      defaultOpen={rows.length === 0}
    >
      <p className="hint" style={{ marginBottom: 12 }}>
        When you like to study each week. Study sessions are only ever placed inside these windows.
      </p>
      {rows.length > 0 ? (
        <div className="rows">
          {ordered.map((r) => (
            <div className="row" key={r.id}>
              <span className="what">
                <strong>{WEEKDAYS[r.weekday]}</strong> {trimClock(r.start_time)}–{trimClock(r.end_time)}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(r.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rows">
          <button type="button" className="btn btn-secondary" onClick={onPreset}>
            Use a typical week (weekdays 17–20, weekends 10–13)
          </button>
        </div>
      )}
      <form className="inline-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="av-day">Day</label>
          <select id="av-day" className="input" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {WEEK_ORDER.map((d) => (
              <option key={d} value={d}>
                {WEEKDAYS[d]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="av-start">From</label>
          <input id="av-start" className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="av-end">To</label>
          <input id="av-end" className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-secondary">
          Add window
        </button>
      </form>
      {err && (
        <p className="error" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      )}
    </Section>
  );
}

export function BusyPanel({
  rows,
  now,
  onAdd,
  onDelete,
  onSetBlocking,
}: {
  rows: BusyRow[];
  now: number;
  onAdd: (title: string, start: Date, end: Date, weeks: number) => Promise<void>;
  onDelete: (id: string) => void;
  onSetBlocking?: (id: string, blocking: boolean) => void; // only after migration 002
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayISO);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:30");
  const [weeks, setWeeks] = useState("1");
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upcoming = rows.filter((r) => Date.parse(r.ends_at) > now);
  const infoOnly = upcoming.filter((r) => !isBlocking(r)).length;
  const visible = showAll ? upcoming : upcoming.slice(0, 6);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!date || !start || !end || end <= start) return setErr("End time must be after start time on the same day.");
    const repeat = Math.min(20, Math.max(1, Math.round(Number(weeks) || 1)));
    setErr(null);
    await onAdd(title.trim() || "Busy", localDateTime(date, start), localDateTime(date, end), repeat);
    setTitle("");
  }

  return (
    <Section title="Busy events" summary={`${upcoming.length} upcoming${infoOnly ? ` · ${infoOnly} info only` : ""}`}>
      <p className="hint" style={{ marginBottom: 12 }}>
        Classes, work shifts, appointments. Overbooked never schedules study time over events that block study.
        {onSetBlocking && " Untick “Blocks study” for events that are only for information."}
      </p>
      {upcoming.length > 0 && (
        <div className="rows">
          {visible.map((r) => (
            <div className={`row${isBlocking(r) ? "" : " info"}`} key={r.id}>
              <span className="what">
                <strong className="clip" title={r.title}>
                  {r.title}
                </strong>
                <span className="hint">
                  {formatDay(Date.parse(r.starts_at))}, {busyTimeLabel(r)}
                  {!isBlocking(r) && " · info only"}
                </span>
              </span>
              <span className="row-actions">
                {onSetBlocking && (
                  <label className="mini-check" title="When ticked, no study time is planned during this event">
                    <input type="checkbox" checked={isBlocking(r)} onChange={(e) => onSetBlocking(r.id, e.target.checked)} />
                    Blocks study
                  </label>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(r.id)} aria-label={`Remove ${r.title}`}>
                  Remove
                </button>
              </span>
            </div>
          ))}
          {upcoming.length > 6 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${upcoming.length}`}
            </button>
          )}
        </div>
      )}
      <form className="inline-form" onSubmit={submit}>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="busy-title">What</label>
          <input
            id="busy-title"
            className="input"
            type="text"
            placeholder="e.g. Marketing class"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="busy-date">Date</label>
          <input id="busy-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="busy-start">From</label>
          <input id="busy-start" className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="busy-end">To</label>
          <input id="busy-end" className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="busy-weeks">Repeat weekly for</label>
          <select id="busy-weeks" className="input" value={weeks} onChange={(e) => setWeeks(e.target.value)}>
            <option value="1">Just once</option>
            {[2, 4, 6, 8, 10, 12, 14, 16].map((n) => (
              <option key={n} value={n}>
                {n} weeks
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-secondary" style={{ gridColumn: "1 / -1" }}>
          Add busy event
        </button>
      </form>
      {err && (
        <p className="error" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      )}
    </Section>
  );
}

export function SettingsPanel({
  settings,
  onSave,
  advanced,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<boolean>;
  advanced: boolean; // min session and buffer can be saved (database migration 002 has been run)
}) {
  const [form, setForm] = useState(() => toForm(settings));
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [synced, setSynced] = useState(settings);

  // Pick up settings loaded from the database after first render
  if (synced !== settings) {
    setSynced(settings);
    setForm(toForm(settings));
  }

  const set = (key: keyof ReturnType<typeof toForm>) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Settings = {
      session_minutes: Math.round(Number(form.max)),
      min_session_minutes: Math.round(Number(form.min)),
      break_minutes: Math.round(Number(form.rest)),
      buffer_minutes: Math.round(Number(form.buffer)),
    };
    if (!(next.min_session_minutes >= 15 && next.min_session_minutes <= 120)) return setErr("Minimum session must be 15–120 minutes.");
    if (!(next.session_minutes >= next.min_session_minutes && next.session_minutes <= 240)) {
      return setErr(`Maximum session must be between the minimum (${next.min_session_minutes}) and 240 minutes.`);
    }
    if (!(next.break_minutes >= 0 && next.break_minutes <= 120)) return setErr("Break must be 0–120 minutes.");
    if (!(next.buffer_minutes >= 0 && next.buffer_minutes <= 120)) return setErr("Buffer must be 0–120 minutes.");
    setErr(null);
    if (await onSave(next)) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Section
      title="Session settings"
      summary={`${settings.min_session_minutes}–${settings.session_minutes}m · ${settings.buffer_minutes}m buffer`}
    >
      <form className="settings-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="set-min">Shortest session</label>
          <input id="set-min" className="input" type="number" min={15} max={120} step={5} value={form.min} onChange={set("min")} disabled={!advanced} />
        </div>
        <div className="field">
          <label htmlFor="set-session">Longest session</label>
          <input id="set-session" className="input" type="number" min={15} max={240} step={5} value={form.max} onChange={set("max")} />
        </div>
        <div className="field">
          <label htmlFor="set-break">Break after a session</label>
          <input id="set-break" className="input" type="number" min={0} max={120} step={5} value={form.rest} onChange={set("rest")} />
        </div>
        <div className="field">
          <label htmlFor="set-buffer">Buffer after classes</label>
          <input id="set-buffer" className="input" type="number" min={0} max={120} step={5} value={form.buffer} onChange={set("buffer")} disabled={!advanced} />
        </div>
        <button type="submit" className="btn btn-secondary">
          {saved ? "Saved" : "Save"}
        </button>
      </form>
      <p className="hint" style={{ marginTop: 10 }}>
        All in minutes. Study sessions are never shorter than the shortest session, except a final one of at least 15
        minutes to finish a task (marked &ldquo;short&rdquo;). The buffer keeps time free after each busy event to travel
        or switch. Changes apply on the next Replan.
      </p>
      {!advanced && (
        <p className="notice" style={{ marginTop: 10 }}>
          The defaults (30-minute shortest session, 15-minute buffer) are already used. To change them, run{" "}
          <code>supabase/migrations/002_planner_preferences.sql</code> in Supabase once.
        </p>
      )}
      {err && (
        <p className="error" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      )}
    </Section>
  );
}

function toForm(s: Settings) {
  return {
    max: String(s.session_minutes),
    min: String(s.min_session_minutes),
    rest: String(s.break_minutes),
    buffer: String(s.buffer_minutes),
  };
}

function clockMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** "09:00–10:30", or "All day" / "All day · 3 days" for events covering whole local days. */
export function busyTimeLabel(b: BusyRow): string {
  const start = Date.parse(b.starts_at);
  const end = Date.parse(b.ends_at);
  if (isAllDay(start, end)) {
    const days = Math.round((end - start) / 86_400_000);
    return days > 1 ? `All day · ${days} days` : "All day";
  }
  return `${formatClock(start)}–${formatClock(end)}`;
}
