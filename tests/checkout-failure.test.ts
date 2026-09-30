import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  CheckoutFailure,
  classifyGitFailure,
  fetchWithRetry,
  runFetchCommand,
  terminationMessage,
} from "../docker/checkout-failure.mjs";

const dns = {
  status: 128,
  stderr: "fatal: unable to access a private URL: Could not resolve host",
};

describe("bounded checkout fetch", () => {
  it("retries a DNS failure, succeeds on the same checkout, and never returns stderr", async () => {
    let now = 0;
    let calls = 0;
    const waits: number[] = [];
    const attempts = await fetchWithRetry(() => (++calls === 1 ? dns : { status: 0, stderr: "" }), {
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });
    expect(attempts).toBe(2);
    expect(calls).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it("stops after three DNS attempts with only a fixed reason code", async () => {
    let now = 0;
    let calls = 0;
    await expect(
      fetchWithRetry(
        () => {
          calls++;
          return dns;
        },
        { now: () => now, wait: async (milliseconds) => (now += milliseconds) },
      ),
    ).rejects.toMatchObject({ code: "CheckoutDnsUnavailable", attempts: 3 });
    expect(calls).toBe(3);
  });

  it.each([
    ["CheckoutAuthenticationFailed", "fatal: Authentication failed for https://token@host/repo"],
    ["CheckoutRevisionUnavailable", "fatal: couldn't find remote ref missing"],
    ["CheckoutLocalStorageFailed", "fatal: No space left on device"],
    ["CheckoutInitializationFailed", "fatal: unrecognized failure"],
  ])("does not retry permanent %s", async (code, stderr) => {
    let calls = 0;
    await expect(
      fetchWithRetry(() => {
        calls++;
        return { status: 128, stderr };
      }),
    ).rejects.toMatchObject({ code, attempts: 1 });
    expect(calls).toBe(1);
  });

  it("enforces the overall deadline and does not begin a new attempt without budget", async () => {
    let now = 0;
    let calls = 0;
    await expect(
      fetchWithRetry(
        () => {
          calls++;
          now = 149_500;
          return dns;
        },
        { now: () => now, wait: async (milliseconds) => (now += milliseconds) },
      ),
    ).rejects.toMatchObject({ code: "CheckoutFetchTimeout", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("recognizes missing alternates and caps a cold fallback to the original three attempts", async () => {
    const cache = classifyGitFailure(
      {
        status: 128,
        stderr:
          "error: object directory /private/path does not exist; check .git/objects/info/alternates",
      },
      "fetch",
    );
    expect(cache.code).toBe("CheckoutCacheInvalid");
    let calls = 0;
    let now = 0;
    await expect(
      fetchWithRetry(
        () => {
          calls++;
          return dns;
        },
        {
          attemptOffset: cache.attempts,
          now: () => now,
          wait: async (milliseconds) => {
            now += milliseconds;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "CheckoutDnsUnavailable", attempts: 3 });
    expect(calls).toBe(2);
  });

  it("emits only a safe termination envelope, even with unsafe Git text", () => {
    const failure = classifyGitFailure(
      { status: 128, stderr: "fatal: Authentication failed for https://token@private/repo" },
      "fetch",
    );
    expect(terminationMessage(failure)).toBe(
      '{"version":1,"stage":"fetch","code":"CheckoutAuthenticationFailed","attempts":1}',
    );
    expect(terminationMessage(new Error("TOKEN=secret"))).toBe(
      '{"version":1,"stage":"prepare","code":"CheckoutInitializationFailed","attempts":0}',
    );
    expect(failure).toBeInstanceOf(CheckoutFailure);
  });

  it("kills a timed-out Git process group and its delayed helper", async () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-fetch-timeout-"));
    try {
      const marker = join(root, "late-helper-ran");
      writeFileSync(join(root, "git"), '#!/bin/sh\n(sleep 1; touch "$MARKER_FILE") &\nwait\n', {
        mode: 0o755,
      });
      const start = Date.now();
      const result = await runFetchCommand(["fetch"], root, 150, {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        MARKER_FILE: marker,
      });
      expect(result.error?.code).toBe("ETIMEDOUT");
      expect(Date.now() - start).toBeLessThan(2_000);
      await delay(1_100);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
