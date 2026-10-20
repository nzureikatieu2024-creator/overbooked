"use client";

import { createBrowserClient } from "@supabase/ssr";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MIN_PASSWORD, friendlyAuthError, validateNewPassword } from "@/lib/auth-recovery";
import { createRecoveryVerifier, type RecoveryStage } from "@/lib/recovery-flow";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/supabase/env";

type Stage = { name: "checking" } | RecoveryStage | { name: "done" };

type AuthClient = ReturnType<typeof createBrowserClient>;

// One dedicated client per page load. It does NOT consume the link automatically
// (detectSessionInUrl: false), so this page decides what a valid recovery is and can
// explain failures. It shares the cookie storage, so the PKCE verifier saved by
// /forgot-password is found.
let recoveryClient: AuthClient | null = null;
function getRecoveryClient(): AuthClient {
  recoveryClient ??= createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    isSingleton: false,
    auth: { detectSessionInUrl: false },
  });
  return recoveryClient;
}

const verifyOnce = createRecoveryVerifier(() => getRecoveryClient().auth, {
  href: () => window.location.href,
  clearUrl: () => window.history.replaceState(null, "", window.location.pathname),
  nowSeconds: () => Math.floor(Date.now() / 1000),
});

export default function ResetPasswordForm() {
  const [stage, setStage] = useState<Stage>({ name: "checking" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    verifyOnce().then((next) => {
      if (active) setStage(next);
    });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateNewPassword(password, confirm);
    if (invalid) return setError(invalid);
    setError(null);
    setBusy(true);
    try {
      const supabase = getRecoveryClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setBusy(false);
        if (error.status === 401 || /session|jwt|expired/i.test(error.message)) {
          setStage({ name: "invalid", message: "Your reset session has expired. Request a new link to try again." });
        } else {
          setError(friendlyAuthError(error.message, error.status));
        }
        return;
      }
      // Sign out every other device that may still use the old password
      await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
      setStage({ name: "done" });
      // Full navigation so the server sees the session cookie
      setTimeout(() => window.location.assign("/app"), 1200);
    } catch (e) {
      setBusy(false);
      setError(friendlyAuthError(e instanceof Error ? e.message : "Network error"));
    }
  }

  if (stage.name === "checking") {
    return (
      <div className="auth-wrap">
        <div className="auth-card" role="status" aria-live="polite">
          <h1>Checking your link…</h1>
          <p className="hint">One moment while we verify your password reset link.</p>
        </div>
      </div>
    );
  }

  if (stage.name === "invalid") {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div>
            <h1>Link not valid</h1>
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {stage.message}
            </p>
          </div>
          <Link href="/forgot-password" className="btn btn-primary btn-lg">
            Request a new link
          </Link>
          <p className="switch">
            <Link href="/login">Back to log in</Link>
          </p>
        </div>
      </div>
    );
  }

  if (stage.name === "done") {
    return (
      <div className="auth-wrap">
        <div className="auth-card" role="status">
          <h1>Password updated</h1>
          <p className="hint">You&apos;re logged in. Taking you to your study plan…</p>
          <Link href="/app" className="btn btn-primary btn-lg">
            Go to my plan
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <div>
          <h1>Choose a new password</h1>
          <p className="hint" style={{ marginTop: 6 }}>
            At least {MIN_PASSWORD} characters. Other devices will be logged out.
          </p>
        </div>

        <div className="field">
          <label htmlFor="new-password">New password</label>
          <div className="password-wrap">
            <input
              id="new-password"
              className="input"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="button" className="reveal" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? "Hide passwords" : "Show passwords"}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="confirm-password">Repeat new password</label>
          <input
            id="confirm-password"
            className="input"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </button>
      </form>
    </div>
  );
}
