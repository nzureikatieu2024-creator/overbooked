import Link from "next/link";

const steps = [
  {
    title: "Add what's due",
    body: "Assignments and exams with a deadline and a rough time estimate. A title is enough to start.",
  },
  {
    title: "Say when you're free",
    body: "Set weekly study hours, then import classes from a Google Calendar or Outlook .ics export, or block time by hand.",
  },
  {
    title: "Get a plan that fits",
    body: "One click books focused, dated study sessions before each deadline. Fall behind? Replan in a click.",
  },
];

const proof = [
  "Never books study time over your classes or shifts",
  "Warns you, with numbers, when a deadline won't fit",
  "Learns how long your tasks really take you",
];

// Illustrative example week shown on the landing page (not user data)
const preview = [
  { day: "Mon", date: 13, items: [{ t: "09:00", n: "Marketing class", busy: true }, { t: "17:00", n: "Stats problem set" }] },
  { day: "Tue", date: 14, items: [{ t: "17:00", n: "Essay draft" }, { t: "18:00", n: "Essay draft" }] },
  { day: "Wed", date: 15, items: [{ t: "10:00", n: "Part-time job", busy: true }, { t: "17:00", n: "Stats problem set" }] },
  { day: "Thu", date: 16, items: [{ t: "17:00", n: "Exam revision" }] },
];

export default function LandingPage() {
  return (
    <div className="container">
      <section className="hero">
        <span className="eyebrow">Automatic study planner for university students</span>
        <h1>Your deadlines, turned into a study plan that actually fits.</h1>
        <p className="lead">
          Overbooked automatically plans your studying around your life — and replans when you fall behind. Not
          another to-do list: a dated calendar of study sessions, built from your deadlines and free time.
        </p>
        <Link href="/signup" className="btn btn-primary btn-lg">
          Sign up free
        </Link>
        <p className="fine">Email and password. No credit card, no setup wizard.</p>
        <ul className="proof">
          {proof.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>

      <section className="preview" aria-label="Example of a planned week">
        <div className="preview-bar">
          <span>Example week</span>
          <span className="preview-risk">
            <span className="badge badge-warn">Tight</span> Essay: 40m to spare before Fri
          </span>
        </div>
        <div className="preview-week">
          {preview.map((d) => (
            <div className="preview-day" key={d.day}>
              <div className="preview-head">
                <span>{d.day}</span>
                <strong>{d.date}</strong>
              </div>
              {d.items.map((i, k) => (
                <div className={`preview-event${i.busy ? " busy" : ""}`} key={k}>
                  <span className="time">{i.t}</span>
                  <span>{i.n}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="features" aria-label="How it works">
        {steps.map((s, i) => (
          <article className="feature" key={s.title}>
            <div className="num">0{i + 1}</div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </article>
        ))}
      </section>

      <section className="audience">
        <h2>Who it&apos;s for</h2>
        <ul>
          <li>University students juggling classes, coursework and exams at the same time.</li>
          <li>Anyone who keeps underestimating how long assignments take.</li>
          <li>People who want an honest answer to &ldquo;can I still get this done in time?&rdquo;</li>
        </ul>
      </section>
    </div>
  );
}
