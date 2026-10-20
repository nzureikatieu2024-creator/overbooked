"use client";

import Link from "next/link";
import { useState } from "react";
import { friendlyAuthError, resetRedirectUrl } from "@/lib/auth-recovery";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return setError("Enter a valid email address.");
    setError(null);
    setBusy(true);
    try {
      const { error } = await createClient().auth.resetPasswordForEmail(clean, {
        redirectTo: resetRedirectUrl(window.location.origin),
      });
      // Only rate limits, network and server problems are shown. Whether the account exists
      // is not revealed: unknown emails get the same confirmation as real ones.
      if (error && (error.status === 429 || /rate limit|fetch|network/i.test(error.message))) {
        setError(friendlyAuthError(error.message, error.status));
      } else if (error && (error.status ?? 0) >= 500) {
        setError("We couldn't send the email right now. Please try again in a few minutes.");
      } else {
        setSent(clean);
      }
    } catch (e) {
      setError(friendlyAuthError(e instanceof Error ? e.message : "Network error"));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" role="status">
          <div>
            <h1>Check your email</h1>
            <p className="hint" style={{ marginTop: 6 }}>
              If an account exists for <strong>{sent}</strong>, we&apos;ve sent a link to reset your password. It works
              once and expires after a short time.
            </p>
          </div>
          <ul className="steps-list">
            <li>Open the email on this device and in this browser.</li>
            <li>Not there after a few minutes? Check spam, or send it again.</li>
          </ul>
          <button type="button" className="btn btn-secondary" onClick={() => setSent(null)}>
            Send again
          </button>
          <p className="switch">
            Remembered it? <Link href="/login">Back to log in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <div>
          <h1>Reset your password</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            Enter the email you signed up with and we&apos;ll send you a link to choose a new password.
          </p>
        </div>

        <div className="field">
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "forgot-error" : undefined}
          />
        </div>

        {error && (
          <p className="error" role="alert" id="forgot-error">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </button>

        <p className="switch">
          <Link href="/login">Back to log in</Link>
        </p>
      </form>
    </div>
  );
}
