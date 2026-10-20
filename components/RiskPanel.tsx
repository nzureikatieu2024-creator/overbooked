import { formatDeadline, formatMinutes } from "@/lib/format";
import type { Risk, RiskReport } from "@/lib/risk";

type Props = { report: RiskReport; sessionMinutes: number; hasPlan: boolean };

const LABEL: Record<Risk["level"], string> = {
  impossible: "Impossible",
  at_risk: "At risk",
  tight: "Tight",
  unplanned: "Not planned",
};

const TONE: Record<Risk["level"], string> = {
  impossible: "danger",
  at_risk: "danger",
  tight: "warn",
  unplanned: "neutral",
};

export default function RiskPanel({ report, sessionMinutes, hasPlan }: Props) {
  const serious = report.risks.filter((r) => r.level === "impossible" || r.level === "at_risk").length;

  return (
    <section className="card" aria-labelledby="risk-heading">
      <div className="card-head">
        <h2 id="risk-heading">Deadline risk</h2>
        <span className="sub">
          {report.checked === 0
            ? "No deadlines to check"
            : serious > 0
              ? `${serious} of ${report.checked} won't make it`
              : `${report.checked} deadline${report.checked === 1 ? "" : "s"} checked`}
        </span>
      </div>

      {report.checked === 0 ? (
        <p className="empty">Add a deadline to a task and Overbooked will check whether it can be done in time.</p>
      ) : report.risks.length === 0 ? (
        <p className="all-clear">
          Every deadline fits, with at least one {sessionMinutes}-minute session to spare before each.
        </p>
      ) : (
        <ul className="risks">
          {report.risks.map((r) => (
            <li key={r.taskId} className={`risk risk-${r.level}`}>
              <div className="risk-head">
                <span className="risk-title">{r.title}</span>
                <span className={`badge badge-${TONE[r.level]}`}>{LABEL[r.level]}</span>
              </div>
              <p className="risk-why">{explain(r, sessionMinutes, report.noAvailability, hasPlan)}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        Based on your remaining work (estimate × time factor − time logged) and your free study time: weekly availability
        minus busy events, from now until the end of each deadline day.
      </p>
    </section>
  );
}

function explain(r: Risk, sessionMinutes: number, noAvailability: boolean, hasPlan: boolean): string {
  const due = formatDeadline(r.deadline);
  const need = formatMinutes(r.needed);
  const free = formatMinutes(r.free);
  const earlier =
    r.earlierWork > 0
      ? `${formatMinutes(r.earlierWork)} goes first to ${listTitles(r.earlierTitles)}, due earlier`
      : "";

  switch (r.level) {
    case "impossible":
      if (r.passed) {
        return `The deadline (${due}) has passed with ${need} of work left. Move the deadline or mark the task done.`;
      }
      if (noAvailability) return `Needs ${need}, but no weekly study availability is set, so no time can be planned before ${due}.`;
      return `Impossible as things stand: it needs ${need}, but there is only ${free} of free study time before ${due}, even if nothing else were scheduled. You'd need ${formatMinutes(r.needed - r.free)} more study time, a later deadline or a smaller scope.`;
    case "at_risk":
      return `Needs ${need}. You have ${free} free before ${due}${earlier ? `, but ${earlier}` : ", but breaks and minimum session lengths use part of it"}. ${formatMinutes(r.shortfall)} won't fit.`;
    case "tight":
      return r.slack < 0
        ? `It fits, but only because work due earlier can't be fully scheduled: ${need} for this task plus ${formatMinutes(r.earlierWork)} for earlier deadlines is more than the ${free} free before ${due}.`
        : `Fits, with only ${formatMinutes(r.slack)} to spare before ${due} (${need} for this task${r.earlierWork ? ` + ${formatMinutes(r.earlierWork)} due earlier` : ""}, ${free} free). Missing one ${sessionMinutes}-minute session would put it at risk.`;
    case "unplanned":
      return hasPlan
        ? `It fits before ${due}, but ${formatMinutes(r.unplanned)} of its ${need} isn't in your saved plan yet. Click Replan to schedule it.`
        : `It fits before ${due}. Click Auto-Plan to schedule its ${need}.`;
  }
}

function listTitles(titles: string[]): string {
  const quoted = titles.map((t) => `“${t}”`);
  if (quoted.length <= 2) return quoted.join(" and ");
  return `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
}
