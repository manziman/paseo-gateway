#!/usr/bin/env node
// Read-only local fixture probe: no resource mutations, Secret reads, or target identities in output.
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";

const expected = ["context", "namespace", "gateway-pod", "workspace-pod"];
const plaintextProbe = `
const net = require("node:net");
const deadline = 3000;
const reachable = (host) => new Promise((resolve) => {
  const socket = net.connect({ host, port: 6767 });
  const end = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(deadline, () => end(false));
  socket.once("connect", () => end(true));
  socket.once("error", () => end(false));
});
(async () => {
  const [podReachable, loopbackReachable] = await Promise.all([
    reachable(process.argv[1]),
    reachable("127.0.0.1"),
  ]);
  process.stdout.write(JSON.stringify({ podPlaintextRefused: !podReachable, daemonLoopbackReachable: loopbackReachable }));
})().catch(() => process.exitCode = 1);
`;
const tlsProbe = `
const tls = require("node:tls");
const deadline = 3000;
const verified = (host) => new Promise((resolve) => {
  const socket = tls.connect({ host, port: 6767, servername: host, minVersion: "TLSv1.2", rejectUnauthorized: true });
  const end = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(deadline, () => end(false));
  socket.once("secureConnect", () => end(socket.authorized && !socket.authorizationError));
  socket.once("error", () => end(false));
});
(async () => {
  process.stdout.write(JSON.stringify({ serviceTlsVerified: await verified(process.argv[1]) }));
})().catch(() => process.exitCode = 1);
`;

export function parseArgs(argv) {
  if (argv[0] !== "--run-local-probe") throw new Error("explicit local probe gate required");
  const result = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!expected.includes(key) || !argv[index + 1] || result[key])
      throw new Error("explicit context, namespace, and fixture Pods required");
    result[key] = argv[index + 1];
  }
  if (!expected.every((key) => result[key]) || result["gateway-pod"] === result["workspace-pod"])
    throw new Error("explicit context, namespace, and distinct fixture Pods required");
  return result;
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

function getJson(options, kind, name) {
  const result = kubectl(options, ["get", kind, name, "-o", "json"]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function fixtureMatches(gateway, workspace, service, options) {
  const ready = (pod) =>
    pod?.metadata?.namespace === options.namespace &&
    !!pod.metadata.uid &&
    pod.status?.phase === "Running" &&
    pod.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) &&
    pod.spec?.hostNetwork !== true;
  return !!(
    ready(gateway) &&
    ready(workspace) &&
    gateway.metadata.name === options["gateway-pod"] &&
    workspace.metadata.name === options["workspace-pod"] &&
    gateway.metadata.labels?.["app.kubernetes.io/component"] === "gateway" &&
    workspace.metadata.labels?.["app.kubernetes.io/component"] === "workspace" &&
    gateway.spec.containers?.some((container) => container.name === "gateway") &&
    workspace.spec.containers?.some((container) => container.name === "transport") &&
    workspace.spec.containers?.some((container) => container.name === "daemon") &&
    isIP(workspace.status.podIP) &&
    service?.metadata?.namespace === options.namespace &&
    service.metadata.name === options["workspace-pod"] &&
    service?.spec?.ports?.some((port) => port.port === 6767 && port.targetPort === 6768) &&
    Object.keys(service.spec.selector ?? {}).length > 0 &&
    Object.entries(service.spec.selector ?? {}).every(
      ([key, value]) => workspace.metadata.labels?.[key] === value,
    )
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Explicit local probe gate and context, namespace, and Pod flags required\n",
    );
    process.exitCode = 2;
    return;
  }
  const gateway = getJson(options, "pod", options["gateway-pod"]);
  const workspace = getJson(options, "pod", options["workspace-pod"]);
  const service = getJson(options, "service", options["workspace-pod"]);
  let report = {
    schemaVersion: 1,
    mode: "local-transport-probe",
    checks: [
      { id: "daemon-loopback-reachable", status: "BLOCKED" },
      { id: "pod-plaintext-refused", status: "BLOCKED" },
      { id: "service-tls-verified", status: "BLOCKED" },
    ],
  };
  if (fixtureMatches(gateway, workspace, service, options)) {
    const name = `${options["workspace-pod"]}.${options.namespace}.svc`;
    const plaintext = kubectl(options, [
      "exec",
      options["workspace-pod"],
      "-c",
      "transport",
      "--",
      "node",
      "-e",
      plaintextProbe,
      workspace.status.podIP,
    ]);
    const secure = kubectl(options, [
      "exec",
      options["gateway-pod"],
      "-c",
      "gateway",
      "--",
      "node",
      "-e",
      tlsProbe,
      name,
    ]);
    if (plaintext.status === 0 && secure.status === 0) {
      try {
        const observedPlaintext = JSON.parse(plaintext.stdout);
        const observedTls = JSON.parse(secure.stdout);
        const afterGateway = getJson(options, "pod", options["gateway-pod"]);
        const afterWorkspace = getJson(options, "pod", options["workspace-pod"]);
        if (
          afterGateway?.metadata?.uid === gateway.metadata.uid &&
          afterWorkspace?.metadata?.uid === workspace.metadata.uid
        )
          report = {
            ...report,
            checks: [
              {
                id: "daemon-loopback-reachable",
                status: observedPlaintext.daemonLoopbackReachable === true ? "PASS" : "FAIL",
              },
              {
                id: "pod-plaintext-refused",
                status: observedPlaintext.podPlaintextRefused === true ? "PASS" : "FAIL",
              },
              {
                id: "service-tls-verified",
                status: observedTls.serviceTlsVerified === true ? "PASS" : "FAIL",
              },
            ],
          };
      } catch {
        // Unreadable result remains BLOCKED and never prints Pod or endpoint details.
      }
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.checks.every((check) => check.status === "PASS") ? 0 : 1;
}

if (process.argv[1]?.endsWith("local-transport-probe.mjs")) main();
