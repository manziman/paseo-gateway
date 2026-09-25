#!/usr/bin/env node
// Opt-in TCP probes against operator-created, UID-verified namespace fixture Pods.
// Never prints context, namespace, Pod names, IPs, endpoints, or kubectl output.
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";

const flags = [
  "context",
  "namespace",
  "namespace-uid",
  "run-label",
  "source-pod",
  "source-uid",
  "source-container",
  "control-pod",
  "control-uid",
  "control-container",
  "allowed-ip",
  "allowed-port",
  "cross-workspace-ip",
  "cross-workspace-port",
  "denied-ip",
  "denied-port",
];
const probeCode = `
const net = require("node:net");
const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
const done = (code) => { socket.destroy(); process.exit(code); };
socket.setTimeout(3000, () => done(5));
socket.once("connect", () => done(0));
socket.once("error", () => done(5));
`;

export function parseArgs(argv) {
  if (argv[0] !== "--run-probes") throw new Error("explicit --run-probes gate required");
  const result = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!flags.includes(key) || !argv[index + 1] || result[key])
      throw new Error("missing or invalid explicit fixture argument");
    result[key] = argv[index + 1];
  }
  if (!flags.every((key) => result[key]))
    throw new Error("all context, namespace, fixture UID and endpoint flags are required");
  if (result["source-pod"] === result["control-pod"])
    throw new Error("source and control Pods must differ");
  for (const key of ["allowed-ip", "cross-workspace-ip", "denied-ip"])
    if (!isIP(result[key])) throw new Error("probe targets must be numeric IP addresses");
  for (const key of ["allowed-port", "cross-workspace-port", "denied-port"])
    if (!/^\d+$/.test(result[key]) || Number(result[key]) < 1 || Number(result[key]) > 65535)
      throw new Error("probe ports must be 1–65535");
  return result;
}

export function fixtureMatches(namespace, source, control, options) {
  const label = "paseo-gateway.manziman.github.io/qualification-run";
  return (
    namespace?.metadata?.uid === options["namespace-uid"] &&
    namespace.metadata?.labels?.[label] === options["run-label"] &&
    source?.metadata?.uid === options["source-uid"] &&
    control?.metadata?.uid === options["control-uid"] &&
    [source, control].every(
      (pod) =>
        pod.metadata?.namespace === options.namespace &&
        pod.metadata?.labels?.[label] === options["run-label"] &&
        pod.status?.phase === "Running" &&
        pod.spec?.hostNetwork !== true,
    ) &&
    source.spec?.containers?.some((container) => container.name === options["source-container"]) &&
    control.spec?.containers?.some((container) => container.name === options["control-container"])
  );
}

function kubectl(options, args) {
  return spawnSync(
    "kubectl",
    [
      "--context",
      options.context,
      "--namespace",
      options.namespace,
      "--request-timeout=15s",
      ...args,
    ],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
}

function getJson(options, args) {
  const result = kubectl(options, args);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function tcp(options, pod, container, host, port) {
  const result = kubectl(options, [
    "exec",
    pod,
    "-c",
    container,
    "--",
    "node",
    "-e",
    probeCode,
    host,
    String(port),
  ]);
  return result.status === 0 ? "reachable" : result.status === 5 ? "unreachable" : "unknown";
}

export function grade(observations) {
  const check = (id, pass, known) => ({ id, status: !known ? "BLOCKED" : pass ? "PASS" : "FAIL" });
  const {
    allowed,
    crossSource,
    crossControl,
    deniedSource,
    deniedControl,
    metadataSource,
    metadataControl,
  } = observations;
  return {
    schemaVersion: 1,
    mode: "namespaced-network-probes",
    checks: [
      check("network.allowed", allowed === "reachable", allowed !== "unknown"),
      check(
        "network.cross-workspace-denied",
        crossSource === "unreachable" && crossControl === "reachable",
        crossSource !== "unknown" && crossControl !== "unknown",
      ),
      check(
        "network.disallowed-egress-denied",
        deniedSource === "unreachable" && deniedControl === "reachable",
        deniedSource !== "unknown" && deniedControl !== "unknown",
      ),
      check(
        "network.metadata-denied",
        metadataSource === "unreachable" && metadataControl === "reachable",
        metadataSource !== "unknown" && metadataControl !== "unknown",
      ),
    ],
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Explicit run gate and all fixture arguments required; see docs/eks-qualification.md\n",
    );
    process.exitCode = 2;
    return;
  }
  const namespace = getJson(options, ["get", "namespace", options.namespace, "-o", "json"]);
  const source = getJson(options, ["get", "pod", options["source-pod"], "-o", "json"]);
  const control = getJson(options, ["get", "pod", options["control-pod"], "-o", "json"]);
  if (!fixtureMatches(namespace, source, control, options)) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, mode: "namespaced-network-probes", qualification: "BLOCKED", reason: "Fixture ownership, UID, status or container could not be verified" })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const src = [options["source-pod"], options["source-container"]];
  const ctl = [options["control-pod"], options["control-container"]];
  const report = grade({
    allowed: tcp(options, ...src, options["allowed-ip"], options["allowed-port"]),
    crossSource: tcp(
      options,
      ...src,
      options["cross-workspace-ip"],
      options["cross-workspace-port"],
    ),
    crossControl: tcp(
      options,
      ...ctl,
      options["cross-workspace-ip"],
      options["cross-workspace-port"],
    ),
    deniedSource: tcp(options, ...src, options["denied-ip"], options["denied-port"]),
    deniedControl: tcp(options, ...ctl, options["denied-ip"], options["denied-port"]),
    metadataSource: tcp(options, ...src, "169.254.169.254", 80),
    metadataControl: tcp(options, ...ctl, "169.254.169.254", 80),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.checks.every((item) => item.status === "PASS") ? 0 : 1;
}

if (process.argv[1]?.endsWith("eks-network-probes.mjs")) main();
