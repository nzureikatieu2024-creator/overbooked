import { test } from "node:test";
import assert from "node:assert/strict";
import {
  friendlyAuthError,
  parseRecoveryLink,
  resetRedirectUrl,
  validateNewPassword,
} from "../lib/auth-recovery.ts";

const PROD = "https://overbooked-black.vercel.app";

test("reset emails redirect to /reset-password on the same site", () => {
  assert.equal(resetRedirectUrl(PROD), `${PROD}/reset-password`);
  assert.equal(resetRedirectUrl(`${PROD}/forgot-password?x=1`), `${PROD}/reset-password`);
  assert.equal(resetRedirectUrl("http://localhost:3000"), "http://localhost:3000/reset-password");
  assert.throws(() => resetRedirectUrl("http://example.com"), /https/);
});

test("reads a PKCE recovery link", () => {
  assert.deepEqual(parseRecoveryLink(`${PROD}/reset-password?code=abc-123&sb_flow_id=x`), { kind: "code", code: "abc-123" });
});

test("reads a token_hash recovery link", () => {
  assert.deepEqual(parseRecoveryLink(`${PROD}/reset-password?token_hash=h1&type=recovery`), { kind: "token_hash", tokenHash: "h1" });
  assert.deepEqual(parseRecoveryLink(`${PROD}/reset-password?token_hash=h1&type=signup`), { kind: "none" });
});

test("expired and invalid links become clear errors, in the query or the hash", () => {
  const expired = parseRecoveryLink(
    `${PROD}/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
  );
  assert.equal(expired.kind, "error");
  assert.match(expired.kind === "error" ? expired.message : "", /expired/);

  const used = parseRecoveryLink(`${PROD}/reset-password?error=access_denied&error_description=Invalid+flow+state`);
  assert.equal(used.kind, "error");
  assert.match(used.kind === "error" ? used.message : "", /invalid or has already been used/);

  // An error always wins over a code that may also be present
  assert.equal(parseRecoveryLink(`${PROD}/reset-password?code=x&error_code=otp_expired`).kind, "error");
});

test("a page visit without a link is not treated as a recovery", () => {
  assert.deepEqual(parseRecoveryLink(`${PROD}/reset-password`), { kind: "none" });
  assert.deepEqual(parseRecoveryLink("not a url"), { kind: "none" });
});

test("new password rules match sign-up", () => {
  assert.match(validateNewPassword("12345", "12345") ?? "", /at least 6/);
  assert.match(validateNewPassword("secret1", "secret2") ?? "", /match/);
  assert.match(validateNewPassword("x".repeat(73), "x".repeat(73)) ?? "", /at most/);
  assert.equal(validateNewPassword("secret1", "secret1"), null);
});

test("auth errors are translated without hiding unknown ones", () => {
  assert.match(friendlyAuthError("Invalid login credentials"), /don't match/);
  assert.match(friendlyAuthError("email rate limit exceeded", 429), /wait a minute/);
  assert.match(friendlyAuthError("New password should be different from the old password."), /different/);
  assert.match(friendlyAuthError("TypeError: Failed to fetch"), /connection/);
  assert.equal(friendlyAuthError("Something unusual"), "Something unusual");
});

// ── Recovery flow: regression for "Link not valid" after clicking a real reset email ──

import { createRecoveryVerifier, verifyRecovery, type RecoveryAuth } from "../lib/recovery-flow.ts";
import { isRecentRecoveryToken } from "../lib/auth-recovery.ts";

const NOW = 1_800_000_000;
const jwt = (amr: unknown) => `h.${Buffer.from(JSON.stringify({ amr })).toString("base64url")}.s`;
const RECOVERY_TOKEN = jwt([{ method: "recovery", timestamp: NOW - 60 }]);
const PASSWORD_TOKEN = jwt([{ method: "password", timestamp: NOW - 60 }]);

function fakeEnv(href: string) {
  const env = {
    url: href,
    cleared: 0,
    href: () => env.url,
    clearUrl: () => {
      env.cleared++;
      env.url = `${PROD}/reset-password`;
    },
    nowSeconds: () => NOW,
  };
  return env;
}

function fakeAuth(over: Partial<RecoveryAuth> = {}) {
  const calls = { exchange: 0, verifyOtp: 0, setSession: 0 };
  let session: { access_token: string } | null = null;
  const auth: RecoveryAuth = {
    async exchangeCodeForSession() {
      calls.exchange++;
      await new Promise((r) => setTimeout(r, 5)); // network delay
      if (calls.exchange > 1) return { error: { code: "flow_state_not_found", name: "AuthApiError", message: "invalid flow state" } };
      session = { access_token: RECOVERY_TOKEN };
      return { error: null };
    },
    async verifyOtp() {
      calls.verifyOtp++;
      session = { access_token: RECOVERY_TOKEN };
      return { error: null };
    },
    async setSession() {
      calls.setSession++;
      session = { access_token: RECOVERY_TOKEN };
      return { error: null };
    },
    async getSession() {
      return { data: { session } };
    },
    ...over,
  };
  return { auth, calls };
}

test("Strict Mode double mount: the code is exchanged once and the user may set a password", async () => {
  const env = fakeEnv(`${PROD}/reset-password?sb_flow_id=f1&code=abc`);
  const { auth, calls } = fakeAuth();
  const verifyOnce = createRecoveryVerifier(() => auth, env);
  // mount → unmount → mount, as React does in development
  const [first, second] = await Promise.all([verifyOnce(), verifyOnce()]);
  assert.equal(calls.exchange, 1);
  assert.deepEqual(first, { name: "ready" });
  assert.deepEqual(second, { name: "ready" });
  assert.equal(env.cleared, 1);
});

test("the code stays in the URL until verification has finished", async () => {
  const env = fakeEnv(`${PROD}/reset-password?code=abc`);
  let urlDuringExchange = "";
  const { auth } = fakeAuth({
    async exchangeCodeForSession() {
      urlDuringExchange = env.href();
      return { error: null };
    },
  });
  await verifyRecovery(auth, env);
  assert.match(urlDuringExchange, /code=abc/);
  assert.equal(env.href(), `${PROD}/reset-password`);
});

test("reloading after a successful exchange still allows the reset", async () => {
  const env = fakeEnv(`${PROD}/reset-password?code=abc`);
  const { auth, calls } = fakeAuth();
  assert.deepEqual(await verifyRecovery(auth, env), { name: "ready" });
  // Reload: URL is clean now, but the recovery session exists
  assert.deepEqual(await verifyRecovery(auth, env), { name: "ready" });
  assert.equal(calls.exchange, 1);
});

test("token_hash and #access_token links are verified", async () => {
  const a = fakeAuth();
  assert.deepEqual(await verifyRecovery(a.auth, fakeEnv(`${PROD}/reset-password?token_hash=h&type=recovery`)), { name: "ready" });
  assert.equal(a.calls.verifyOtp, 1);
  const b = fakeAuth();
  assert.deepEqual(
    await verifyRecovery(b.auth, fakeEnv(`${PROD}/reset-password#access_token=at&refresh_token=rt&type=recovery`)),
    { name: "ready" },
  );
  assert.equal(b.calls.setSession, 1);
});

