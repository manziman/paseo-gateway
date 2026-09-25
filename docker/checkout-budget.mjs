import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CheckoutFailure,
  FETCH_DEADLINE_MS,
  MAX_FETCH_ATTEMPTS,
  runFetchCommand,
  terminationMessage,
} from "./checkout-failure.mjs";

const codes = new Set([
  "CheckoutInitializationFailed",
  "CheckoutConfigurationInvalid",
  "CheckoutFetchTimeout",
  "CheckoutDnsUnavailable",
  "CheckoutAuthenticationFailed",
  "CheckoutRevisionUnavailable",
  "CheckoutLocalStorageFailed",
  "CheckoutNetworkUnavailable",
  "CheckoutCacheInvalid",
]);
const invalid = () => new CheckoutFailure("prepare", "CheckoutInitializationFailed");

/** A Pod-local emptyDir receipt; claims precede Git, so a killed init cannot reset its budget. */
export async function checkoutBudget(path) {
  let state;
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(2049);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 2048) throw invalid();
      state = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
    if (
      state?.version !== 1 ||
      !Number.isSafeInteger(state.startedAt) ||
      state.startedAt <= 0 ||
      !Number.isSafeInteger(state.deadline) ||
      state.deadline !== state.startedAt + FETCH_DEADLINE_MS ||
      Date.now() < state.startedAt ||
      !Number.isInteger(state.attempts) ||
      state.attempts < 0 ||
      state.attempts > MAX_FETCH_ATTEMPTS ||
      !Number.isSafeInteger(state.nextAttemptAt) ||
      state.nextAttemptAt < 0 ||
      (state.failure !== undefined &&
        (!state.failure ||
          typeof state.failure !== "object" ||
          !codes.has(state.failure.code) ||
          !["prepare", "fetch", "checkout"].includes(state.failure.stage)))
    )
      throw invalid();
  } catch (error) {
    if (error.code !== "ENOENT") throw invalid();
    const startedAt = Date.now();
    state = {
      version: 1,
      startedAt,
      deadline: startedAt + FETCH_DEADLINE_MS,
      attempts: 0,
      nextAttemptAt: 0,
    };
  }
  const save = async () => {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(`${path}.tmp`, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(`${path}.tmp`, path);
  };
  const failure = () =>
    state.failure
      ? new CheckoutFailure(state.failure.stage, state.failure.code, state.attempts)
      : new CheckoutFailure(
          "fetch",
          state.attempts >= MAX_FETCH_ATTEMPTS
            ? "CheckoutInitializationFailed"
            : "CheckoutFetchTimeout",
          state.attempts,
        );
  if (state.failure || state.attempts >= MAX_FETCH_ATTEMPTS || Date.now() >= state.deadline)
    throw failure();
  await save();
  return {
    get deadline() {
      return state.deadline;
    },
    get attempts() {
      return state.attempts;
    },
    async fail(error) {
      const safe = JSON.parse(terminationMessage(error));
      state.failure = { stage: safe.stage, code: safe.code };
      await save();
    },
    async run(args, cwd) {
      if (state.failure || state.attempts >= MAX_FETCH_ATTEMPTS || Date.now() >= state.deadline)
        throw failure();
      const backoff = Math.max(0, state.nextAttemptAt - Date.now());
      if (Date.now() + backoff >= state.deadline)
        throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", state.attempts);
      if (backoff) await delay(backoff);
      if (Date.now() >= state.deadline)
        throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", state.attempts);
      state.attempts++;
      // Reserve before invoking Git; persist a minimum delay even if the process dies mid-fetch.
      state.nextAttemptAt = Date.now() + (state.attempts === 1 ? 1000 : 2000);
      await save();
      const remaining = state.deadline - Date.now();
      if (remaining <= 0)
        throw new CheckoutFailure("fetch", "CheckoutFetchTimeout", state.attempts);
      const result = await runFetchCommand(args, cwd, remaining);
      state.nextAttemptAt = Date.now() + (state.attempts === 1 ? 1000 : 2000);
      await save();
      return result;
    },
  };
}
