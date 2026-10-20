"use client";

import { useState } from "react";
import { WEEKDAYS_SHORT, formatClock, formatMinutes, sameDay, startOfWeek } from "@/lib/format";
import type { SessionStatus } from "@/lib/scheduler";
import type { BusyRow, SessionRow, TaskRow } from "@/lib/types";

type Props = {
  now: number;
  sessions: SessionRow[];
  busy: BusyRow[];
  tasks: TaskRow[];
  onUpdate: (id: string, status: SessionStatus, actualMinutes: number | null) => Promise<void>;
};

type Entry =
  | { kind: "session"; start: number; end: number; session: SessionRow; title: string }
  | { kind: "busy"; start: number; end: number; title: string; id: string };

export default function WeekCalendar({ now, sessions, busy, tasks, onUpdate }: Props) {
  const [offset, setOffset] = useState(0);
  const weekStart = startOfWeek(now);
  weekStart.setDate(weekStart.getDate() + offset * 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekEnd = new Date(days[6]);
  weekEnd.setDate(weekEnd.getDate() + 1);

  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const entries: Entry[] = [
    ...sessions.map((s) => ({
      kind: "session" as const,
      start: Date.parse(s.starts_at),
      end: Date.parse(s.ends_at),
      session: s,
      title: titles.get(s.task_id) ?? "Task",
    })),
    ...busy.map((b) => ({
      kind: "busy" as const,
      start: Date.parse(b.starts_at),
      end: Date.parse(b.ends_at),
      title: b.title,
      id: b.id,
    })),
  ]
    .filter((e) => e.start < weekEnd.getTime() && e.start >= weekStart.getTime())
    .sort((a, b) => a.start - b.start);

  const weekMinutes = entries
    .filter((e) => e.kind === "session" && e.session.status !== "missed")
    .reduce((sum, e) => sum + (e.end - e.start) / 60_000, 0);

  const label = `${days[0].toLocaleDateString([], { day: "numeric", month: "short" })} – ${days[6].toLocaleDateString([], {
    day: "numeric",
    month: "short",
  })}`;

  return (
    <section className="card" aria-labelledby="cal-heading">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div>
          <h2 id="cal-heading">Week</h2>
          <span className="sub">{formatMinutes(weekMinutes)} of study this week</span>
        </div>
        <div className="week-nav">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOffset(offset - 1)} aria-label="Previous week">
            ←
          </button>
          <span className="week-label">{label}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOffset(offset + 1)} aria-label="Next week">
            →
          </button>
          {offset !== 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOffset(0)}>
              Today
            </button>
          )}
        </div>
      </div>

      <div className="legend" aria-hidden="true">
        <span>
          <i /> Study
        </span>
        <span>
          <i className="completed" /> Done
        </span>
        <span>
          <i className="missed" /> Missed
        </span>
        <span>
          <i className="busy" /> Busy
        </span>
      </div>

      <div className="week">
        {days.map((day) => {
          const items = entries.filter((e) => sameDay(e.start, day));
          const isToday = sameDay(now, day);
          const dayEnd = new Date(day);
          dayEnd.setDate(dayEnd.getDate() + 1);
          const isPast = !isToday && dayEnd.getTime() <= now;
          const load = items
            .filter((e) => e.kind === "session" && e.session.status !== "missed")
            .reduce((sum, e) => sum + (e.end - e.start) / 60_000, 0);
          return (
            <div className={`day${isToday ? " today" : ""}${isPast ? " past" : ""}`} key={day.toISOString()}>
              <div className="day-head">
                <span className="dow">{isToday ? "Today" : WEEKDAYS_SHORT[day.getDay()]}</span>
                <span className="date">{day.getDate()}</span>
                {load > 0 && <span className="load">{formatMinutes(load)}</span>}
              </div>
              {items.length === 0 ? (
                <p className="none">Nothing planned</p>
              ) : (
                <div className="events">
                  {items.map((e) =>
                    e.kind === "busy" ? (
                      <div className="event busy" key={e.id}>
                        <div className="time">
                          {formatClock(e.start)}–{formatClock(e.end)}
                        </div>
                        <div className="name">{e.title}</div>
                      </div>
                    ) : (
                      <SessionCard key={e.session.id} entry={e} now={now} onUpdate={onUpdate} />
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SessionCard({
  entry,
  now,
  onUpdate,
}: {
  entry: Extract<Entry, { kind: "session" }>;
  now: number;
  onUpdate: Props["onUpdate"];
}) {
  const { session, start, end, title } = entry;
  const planned = Math.round((end - start) / 60_000);
  const [logging, setLogging] = useState(false);
  const [minutes, setMinutes] = useState(String(session.actual_minutes ?? planned));
  const [busy, setBusy] = useState(false);
  const overdue = session.status === "planned" && end <= now;

  async function act(status: SessionStatus, actual: number | null) {
    setBusy(true);
    await onUpdate(session.id, status, actual);
    setBusy(false);
    setLogging(false);
  }

  async function saveLog(e: React.FormEvent) {
    e.preventDefault();
    const value = Math.round(Number(minutes));
    if (!(value >= 0 && value <= 1440)) return;
    await act("completed", value);
  }

  let state = "";
  if (session.status === "completed") state = `Done · ${formatMinutes(session.actual_minutes ?? planned)} actual`;
  else if (session.status === "missed") state = "Missed";
  else if (overdue) state = "Did you do this?";
  else state = formatMinutes(planned);

  return (
    <div className={`event ${session.status}`}>
      <div className="time">
        {formatClock(start)}–{formatClock(end)}
      </div>
      <div className="name">{title}</div>
      <div className="state">{state}</div>

      {logging ? (
        <form className="log-form" onSubmit={saveLog}>
          <label className="sr-only" htmlFor={`log-${session.id}`}>
            Actual minutes spent
          </label>
          <input
            id={`log-${session.id}`}
            className="input"
            type="number"
            min={0}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            autoFocus
          />
          <span className="hint">min</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save
          </button>
        </form>
      ) : (
        <div className="actions">
          {session.status !== "completed" && (
            <button type="button" className="btn btn-secondary" onClick={() => setLogging(true)} disabled={busy}>
              Done
            </button>
          )}
          {session.status === "planned" && (
            <button type="button" className="btn btn-ghost" onClick={() => act("missed", null)} disabled={busy}>
              Missed
            </button>
          )}
          {session.status === "completed" && (
            <button type="button" className="btn btn-ghost" onClick={() => setLogging(true)} disabled={busy}>
              Edit time
            </button>
          )}
          {session.status !== "planned" && (
            <button type="button" className="btn btn-ghost" onClick={() => act("planned", null)} disabled={busy}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
