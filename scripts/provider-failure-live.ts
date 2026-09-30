import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import WebSocket from "ws";
import { z } from "zod";
import { resourceName } from "../src/controller/resources.js";
import { API_GROUP, API_VERSION, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { statusCode } from "../src/kubernetes/store.js";
import { authRejected, classifyRejectedTurn } from "./provider-failure-contract.js";

const Schema = z
  .object({
    context: z.string().min(1),
    namespace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    identitySecret: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .default("paseo-identity"),
    tls: z.object({ caFile: z.string().min(1), serverName: z.string().min(1) }).strict(),
    provider: z.enum(["claude", "opencode"]),
    credentialEnv: z.enum(["CLAUDE_CODE_OAUTH_TOKEN", "LITELLM_API_KEY"]),
    validCredentialFile: z.string().min(1).optional(),
    invalidOnly: z.boolean().default(false),
    providerConfigFile: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    rejectionDeadlineMs: z.number().int().min(10000).max(180000).default(90000),
  })
  .strict()
  .refine(
    (value) =>
      value.provider === "claude"
        ? value.credentialEnv === "CLAUDE_CODE_OAUTH_TOKEN" && !value.providerConfigFile
        : value.credentialEnv === "LITELLM_API_KEY" && !!value.providerConfigFile && !!value.model,
    "Provider credentials/configuration must match the selected case",
  )
  .refine(
    (value) => value.invalidOnly || !!value.validCredentialFile,
    "Valid credential file required for restoration mode",
  );
type Config = z.infer<typeof Schema>;
type Status = "passed" | "failed" | "blocked" | "skipped";
type Check = { check: string; status: Status; reason?: string };
const configPath = process.argv[2];
const reportPath = process.argv[3];
if (!configPath || !reportPath)
  throw new Error("Usage: provider-failure-live.ts CONFIG.json REPORT.json");
let config: Config;
try {
  config = Schema.parse(JSON.parse(await readFile(configPath, "utf8")));
} catch {
  throw new Error("Invalid private provider failure configuration (details redacted)");
}

const runId = randomUUID();
const suffix = runId.slice(0, 8);
const namespace = config.namespace;
const secretName = `provider-failure-${suffix}`;
const profileName = `provider-failure-${suffix}`;
const projectName = `provider-failure-${suffix}`;
const created: Array<{ kind: string; name: string; uid: string }> = [];
const checks: Check[] = [];
const identities: Record<string, string> = {};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: config.provider,
  checks,
  runtimeVersion: undefined as string | undefined,
  imageDigests: [] as string[],
  cleanup: "pending",
  rejectionSurface: undefined as string | undefined,
  failureDiagnostic: undefined as string | undefined,
  failureSignals: [] as Array<{
    terminal: string;
    resultError: boolean;
    finalLastError: boolean;
    timelineError: boolean;
    lastMessageAuthCategory: boolean;
    timelineAuthCategory: boolean;
    timelineItemTypes: string[];
    assistantSucceeded: boolean;
  }>,
};
const cluster = loadKubernetesConfig(config.context);
const api = cluster.makeApiClient(CoreV1Api);
const custom = cluster.makeApiClient(CustomObjectsApi);
const store = new KubernetesStore(cluster, namespace);
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
let workspaceId: string | undefined;
let workspaceUid: string | undefined;
let invalidCredential: string | undefined;

