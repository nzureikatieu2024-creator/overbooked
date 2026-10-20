// Pure helpers for the password recovery flow (no Supabase calls), so they can be unit tested.

export const RESET_PATH = "/reset-password";
export const MIN_PASSWORD = 6; // same rule as sign-up
export const MAX_PASSWORD = 72; // Supabase / bcrypt limit

export type RecoveryLink =
  | { kind: "code"; code: string } // PKCE link (default for @supabase/ssr)
  | { kind: "token_hash"; tokenHash: string } // custom email template: ?token_hash=…&type=recovery
  | { kind: "session"; accessToken: string; refreshToken: string } // implicit flow: #access_token=…&type=recovery
  | { kind: "error"; code: string; message: string } // Supabase redirected with an error (expired, used, …)
  | { kind: "none" };

/** Reads what the recovery email link put in the URL. Looks at both the query string and the hash. */
export function parseRecoveryLink(href: string): RecoveryLink {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "none" };
  }
  const params = new URLSearchParams(url.search);
  new URLSearchParams(url.hash.replace(/^#/, "")).forEach((v, k) => {
    if (!params.has(k)) params.set(k, v);
  });

  const error = params.get("error_code") || params.get("error");
  if (error || params.get("error_description")) {
    const code = error ?? "unknown";
    return { kind: "error", code, message: recoveryErrorMessage(code, params.get("error_description")) };
  }
  const code = params.get("code");
  if (code) return { kind: "code", code };
  const tokenHash = params.get("token_hash");
  if (tokenHash && (params.get("type") ?? "recovery") === "recovery") return { kind: "token_hash", tokenHash };
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken && params.get("type") === "recovery") return { kind: "session", accessToken, refreshToken };
  return { kind: "none" };
}

/**
 * Whether an access token comes from a password recovery (Supabase puts the sign-in
 * method in the JWT "amr" claim) within the last `maxAgeSeconds`. Used only when the
 * link was already processed, e.g. after a reload. Never logs or stores the token.
 */
export function isRecentRecoveryToken(accessToken: string, nowSeconds: number, maxAgeSeconds = 3600): boolean {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return false;
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    const amr: unknown = json.amr;
    if (!Array.isArray(amr)) return false;
    return amr.some(
      (m) =>
        m &&
        typeof m === "object" &&
        (m as { method?: unknown }).method === "recovery" &&
        nowSeconds - Number((m as { timestamp?: unknown }).timestamp) <= maxAgeSeconds,
    );
  } catch {
    return false;
  }
}

/** Plain-language message for an expired, used or otherwise invalid recovery link. */
export function recoveryErrorMessage(code: string, description?: string | null): string {
  const text = `${code} ${description ?? ""}`.toLowerCase();
  if (text.includes("expired") || text.includes("otp_expired")) {
    return "This reset link has expired. Reset links work once and only for a limited time, so request a new one below.";
  }
  if (text.includes("code verifier") || text.includes("code_verifier") || text.includes("pkce")) {
    return "This reset link has to be opened in the same browser you requested it from. Request a new link here, then open the email on this device.";
  }
  if (text.includes("flow_state") || text.includes("invalid") || text.includes("access_denied") || text.includes("not found")) {
    return "This reset link is invalid or has already been used. Request a new one below.";
  }
  return "We couldn't verify this reset link. Request a new one below.";
}

/** Validation for the new password form. Returns an error message, or null if it is fine. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

/**
 * Where the reset email should send the user. Uses the site the request came from
 * (localhost, or https://overbooked-black.vercel.app in production). That URL must
 * be listed under Supabase → Authentication → URL Configuration → Redirect URLs.
 */
export function resetRedirectUrl(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Password reset links must use https.");
  }
  return `${url.origin}${RESET_PATH}`;
}

/** Friendlier wording for common Supabase Auth errors. Unknown messages are passed through. */
export function friendlyAuthError(message: string, status?: number): string {
  const m = message.toLowerCase();
  if (status === 429 || m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  if (m.includes("invalid login credentials")) return "That email and password don't match an account.";
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "An account with this email already exists. Log in instead.";
  }
  if (m.includes("same_password") || m.includes("different from the old")) {
    return "Choose a password that is different from your current one.";
  }
  if (m.includes("weak") || m.includes("password should")) return message;
  if (m.includes("unable to validate email") || m.includes("invalid email") || (m.includes("email address") && m.includes("invalid"))) {
    return "Enter a valid email address.";
  }
  if (m.includes("failed to fetch") || m.includes("network")) {
    return "Can't reach the server. Check your connection and try again.";
  }
  return message;
}
