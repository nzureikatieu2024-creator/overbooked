"use client";

import Link from "next/link";
import { useState } from "react";
import { friendlyAuthError } from "@/lib/auth-recovery";
import { createClient } from "@/lib/supabase/client";

type Mode = "signup" | "login";

export default function AuthForm({ mode }: { mode: Mode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const isSignup = mode === "signup";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    const supabase = createClient();

    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) {
          setError(friendlyAuthError(error.message, error.status));
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
          setError(friendlyAuthError(error.message, error.status));
          setBusy(false);
          return;
        }
      }
    } catch (e) {
      setError(friendlyAuthError(e instanceof Error ? e.message : "Network error"));
      setBusy(false);
      return;
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
          <div className="label-row">
            <label htmlFor="password">Password</label>
            {!isSignup && (
              <Link href="/forgot-password" className="text-link">
                Forgot password?
              </Link>
            )}
          </div>
          <div className="password-wrap">
            <input
              id="password"
              className="input"
              type={showPassword ? "text" : "password"}
              autoComplete={isSignup ? "new-password" : "current-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid={isSignup ? "signup-password" : "login-password"}
            />
            <button
              type="button"
              className="reveal"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
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
          {busy ? (isSignup ? "Creating account…" : "Logging in…") : isSignup ? "Sign up" : "Log in"}
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
