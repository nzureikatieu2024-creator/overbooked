"use client";

import { useState } from "react";
import { DIFFICULTY, formatDeadline, formatMinutes } from "@/lib/format";
import { FACTOR_MIN_SAMPLES, SHORT_FINAL_MINUTES, deadlineEnd, suggestEstimate, type FactorInfo } from "@/lib/scheduler";
import { isArchived, type TaskRow, type TaskStats } from "@/lib/types";

export type NewTask = {
  title: string;
  deadline: string;
  estimatedHours: number;
  difficulty: number;
};

const DEFAULT_HOURS = "2";
const DEFAULT_DIFFICULTY = "2";

type Props = {
  tasks: TaskRow[];
  stats: Map<string, TaskStats>;
  loaded: boolean;
  onAdd: (task: NewTask) => Promise<boolean>;
  onToggle: (task: TaskRow) => void;
  onDelete: (task: TaskRow) => void;
  onArchive?: (task: TaskRow, archive: boolean) => void; // only after migration 002
  onArchiveDone?: () => void;
  factor: FactorInfo;
  byDifficulty: Record<number, FactorInfo>;
};

export default function TaskPanel({
  tasks,
  stats,
  loaded,
  onAdd,
  onToggle,
  onDelete,
  onArchive,
  onArchiveDone,
  factor,
  byDifficulty,
}: Props) {
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [difficulty, setDifficulty] = useState(DEFAULT_DIFFICULTY);
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The estimate the user typed before accepting a suggestion; null = their own value is in the field
  const [ownHours, setOwnHours] = useState<string | null>(null);

  const typedHours = Number(ownHours ?? hours);
  const suggestion = ownHours === null ? suggestEstimate(typedHours, Number(difficulty), byDifficulty, factor) : null;
  const diffInfo = byDifficulty[Number(difficulty)];
  const diffLabel = (DIFFICULTY[Number(difficulty)] ?? "Medium").toLowerCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) {
      setFormError("Give the task a title.");
      return;
    }
    // Any invalid optional value falls back to its default, so a title alone always saves.
    const parsedHours = Number(hours);
    const estimatedHours = parsedHours > 0 && parsedHours <= 200 ? Math.round(parsedHours * 4) / 4 : 2;
    setFormError(null);
    setSaving(true);
    const ok = await onAdd({ title: clean, deadline, estimatedHours, difficulty: Number(difficulty) || 2 });
    setSaving(false);
    if (ok) {
      setAdded(clean);
      setTimeout(() => setAdded((a) => (a === clean ? null : a)), 3000);
      setTitle("");
      setDeadline("");
      setHours(DEFAULT_HOURS);
      setDifficulty(DEFAULT_DIFFICULTY);
      setOwnHours(null);
    }
  }

  const archived = tasks.filter(isArchived);
  const current = tasks.filter((t) => !isArchived(t));
  const doneCount = current.filter((t) => t.status === "done").length;
  const sorted = [...current].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    const da = a.deadline ? deadlineEnd(a.deadline) : Infinity;
    const db = b.deadline ? deadlineEnd(b.deadline) : Infinity;
    if (da !== db) return da - db;
    return b.created_at.localeCompare(a.created_at);
  });

  return (
    <section className="card" aria-labelledby="tasks-heading">
      <div className="card-head">
        <h2 id="tasks-heading">Tasks</h2>
        <span className="sub">{current.filter((t) => t.status === "active").length} open</span>
      </div>

      <form className="task-form" onSubmit={submit}>
        <div className="main-row">
          <label htmlFor="task-title" className="sr-only">
            Task title
          </label>
          <input
            id="task-title"
            className="input"
            type="text"
            placeholder="e.g. Statistics problem set 3"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            data-testid="core-input"
          />
          <button type="submit" className="btn btn-primary" disabled={saving} data-testid="core-submit">
            {saving ? "Adding…" : "Add task"}
          </button>
        </div>
        <div className="meta-row">
          <div className="field">
            <label htmlFor="task-deadline">Deadline (optional)</label>
            <input
              id="task-deadline"
              className="input"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="task-hours">Estimate (hours)</label>
            <input
              id="task-hours"
              className="input"
              type="number"
              min={0.25}
              max={200}
              step={0.25}
              value={hours}
              onChange={(e) => {
                setHours(e.target.value);
                setOwnHours(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="task-difficulty">Difficulty</label>
            <select
              id="task-difficulty"
              className="input"
              value={difficulty}
              onChange={(e) => {
                setDifficulty(e.target.value);
                if (ownHours !== null) setHours(ownHours);
                setOwnHours(null);
              }}
            >
              <option value="1">Easy</option>
              <option value="2">Medium</option>
              <option value="3">Hard</option>
            </select>
          </div>
        </div>
        {ownHours !== null ? (
          <p className="suggest">
            <span>
              Using the suggested <strong>{hours}h</strong> (you entered {ownHours}h).
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setHours(ownHours);
                setOwnHours(null);
              }}
            >
              Undo
            </button>
          </p>
        ) : suggestion ? (
          <p className="suggest">
            <span>
              <strong>Suggestion: {suggestion.hours}h.</strong> Your {diffLabel} tasks took ×
              {suggestion.difficultyFactor.toFixed(2)} their planned time ({suggestion.samples} sessions). Plans already
              apply your overall ×{suggestion.overallFactor.toFixed(2)}, so {typedHours}h × {suggestion.difficultyFactor.toFixed(2)} ÷{" "}
              {suggestion.overallFactor.toFixed(2)} ≈ {suggestion.hours}h.
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setOwnHours(hours);
                setHours(String(suggestion.hours));
              }}
            >
              Use {suggestion.hours}h
            </button>
          </p>
        ) : (
          diffInfo &&
          !diffInfo.active && (
            <p className="hint">
              After {FACTOR_MIN_SAMPLES} completed sessions on {diffLabel} tasks ({diffInfo.samples} so far), Overbooked can
              suggest an estimate based on how long they really take you.
            </p>
          )
        )}
        <p className="saved" role="status" aria-live="polite">
          {added ? `Added “${added}”. Click Replan to schedule it.` : ""}
        </p>
        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
      </form>

      <div style={{ marginTop: 18 }}>
        {!loaded ? (
          <p className="empty">Loading your tasks…</p>
        ) : sorted.length === 0 ? (
          <p className="empty">
            {archived.length
              ? "No current tasks. Add an assignment or exam above, or restore one from the archive."
              : "No tasks yet. Add your first assignment or exam above."}
          </p>
        ) : (
          <ul className="task-list">
            {sorted.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                stats={stats.get(task.id)}
                onToggle={() => onToggle(task)}
                onDelete={() => onDelete(task)}
                onArchive={onArchive ? () => onArchive(task, true) : undefined}
              />
            ))}
          </ul>
        )}

        {onArchiveDone && doneCount > 1 && (
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={onArchiveDone}>
            Archive {doneCount} done tasks
          </button>
        )}

        {archived.length > 0 && (
          <details className="archived">
            <summary>
              Archived ({archived.length}) <span className="hint">· hidden and not planned; history kept</span>
            </summary>
            <ul className="task-list">
              {archived.map((task) => (
                <li className="task-item archived-item" data-testid="core-item" key={task.id}>
                  <span className="archived-dot" aria-hidden="true" />
                  <div style={{ minWidth: 0 }}>
                    <div className="task-title">{task.title}</div>
                    <div className="task-meta">
                      <span>{task.deadline ? `Due ${formatDeadline(task.deadline)}` : "No deadline"}</span>
                      <span>{task.status === "done" ? "Done" : "Not finished"}</span>
                    </div>
                  </div>
                  <div className="task-actions row-actions">
                    {onArchive && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onArchive(task, false)}>
                        Restore
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onDelete(task)} aria-label={`Delete “${task.title}”`}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function TaskItem({
  task,
  stats,
  onToggle,
  onDelete,
  onArchive,
}: {
  task: TaskRow;
  stats?: TaskStats;
  onToggle: () => void;
  onDelete: () => void;
  onArchive?: () => void;
}) {
  const done = task.status === "done";
  const total = stats ? stats.logged + stats.remaining : 0;
  const progress = done ? 100 : total > 0 && stats ? Math.round((stats.logged / total) * 100) : 0;

  let badge: React.ReactNode = null;
  if (done) badge = <span className="badge badge-ok">Done</span>;
  else if (stats && stats.remaining === 0) badge = <span className="badge badge-ok">Time covered</span>;
  else if (stats && stats.remaining < SHORT_FINAL_MINUTES)
    badge = (
      <span className="badge badge-neutral" title="Too short for a study session. Finish it in a spare moment, then mark it done.">
        {formatMinutes(stats.remaining)} left · too short to plan
      </span>
    );
  else if (stats && stats.unscheduled > 0 && stats.plannedAhead === 0)
    badge = <span className="badge badge-neutral">Not planned yet</span>;
  else if (stats && stats.unscheduled > 0)
    badge = <span className="badge badge-danger">{formatMinutes(stats.unscheduled)} doesn&apos;t fit</span>;
  else if (stats) badge = <span className="badge badge-ok">Fully planned</span>;

  return (
    <li className={`task-item${done ? " done" : ""}`} data-testid="core-item">
      <input
        type="checkbox"
        className="check"
        checked={done}
        onChange={onToggle}
        aria-label={done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`}
      />
      <div style={{ minWidth: 0 }}>
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <span>{task.deadline ? `Due ${formatDeadline(task.deadline)}` : "No deadline"}</span>
          <span>{Number(task.estimated_hours)}h estimate</span>
          <span>{DIFFICULTY[task.difficulty] ?? "Medium"}</span>
          {stats && !done && stats.logged > 0 && <span>{formatMinutes(stats.logged)} logged</span>}
          {stats && !done && stats.overdue > 0 && <span>{stats.overdue} to mark</span>}
        </div>
        {!done && (
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="task-actions">
        {badge}
        <div className="row-actions">
          {onArchive && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive} aria-label={`Archive “${task.title}”`}>
              Archive
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} aria-label={`Delete “${task.title}”`}>
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}
