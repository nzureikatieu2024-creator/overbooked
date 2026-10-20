import { formatClock, formatDeadline, formatMinutes, sameDay, todayISO } from "@/lib/format";
import type { BusyRow, SessionRow, TaskRow, TaskStats } from "@/lib/types";

type Props = {
  now: number;
  sessions: SessionRow[];
  busy: BusyRow[];
  tasks: TaskRow[];
  stats: Map<string, TaskStats>;
};

type Item =
  | { kind: "session"; start: number; end: number; title: string; session: SessionRow }
  | { kind: "busy"; start: number; end: number; title: string; id: string };

const DAY = 24 * 3600_000;

export default function Today({ now, sessions, busy, tasks, stats }: Props) {
  const today = new Date(now);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));

  const items: Item[] = [
    ...sessions
      .filter((s) => sameDay(Date.parse(s.starts_at), today))
      .map((s) => ({
        kind: "session" as const,
        start: Date.parse(s.starts_at),
        end: Date.parse(s.ends_at),
        title: titles.get(s.task_id) ?? "Task",
        session: s,
      })),
    ...busy
      .filter((b) => sameDay(Date.parse(b.starts_at), today) || (Date.parse(b.starts_at) < now && Date.parse(b.ends_at) > now))
      .map((b) => ({ kind: "busy" as const, start: Date.parse(b.starts_at), end: Date.parse(b.ends_at), title: b.title, id: b.id })),
  ].sort((a, b) => a.start - b.start);

  const studyToday = items.filter((i): i is Extract<Item, { kind: "session" }> => i.kind === "session");
  const leftMinutes = studyToday
    .filter((i) => i.session.status === "planned" && i.end > now)
    .reduce((sum, i) => sum + (i.end - Math.max(i.start, now)) / 60_000, 0);
  const doneMinutes = studyToday
    .filter((i) => i.session.status === "completed")
    .reduce((sum, i) => sum + (i.session.actual_minutes ?? (i.end - i.start) / 60_000), 0);
  const nextUp = studyToday.find((i) => i.session.status === "planned" && i.end > now);

  const iso = todayISO();
  const deadlines = tasks
    .filter((t) => t.status === "active" && t.deadline)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!))
    .filter((t) => t.deadline! >= iso || (stats.get(t.id)?.remaining ?? 0) > 0)
    .slice(0, 4);

  const hasTasks = tasks.some((t) => t.status === "active");
  const hasPlan = sessions.length > 0;

  return (
    <section className="today" aria-labelledby="today-heading">
      <div className="today-head">
        <div>
          <span className="eyebrow-sm">Today</span>
          <h2 id="today-heading">{today.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</h2>
        </div>
        <div className="today-stats">
          <div className="stat">
            <div className="v">{formatMinutes(leftMinutes)}</div>
            <div className="k">study left today</div>
          </div>
          <div className="stat">
            <div className="v">{formatMinutes(doneMinutes)}</div>
            <div className="k">done today</div>
          </div>
          <div className="stat">
            <div className="v">{nextUp ? formatClock(Math.max(nextUp.start, now)) : "—"}</div>
            <div className="k">{nextUp ? (nextUp.start <= now ? "in progress" : "next session") : "no more sessions"}</div>
          </div>
        </div>
      </div>

      <div className="today-grid">
        <div>
          <h3 className="today-sub">Schedule</h3>
          {items.length === 0 ? (
            <p className="empty">
              {!hasTasks
                ? "Nothing today yet. Add a task below and click Auto-Plan to get study sessions."
                : !hasPlan
                  ? "No study sessions yet. Click Auto-Plan to schedule your tasks."
                  : "Nothing scheduled today. Enjoy the break, or add availability to study more."}
            </p>
          ) : (
            <ol className="timeline">
              {items.map((i) => {
                const live = i.start <= now && i.end > now;
                const past = i.end <= now;
                let state = "";
                if (i.kind === "busy") state = "Busy";
                else if (i.session.status === "completed") state = "Done";
                else if (i.session.status === "missed") state = "Missed";
                else if (live) state = "Now";
                else if (past) state = "To mark";
                else state = formatMinutes((i.end - i.start) / 60_000);
                const cls = i.kind === "busy" ? "busy" : i.session.status;
                return (
                  <li key={i.kind === "busy" ? i.id : i.session.id} className={`tl-item ${cls}${live ? " live" : ""}${past ? " past" : ""}`}>
                    <span className="tl-time">
                      {formatClock(i.start)}
                      <span className="tl-end">{formatClock(i.end)}</span>
                    </span>
                    <span className="tl-dot" aria-hidden="true" />
                    <span className="tl-title">{i.title}</span>
                    <span className="tl-state">{state}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div>
          <h3 className="today-sub">Nearest deadlines</h3>
          {deadlines.length === 0 ? (
            <p className="empty">{hasTasks ? "No deadlines set on your open tasks." : "No deadlines yet."}</p>
          ) : (
            <ul className="deadlines">
              {deadlines.map((t) => {
                const s = stats.get(t.id);
                const days = Math.round((localDay(t.deadline!) - localDay(iso)) / DAY);
                const when = days < 0 ? "Overdue" : days === 0 ? "Today" : days === 1 ? "Tomorrow" : `In ${days} days`;
                const tone = days < 0 ? "danger" : days <= 1 ? "warn" : "neutral";
                return (
                  <li key={t.id} className="deadline">
                    <div className="deadline-main">
                      <span className="deadline-title">{t.title}</span>
                      <span className="hint">
                        {formatDeadline(t.deadline!)}
                        {s && s.remaining > 0 ? ` · ${formatMinutes(s.remaining)} left` : " · time covered"}
                        {s && s.unscheduled > 0 && s.plannedAhead > 0 ? ` · ${formatMinutes(s.unscheduled)} doesn't fit` : ""}
                      </span>
                    </div>
                    <span className={`badge badge-${tone}`}>{when}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function localDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
