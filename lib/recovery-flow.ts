// Verifies a password recovery link exactly once and reports whether the user may set
// a new password. Dependencies are injected so the race conditions can be unit tested.

import { isRecentRecoveryToken, parseRecoveryLink, recoveryErrorMessage } from "./auth-recovery.ts";

export type RecoveryStage = { name: "ready" } | { name: "invalid"; message: string };

type AuthError = { code?: string; name: string; message: string } | null;

/** The subset of the Supabase auth client this flow uses. */
export type RecoveryAuth = {
  exchangeCodeForSession(code: string): Promise<{ error: AuthError }>;
  verifyOtp(params: { type: "recovery"; token_hash: string }): Promise<{ error: AuthError }>;
  setSession(params: { access_token: string; refresh_token: string }): Promise<{ error: AuthError }>;
  getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
};

export type RecoveryEnv = {
  href: () => string;
  clearUrl: () => void; // removes the one-time code / tokens from the address bar
  nowSeconds: () => number;
};

const NO_LINK = "Open this page from the link in your password reset email, or request a new link.";

async function existingRecovery(auth: RecoveryAuth, env: RecoveryEnv, otherwise: string): Promise<RecoveryStage> {
  // getSession waits until the client has finished restoring any saved session
  const { data } = await auth.getSession();
  const token = data.session?.access_token;
  if (token && isRecentRecoveryToken(token, env.nowSeconds())) return { name: "ready" };
  return { name: "invalid", message: otherwise };
}

export async function verifyRecovery(auth: RecoveryAuth, env: RecoveryEnv): Promise<RecoveryStage> {
  const link = parseRecoveryLink(env.href());
  let stage: RecoveryStage;
  try {
    if (link.kind === "error") {
      stage = { name: "invalid", message: link.message };
    } else if (link.kind === "none") {
      stage = await existingRecovery(auth, env, NO_LINK);
    } else {
      const { error } =
        link.kind === "code"
          ? await auth.exchangeCodeForSession(link.code)
          : link.kind === "token_hash"
            ? await auth.verifyOtp({ type: "recovery", token_hash: link.tokenHash })
            : await auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
      stage = error
        ? // e.g. the code was already used by an earlier load: accept an existing recovery session
          await existingRecovery(auth, env, recoveryErrorMessage(error.code ?? error.name, error.message))
        : { name: "ready" };
    }
  } catch {
    stage = { name: "invalid", message: "We couldn't reach the server to verify this link. Check your connection and reload the page." };
    return stage; // keep the link in the address bar so a reload can retry
  }
  // Only after verification has finished is the one-time code removed from the URL
  env.clearUrl();
  return stage;
}

/**
 * A recovery code works exactly once, but React Strict Mode (development) mounts
 * components twice. This shares one verification per URL between all callers.
 */
export function createRecoveryVerifier(auth: () => RecoveryAuth, env: RecoveryEnv) {
  let pending: { href: string; result: Promise<RecoveryStage> } | null = null;
  return function verifyOnce(): Promise<RecoveryStage> {
    const href = env.href();
    if (!pending || pending.href !== href) pending = { href, result: verifyRecovery(auth(), env) };
    return pending.result;
  };
}
