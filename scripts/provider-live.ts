import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { CoreV1Api } from "@kubernetes/client-node";
import WebSocket from "ws";
import { z } from "zod";
import { resourceName } from "../src/controller/resources.js";
import { API_GROUP, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { ProviderAcceptanceConfigSchema as selected } from "./provider-acceptance-config.js";

// Explicit config selects the only context, namespace and credential profiles used.
// Never discover a provider credential from the operator's home or environment.
type Case = z.infer<typeof selected>["cases"][number];
type Check = { check: string; status: "passed" | "failed" | "blocked"; reason?: string };
type CaseReport = {
  provider: Case["provider"];
  authentication: Case["authentication"];
  checks: Check[];
  runtimeVersion?: string;
  imageDigests: string[];
};
const execute = promisify(execFile);
const configPath = process.argv[2];
const reportPath = process.argv[3];
if (!configPath || !reportPath)
  throw new Error(
    "Usage: node --import tsx scripts/provider-live.ts CONFIG.json REPORT.json; missing prerequisites exit 2, never pass",
  );
const reports: CaseReport[] = [];
const gatewayImageDigests = new Set<string>();
const cleanup: { workspace: string; state: string }[] = [];
let config: z.infer<typeof selected>;
try {
  config = selected.parse(JSON.parse(await readFile(configPath, "utf8")));
} catch {
  throw new Error("Invalid provider acceptance configuration (details redacted)");
}
const cluster = loadKubernetesConfig(config.context);
const api = cluster.makeApiClient(CoreV1Api);
const store = new KubernetesStore(cluster, config.namespace);
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
async function connect() {
  const gatewayPods = await api.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  for (const pod of gatewayPods.items)
    for (const status of pod.status?.containerStatuses ?? []) {
      const digest = /sha256:[a-f0-9]{64}/.exec(status.imageID)?.[0];
      if (digest) gatewayImageDigests.add(digest);
    }
  const secret = await api.readNamespacedSecret({
    namespace: config.namespace,
    name: config.identitySecret,
  });
  const password = Buffer.from(secret.data?.password ?? "", "base64").toString();
  if (!password) throw new Error("GatewayIdentityMissing");
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
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("PortForwardFailed"));
    };
    proxy?.once("error", fail);
    proxy?.once("exit", fail);
  });
  const ca = config.tls ? await readFile(config.tls.caFile, "utf8") : undefined;
  const transportFactory = createWebSocketTransportFactory((address, options) => {
    const socket = new WebSocket(address, options?.protocols, {
      headers: options?.headers,
      agent: config.tls
        ? new HttpsAgent({ ca, servername: config.tls.serverName, rejectUnauthorized: true })
        : undefined,
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
    url: `${config.tls ? "wss" : "ws"}://127.0.0.1:${port}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  return client;
}
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error("AcceptanceDeadlineExceeded");
}
async function inPod(name: string, command: string[]): Promise<string> {
  const result = await execute(
    "kubectl",
    [
      "--context",
      config.context,
      "-n",
      config.namespace,
      "exec",
      name,
      "-c",
      "daemon",
      "--",
      ...command,
    ],
    { timeout: 30000, maxBuffer: 64000 },
  );
  return result.stdout;
}
/** Fault injection is opt-in and affects only the selected disposable namespace. */
async function replaceGateway(active: DaemonClient): Promise<DaemonClient> {
  const pods = await api.listNamespacedPod({
    namespace: config.namespace,
    labelSelector: "app.kubernetes.io/component=gateway",
  });
  const pod = pods.items.find((row) => !row.metadata?.deletionTimestamp);
  assert.ok(pod?.metadata?.name);
  assert.ok(pod.metadata.uid);
  await active.close();
  client = undefined;
  proxy?.kill();
  await api.deleteNamespacedPod({
    namespace: config.namespace,
    name: pod.metadata.name,
    body: { preconditions: { uid: pod.metadata.uid } },
  });
  await eventually(async () =>
    (
      await api.listNamespacedPod({
        namespace: config.namespace,
        labelSelector: "app.kubernetes.io/component=gateway",
      })
    ).items.find(
      (row) =>
        row.metadata?.uid !== pod.metadata?.uid &&
        row.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ),
    ),
  );
  return connect();
}

/** Observe a running tool before replacing the gateway, then require one completion. */
async function activeTurnRecovery(active: DaemonClient, workspace: string, item: Case) {
  const marker = `RECOVERED_${randomUUID().replaceAll("-", "")}`;
  const agent = await active.createAgent({
    workspaceId: workspace,
    config: {
      provider: item.provider,
      cwd: workspacePath(workspace),
      ...(item.model ? { model: item.model } : {}),
      ...(item.mode ? { modeId: item.mode } : {}),
    },
    initialPrompt: `Use a shell tool exactly once to run sleep 30, then reply exactly ${marker}. Do not modify files or make network requests yourself.`,
  });
  const runningCall = await eventually(async () => {
    const history = await active.fetchAgentTimeline(agent.id);
    return history.entries.find(
      ({ item }) => item.type === "tool_call" && item.status === "running",
    );
  });
  assert.equal(runningCall.item.type, "tool_call");
  const callId = runningCall.item.type === "tool_call" ? runningCall.item.callId : undefined;
  assert.ok(callId);
  const resumed = await replaceGateway(active);
  assert.equal((await resumed.waitForFinish(agent.id, 180000)).status, "idle");
  const history = await resumed.fetchAgentTimeline(agent.id);
  assert.equal(history.error, null);
  assert.equal(history.entries.filter(({ item }) => item.type === "user_message").length, 1);
  assert.equal(
    history.entries.filter(({ item }) => item.type === "tool_call" && item.callId === callId)
      .length,
    1,
  );
  assert.ok(
    history.entries.some(
      ({ item }) => item.type === "assistant_message" && item.text.includes(marker),
    ),
  );
  return resumed;
}

async function runCase(item: Case, report: CaseReport) {
  if (!item.project) {
    report.checks.push({
      check: "concurrent-provider-prompts",
      status: "blocked",
      reason: "ExplicitCredentialProfileProjectRequired",
    });
    return;
  }
  const project = (await store.projects()).find((row) => row.metadata.name === item.project);
  if (!project) {
    report.checks.push({
      check: "concurrent-provider-prompts",
      status: "blocked",
      reason: "SelectedProjectMissing",
    });
    return;
  }
  if (item.authentication === "codex-subscription-authority") {
    const profile = await store.credentialProfile(project.spec.credentialProfile);
    if (!profile?.spec.codexSubscription) {
      report.checks.push({
        check: "concurrent-provider-prompts",
        status: "blocked",
        reason: "SubscriptionAuthorityProfileRequired",
      });
      return;
    }
  }
  let active = client ?? (await connect());
  const visible = (await active.listProjects()).projects.find(
    (row) => row.projectId === item.project,
  );
  if (!visible) throw new Error("SelectedProjectNotVisible");
  const workspaces: { id: string; agent?: string; marker: string }[] = [];
  const podIdentities = new Map<string, string | undefined>();
  try {
    for (let index = 0; index < 2; index++) {
      const created = await active.createWorkspace({
        title: `Provider acceptance ${randomUUID().slice(0, 8)}`,
        source: { kind: "directory", projectId: item.project, path: workspacePath(item.project) },
      });
      assert.ok(created.workspace);
      const workspace = {
        id: created.workspace.id,
        marker: `PARITY_${randomUUID().replaceAll("-", "")}`,
      };
      workspaces.push(workspace);
      cleanup.push({ workspace: workspace.id, state: "created" });
    }
    for (const workspace of workspaces) {
      const ready = await eventually(async () => {
        const row = (await store.workspaces()).find(
          (entry) => entry.metadata.name === workspace.id,
        );
        if (row?.status?.phase === "Failed") throw new Error("WorkspaceFailed");
        return row?.status?.phase === "Ready" ? row : undefined;
      });
      const pod = await api.readNamespacedPod({
        namespace: config.namespace,
        name: resourceName(ready),
      });
      podIdentities.set(workspace.id, pod.metadata?.uid);
      for (const status of pod.status?.containerStatuses ?? []) {
        const digest = /sha256:[a-f0-9]{64}/.exec(status.imageID)?.[0];
        if (digest && !report.imageDigests.includes(digest)) report.imageDigests.push(digest);
      }
      const version = await inPod(resourceName(ready), [item.provider, "--version"]);
      report.runtimeVersion =
        /\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*/.exec(version)?.[0] ?? "unrecognized";
    }
    await Promise.all(
      workspaces.map(async (workspace) => {
        const agent = await active.createAgent({
          workspaceId: workspace.id,
          config: {
            provider: item.provider,
            cwd: workspacePath(workspace.id),
            ...(item.model ? { model: item.model } : {}),
            ...(item.mode ? { modeId: item.mode } : {}),
          },
          env: { ACCEPTANCE_SENTINEL: workspace.marker },
          initialPrompt:
            "Use a shell tool to read the environment variable ACCEPTANCE_SENTINEL. Reply with only its value. Do not modify any files or perform any network request yourself.",
        });
        workspace.agent = agent.id;
        assert.equal((await active.waitForFinish(agent.id, 180000)).status, "idle");
      }),
    );
    const verify = async () => {
      for (const workspace of workspaces) {
        assert.ok(workspace.agent);
        const timeline = await active.fetchAgentTimeline(workspace.agent);
        assert.equal(timeline.error, null);
        assert.equal(
          timeline.entries.filter((entry) => entry.item.type === "user_message").length,
          1,
        );
        assert.ok(
          timeline.entries.some(
            (entry) =>
              entry.item.type === "assistant_message" && entry.item.text.includes(workspace.marker),
          ),
        );
        for (const other of workspaces.filter((entry) => entry.id !== workspace.id))
          assert.ok(!JSON.stringify(timeline.entries).includes(other.marker));
      }
    };
    await verify();
    report.checks.push({
      check: "concurrent-provider-prompts-env-independent-history",
      status: "passed",
    });
    if (item.authentication === "codex-subscription-authority") {
      const subscription = (await store.credentialProfile(project.spec.credentialProfile))?.spec
        .codexSubscription;
      assert.ok(subscription);
      for (const workspace of workspaces) {
        const row = (await store.workspaces()).find(
          (entry) => entry.metadata.name === workspace.id,
        );
        assert.ok(row);
        const pod = await api.readNamespacedPod({
          namespace: config.namespace,
          name: resourceName(row),
        });
        assert.equal(pod.spec?.automountServiceAccountToken, false);
        assert.ok(!JSON.stringify(pod.spec).includes(subscription.authSecretRef.name));
        assert.equal(
          (
            await inPod(resourceName(row), [
              "node",
              "-e",
              "const f=require('node:fs');let refresh=false;try{const a=JSON.parse(f.readFileSync('/home/paseo/.codex/auth.json','utf8'));refresh=!!a.tokens?.refresh_token;}catch(e){if(e.code!=='ENOENT')process.exit(1)}const p=JSON.parse(f.readFileSync('/run/paseo-codex/access.json','utf8'));process.stdout.write(JSON.stringify({refresh,accessOnly:Object.keys(p).sort().join()==='accessToken,chatgptAccountId,chatgptPlanType,expiresAt'}))",
            ])
          ).trim(),
          '{"refresh":false,"accessOnly":true}',
        );
      }
      report.checks.push({
        check: "worker-access-only-no-persisted-refresh-no-authority-mount-no-kubernetes-token",
        status: "passed",
      });
    }
    const providers = await active.refreshProvidersSnapshot({
      cwd: workspacePath(workspaces[0]?.id ?? ""),
      providers: [item.provider],
    });
    assert.equal(providers.acknowledged, true);
    const catalog = await active.getProvidersSnapshot({
      cwd: workspacePath(workspaces[0]?.id ?? ""),
    });
    assert.ok(catalog.entries.some((entry) => entry.provider === item.provider));
    report.checks.push({ check: "provider-discovery-refresh", status: "passed" });
    if (config.renewCodexAuthority && item.authentication === "codex-subscription-authority") {
      const profile = await store.credentialProfile(project.spec.credentialProfile);
      const subscription = profile?.spec.codexSubscription;
      assert.ok(subscription);
      const before = await store.readSecret(subscription.authSecretRef.name);
      assert.ok(before?.metadata?.resourceVersion);
      assert.ok(before.data?.["paseo-access.json"]);
      const beforeOutput = await store.readSecret(subscription.outputSecretName);
      assert.ok(beforeOutput?.data?.["access.json"]);
      const beforeAuth = before.data[subscription.authSecretRef.key];
      assert.ok(beforeAuth);
      const expectedOwner = `${profile.metadata.namespace}/${profile.metadata.name}/${profile.metadata.uid ?? ""}`;
      assert.equal(before.metadata.annotations?.[`${API_GROUP}/codex-owner`], expectedOwner);
      // Advance cached access expiry only. Native refresh credentials remain untouched;
      // the running gateway must call Codex and commit genuinely rotated state.
      const cached: unknown = JSON.parse(
        Buffer.from(before.data["paseo-access.json"], "base64").toString(),
      );
      const refreshedCache = {
        ...z
          .object({
            accessToken: z.string(),
            chatgptAccountId: z.string(),
            chatgptPlanType: z.string().nullable(),
            expiresAt: z.string(),
          })
          .parse(cached),
        expiresAt: new Date().toISOString(),
      };
      assert.ok(
        await store.compareAndSwapSecret(
          subscription.authSecretRef.name,
          before.metadata.resourceVersion,
          {
            ...before,
            data: {
              ...before.data,
              "paseo-access.json": Buffer.from(JSON.stringify(refreshedCache)).toString("base64"),
            },
          },
        ),
      );
      await eventually(async () => {
        const next = await store.readSecret(subscription.authSecretRef.name);
        const output = await store.readSecret(subscription.outputSecretName);
        return next?.data?.[subscription.authSecretRef.key] !== beforeAuth &&
          output?.data?.["access.json"] &&
          output.data["access.json"] !== beforeOutput.data?.["access.json"]
          ? true
          : undefined;
      });
      const renewedOutput = await store.readSecret(subscription.outputSecretName);
      assert.ok(renewedOutput?.data?.["access.json"]);
      const expectedProjection = createHash("sha256")
        .update(Buffer.from(renewedOutput.data["access.json"], "base64"))
        .digest("hex");
      for (const workspace of workspaces) {
        const row = (await store.workspaces()).find(
          (entry) => entry.metadata.name === workspace.id,
        );
        assert.ok(row);
        const currentPod = await api.readNamespacedPod({
          namespace: config.namespace,
          name: resourceName(row),
        });
        assert.equal(currentPod.metadata?.uid, podIdentities.get(workspace.id));
        await eventually(async () =>
          (
            await inPod(resourceName(row), [
              "node",
              "-e",
              "const f=require('node:fs'),c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/run/paseo-codex/access.json')).digest('hex'))",
            ])
          ).trim() === expectedProjection
            ? true
            : undefined,
        );
        // A fresh app-server in the existing Pod must initialize using the replacement
        // projection. Existing agents keep their history and are never replayed.
        const followup = await active.createAgent({
          workspaceId: workspace.id,
          config: {
            provider: "codex",
            cwd: workspacePath(workspace.id),
            ...(item.mode ? { modeId: item.mode } : {}),
            ...(item.model ? { model: item.model } : {}),
          },
          initialPrompt: "Reply exactly CODEX_RENEWAL_OK. Do not use tools.",
        });
        assert.equal((await active.waitForFinish(followup.id, 180000)).status, "idle");
        const history = await active.fetchAgentTimeline(followup.id);
        assert.ok(
          history.entries.some(
            (entry) =>
              entry.item.type === "assistant_message" &&
              entry.item.text.includes("CODEX_RENEWAL_OK"),
          ),
        );
        assert.equal(
          history.entries.filter((entry) => entry.item.type === "user_message").length,
          1,
        );
      }
      await verify();
      report.checks.push({
        check: "native-codex-renewal-and-fresh-agent-in-existing-worker",
        status: "passed",
      });
    }
    if (config.replaceGateway) {
      const subscription =
        item.authentication === "codex-subscription-authority"
          ? (await store.credentialProfile(project.spec.credentialProfile))?.spec.codexSubscription
          : undefined;
      const authorityBefore = subscription
        ? (await store.readSecret(subscription.authSecretRef.name))?.data?.[
            subscription.authSecretRef.key
          ]
        : undefined;
      active = await replaceGateway(active);
      await verify();
      if (subscription) {
        assert.ok(authorityBefore);
        assert.equal(
          (await store.readSecret(subscription.authSecretRef.name))?.data?.[
            subscription.authSecretRef.key
          ],
          authorityBefore,
        );
        report.checks.push({
          check: "committed-codex-auth-reused-after-gateway-replacement",
          status: "passed",
        });
      }
      report.checks.push({ check: "gateway-replacement-no-prompt-replay", status: "passed" });
    } else
      report.checks.push({
        check: "gateway-replacement-no-prompt-replay",
        status: "blocked",
        reason: "ReplacementNotSelected",
      });
    if (config.activeTurnGatewayRecovery) {
      assert.ok(workspaces[0]);
      active = await activeTurnRecovery(active, workspaces[0].id, item);
      await verify();
      report.checks.push({ check: "active-turn-recovery", status: "passed" });
    } else
      report.checks.push({
        check: "active-turn-recovery",
        status: "blocked",
        reason: "ActiveTurnReplacementNotSelected",
      });
    for (const check of ["credential-expiry-revocation", "credential-replacement"])
      report.checks.push({
        check,
        status: "blocked",
        reason: "SeparateRotationOrFaultInjectionRequired",
      });
  } finally {
    for (const workspace of workspaces) {
      const row = (await store.workspaces()).find((entry) => entry.metadata.name === workspace.id);
      if (row) {
        if (config.retainRunning) {
          const entry = cleanup.find((entry) => entry.workspace === workspace.id);
          if (entry) entry.state = "running-retained-for-explicit-inspection";
          continue;
        }
        await store.setResidency(row, "Suspended");
        const entry = cleanup.find((entry) => entry.workspace === workspace.id);
        if (entry) entry.state = "suspend-requested-pvc-retained";
      }
    }
  }
}
try {
  for (const item of config.cases) {
    const report: CaseReport = {
      provider: item.provider,
      authentication: item.authentication,
      checks: [],
      imageDigests: [],
    };
    reports.push(report);
    try {
      await runCase(item, report);
    } catch {
      report.checks.push({
        check: "provider-acceptance",
        status: "failed",
        reason: "AcceptanceFailedInspectPrivateWorkspaceState",
      });
    }
  }
} finally {
  await client?.close().catch(() => {});
  proxy?.kill();
  // Private cleanup inventory contains resource names and is deliberately separate.
  await writeFile(
    `${reportPath}.cleanup-private.json`,
    JSON.stringify(
      { context: config.context, namespace: config.namespace, resources: cleanup },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        paseoVersion: "0.9.1",
        gatewayImageDigests: [...gatewayImageDigests],
        cases: reports,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
const statuses = reports.flatMap((entry) => entry.checks.map((check) => check.status));
process.exitCode = statuses.includes("failed") ? 1 : statuses.includes("blocked") ? 2 : 0;
console.log(
  JSON.stringify({
    cases: reports.length,
    passed: statuses.filter((status) => status === "passed").length,
    failed: statuses.filter((status) => status === "failed").length,
    blocked: statuses.filter((status) => status === "blocked").length,
  }),
);
