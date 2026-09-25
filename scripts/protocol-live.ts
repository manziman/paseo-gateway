import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { CoreV1Api } from "@kubernetes/client-node";
import WebSocket from "ws";
import { resourceName } from "../src/controller/resources.js";
import { parseScopedId, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { ProtocolLiveConfigSchema } from "./protocol-live-config.js";

// This harness owns one workspace. Configuration and cleanup identities remain private.
const configPath = process.argv[2];
const reportPath = process.argv[3];
if (!configPath || !reportPath)
  throw new Error("Usage: node --import tsx scripts/protocol-live.ts CONFIG.json REPORT.json");
const config = ProtocolLiveConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const cluster = loadKubernetesConfig(config.context);
const store = new KubernetesStore(cluster, config.namespace);
const api = cluster.makeApiClient(CoreV1Api);
const report: { check: string; status: "passed" | "failed"; reason?: string }[] = [];
const meta: { generatedAt: string; gatewayImageDigest?: string; workspaceImageDigest?: string } = {
  generatedAt: new Date().toISOString(),
};
const privateCleanup: {
  context: string;
  namespace: string;
  workspaceId?: string;
  agentId?: string;
  scheduleId?: string;
  state?: string;
  socketConnectedAtSuspension?: boolean;
} = { context: config.context, namespace: config.namespace };
let proxy: ChildProcess | undefined;
let forwardedPort: number | undefined;
let client: DaemonClient | undefined;
let stage = "connect";

async function eventually<T>(read: () => Promise<T | undefined>, attempts = 120): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(2000);
  }
  throw new Error("AcceptanceDeadlineExceeded");
}

