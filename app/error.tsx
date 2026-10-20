"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="auth-wrap">
      <div className="auth-card" role="alert">
        <div>
          <h1>Something went wrong</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            This page failed to load. Your saved tasks and plan are not affected.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={() => retry()}>
          Try again
        </button>
        <p className="switch">
          <Link href="/">Go to the home page</Link>
        </p>
      </div>
    </div>
  );
}
