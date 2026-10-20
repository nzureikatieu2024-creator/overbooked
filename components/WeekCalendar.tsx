"use client";

import { useState } from "react";
import { WEEKDAYS_SHORT, formatClock, formatDay, formatMinutes, isAllDay, sameDay, startOfWeek } from "@/lib/format";
import type { SessionStatus } from "@/lib/scheduler";
import { isBlocking, type AvailabilityRow, type BusyRow, type SessionRow, type TaskRow } from "@/lib/types";

type Props = {
  now: number;
  sessions: SessionRow[];
  busy: BusyRow[];
  tasks: TaskRow[];
  availability: AvailabilityRow[];
  minSessionMinutes: number;
  onUpdate: (id: string, status: SessionStatus, actualMinutes: number | null) => Promise<void>;
  onSetBlocking?: (id: string, blocking: boolean) => void;
};

type Entry =
  | { kind: "session"; id: string; start: number; end: number; title: string; session: SessionRow }
  | { kind: "busy"; id: string; start: number; end: number; title: string; event: BusyRow; allDay: boolean };

type Placed = Entry & { lane: number; lanes: number };

const HOUR_PX = 44;
const MIN_EVENT_PX = 22;
const DAY_MS = 24 * 3600_000;

export default function WeekCalendar({ now, sessions, busy, tasks, availability, minSessionMinutes, onUpdate, onSetBlocking }: Props) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const weekStart = startOfWeek(now);
  weekStart.setDate(weekStart.getDate() + offset * 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekEnd = new Date(days[6]);
  weekEnd.setDate(weekEnd.getDate() + 1);
  const ws = weekStart.getTime();
  const we = weekEnd.getTime();

  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const entries: Entry[] = [
    ...sessions.map((s) => ({
      kind: "session" as const,
      id: `s-${s.id}`,
      start: Date.parse(s.starts_at),
      end: Date.parse(s.ends_at),
      title: titles.get(s.task_id) ?? "Task",
      session: s,
    })),
    ...busy.map((b) => {
      const start = Date.parse(b.starts_at);
      const end = Date.parse(b.ends_at);
      return { kind: "busy" as const, id: `b-${b.id}`, start, end, title: b.title, event: b, allDay: isAllDay(start, end) };
    }),
  ]
    .filter((e) => e.start < we && e.end > ws)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // All-day and multi-day events go in the all-day row instead of filling whole columns
  const isAllDayEntry = (e: Entry) => e.kind === "busy" && (e.allDay || e.end - e.start >= DAY_MS);
  const blockingBusy = busy.filter(isBlocking);
  const conflictOf = (e: Entry) =>
    e.kind === "session" &&
    e.session.status === "planned" &&
    e.end > now &&
    blockingBusy.some((b) => Date.parse(b.starts_at) < e.end && e.start < Date.parse(b.ends_at));

  const dayData = days.map((day) => {
    const start = day.getTime();
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const end = next.getTime();
    const own = entries.filter((e) => e.start < end && e.end > start);
    return {
      day,
      start,
      end,
      allDay: own.filter(isAllDayEntry),
      // Timed events are clipped to the day, so events crossing midnight show on both days
      timed: layoutLanes(own.filter((e) => !isAllDayEntry(e)).map((e) => ({ ...e, start: Math.max(e.start, start), end: Math.min(e.end, end) }))),
      isToday: sameDay(now, day),
      isPast: end <= now,
      windows: availability.filter((a) => a.weekday === day.getDay()),
    };
  });
  const hasAllDay = dayData.some((d) => d.allDay.length > 0);

  // Visible hours: preferred study hours and every timed event this week, at least 08:00–20:00
  let firstHour = 8;
  let lastHour = 20;
  for (const a of availability) {
    firstHour = Math.min(firstHour, Math.floor(clockHours(a.start_time)));
    lastHour = Math.max(lastHour, Math.ceil(clockHours(a.end_time)));
  }
  for (const d of dayData) {
    for (const e of d.timed) {
      firstHour = Math.min(firstHour, Math.floor((e.start - d.start) / 3600_000));
      lastHour = Math.max(lastHour, Math.ceil((e.end - d.start) / 3600_000));
    }
  }
  firstHour = Math.max(0, firstHour);
  lastHour = Math.min(24, lastHour);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);

  const weekStudy = entries
    .filter((e) => e.kind === "session" && e.session.status !== "missed")
    .reduce((sum, e) => sum + (e.end - e.start) / 60_000, 0);
  const weekBusy = entries
    .filter((e) => e.kind === "busy" && isBlocking(e.event) && !isAllDayEntry(e))
    .reduce((sum, e) => sum + (Math.min(e.end, we) - Math.max(e.start, ws)) / 60_000, 0);

  const label = `${days[0].toLocaleDateString([], { day: "numeric", month: "short" })} – ${days[6].toLocaleDateString([], {
    day: "numeric",
    month: "short",
  })}`;

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const select = (id: string) => setSelectedId((cur) => (cur === id ? null : id));
  const details = (e: Entry, inline?: boolean) => (
    <EventDetails
      entry={e}
      now={now}
      minSession={minSessionMinutes}
      conflict={conflictOf(e)}
      onUpdate={onUpdate}
      onSetBlocking={onSetBlocking}
      onClose={() => setSelectedId(null)}
      inline={inline}
    />
  );

  return (
    <section className="card cal" aria-labelledby="cal-heading">
      <div className="card-head cal-head">
        <div>
          <h2 id="cal-heading">Week</h2>
          <span className="sub">
            {formatMinutes(weekStudy)} study · {formatMinutes(weekBusy)} busy
          </span>
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
              This week
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
        <span>
          <i className="info" /> Info only
        </span>
        <span>
          <i className="avail" /> Study hours
        </span>
      </div>

      {/* Wide screens: time grid */}
      <div className="tg" aria-label={`Week of ${label}`}>
        <div className="tg-row tg-heads">
          <div className="tg-gutter" />
          {dayData.map((d) => (
            <div key={d.start} className={`tg-dayhead${d.isToday ? " today" : ""}${d.isPast ? " past" : ""}`}>
              <span className="dow">{d.isToday ? "Today" : WEEKDAYS_SHORT[d.day.getDay()]}</span>
              <span className="date">{d.day.getDate()}</span>
            </div>
          ))}
        </div>

        {hasAllDay && (
          <div className="tg-row tg-allday">
            <div className="tg-gutter tg-label">All day</div>
            {dayData.map((d) => (
              <div key={d.start} className="tg-allday-cell">
                {d.allDay.map((e) => (
                  <EventChip key={e.id} entry={e} selected={selectedId === e.id} onSelect={select} />
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="tg-row tg-body" style={{ height: hours.length * HOUR_PX }}>
          <div className="tg-gutter tg-hours" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} style={{ top: (h - firstHour) * HOUR_PX }}>
                {String(h).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          {dayData.map((d) => (
            <div key={d.start} className={`tg-col${d.isToday ? " today" : ""}${d.isPast ? " past" : ""}`}>
              {d.windows.map((w, i) => (
                <div
                  key={i}
                  className="tg-avail"
                  style={{ top: (clockHours(w.start_time) - firstHour) * HOUR_PX, height: (clockHours(w.end_time) - clockHours(w.start_time)) * HOUR_PX }}
                  aria-hidden="true"
                />
              ))}
              {hours.map((h) => (
                <div key={h} className="tg-line" style={{ top: (h - firstHour) * HOUR_PX }} aria-hidden="true" />
              ))}
              {d.timed.map((e) => (
                <EventBlock
                  key={e.id}
                  entry={e}
                  now={now}
                  minSession={minSessionMinutes}
                  conflict={conflictOf(e)}
                  selected={selectedId === e.id}
                  onSelect={select}
                  top={((e.start - d.start) / 3600_000 - firstHour) * HOUR_PX}
                  height={Math.max(MIN_EVENT_PX, ((e.end - e.start) / 3600_000) * HOUR_PX - 2)}
                />
              ))}
              {d.isToday && now >= d.start + firstHour * 3600_000 && now <= d.start + lastHour * 3600_000 && (
                <div className="tg-now" style={{ top: ((now - d.start) / 3600_000 - firstHour) * HOUR_PX }} aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Narrow screens: compact day agenda */}
      <ol className="agenda" aria-label={`Week of ${label}`}>
        {dayData.map((d) => {
          const items: Entry[] = [...d.allDay, ...d.timed];
          return (
            <li key={d.start} className={`ag-day${d.isToday ? " today" : ""}${d.isPast ? " past" : ""}${items.length ? "" : " empty"}`}>
              <div className="ag-date">
                <span className="dow">{d.isToday ? "Today" : WEEKDAYS_SHORT[d.day.getDay()]}</span>
                <span className="date">{d.day.getDate()}</span>
              </div>
              {items.length === 0 ? (
                <span className="ag-none">{d.isPast ? "—" : "Nothing planned"}</span>
              ) : (
                <ul className="ag-items">
                  {items.map((e) => (
                    <li key={e.id}>
                      <AgendaRow
                        entry={e}
                        now={now}
                        minSession={minSessionMinutes}
                        conflict={conflictOf(e)}
                        allDay={isAllDayEntry(e)}
                        selected={selectedId === e.id}
                        onSelect={select}
                      />
                      {selectedId === e.id && details(e, true)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {selected ? (
        <div className="tg-details">{details(selected)}</div>
      ) : (
        entries.length > 0 && <p className="hint tg-tip">Select an event to see its details, mark a session done or change whether it blocks study time.</p>
      )}
    </section>
  );
}

// ── Pieces ────────────────────────────────────────

function clockHours(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h + m / 60;
}

/** Side-by-side lanes for overlapping events within one day. */
function layoutLanes(list: Entry[]): Placed[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const e of sorted) {
    if (e.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane === -1) lane = laneEnds.push(e.end) - 1;
    else laneEnds[lane] = e.end;
    cluster.push({ ...e, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return out;
}

function classOf(e: Entry, now: number, conflict: boolean): string {
  if (e.kind === "busy") return isBlocking(e.event) ? "busy" : "info";
  const s = e.session;
  const live = s.status === "planned" && Date.parse(s.starts_at) <= now && Date.parse(s.ends_at) > now;
  return `${s.status}${live ? " live" : ""}${conflict ? " clash" : ""}`;
}

function plannedMinutes(s: SessionRow): number {
  return Math.round((Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 60_000);
}

function sessionState(s: SessionRow, now: number, minSession: number, conflict: boolean): string {
  const planned = plannedMinutes(s);
  if (s.status === "completed") return `Done · ${formatMinutes(s.actual_minutes ?? planned)}`;
  if (s.status === "missed") return "Missed";
  if (Date.parse(s.ends_at) <= now) return "Did you do this?";
  if (conflict) return "Overlaps a busy event";
  if (Date.parse(s.starts_at) <= now) return "Now";
  return planned < minSession ? `${formatMinutes(planned)} · short final` : formatMinutes(planned);
}

function EventBlock({
  entry,
  now,
  minSession,
  conflict,
  selected,
  onSelect,
  top,
  height,
}: {
  entry: Placed;
  now: number;
  minSession: number;
  conflict: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  top: number;
  height: number;
}) {
  const tall = height >= 38;
  const timeText = `${formatClock(entry.start)}–${formatClock(entry.end)}`;
  const short = entry.kind === "session" && plannedMinutes(entry.session) < minSession;
  return (
    <button
      type="button"
      className={`tg-event ${classOf(entry, now, conflict)}${selected ? " selected" : ""}${tall ? "" : " compact"}`}
      style={{
        top,
        height,
        left: `calc(${(entry.lane / entry.lanes) * 100}% + 2px)`,
        width: `calc(${100 / entry.lanes}% - 4px)`,
      }}
      onClick={() => onSelect(entry.id)}
      aria-pressed={selected}
      title={`${entry.title} · ${timeText}`}
    >
      <span className="tg-title">{entry.title}</span>
      {tall ? <span className="tg-time">{timeText}{short ? " · short" : ""}</span> : <span className="sr-only">{timeText}</span>}
    </button>
  );
}

function EventChip({ entry, selected, onSelect }: { entry: Entry; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className={`tg-chip ${classOf(entry, 0, false)}${selected ? " selected" : ""}`}
      onClick={() => onSelect(entry.id)}
      aria-pressed={selected}
      title={entry.title}
    >
      {entry.title}
    </button>
  );
}

function AgendaRow({
  entry,
  now,
  minSession,
  conflict,
  allDay,
  selected,
  onSelect,
}: {
  entry: Entry;
  now: number;
  minSession: number;
  conflict: boolean;
  allDay: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const state =
    entry.kind === "session" ? sessionState(entry.session, now, minSession, conflict) : isBlocking(entry.event) ? "Busy" : "Info";
  return (
    <button
      type="button"
      className={`ag-row ${classOf(entry, now, conflict)}${selected ? " selected" : ""}`}
      onClick={() => onSelect(entry.id)}
      aria-expanded={selected}
    >
      <span className="ag-time">{allDay ? "All day" : formatClock(entry.start)}</span>
      <span className="ag-title">{entry.title}</span>
      <span className="ag-state">{state}</span>
    </button>
  );
}

function EventDetails({
  entry,
  now,
  minSession,
  conflict,
  onUpdate,
  onSetBlocking,
  onClose,
  inline,
}: {
  entry: Entry;
  now: number;
  minSession: number;
  conflict: boolean;
  onUpdate: Props["onUpdate"];
  onSetBlocking?: Props["onSetBlocking"];
  onClose: () => void;
  inline?: boolean;
}) {
  // Use the full event times, not the per-day clipped ones
  const start = entry.kind === "session" ? Date.parse(entry.session.starts_at) : Date.parse(entry.event.starts_at);
  const end = entry.kind === "session" ? Date.parse(entry.session.ends_at) : Date.parse(entry.event.ends_at);
  const allDay = entry.kind === "busy" && entry.allDay;
  const when = allDay
    ? `${formatDay(start)}${end - start > DAY_MS ? ` – ${formatDay(end - 1)}` : ""} · all day`
    : `${formatDay(start)} · ${formatClock(start)}–${formatClock(end)} (${formatMinutes((end - start) / 60_000)})`;

  return (
    <div className={`details${inline ? " inline" : ""}`} role="region" aria-label={`Details: ${entry.title}`}>
      <div className="details-head">
        <div style={{ minWidth: 0 }}>
          <span className="details-kind">
            {entry.kind === "session" ? "Study session" : isBlocking(entry.event) ? "Busy event" : "For information"}
          </span>
          <h3 className="details-title">{entry.title}</h3>
          <p className="hint">{when}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      {entry.kind === "session" ? (
        <SessionActions key={entry.session.id} session={entry.session} now={now} minSession={minSession} conflict={conflict} onUpdate={onUpdate} />
      ) : (
        <div className="details-body">
          <p className="hint">
            {isBlocking(entry.event)
              ? "No study time is planned during this event, or during your transition buffer after it."
              : "Shown for information only. Study sessions can be planned during it."}
          </p>
          {onSetBlocking && (
            <label className="check-line">
              <input
                type="checkbox"
                className="check"
                checked={isBlocking(entry.event)}
                onChange={(e) => onSetBlocking(entry.event.id, e.target.checked)}
              />
              <span>Blocks study time</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function SessionActions({
  session,
  now,
  minSession,
  conflict,
  onUpdate,
}: {
  session: SessionRow;
  now: number;
  minSession: number;
  conflict: boolean;
  onUpdate: Props["onUpdate"];
}) {
  const planned = plannedMinutes(session);
  const [logging, setLogging] = useState(false);
  const [minutes, setMinutes] = useState(String(session.actual_minutes ?? planned));
  const [busy, setBusy] = useState(false);
  const [logError, setLogError] = useState(false);

  async function act(status: SessionStatus, actual: number | null) {
    setBusy(true);
    await onUpdate(session.id, status, actual);
    setBusy(false);
    setLogging(false);
  }

  async function saveLog(e: React.FormEvent) {
    e.preventDefault();
    const value = Math.round(Number(minutes));
    if (!(value >= 0 && value <= 1440)) return setLogError(true);
    setLogError(false);
    await act("completed", value);
  }

  return (
    <div className="details-body">
      <p className="state-line">{sessionState(session, now, minSession, conflict)}</p>
      {planned < minSession && session.status === "planned" && (
        <p className="hint">Short final session: only {formatMinutes(planned)} of work was left for this task.</p>
      )}
      {conflict && <p className="hint">A busy event now overlaps this session. Click Replan to move it.</p>}
      {logging ? (
        <form className="log-form" onSubmit={saveLog}>
          <label htmlFor={`log-${session.id}`}>Minutes actually spent</label>
          <input
            id={`log-${session.id}`}
            className="input"
            type="number"
            min={0}
            max={1440}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-invalid={logError || undefined}
            autoFocus
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save
          </button>
          {logError && (
            <span className="log-error" role="alert">
              Enter 0–1440 minutes
            </span>
          )}
        </form>
      ) : (
        <div className="actions">
          {session.status !== "completed" && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLogging(true)} disabled={busy}>
              Done
            </button>
          )}
          {session.status === "planned" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => act("missed", null)} disabled={busy}>
              Missed
            </button>
          )}
          {session.status === "completed" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLogging(true)} disabled={busy}>
              Edit time
            </button>
          )}
          {session.status !== "planned" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => act("planned", null)} disabled={busy}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