function metadata(name: string) {
  return {
    name,
    namespace,
    labels: {
      "app.kubernetes.io/managed-by": "provider-failure-local-fixture",
      [`${API_GROUP}/qualification-run`]: runId,
    },
  };
}
function checkOwnership(
  value: { metadata?: { uid?: string; labels?: Record<string, string> } },
  kind: string,
) {
  assert.equal(value.metadata?.uid, identities[kind]);
  assert.equal(value.metadata?.labels?.[`${API_GROUP}/qualification-run`], runId);
}
function credentialShape(value: string): string {
  // Preserve the public format prefix and length without reusing any secret suffix.
  const prefix = value.slice(0, Math.min(12, value.length));
  const length = Math.max(24, value.length - prefix.length);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const candidate =
    prefix + Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
  assert.notEqual(candidate, value);
  return candidate;
}
function generatedInvalidCredential(provider: Config["provider"]): string {
  const prefix = provider === "claude" ? "sk-ant-oat01-" : "sk-test-";
  return prefix + randomBytes(48).toString("base64url");
}
async function eventually<T>(read: () => Promise<T | undefined>, count = 90): Promise<T> {
  for (let index = 0; index < count; index++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error("AcceptanceDeadlineExceeded");
}
async function connect(): Promise<DaemonClient> {
  const identity = await api.readNamespacedSecret({ namespace, name: config.identitySecret });
  const password = Buffer.from(identity.data?.password ?? "", "base64").toString();
  if (!password) throw new Error("GatewayIdentityMissing");
  proxy = spawn(
    "kubectl",
    [
      "--context",
      config.context,
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
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("GatewayPortForwardTimeout")), 15000);
    proxy?.stdout?.on("data", (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proxy?.once("error", reject);
    proxy?.once("exit", () => reject(new Error("GatewayPortForwardExited")));
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
  return client;
}
async function reconnectAfterResume() {
  await client?.close().catch(() => {});
  proxy?.kill();
  client = undefined;
  proxy = undefined;
  await connect();
}
async function createObjects(valid?: string) {
  invalidCredential = valid ? credentialShape(valid) : generatedInvalidCredential(config.provider);
  const configContents = config.providerConfigFile
    ? await readFile(config.providerConfigFile, "utf8")
    : undefined;
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata(secretName),
    type: "Opaque",
    data: {
      token: Buffer.from(invalidCredential).toString("base64"),
      ...(configContents
        ? { "opencode.json": Buffer.from(configContents).toString("base64") }
        : {}),
    },
  };
  const createdSecret = await api.createNamespacedSecret({ namespace, body: secret });
  assert.ok(createdSecret.metadata?.uid);
  created.push({ kind: "Secret", name: secretName, uid: createdSecret.metadata.uid });
  identities.Secret = createdSecret.metadata.uid;
  const profile = {
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: metadata(profileName),
    spec: {
      env: [
        {
          name: config.credentialEnv,
          valueFrom: { secretKeyRef: { name: secretName, key: "token" } },
        },
      ],
      files: configContents
        ? [
            {
              path: ".config/opencode/opencode.json",
              valueFrom: { secretKeyRef: { name: secretName, key: "opencode.json" } },
              mode: 288,
            },
          ]
        : [],
    },
  };
  const createdProfile = await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    namespace,
    plural: "paseocredentialprofiles",
    body: profile,
  });
  const profileUid = z.object({ metadata: z.object({ uid: z.string() }) }).parse(createdProfile)
    .metadata.uid;
  created.push({ kind: "PaseoCredentialProfile", name: profileName, uid: profileUid });
  identities.PaseoCredentialProfile = profileUid;
  const project = {
    apiVersion: API_VERSION,
    kind: "PaseoProject",
    metadata: metadata(projectName),
    spec: {
      displayName: "Isolated provider rejection fixture",
      repository: "https://github.com/octocat/Hello-World.git",
      revision: "HEAD",
      credentialProfile: profileName,
    },
  };
  const createdProject = await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    namespace,
    plural: "paseoprojects",
    body: project,
  });
  const projectUid = z.object({ metadata: z.object({ uid: z.string() }) }).parse(createdProject)
    .metadata.uid;
  created.push({ kind: "PaseoProject", name: projectName, uid: projectUid });
  identities.PaseoProject = projectUid;
}
async function replaceCredential(value: string) {
  const secret = await api.readNamespacedSecret({ namespace, name: secretName });
  checkOwnership(secret, "Secret");
  await api.replaceNamespacedSecret({
    namespace,
    name: secretName,
    body: { ...secret, data: { ...secret.data, token: Buffer.from(value).toString("base64") } },
  });
}
async function ownedWorkspace() {
  assert.ok(workspaceId && workspaceUid);
  const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
  assert.ok(row);
  assert.equal(row.metadata.uid, workspaceUid);
  assert.equal(row.spec.projectRef, projectName);
  assert.equal(row.spec.credentialProfile, profileName);
  return row;
}
async function readyPod(priorUid?: string) {
  return eventually(async () => {
    const row = await ownedWorkspace();
    if (row.status?.phase === "Failed") throw new Error("WorkspaceFailedBeforeCredentialProbe");
    if (row.status?.phase !== "Ready") return undefined;
    const pod = await api.readNamespacedPod({ namespace, name: resourceName(row) });
    const uid = pod.metadata?.uid;
    if (!uid || uid === priorUid) return undefined;
    assert.equal(pod.metadata?.labels?.[`${API_GROUP}/workspace-uid`], workspaceUid);
    for (const status of pod.status?.containerStatuses ?? []) {
      const digest = /sha256:[a-f0-9]{64}/.exec(status.imageID)?.[0];
      if (digest && !report.imageDigests.includes(digest)) report.imageDigests.push(digest);
    }
    return uid;
  });
}
async function runAgent(expectSuccess: boolean) {
  assert.ok(client && workspaceId);
  const marker = `CREDENTIAL_${randomUUID().replaceAll("-", "")}`;
  const agent = await client.createAgent({
    workspaceId,
    config: {
      provider: config.provider,
      cwd: workspacePath(workspaceId),
      ...(config.model ? { model: config.model } : {}),
      ...(config.mode ? { modeId: config.mode } : {}),
    },
    initialPrompt: `Reply exactly ${marker}. Do not use tools.`,
  });
  const result = await client.waitForFinish(agent.id, config.rejectionDeadlineMs);
  const timeline = await client.fetchAgentTimeline(agent.id);
  const structuredErrors = [result.error, result.final?.lastError, timeline.error].filter(
    (entry): entry is string => typeof entry === "string",
  );
  const assistantTexts = timeline.entries
    .filter(({ item }) => item.type === "assistant_message")
    .map(({ item }) => (item.type === "assistant_message" ? item.text : ""));
  const itemText = timeline.entries.map(({ item }) => JSON.stringify(item)).join(" ");
  const assistantSucceeded = timeline.entries.some(
    ({ item }) => item.type === "assistant_message" && item.text.includes(marker),
  );
  report.failureSignals.push({
    terminal: result.status,
    resultError: !!result.error,
    finalLastError: !!result.final?.lastError,
    timelineError: !!timeline.error,
    lastMessageAuthCategory: authRejected(result.lastMessage ?? ""),
    timelineAuthCategory: authRejected(itemText),
    timelineItemTypes: timeline.entries.map(({ item }) => item.type),
    assistantSucceeded,
  });
  if (expectSuccess) {
    assert.equal(result.status, "idle");
    assert.equal(timeline.error, null);
    assert.ok(assistantSucceeded);
    return { terminal: result.status, category: "success" };
  }
  const category = classifyRejectedTurn({
    status: result.status,
    structuredErrors,
    lastMessage: result.lastMessage,
    assistantTexts,
    successMarker: marker,
  });
  if (!category) throw new Error(`NoObservableAuthRejection_${result.status}`);
  return { terminal: result.status, category };
}
async function setResidency(residency: "Running" | "Suspended") {
  const row = await ownedWorkspace();
  await store.setResidency(row, residency);
}
async function waitSuspended(priorPodUid?: string) {
  await eventually(async () => {
    const row = await ownedWorkspace();
    if (row.status?.phase !== "Suspended") return undefined;
    try {
      const pod = await api.readNamespacedPod({ namespace, name: resourceName(row) });
      if (pod.metadata?.uid === priorPodUid || !pod.metadata?.deletionTimestamp) return undefined;
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      return true;
    }
    return undefined;
  });
}

