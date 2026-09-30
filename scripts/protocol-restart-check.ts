import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { CoreV1Api } from "@kubernetes/client-node";
import WebSocket from "ws";
import { resourceName } from "../src/controller/resources.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { ProtocolLiveConfigSchema } from "./protocol-live-config.js";

// Reads an earlier protocol-live fixture through a new process/client after a
// gateway replacement. Only its unique acceptance label is changed/deleted.
const [configPath, cleanupPath, reportPath] = process.argv.slice(2);
if (!configPath || !cleanupPath || !reportPath)
  throw new Error(
    "Usage: node --import tsx scripts/protocol-restart-check.ts CONFIG CLEANUP REPORT",
  );
const config = ProtocolLiveConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const cleanup = JSON.parse(await readFile(cleanupPath, "utf8")) as {
  context: string;
  namespace: string;
  workspaceId: string;
  agentId: string;
  state: string;
};
assert.equal(cleanup.context, config.context);
assert.equal(cleanup.namespace, config.namespace);
assert.equal(cleanup.state, "Suspended");
assert.ok(cleanup.workspaceId && cleanup.agentId);

const cluster = loadKubernetesConfig(config.context);
const store = new KubernetesStore(cluster, config.namespace);
const api = cluster.makeApiClient(CoreV1Api);
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
let stage = "initial-state";
const checks: { check: string; status: "passed" | "failed" }[] = [];
let gatewayImageDigest: string | undefined;

async function currentWorkspace() {
  const row = (await store.workspaces()).find(
    (entry) => entry.metadata.name === cleanup.workspaceId,
  );
  assert.ok(row?.metadata.uid);
  assert.equal(row.spec.residency, "Suspended");
  assert.equal(row.status?.phase, "Suspended");
  const pods = await api.listNamespacedPod({
    namespace: config.namespace,
    fieldSelector: `metadata.name=${resourceName(row)}`,
  });
  assert.equal(pods.items.length, 0, "Suspended fixture unexpectedly has a Pod");
  return row;
}

try {
  const original = await currentWorkspace();
  const gatewayPods = await api.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  gatewayImageDigest = /sha256:[a-f0-9]{64}/.exec(
    gatewayPods.items[0]?.status?.containerStatuses?.[0]?.imageID ?? "",
  )?.[0];
  const secret = await api.readNamespacedSecret({
    namespace: config.namespace,
    name: config.identitySecret,
  });
  const password = Buffer.from(secret.data?.password ?? "", "base64").toString();
  assert.ok(password);
  proxy = spawn(
    "kubectl",
    [
      "--context",
      config.context,
      "-n",
      config.namespace,
      "port-forward",
      "--address",
      "127.0.0.1",
      "service/paseo-gateway",
      ":8080",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PortForwardTimeout")), 15000);
    proxy?.stdout?.on("data", (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    proxy?.once("error", reject);
    proxy?.once("exit", () => reject(new Error("PortForwardExited")));
  });
  const ca = await readFile(config.tls.caFile, "utf8");
  const transportFactory = createWebSocketTransportFactory((address, options) => {
    const socket = new WebSocket(address, options?.protocols, {
      headers: options?.headers,
      agent: new HttpsAgent({ ca, servername: config.tls.serverName, rejectUnauthorized: true }),
      rejectUnauthorized: true,
      perMessageDeflate: false,
    });
    return {
      get readyState() {
        return socket.readyState;
      },
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      on: (event, listener) => socket.on(event, listener),
      off: (event, listener) => socket.off(event, listener),
    };
  });
  client = new DaemonClient({
    transportFactory,
    url: `wss://127.0.0.1:${port}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();

  stage = "retained-after-gateway-restart";
  const workspaces = await client.fetchWorkspaces();
  const descriptor = workspaces.entries.find((entry) => entry.id === cleanup.workspaceId);
  assert.ok(descriptor);
  const ownedLabels = (descriptor.labels ?? []).filter((name) =>
    /^acceptance-[0-9a-f]{8}$/.test(name),
  );
  assert.equal(ownedLabels.length, 1, "Expected exactly one owned acceptance label");
  const label = ownedLabels[0];
  assert.ok(label);
  const listed = await client.listWorkspaceLabels();
  assert.ok(listed.labels.some((entry) => entry.name === label && entry.color === "teal"));
  const agents = await client.fetchAgents({ filter: { projectKeys: [config.project] } });
  const retained = agents.entries.find((entry) => entry.agent.id === cleanup.agentId);
  assert.ok(retained);
  assert.equal(retained.agent.status, "closed");
  assert.equal(retained.agent.providerUnavailable, true);
  assert.equal(retained.agent.labels["paseo-gateway.availability"], "suspended");
  assert.ok(retained.agent.labels["paseo-gateway.captured-at"]);
  assert.equal((await currentWorkspace()).metadata.uid, original.metadata.uid);
  checks.push({ check: stage, status: "passed" });

  stage = "owned-label-update-delete";
  const updated = await client.updateWorkspaceLabel({ name: label, color: "blue" });
  assert.equal(updated.label?.color, "blue");
  assert.ok(
    (await client.listWorkspaceLabels()).labels.some(
      (entry) => entry.name === label && entry.color === "blue",
    ),
  );
  assert.ok(
    (await client.fetchWorkspaces()).entries
      .find((entry) => entry.id === cleanup.workspaceId)
      ?.labels?.includes(label),
  );
  const deleted = await client.deleteWorkspaceLabel({ name: label });
  assert.equal(deleted.affectedWorkspaceCount, 1);
  assert.ok(!(await client.listWorkspaceLabels()).labels.some((entry) => entry.name === label));
  assert.ok(
    !(await client.fetchWorkspaces()).entries
      .find((entry) => entry.id === cleanup.workspaceId)
      ?.labels?.includes(label),
  );
  assert.equal((await currentWorkspace()).metadata.uid, original.metadata.uid);
  checks.push({ check: stage, status: "passed" });
} catch {
  checks.push({ check: stage, status: "failed" });
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined);
  proxy?.kill();
  await writeFile(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), gatewayImageDigest, checks }, null, 2),
  );
}