test("expired, reused and malformed links are rejected with a clear message", async () => {
  const expired = await verifyRecovery(fakeAuth().auth, fakeEnv(`${PROD}/reset-password?error_code=otp_expired&error=access_denied`));
  assert.equal(expired.name, "invalid");
  assert.match(expired.name === "invalid" ? expired.message : "", /expired/);

  // Reused code and no recovery session
  const { auth } = fakeAuth({
    async exchangeCodeForSession() {
      return { error: { code: "flow_state_not_found", name: "AuthApiError", message: "invalid flow state, no valid flow state found" } };
    },
  });
  const reused = await verifyRecovery(auth, fakeEnv(`${PROD}/reset-password?code=used`));
  assert.match(reused.name === "invalid" ? reused.message : "", /invalid or has already been used/);

  // Opened in another browser: the PKCE verifier is missing
  const other = fakeAuth({
    async exchangeCodeForSession() {
      return { error: { name: "AuthPKCECodeVerifierMissingError", message: "PKCE code verifier not found in storage." } };
    },
  });
  const otherBrowser = await verifyRecovery(other.auth, fakeEnv(`${PROD}/reset-password?code=x`));
  assert.match(otherBrowser.name === "invalid" ? otherBrowser.message : "", /same browser/);
});

test("a normal logged-in session is not accepted as a recovery", async () => {
  const { auth } = fakeAuth({
    async getSession() {
      return { data: { session: { access_token: PASSWORD_TOKEN } } };
    },
  });
  const r = await verifyRecovery(auth, fakeEnv(`${PROD}/reset-password`));
  assert.equal(r.name, "invalid");
});

test("network failure keeps the link so a reload can retry", async () => {
  const env = fakeEnv(`${PROD}/reset-password?code=abc`);
  const { auth } = fakeAuth({
    async exchangeCodeForSession() {
      throw new TypeError("Failed to fetch");
    },
  });
  const r = await verifyRecovery(auth, env);
  assert.equal(r.name, "invalid");
  assert.equal(env.cleared, 0);
  assert.match(env.href(), /code=abc/);
});

test("recovery tokens are recognised only when recent and from a recovery", () => {
  assert.equal(isRecentRecoveryToken(RECOVERY_TOKEN, NOW), true);
  assert.equal(isRecentRecoveryToken(RECOVERY_TOKEN, NOW + 7200), false);
  assert.equal(isRecentRecoveryToken(PASSWORD_TOKEN, NOW), false);
  assert.equal(isRecentRecoveryToken("garbage", NOW), false);
});

test("implicit-flow hash links are parsed without exposing tokens elsewhere", () => {
  const link = parseRecoveryLink(`${PROD}/reset-password#access_token=a&refresh_token=r&type=recovery`);
  assert.equal(link.kind, "session");
  assert.deepEqual(parseRecoveryLink(`${PROD}/reset-password#access_token=a&refresh_token=r&type=signup`), { kind: "none" });
});