try {
  if (!config.invalidOnly && !config.validCredentialFile)
    throw new Error("SelectedCredentialMissing");
  const valid = config.invalidOnly
    ? undefined
    : (await readFile(config.validCredentialFile ?? "", "utf8")).trim();
  if (valid === "") throw new Error("SelectedCredentialMissing");
  await createObjects(valid);
  const active = await connect();
  await eventually(async () =>
    (await active.listProjects()).projects.some((entry) => entry.projectId === projectName)
      ? true
      : undefined,
  );
  const createdWorkspace = await active.createWorkspace({
    title: `Credential rejection ${suffix}`,
    source: { kind: "directory", projectId: projectName, path: workspacePath(projectName) },
  });
  assert.ok(createdWorkspace.workspace);
  workspaceId = createdWorkspace.workspace.id;
  const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspaceId);
  assert.ok(row?.metadata.uid);
  workspaceUid = row.metadata.uid;
  const firstPodUid = await readyPod();
  const pvcName = (await ownedWorkspace()).status?.pvcName;
  assert.ok(pvcName);
  const rejected = await runAgent(false);
  report.rejectionSurface = rejected.category;
  checks.push({ check: "generated-invalid-observable-auth-rejection", status: "passed" });
  if (!valid) {
    for (const check of [
      "environment-unchanged-before-pod-recreation",
      "existing-valid-credential-restored-after-pod-recreation",
      "workspace-uid-stable-pod-uid-replaced-pvc-retained",
      "actual-provider-expiry-or-revocation",
      "independent-valid-credential-rotation",
    ])
      checks.push({ check, status: "skipped", reason: "NotSelectedInInvalidOnlyRun" });
  } else {
    await replaceCredential(valid);
    assert.equal(await readyPod(), firstPodUid);
    await runAgent(false);
    checks.push({ check: "environment-unchanged-before-pod-recreation", status: "passed" });
    await setResidency("Suspended");
    await waitSuspended(firstPodUid);
    await setResidency("Running");
    const secondPodUid = await readyPod(firstPodUid);
    assert.notEqual(secondPodUid, firstPodUid);
    await reconnectAfterResume();
    await runAgent(true);
    checks.push({
      check: "existing-valid-credential-restored-after-pod-recreation",
      status: "passed",
    });
    const rowAfter = await ownedWorkspace();
    assert.equal(rowAfter.status?.pvcName, pvcName);
    checks.push({ check: "workspace-uid-stable-pod-uid-replaced-pvc-retained", status: "passed" });
    for (const check of [
      "actual-provider-expiry-or-revocation",
      "independent-valid-credential-rotation",
    ])
      checks.push({ check, status: "skipped", reason: "NotSelectedForSyntheticAcceptance" });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "UnknownFailure";
  report.failureDiagnostic = (
    invalidCredential ? message.replaceAll(invalidCredential, "[INVALID_TOKEN]") : message
  )
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[TOKEN]")
    .slice(0, 240);
  checks.push({
    check: "provider-failure-acceptance",
    status: "failed",
    reason: "InspectPrivateFixtureState",
  });
} finally {
  try {
    if (workspaceId && workspaceUid) {
      const row = await ownedWorkspace();
      if (row.spec.residency !== "Suspended") await setResidency("Suspended");
      await waitSuspended();
      report.cleanup = "owned-workspace-suspended-pvc-retained";
    }
    if (invalidCredential && identities.Secret) {
      await replaceCredential(invalidCredential);
      report.cleanup += ";fixture-secret-reset-to-generated-invalid";
    }
  } catch {
    report.cleanup = "cleanup-incomplete-inspect-private-inventory";
    checks.push({
      check: "fixture-cleanup",
      status: "failed",
      reason: "OwnershipOrCleanupFailure",
    });
  }
  await client?.close().catch(() => {});
  proxy?.kill();
  await writeFile(
    `${reportPath}.cleanup-private.json`,
    JSON.stringify(
      { context: config.context, namespace, runId, created, workspaceId, workspaceUid },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
const statuses = checks.map((entry) => entry.status);
process.exitCode = statuses.includes("failed") ? 1 : statuses.includes("blocked") ? 2 : 0;
console.log(
  JSON.stringify({
    provider: config.provider,
    passed: statuses.filter((item) => item === "passed").length,
    failed: statuses.filter((item) => item === "failed").length,
    blocked: statuses.filter((item) => item === "blocked").length,
    skipped: statuses.filter((item) => item === "skipped").length,
    cleanup: report.cleanup,
  }),
);
