import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resourceName } from "../src/controller/resources.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { liveConnection, liveConnectionConfig } from "./live-connection.js";
import { context, namespace } from "./local-config.js";

// Creates and archives one test workspace; external Git operations are read-only.
if (process.env.RUN_CHECKOUT_LIVE !== "1")
  throw new Error("Set RUN_CHECKOUT_LIVE=1 to create an authorized PR checkout workspace");
const projectId = process.env.PASEO_TEST_PROJECT;
const rawPr = process.env.PASEO_TEST_PR ?? "";
const pullRequest = Number(rawPr);
if (
  !projectId ||
  !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(projectId) ||
  !/^[1-9]\d*$/.test(rawPr) ||
  !Number.isSafeInteger(pullRequest)
)
  throw new Error("Set PASEO_TEST_PROJECT and a positive integer PASEO_TEST_PR");

const connectionConfig = await liveConnectionConfig();
const store = new KubernetesStore(loadKubernetesConfig(context), namespace);
assert.ok((await store.projects()).some((row) => row.metadata.name === projectId));
const encoded = (await store.secret(connectionConfig.identitySecret)).data?.password;
assert.ok(encoded, "Gateway identity is unavailable");
const execute = promisify(execFile);
async function git(pod: string, args: string[]) {
  try {
    const result = await execute(
      "kubectl",
      ["--context", context, "-n", namespace, "exec", pod, "-c", "daemon", "--", "git", ...args],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim();
  } catch {
    throw new Error("Read-only Git verification failed; inspect protected workspace logs");
  }
}
async function eventually<T>(read: () => Promise<T | undefined>, label: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function inventory(client: DaemonClient) {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await client.fetchAgents({
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of response.entries) ids.add(entry.agent.id);
    cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    assert.ok(!response.pageInfo.hasMore || cursor, "Inventory must provide its next cursor");
    if (cursor) {
      assert.ok(!cursors.has(cursor), "Inventory pagination must advance");
      cursors.add(cursor);
    }
  } while (cursor);
  return ids;
}

const proxy = spawn(
  "kubectl",
  [
    "--context",
    context,
    "-n",
    namespace,
    "port-forward",
    "--address",
    "127.0.0.1",
    "service/paseo-gateway",
    ":8080",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let client: DaemonClient | undefined;
try {
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Port-forward timed out")), 15000);
    let output = "";
    proxy.stdout.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-2048);
      const match = /127\.0\.0\.1:(\d+)/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    for (const event of ["error", "exit"] as const)
      proxy.once(event, () => {
        clearTimeout(timer);
        reject(new Error("Port-forward unavailable"));
      });
    // Drain diagnostics without printing potentially sensitive cluster output.
    proxy.stderr.resume();
  });
  const connection = liveConnection(port, connectionConfig);
  client = new DaemonClient({
    url: connection.url,
    transportFactory: connection.transportFactory,
    password: Buffer.from(encoded, "base64").toString("utf8"),
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  const before = await inventory(client);
  const response = await client.createWorkspace({
    title: `PR checkout acceptance ${randomUUID().slice(0, 8)}`,
    idempotencyKey: `checkout-acceptance-${randomUUID()}`,
    source: {
      kind: "worktree",
      projectId,
      action: "checkout",
      checkoutSource: { kind: "change_request", forge: "github", number: pullRequest },
    },
    onEvent: (snapshot) => {
      if (snapshot.workspaceId) console.log(`Checkout creation workspace: ${snapshot.workspaceId}`);
    },
  });
  assert.ok(response.workspace, response.error ?? "Workspace creation failed");
  const workspaceId = response.workspace.id;
  console.log(`Test workspace: ${workspaceId}`);
  const read = async () => {
    const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
    assert.ok(row, "Created workspace must remain discoverable");
    return row;
  };
  const workspace = await eventually(async () => {
    const row = await read();
    if (row.status?.phase === "Failed") throw new Error("PR workspace initialization failed");
    return row.status?.phase === "Ready" ? row : undefined;
  }, "modern creation readiness");
  assert.equal(workspace.spec.pullRequest, pullRequest);
  assert.equal(workspace.spec.projectRef, projectId);
  assert.equal(workspace.spec.retentionPolicy?.storage ?? "Retain", "Retain");
  assert.equal(workspace.spec.retentionPolicy?.ttlAfterArchivedSeconds, undefined);
  const pod = resourceName(workspace);
  const volume = await store.get("PersistentVolumeClaim", pod);
  assert.ok(volume?.metadata?.uid, "Checkout must have retained storage");
  const head = await git(pod, ["rev-parse", "HEAD"]);
  const remote = await git(pod, [
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/pull/${pullRequest}/head`,
  ]);
  assert.match(head, /^[a-f0-9]{40,64}$/);
  assert.equal(remote, `${head}\trefs/pull/${pullRequest}/head`, "Checkout must match the PR head");
  console.log("PASS PR checkout HEAD matches the remote pull-request ref");
  const first = await client.archiveWorkspace(workspaceId);
  assert.equal(first.error, null);
  assert.ok(first.archivedAt);
  const archived = await eventually(async () => {
    const row = await read();
    return row.status?.phase === "Archived" &&
      row.status.teardownCompletedAt &&
      !(await store.get("Pod", pod))
      ? row
      : undefined;
  }, "archive teardown and pod deletion");
  const second = await client.archiveWorkspace(workspaceId);
  assert.equal(second.error, null);
  assert.ok(second.archivedAt);
  const repeated = await read();
  assert.equal(repeated.status?.archivedAt, archived.status?.archivedAt);
  assert.equal(repeated.status?.teardownCompletedAt, archived.status?.teardownCompletedAt);
  const retained = await store.get("PersistentVolumeClaim", pod);
  assert.equal(retained?.metadata?.uid, volume.metadata.uid);
  assert.equal(retained?.metadata?.deletionTimestamp, undefined);
  assert.equal((await read()).status?.storageDeletedAt, undefined);
  assert.equal(await store.get("Pod", pod), undefined);
  const after = await inventory(client);
  for (const id of before) assert.ok(after.has(id), "Existing agent inventory must remain intact");
  assert.ok([...after].every((id) => !id.startsWith(`${workspaceId}~`)));
  console.log(
    `PASS archive twice, teardown, pod deletion, PVC retention and inventory (${before.size} agents)`,
  );
  console.log(`Retained archived checkout workspace: ${workspaceId}`);
} finally {
  try {
    await client?.close();
  } finally {
    proxy.kill();
  }
}
