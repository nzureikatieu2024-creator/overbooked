import { DIFFICULTY, formatMinutes } from "@/lib/format";
import { FACTOR_MIN_SAMPLES, type FactorInfo } from "@/lib/scheduler";
import type { TaskRow, TaskStats } from "@/lib/types";

type Props = {
  tasks: TaskRow[];
  stats: Map<string, TaskStats>;
  factor: FactorInfo;
  byDifficulty: Record<number, FactorInfo>;
};

export default function Insights({ tasks, stats, factor, byDifficulty }: Props) {
  const rows = tasks.filter((t) => (stats.get(t.id)?.plannedCompleted ?? 0) > 0 || t.status === "active");

  return (
    <section className="card" aria-labelledby="insights-heading">
      <div className="card-head">
        <h2 id="insights-heading">Estimated vs actual</h2>
        <span className="sub">Time factor ×{factor.factor.toFixed(2)}</span>
      </div>

      <div className="formula">
        {factor.active ? (
          <>
            Across your <strong>{factor.samples}</strong> completed sessions you spent{" "}
            <strong>{formatMinutes(factor.actualMinutes)}</strong> on work planned as{" "}
            <strong>{formatMinutes(factor.plannedMinutes)}</strong>. Factor = actual ÷ planned ={" "}
            <strong>{factor.raw.toFixed(2)}</strong>
            {factor.raw !== factor.factor && <> (limited to the 0.50–2.00 range)</>}. New plans schedule{" "}
            <strong>estimate × {factor.factor.toFixed(2)} − time already logged</strong>.
          </>
        ) : (
          <>
            The time factor is <strong>actual ÷ planned minutes</strong> over your completed sessions. It stays at{" "}
            <strong>×1.00</strong> until you have logged {FACTOR_MIN_SAMPLES} completed sessions (
            {factor.samples} so far), then it scales every remaining estimate on your next Replan.
          </>
        )}
      </div>

      <div className="diff-factors" aria-label="Time factor by difficulty">
        {[1, 2, 3].map((d) => {
          const f = byDifficulty[d];
          return (
            <div className="diff-factor" key={d}>
              <span className="k">{DIFFICULTY[d]}</span>
              <span className="v">{f.active ? `×${f.factor.toFixed(2)}` : "—"}</span>
              <span className="hint">
                {f.samples} session{f.samples === 1 ? "" : "s"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ marginBottom: 14 }}>
        Per-difficulty factors use the same actual ÷ planned formula, limited to one difficulty. They never change your
        estimates on their own: when you add a task, Overbooked may suggest an estimate of{" "}
        <strong>your estimate × difficulty factor ÷ overall factor</strong> (the overall factor is already applied when
        planning), and you choose whether to use it.
      </p>

      {rows.length === 0 ? (
        <p className="empty">Complete a few sessions to compare your estimates with reality.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Task</th>
                <th className="num">Estimate</th>
                <th className="num">Adjusted</th>
                <th className="num">Done (planned)</th>
                <th className="num">Done (actual)</th>
                <th className="num">Still needed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const s = stats.get(t.id);
                const estimate = Number(t.estimated_hours) * 60;
                return (
                  <tr key={t.id}>
                    <td className="title">{t.title}</td>
                    <td className="num">{formatMinutes(estimate)}</td>
                    <td className="num">{formatMinutes(estimate * factor.factor)}</td>
                    <td className="num">{formatMinutes(s?.plannedCompleted ?? 0)}</td>
                    <td className="num">{formatMinutes(s?.logged ?? 0)}</td>
                    <td className="num">{t.status === "done" ? "—" : formatMinutes(s?.remaining ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