async function connect(): Promise<DaemonClient> {
  const secret = await api.readNamespacedSecret({
    namespace: config.namespace,
    name: config.identitySecret,
  });
  const password = Buffer.from(secret.data?.password ?? "", "base64").toString();
  if (!password) throw new Error("GatewayIdentityMissing");
  if (!proxy) {
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
    forwardedPort = await new Promise<number>((resolve, reject) => {
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
  }
  if (!forwardedPort) throw new Error("PortForwardUnavailable");
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
    url: `wss://127.0.0.1:${forwardedPort}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  return client;
}

try {
  let active = await connect();
  stage = "workspace-ready";
  const project = (await active.listProjects()).projects.find(
    (row) => row.projectId === config.project,
  );
  assert.ok(project, "Configured project unavailable");
  const created = await active.createWorkspace({
    title: `Protocol acceptance ${randomUUID().slice(0, 8)}`,
    source: {
      kind: "directory",
      projectId: config.project,
      path: workspacePath(config.project),
    },
  });
  assert.ok(created.workspace);
  const workspaceId = created.workspace.id;
  privateCleanup.workspaceId = workspaceId;
  await eventually(async () => {
    const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
    if (row?.status?.phase === "Failed") throw new Error("WorkspaceFailed");
    return row?.status?.phase === "Ready" ? true : undefined;
  });
  const currentWorkspace = (await store.workspaces()).find(
    (entry) => entry.metadata.name === workspaceId,
  );
  if (currentWorkspace) {
    const pod = await api.readNamespacedPod({
      namespace: config.namespace,
      name: resourceName(currentWorkspace),
    });
    meta.workspaceImageDigest = /sha256:[a-f0-9]{64}/.exec(
      pod.status?.containerStatuses?.[0]?.imageID ?? "",
    )?.[0];
  }
  const gatewayPods = await api.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  meta.gatewayImageDigest = /sha256:[a-f0-9]{64}/.exec(
    gatewayPods.items[0]?.status?.containerStatuses?.[0]?.imageID ?? "",
  )?.[0];
  const initialMarker = `READY_${randomUUID().replaceAll("-", "")}`;
  stage = "initial-agent";
  const agent = await active.createAgent({
    workspaceId,
    config: {
      provider: "claude",
      cwd: workspacePath(workspaceId),
      modeId: "bypassPermissions",
    },
    initialPrompt: `Reply with exactly ${initialMarker}. Do not use tools.`,
  });
  privateCleanup.agentId = agent.id;
  assert.equal((await active.waitForFinish(agent.id, 180000)).status, "idle");
  const firstTimeline = await active.fetchAgentTimeline(agent.id);
  assert.ok(firstTimeline.entries.some((entry) => entry.item.type === "assistant_message"));
  report.push({ check: "existing-agent-ready", status: "passed" });

  const label = `acceptance-${randomUUID().slice(0, 8)}`;
  stage = "workspace-label";
  const assigned = await active.setWorkspaceLabel({
    workspaceId,
    label: { name: label, color: "teal" },
    assigned: true,
  });
  assert.ok(assigned.workspaceLabels.includes(label));
  assert.ok((await active.listWorkspaceLabels()).labels.some((entry) => entry.name === label));
  await active.close();
  active = await connect();
  assert.ok((await active.listWorkspaceLabels()).labels.some((entry) => entry.name === label));
  assert.ok(
    (await active.fetchWorkspaces()).entries.some(
      (entry) => entry.id === workspaceId && !!entry.labels?.includes(label),
    ),
  );
  report.push({ check: "workspace-label-reconnect", status: "passed" });

  const marker = `SCHEDULE_${randomUUID().replaceAll("-", "")}`;
  stage = "schedule-create";
  const targetId = parseScopedId(agent.id).backendId;
  const scheduled = await active.scheduleCreate({
    name: "Existing agent acceptance",
    prompt: "Placeholder prompt",
    cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
    target: { type: "agent", agentId: targetId },
    runOnCreate: false,
  });
  assert.ok(scheduled.schedule && !scheduled.error, "Schedule creation failed");
  const scheduleId = scheduled.schedule.id;
  privateCleanup.scheduleId = scheduleId;
  assert.ok((await active.scheduleList()).schedules.some((entry) => entry.id === scheduleId));
  assert.equal((await active.schedulePause({ id: scheduleId })).schedule?.status, "paused");
  assert.equal((await active.scheduleResume({ id: scheduleId })).schedule?.status, "active");
  const updated = await active.scheduleUpdate({
    id: scheduleId,
    prompt: `Reply with exactly ${marker}. Do not use tools.`,
  });
  assert.equal(updated.schedule?.prompt, `Reply with exactly ${marker}. Do not use tools.`);
  assert.equal((await active.scheduleInspect({ id: scheduleId })).schedule?.target.type, "agent");
  await active.scheduleRunOnce({ id: scheduleId });
  stage = "schedule-run";
  const run = await eventually(async () => {
    const logs = await active.scheduleLogs({ id: scheduleId });
    const entry = logs.runs[0];
    if (entry?.status === "failed") throw new Error("ScheduledRunFailed");
    return entry?.status === "succeeded" ? entry : undefined;
  }, 150);
  assert.equal(run.workspaceId, workspaceId);
  assert.equal(run.agentId, targetId);
  const timeline = await active.fetchAgentTimeline(agent.id);
  assert.equal(
    timeline.entries.filter(
      (entry) => entry.item.type === "user_message" && entry.item.text.includes(marker),
    ).length,
    1,
  );
  assert.ok(
    timeline.entries.some(
      (entry) => entry.item.type === "assistant_message" && entry.item.text.includes(marker),
    ),
  );
  assert.equal(
    (await store.workspaces()).find((row) => row.metadata.name === workspaceId)?.spec.residency,
    "Running",
  );
  report.push({ check: "existing-agent-schedule-single-prompt", status: "passed" });
  await active.schedulePause({ id: scheduleId });
  await active.scheduleDelete({ id: scheduleId });
  privateCleanup.scheduleId = undefined;

  const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
  stage = "suspend-inventory";
  assert.ok(row);
  await store.setResidency(row, "Suspended");
  await eventually(async () => {
    const current = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
    if (current?.status?.phase === "Failed") throw new Error("SuspensionFailed");
    return current?.status?.phase === "Suspended" ? true : undefined;
  });
  privateCleanup.state = "Suspended";
  privateCleanup.socketConnectedAtSuspension = active.isConnected;
  // Stopping the backend closes the gateway socket. Reconnect to observe the
  // retained control-plane snapshot; never replay the prior agent mutation.
  stage = "reconnect-after-suspend";
  await active.close().catch(() => {});
  active = await connect();
  stage = "suspend-inventory";
  const retained = await active.fetchAgents({ filter: { projectKeys: [config.project] } });
  const entry = retained.entries.find((item) => item.agent.id === agent.id);
  assert.ok(entry, "Suspended agent absent from retained inventory");
  stage = "suspend-status";
  assert.equal(entry.agent.status, "closed");
  stage = "suspend-provider";
  assert.equal(entry.agent.providerUnavailable, true);
  stage = "suspend-availability";
  assert.equal(entry.agent.labels["paseo-gateway.availability"], "suspended");
  stage = "suspend-capture-time";
  assert.ok(entry.agent.labels["paseo-gateway.captured-at"]);
  report.push({ check: "suspended-inventory-captured", status: "passed" });
} catch {
  report.push({
    check: stage,
    status: "failed",
    reason: "InspectPrivateCleanupAndGatewayEvents",
  });
  process.exitCode = 1;
} finally {
  try {
    if (privateCleanup.scheduleId && client)
      await client.schedulePause({ id: privateCleanup.scheduleId });
  } catch {
    privateCleanup.state = "SchedulePauseUnconfirmed";
  }
  try {
    await client?.close();
  } catch {
    /* Report cleanup separately. */
  }
  proxy?.kill();
  await writeFile(reportPath, JSON.stringify({ ...meta, checks: report }, null, 2));
  const privatePath = `${reportPath}.cleanup-private.json`;
  await writeFile(privatePath, JSON.stringify(privateCleanup, null, 2), { mode: 0o600 });
  await chmod(privatePath, 0o600);
  console.log(JSON.stringify({ ...meta, checks: report }));
}
