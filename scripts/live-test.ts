import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { resourceName } from "../src/controller/resources.js";
import { API_GROUP, API_VERSION, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { startActiveTurn, verifyActiveTurn } from "./active-turn.js";
import { context, namespace } from "./local-config.js";

const config = loadKubernetesConfig(context);
const api = config.makeApiClient(CoreV1Api);
const store = new KubernetesStore(config, namespace);
const identity = await api.readNamespacedSecret({ namespace, name: "paseo-identity" });
const encoded = identity.data?.password;
if (!encoded) throw new Error("Run npm run dev:up first");
const password = Buffer.from(encoded, "base64").toString("utf8");
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
let observedServerId: string | undefined;

async function connect() {
  proxy = spawn(
    "kubectl",
    [
      "--context",
      context,
      "--namespace",
      namespace,
      "port-forward",
      "--address",
      "127.0.0.1",
      "service/paseo-gateway",
      ":8080",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway port-forward did not start")), 15000);
    proxy?.stdout?.on("data", (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proxy?.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Cannot start kubectl"));
    });
    proxy?.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Port-forward exited"));
    });
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client.on("status", (message) => {
    if (message.payload.status === "server_info" && typeof message.payload.serverId === "string")
      observedServerId = message.payload.serverId;
  });
  await client.connect();
  return client;
}

async function eventually<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const providerTest = process.env.RUN_CLAUDE_LIVE === "1";
  let projectId: string | undefined;
  if (!providerTest) {
    // Separate, explicitly unusable credentials let infrastructure checks run without a model account.
    projectId = `infra-${randomUUID()}`;
    await api.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: projectId, namespace },
        type: "Opaque",
        stringData: { token: "infrastructure-test-no-provider-access" },
      },
    });
    await config.makeApiClient(CustomObjectsApi).createNamespacedCustomObject({
      group: API_GROUP,
      version: "v1alpha1",
      namespace,
      plural: "paseoprojects",
      body: {
        apiVersion: API_VERSION,
        kind: "PaseoProject",
        metadata: { name: projectId, namespace },
        spec: {
          displayName: "Infrastructure test (no Claude credentials)",
          repository: "https://github.com/octocat/Hello-World.git",
          revision: "HEAD",
          credentialProfile: projectId,
        },
      },
    });
  } else {
    const profile = await api.readNamespacedSecret({ namespace, name: "claude-default" });
    if (!profile.data?.token)
      throw new Error("Import a Claude subscription token before provider acceptance");
    projectId = (await store.projects()).find((p) => p.spec.credentialProfile === "claude-default")
      ?.metadata.name;
  }
  let active = await connect();
  const projects = await active.listProjects();
  const project = projects.projects.find((p) => p.projectId === projectId);
  if (!project) throw new Error("Configure a project first");
  const workspaces = [];
  for (const name of ["Live one", "Live two"]) {
    const response = await active.createWorkspace({
      title: name,
      source: { kind: "directory", path: project.projectRootPath, projectId: project.projectId },
    });
    if (!response.workspace) throw new Error(response.error ?? "Workspace creation failed");
    workspaces.push(response.workspace);
    console.log(`Created retained live-test workspace: ${response.workspace.id}`);
  }
  for (const workspace of workspaces) {
    await eventually(
      async () =>
        (await store.workspaces()).find(
          (w) => w.metadata.name === workspace.id && w.status?.phase === "Ready",
        ),
      "workspace readiness",
    );
    const created = await active.createFileEntry({
      cwd: workspacePath(workspace.id),
      parentPath: ".",
      name: "paseo-live-marker.txt",
      kind: "file",
    });
    assert.equal(created.error, null);
    const initial = await active.readFile(workspacePath(workspace.id), "paseo-live-marker.txt");
    const written = await active.writeFile({
      cwd: workspacePath(workspace.id),
      path: "paseo-live-marker.txt",
      content: workspace.id,
      expectedModifiedAt: initial.modifiedAt,
      expectedRevision: initial.revision,
    });
    assert.equal(written.status, "written");
  }
  console.log("PASS: two Kubernetes workspaces are ready; isolated file writes succeeded.");
  const providerAgents: { id: string; marker: string }[] = [];
  async function verifyProviderTimelines(connection: DaemonClient) {
    for (const agent of providerAgents) {
      const timeline = await connection.fetchAgentTimeline(agent.id);
      assert.equal(timeline.error, null);
      assert.ok(
        timeline.entries.some(
          (entry) =>
            entry.item.type === "assistant_message" && entry.item.text.includes(agent.marker),
        ),
        "Expected the workspace-specific assistant response",
      );
      assert.equal(
        timeline.entries.filter(
          (entry) => entry.item.type === "user_message" && entry.item.text.includes(agent.marker),
        ).length,
        1,
        "The original prompt must appear exactly once after recovery",
      );
    }
  }
  if (providerTest) {
    const agents = await Promise.all(
      workspaces.map((workspace) =>
        active.createAgent({
          config: { provider: "claude", cwd: workspacePath(workspace.id) },
          workspaceId: workspace.id,
          initialPrompt: `Reply with exactly PASEO_LIVE_OK_${workspace.id}. Do not use tools or modify files.`,
        }),
      ),
    );
    for (const [index, agent] of agents.entries()) {
      const workspace = workspaces[index];
      assert.ok(workspace);
      providerAgents.push({ id: agent.id, marker: `PASEO_LIVE_OK_${workspace.id}` });
      const finished = await active.waitForFinish(agent.id, 120000);
      assert.equal(finished.status, "idle", "Claude must finish successfully");
    }
    await verifyProviderTimelines(active);
    console.log("PASS: concurrent Claude subscription prompts and recovered timelines.");
  }
  const first = workspaces[0];
  if (!first) throw new Error("Missing workspace");
  const row = (await store.workspaces()).find((w) => w.metadata.name === first.id);
  if (!row) throw new Error("Missing workspace record");
  // Replace the gateway while workspace processes stay alive; no provider request is replayed.
  const initialServerId = observedServerId;
  assert.ok(initialServerId);
  const initialDirectory = await active.fetchWorkspaces();
  assert.ok(initialDirectory.sync?.generation);
  const terminal = await active.createTerminal(workspacePath(first.id), "Gateway recovery test");
  assert.ok(terminal.terminal);
  const workspacePodsBefore = await Promise.all(
    workspaces.map(async (entry) => {
      const record = (await store.workspaces()).find((w) => w.metadata.name === entry.id);
      if (!record) throw new Error("Workspace record disappeared");
      const pod = await api.readNamespacedPod({ namespace, name: resourceName(record) });
      return { name: resourceName(record), uid: pod.metadata?.uid };
    }),
  );
  const gatewayPods = await api.listNamespacedPod({
    namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  const gatewayPod = gatewayPods.items.find((pod) => !pod.metadata?.deletionTimestamp);
  if (!gatewayPod?.metadata?.name || !gatewayPod.metadata.uid) throw new Error("No gateway pod");
  const activeTurn = providerTest ? await startActiveTurn(active, first.id) : undefined;
  await active.close();
  proxy?.kill();
  await api.deleteNamespacedPod({
    namespace,
    name: gatewayPod.metadata.name,
    body: { preconditions: { uid: gatewayPod.metadata.uid } },
  });
  await eventually(
    async () =>
      (
        await api.listNamespacedPod({
          namespace,
          labelSelector: "app.kubernetes.io/component=gateway",
        })
      ).items.find(
        (pod) =>
          pod.metadata?.uid !== gatewayPod.metadata?.uid &&
          !pod.metadata?.deletionTimestamp &&
          pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      ),
    "gateway replacement",
  );
  active = await connect();
  assert.equal(observedServerId, initialServerId);
  if (activeTurn) {
    await verifyActiveTurn(active, activeTurn);
    providerAgents.push(activeTurn);
  }
  await verifyProviderTimelines(active);
  const newDirectory = await active.fetchWorkspaces();
  assert.ok(newDirectory.sync?.generation);
  assert.notEqual(newDirectory.sync.generation, initialDirectory.sync.generation);
  const retainedTerminals = await active.listTerminals(workspacePath(first.id));
  assert.ok(retainedTerminals.terminals.some((entry) => entry.id === terminal.terminal?.id));
  for (const before of workspacePodsBefore) {
    const after = await api.readNamespacedPod({ namespace, name: before.name });
    assert.equal(after.metadata?.uid, before.uid);
  }
  console.log(
    "PASS: gateway replacement retains host identity, workspace pods and terminals; directory generation changes.",
  );
  const podName = resourceName(row);
  const oldPod = await api.readNamespacedPod({ namespace, name: podName });
  const oldPvc = await api.readNamespacedPersistentVolumeClaim({ namespace, name: podName });
  await active.close();
  proxy?.kill();
  await api.deleteNamespacedPod({
    namespace,
    name: podName,
    body: { preconditions: { uid: oldPod.metadata?.uid } },
  });
  await eventually(async () => {
    const current = (await store.workspaces()).find((w) => w.metadata.name === row.metadata.name);
    if (current?.status?.phase !== "Ready") return undefined;
    try {
      const pod = await api.readNamespacedPod({ namespace, name: podName });
      return pod.metadata?.uid !== oldPod.metadata?.uid &&
        pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
        ? pod
        : undefined;
    } catch {
      return undefined;
    }
  }, "replacement pod readiness");
  active = await connect();
  await verifyProviderTimelines(active);
  const recovered = await active.readFile(workspacePath(first.id), "paseo-live-marker.txt");
  assert.equal(Buffer.from(recovered.bytes).toString("utf8"), first.id);
  const currentPvc = await api.readNamespacedPersistentVolumeClaim({ namespace, name: podName });
  assert.equal(currentPvc.metadata?.uid, oldPvc.metadata?.uid);
  console.log("PASS: Kubernetes pod replacement preserves the same PVC and workspace file.");
  await active.close();
  proxy?.kill();
  let current = (await store.workspaces()).find((w) => w.metadata.name === row.metadata.name);
  if (!current) throw new Error("Missing workspace record");
  await store.setResidency(current, "Suspended");
  await eventually(
    async () =>
      (await store.workspaces()).find(
        (w) => w.metadata.name === row.metadata.name && w.status?.phase === "Suspended",
      ),
    "workspace suspension",
  );
  assert.equal(await store.get("Pod", podName), undefined);
  current = (await store.workspaces()).find((w) => w.metadata.name === row.metadata.name);
  if (!current) throw new Error("Missing suspended workspace");
  await store.setResidency(current, "Running");
  await eventually(
    async () =>
      (await store.workspaces()).find(
        (w) => w.metadata.name === row.metadata.name && w.status?.phase === "Ready",
      ),
    "workspace resumption",
  );
  active = await connect();
  await verifyProviderTimelines(active);
  const resumed = await active.readFile(workspacePath(first.id), "paseo-live-marker.txt");
  assert.equal(Buffer.from(resumed.bytes).toString("utf8"), first.id);
  assert.equal(
    (await api.readNamespacedPersistentVolumeClaim({ namespace, name: podName })).metadata?.uid,
    oldPvc.metadata?.uid,
  );
  console.log("PASS: suspend/resume retains the same PVC and workspace file.");
  if (providerTest)
    console.log(
      "PASS: all three Claude timelines and single prompt occurrences survive gateway replacement, pod replacement and suspend/resume.",
    );
  console.log(
    "Workspaces retained for desktop inspection. Archive them through the client to stop compute.",
  );
} finally {
  await client?.close();
  proxy?.kill();
}
