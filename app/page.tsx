import Link from "next/link";

const steps = [
  {
    title: "Tell it what's due",
    body: "Add assignments and exams with a deadline, a time estimate and how hard they are. A title is enough to start.",
  },
  {
    title: "Tell it when you're free",
    body: "Set your weekly study hours, then import classes from a Google Calendar or Outlook .ics export, or block time by hand. Overbooked never books over them.",
  },
  {
    title: "Get real, dated study blocks",
    body: "One click plans focused sessions with breaks before each deadline. Fall behind? Replan, and it tells you honestly what no longer fits.",
  },
];

export default function LandingPage() {
  return (
    <div className="container">
      <section className="hero">
        <span className="eyebrow">Automatic study scheduler for students</span>
        <h1>Overbooked automatically plans your studying around your life — and replans when you fall behind.</h1>
        <p className="lead">
          Not another to-do list. Overbooked turns your deadlines and free time into a concrete weekly study
          calendar, then learns how long things really take you.
        </p>
        <Link href="/signup" className="btn btn-primary btn-lg">
          Sign up free
        </Link>
        <p className="fine">Email and password. No credit card, no setup wizard.</p>
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
