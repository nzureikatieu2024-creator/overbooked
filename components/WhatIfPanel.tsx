"use client";

import { useMemo, useState } from "react";
import { formatClock, formatDay, formatDeadline, formatMinutes, localDateTime } from "@/lib/format";
import { buildPlanInput, type PlanData } from "@/lib/plan-input";
import { estimateWithExtra, simulate, type Change, type SimulationResult } from "@/lib/whatif";

type Props = {
  data: PlanData;
  now: number;
  planning: boolean;
  onApply: (changes: Change[]) => Promise<boolean>;
};

type Kind = Change["kind"];

function tomorrowISO(now: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function WhatIfPanel({ data, now, planning, onApply }: Props) {
  const openTasks = data.tasks.filter((t) => t.status === "active");
  const [changes, setChanges] = useState<Change[]>([]);
  const [kind, setKind] = useState<Kind>("lose_time");
  const [date, setDate] = useState(() => tomorrowISO(now));
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("17:00");
  const [end, setEnd] = useState("20:00");
  const [taskId, setTaskId] = useState("");
  const [hours, setHours] = useState("2");
  const [err, setErr] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const titles = new Map(data.tasks.map((t) => [t.id, t.title]));
  // Drop changes for tasks that were deleted or completed meanwhile
  const valid = useMemo(
    () => changes.filter((c) => c.kind === "lose_time" || data.tasks.some((t) => t.id === c.taskId && t.status === "active")),
    [changes, data.tasks],
  );

  // Pure preview: the real planner on a copy of the data. Nothing here writes to the database.
  const factor = useMemo(() => buildPlanInput(data, new Date(now)).input.factor, [data, now]);
  const result = useMemo<SimulationResult | null>(() => {
    if (valid.length === 0) return null;
    try {
      return simulate(buildPlanInput(data, new Date(now)).input, valid);
    } catch {
      return null;
    }
  }, [data, now, valid]);

  function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setApplied(null);
    const id = `${Date.now()}-${changes.length}`;
    if (kind === "lose_time") {
      if (!date) return setErr("Pick a date.");
      if (!allDay && (!start || !end || end <= start)) return setErr("End time must be after start time.");
      if (localDateTime(date, allDay ? "23:59" : end).getTime() <= now) return setErr("Pick a time in the future.");
      setChanges([...changes, { id, kind, date, start, end, allDay }]);
    } else {
      const chosen = taskId || openTasks[0]?.id;
      const h = Number(hours);
      if (!chosen) return setErr("Add a task first.");
      if (!(h > 0 && h <= 100)) return setErr("Enter between 0.25 and 100 extra hours.");
      setChanges([...changes, { id, kind, taskId: chosen, hours: Math.round(h * 4) / 4 }]);
    }
  }

  function describe(c: Change): string {
    if (c.kind === "extra_work") return `“${titles.get(c.taskId) ?? "Task"}” needs ${c.hours}h more`;
    const day = formatDeadline(c.date);
    return c.allDay ? `No study time on ${day}` : `No study time on ${day}, ${c.start}–${c.end}`;
  }

  async function apply() {
    const lines = valid.map((c) => {
      if (c.kind === "lose_time") return `• Add a busy event: ${describe(c).replace("No study time on ", "")}`;
      const t = data.tasks.find((x) => x.id === c.taskId);
      const before = Number(t?.estimated_hours ?? 0);
      return `• Change the estimate of “${t?.title}” from ${before}h to ${estimateWithExtra(before, c.hours, factor)}h`;
    });
    const ok = window.confirm(
      `Apply this scenario to your real plan?\n\n${lines.join("\n")}\n• Replan all upcoming study sessions\n\nYou can undo by removing the busy event or editing the estimate, then replanning.`,
    );
    if (!ok) return;
    setApplying(true);
    const saved = await onApply(valid);
    setApplying(false);
    if (saved) {
      setChanges([]);
      setApplied("Scenario applied and your plan was rebuilt.");
    }
  }

  const impacted = result?.tasks.filter((t) => t.impacted) ?? [];
  const delta = result ? result.unscheduled[1] - result.unscheduled[0] : 0;

  return (
    <section className="card whatif" aria-labelledby="whatif-heading">
      <div className="card-head">
        <div>
          <h2 id="whatif-heading">What if…?</h2>
          <span className="sub">Test a change before it happens. Preview only: nothing is saved unless you apply it.</span>
        </div>
      </div>

      {openTasks.length === 0 ? (
        <p className="empty">Add an open task to see how changes would affect your deadlines.</p>
      ) : (
        <>
          <form className="whatif-form" onSubmit={add}>
            <div className="seg" role="radiogroup" aria-label="Type of change">
              <button type="button" role="radio" aria-checked={kind === "lose_time"} className={kind === "lose_time" ? "on" : ""} onClick={() => setKind("lose_time")}>
                I lose study time
              </button>
              <button type="button" role="radio" aria-checked={kind === "extra_work"} className={kind === "extra_work" ? "on" : ""} onClick={() => setKind("extra_work")}>
                A task takes longer
              </button>
            </div>

            {kind === "lose_time" ? (
              <div className="whatif-fields">
                <div className="field">
                  <label htmlFor="wi-date">Day</label>
                  <input id="wi-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <label className="check-line wi-allday">
                  <input type="checkbox" className="check" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                  <span>Whole day</span>
                </label>
                {!allDay && (
                  <>
                    <div className="field">
                      <label htmlFor="wi-start">From</label>
                      <input id="wi-start" className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="wi-end">To</label>
                      <input id="wi-end" className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="whatif-fields">
                <div className="field" style={{ flex: "2 1 200px" }}>
                  <label htmlFor="wi-task">Task</label>
                  <select id="wi-task" className="input" value={taskId || openTasks[0]?.id} onChange={(e) => setTaskId(e.target.value)}>
                    {openTasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="wi-hours">Extra hours</label>
                  <input id="wi-hours" className="input" type="number" min={0.25} max={100} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} />
                </div>
              </div>
            )}
            <button type="submit" className="btn btn-secondary">
              Add to scenario
            </button>
          </form>

          {err && (
            <p className="error" role="alert" style={{ marginTop: 10 }}>
              {err}
            </p>
          )}

          {valid.length > 0 && (
            <ul className="chips" aria-label="Scenario changes">
              {valid.map((c) => (
                <li key={c.id} className="chip">
                  {describe(c)}
                  <button type="button" aria-label={`Remove: ${describe(c)}`} onClick={() => setChanges(changes.filter((x) => x.id !== c.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {valid.length === 0 && !applied && (
            <p className="hint" style={{ marginTop: 12 }}>
              For example: an extra work shift on Thursday evening, or an essay that turns out to need 3 more hours.
            </p>
          )}

          {result && (
            <div className="whatif-result" aria-live="polite">
              <div className="compare">
                <div className="compare-col">
                  <span className="k">Current plan</span>
                  <span className="v">{formatMinutes(result.unscheduled[0])}</span>
                  <span className="hint">doesn&apos;t fit</span>
                </div>
                <div className="compare-arrow" aria-hidden="true">→</div>
                <div className={`compare-col${delta > 0 ? " worse" : delta < 0 ? " better" : ""}`}>
                  <span className="k">With these changes</span>
                  <span className="v">{formatMinutes(result.unscheduled[1])}</span>
                  <span className="hint">doesn&apos;t fit</span>
                </div>
                <div className="compare-col">
                  <span className="k">Study time lost</span>
                  <span className="v">{formatMinutes(result.lostMinutes)}</span>
                  <span className="hint">of {formatMinutes(result.freeMinutes[0])} free</span>
                </div>
              </div>

              {impacted.length === 0 ? (
                <p className="all-clear">No deadline is affected: every task finishes at the same time as before.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Due</th>
                        <th className="num">Work left</th>
                        <th className="num">Finishes</th>
                        <th className="num">Doesn&apos;t fit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impacted.map((t) => (
                        <tr key={t.taskId}>
                          <td className="title">{t.title}</td>
                          <td>{t.deadline ? formatDeadline(t.deadline) : "—"}</td>
                          <td className="num">{pair(t.needed.map(formatMinutes))}</td>
                          <td className="num">{pair(t.finish.map((f) => (f === null ? "—" : `${formatDay(f)} ${formatClock(f)}`)))}</td>
                          <td className={`num${t.unscheduled[1] > t.unscheduled[0] ? " bad" : ""}`}>{pair(t.unscheduled.map(formatMinutes))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.suggestions.length > 0 && (
                <div className="suggestions">
                  <h3 className="today-sub">Ways to make it fit</h3>
                  <ul>
                    {result.suggestions.map((s, i) => (
                      <li key={i}>
                        {s.kind === "find_time" &&
                          `Find ${formatMinutes(s.minutes)} more study time for “${s.title}”${s.before ? ` before ${formatDeadline(s.before)}` : " in the next 14 days"}, or reduce its scope by that much.`}
                        {s.kind === "extend_deadline" &&
                          `Moving “${s.title}” to ${formatDeadline(s.newDeadline)} (${s.days} day${s.days === 1 ? "" : "s"} later) would make it fit, if that's an option.`}
                        {s.kind === "deadline_passed" &&
                          `“${s.title}” is already past its deadline with ${formatMinutes(s.minutes)} left: update the deadline or mark it done.`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="whatif-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setChanges([])} disabled={applying}>
                  Clear scenario
                </button>
                <button type="button" className="btn btn-secondary" onClick={apply} disabled={applying || planning}>
                  {applying ? "Applying…" : "Apply to my plan…"}
                </button>
              </div>
            </div>
          )}

          {applied && (
            <p className="notice" role="status" style={{ marginTop: 12 }}>
              {applied}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function pair([a, b]: string[]): React.ReactNode {
  if (a === b) return a;
  return (
    <>
      <span className="was">{a}</span> → {b}
    </>
  );
}
