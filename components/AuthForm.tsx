"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Mode = "signup" | "login";

export default function AuthForm({ mode }: { mode: Mode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const supabase = createClient();

    if (isSignup) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
      if (!data.session) {
        // Happens only if "Confirm email" is still enabled in Supabase.
        setNotice("Account created, but email confirmation is turned on in Supabase. Turn it off to log in instantly.");
        setBusy(false);
        return;
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        setBusy(false);
        return;
      }
    }

    // Full navigation so the server sees the new session cookie.
    window.location.assign("/app");
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit} noValidate={false}>
        <div>
          <h1>{isSignup ? "Create your account" : "Welcome back"}</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            {isSignup ? "Start planning in under a minute." : "Log in to see your study plan."}
          </p>
        </div>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid={isSignup ? "signup-email" : "login-email"}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid={isSignup ? "signup-password" : "login-password"}
          />
          {isSignup && <span className="hint">At least 6 characters.</span>}
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={busy}
          data-testid={isSignup ? "signup-submit" : "login-submit"}
        >
          {busy ? "Please wait…" : isSignup ? "Sign up" : "Log in"}
        </button>

        <p className="switch">
          {isSignup ? (
            <>
              Already have an account? <Link href="/login">Log in</Link>
            </>
          ) : (
            <>
              New here? <Link href="/signup">Create an account</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
