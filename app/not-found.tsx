import Link from "next/link";

export const metadata = { title: "Page not found — Overbooked" };

export default function NotFound() {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div>
          <h1>Page not found</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            This page doesn&apos;t exist. It may have moved, or the link may be mistyped.
          </p>
        </div>
        <Link href="/app" className="btn btn-primary btn-lg">
          Go to my study plan
        </Link>
        <p className="switch">
          <Link href="/">Home</Link>
        </p>
      </div>
    </div>
  );
}
