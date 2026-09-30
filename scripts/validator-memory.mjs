#!/usr/bin/env node
// Opt-in exact-image check; intentionally not a timing/RSS test in the portable unit suite.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const image = args[0];
const baseline = args[1] === "--baseline";
if (!image || args.length > 2 || (args[1] && !baseline)) {
  console.error("usage: npm run test:validator-memory -- LOCAL_GATEWAY_IMAGE [--baseline]");
  process.exit(2);
}
const docker = (argv, options = {}) =>
  execFileSync("docker", argv, {
    encoding: "utf8",
    timeout: 70_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
let metadata;
try {
  metadata = JSON.parse(docker(["image", "inspect", image]))[0];
} catch {
  console.error("Local image metadata unavailable; no pull attempted");
  process.exit(2);
}
const expected = baseline
  ? [
      ["node", "dist/main.js"],
      ["node", "--no-maglev", "dist/main.js"],
    ]
  : [["node", "--no-maglev", "dist/main.js"]];
if (
  metadata.Os !== "linux" ||
  metadata.Architecture !== "arm64" ||
  !/^sha256:[a-f0-9]{64}$/.test(metadata.Id) ||
  !expected.some((cmd) => JSON.stringify(cmd) === JSON.stringify(metadata.Config?.Cmd))
) {
  console.error(
    "Expected a local linux/arm64 gateway image with the pinned explicit Node launch command",
  );
  process.exit(2);
}
const run = `paseo-validator-memory-${randomUUID()}`;
const probe = fileURLToPath(new URL("./validator-memory-probe.mjs", import.meta.url));
let output = "";
let exitCode = 0;
try {
  output = docker([
    "run",
    "--rm",
    "--name",
    run,
    "--label",
    `paseo-memory-fixture=${run}`,
    "--network",
    "none",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${probe},dst=/app/validator-memory-probe.mjs,readonly`,
    "--env",
    "NODE_OPTIONS=--max-old-space-size=256",
    "--env",
    `PASEO_MEMORY_NODE_ARGS=${JSON.stringify(metadata.Config.Cmd.slice(1, -1).filter((arg) => !baseline || arg !== "--no-maglev"))}`,
    "--entrypoint",
    "node",
    metadata.Id,
    "/app/validator-memory-probe.mjs",
    "supervise",
  ]);
} catch (error) {
  output = typeof error.stdout === "string" ? error.stdout : "";
  exitCode = typeof error.status === "number" ? error.status : 2;
} finally {
  // Only remove this invocation's container, after verifying its unique ownership label.
  try {
    const current = JSON.parse(docker(["inspect", run]))[0];
    if (current.Config?.Labels?.["paseo-memory-fixture"] === run)
      docker(["rm", "--force", current.Id]);
  } catch {
    /* --rm normally already removed it. */
  }
}
try {
  const rows = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const runtime = rows.find((row) => row.event === "runtime");
  const summary = rows.find((row) => row.event === "summary");
  const supervisor = rows.find((row) => row.event === "supervisor");
  const initial = rows.find((row) => row.event === "initial");
  const peakRss = Math.max(summary?.peakRss ?? 0, supervisor?.peakRss ?? 0);
  const validRuntime =
    runtime?.node === "v24.21.0" &&
    runtime?.sdk === "0.9.1" &&
    runtime?.protocol === "0.9.1" &&
    runtime?.zod === "4.4.3" &&
    runtime?.platform === "linux" &&
    runtime?.arch === "arm64" &&
    runtime?.heapOption === true &&
    runtime?.noMaglev === !baseline;
  const reproduced =
    supervisor?.oomKill > 0 ||
    (summary?.nativeSurge === true && peakRss - (initial?.rss ?? peakRss) > 400 * 1024 * 1024);
  const pass =
    validRuntime && exitCode === 0 && summary?.calls === 100_000 && peakRss < 512 * 1024 * 1024;
  console.log(
    JSON.stringify(
      {
        imageDigest: metadata.Id,
        baseline,
        status: baseline
          ? validRuntime && reproduced
            ? "REPRODUCED"
            : "NOT_REPRODUCED"
          : pass
            ? "PASS"
            : "FAIL",
        runtime,
        summary,
        supervisor,
        peakRss,
        containerExitCode: exitCode,
        lastReportedCalls: Math.max(
          0,
          ...rows.map((row) => (typeof row.calls === "number" ? row.calls : 0)),
        ),
      },
      null,
      2,
    ),
  );
  process.exitCode = baseline ? (validRuntime && reproduced ? 17 : 1) : pass ? 0 : 1;
} catch {
  console.error("Probe output unavailable or invalid; no successful qualification");
  process.exitCode = 2;
}
