import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const FETCH_DEADLINE_MS = 150_000;
export const MAX_FETCH_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];
const MAX_STDERR_BYTES = 64 * 1024;

export class CheckoutFailure extends Error {
  constructor(stage, code, attempts = 0) {
    super(`${code}:${stage}`);
    this.name = "CheckoutFailure";
    this.stage = stage;
    this.code = code;
    this.attempts = attempts;
  }
}

/** Classify without ever returning Git stderr, repository locations, or credentials. */
export function classifyGitFailure(result, stage, attempts = 1) {
  const output = String(result?.stderr ?? "");
  const errorCode = result?.error?.code;
  let code = "CheckoutInitializationFailed";
  if (errorCode === "ETIMEDOUT" || /(?:operation|connection) timed out/i.test(output))
    code = "CheckoutFetchTimeout";
  else if (
    /could not resolve (?:host|hostname)|temporary failure in name resolution|name or service not known|no such host/i.test(
      output,
    )
  )
    code = "CheckoutDnsUnavailable";
  else if (
    /authentication failed|http (?:401|403)|permission denied \(publickey\)|could not read username|access denied/i.test(
      output,
    )
  )
    code = "CheckoutAuthenticationFailed";
  else if (
    /couldn.t find remote ref|not our ref|remote branch .* not found|invalid refspec|invalid reference/i.test(
      output,
    )
  )
    code = "CheckoutRevisionUnavailable";
  else if (
    ["ENOSPC", "EROFS", "EACCES", "EPERM"].includes(errorCode) ||
    /no space left on device|read-only file system|unable to create .*\.lock|could not write/i.test(
      output,
    )
  )
    code = "CheckoutLocalStorageFailed";
  else if (/network is unreachable|connection (?:refused|reset)|failed to connect/i.test(output))
    code = "CheckoutNetworkUnavailable";
  else if (
    /bad object|missing object|unable to read object|object directory .* does not exist|unable to normalize alternate object path|alternates.*(?:invalid|missing)/i.test(
      output,
    )
  )
    code = "CheckoutCacheInvalid";
  return new CheckoutFailure(stage, code, attempts);
}

export function terminationMessage(error) {
  const failure =
    error instanceof CheckoutFailure
      ? error
      : new CheckoutFailure("prepare", "CheckoutInitializationFailed");
  return JSON.stringify({
    version: 1,
    stage: failure.stage,
    code: failure.code,
    attempts: failure.attempts,
  });
}

/** Kill the entire Git process group, including SSH/credential helpers, at the deadline. */
export function runFetchCommand(args, cwd, timeoutMs, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      resolve(result);
    };
    const stop = (code) => {
      if (settled) return;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ status: null, stderr: Buffer.concat(chunks), error: { code } });
    };
    const timer = setTimeout(() => stop("ETIMEDOUT"), Math.max(1, timeoutMs));
    child.stderr?.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_STDERR_BYTES) stop("ENOBUFS");
      else chunks.push(chunk);
    });
    child.on("error", (error) =>
      finish({ status: null, stderr: Buffer.concat(chunks), error: { code: error.code } }),
    );
    child.on("close", (status) => finish({ status, stderr: Buffer.concat(chunks) }));
  });
}

/** Retry only identified transient fetch failures within one bounded budget. */
export async function fetchWithRetry(run, options = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  const deadline = options.deadline ?? now() + FETCH_DEADLINE_MS;
  const attemptOffset = options.attemptOffset ?? 0;
  if (!Number.isInteger(attemptOffset) || attemptOffset < 0 || attemptOffset >= MAX_FETCH_ATTEMPTS)
    throw new CheckoutFailure("fetch", "CheckoutInitializationFailed", 0);
  for (let attempt = attemptOffset + 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", attempt - 1);
    const result = await run(remaining);
    if (result.status === 0) {
      if (now() > deadline) throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", attempt);
      return attempt;
    }
    const failure = classifyGitFailure(result, "fetch", attempt);
    if (
      !["CheckoutDnsUnavailable", "CheckoutNetworkUnavailable", "CheckoutFetchTimeout"].includes(
        failure.code,
      ) ||
      attempt === MAX_FETCH_ATTEMPTS
    )
      throw failure;
    const backoff = BACKOFF_MS[attempt - 1];
    if (deadline - now() <= backoff)
      throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", attempt);
    await wait(backoff);
  }
  throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", MAX_FETCH_ATTEMPTS);
}
