"use client";

import { useState } from "react";
import { WEEKDAYS, formatClock, formatDay, localDateTime, todayISO, trimClock } from "@/lib/format";
import type { AvailabilityRow, BusyRow, Settings } from "@/lib/types";

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
      title="Weekly availability"
      summary={rows.length ? `${Math.round((totalMinutes / 60) * 10) / 10}h / week` : "Not set"}
      defaultOpen={rows.length === 0}
    >
      <p className="hint" style={{ marginBottom: 12 }}>
        When you can study each week. Study blocks are only placed inside these windows.
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
}: {
  rows: BusyRow[];
  now: number;
  onAdd: (title: string, start: Date, end: Date, weeks: number) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(todayISO);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:30");
  const [weeks, setWeeks] = useState("1");
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upcoming = rows.filter((r) => Date.parse(r.ends_at) > now);
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
    <Section title="Busy events" summary={`${upcoming.length} upcoming`}>
      <p className="hint" style={{ marginBottom: 12 }}>
        Classes, work shifts, appointments. Overbooked never schedules study time over them.
      </p>
      {upcoming.length > 0 && (
        <div className="rows">
          {visible.map((r) => (
            <div className="row" key={r.id}>
              <span className="what">
                <strong>{r.title}</strong> · {formatDay(Date.parse(r.starts_at))}, {formatClock(Date.parse(r.starts_at))}–
                {formatClock(Date.parse(r.ends_at))}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(r.id)}>
                Remove
              </button>
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

export function SettingsPanel({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [session, setSession] = useState(String(settings.session_minutes));
  const [rest, setRest] = useState(String(settings.break_minutes));
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [synced, setSynced] = useState(settings);

  // Pick up settings loaded from the database after first render
  if (synced !== settings) {
    setSynced(settings);
    setSession(String(settings.session_minutes));
    setRest(String(settings.break_minutes));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const s = Math.round(Number(session));
    const b = Math.round(Number(rest));
    if (!(s >= 25 && s <= 240)) return setErr("Session length must be between 25 and 240 minutes.");
    if (!(b >= 0 && b <= 120)) return setErr("Break must be between 0 and 120 minutes.");
    setErr(null);
    await onSave({ session_minutes: s, break_minutes: b });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Section title="Session settings" summary={`${settings.session_minutes}m / ${settings.break_minutes}m`}>
      <form className="settings-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="set-session">Max session (min)</label>
          <input
            id="set-session"
            className="input"
            type="number"
            min={25}
            max={240}
            step={5}
            value={session}
            onChange={(e) => setSession(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="set-break">Break after (min)</label>
          <input
            id="set-break"
            className="input"
            type="number"
            min={0}
            max={120}
            step={5}
            value={rest}
            onChange={(e) => setRest(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-secondary">
          {saved ? "Saved" : "Save"}
        </button>
      </form>
      <p className="hint" style={{ marginTop: 10 }}>
        Sessions are never shorter than 25 minutes unless less work is left. Changes apply on the next Replan.
      </p>
      {err && (
        <p className="error" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      )}
    </Section>
  );
}

function clockMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
