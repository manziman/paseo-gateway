import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { WorkspaceAdmission } from "./controller/admission.js";
import { runController, WorkspaceController } from "./controller/controller.js";
import { WorkspaceAccess } from "./controller/workspace-access.js";
import { GitHubAppBroker } from "./credentials/github-app.js";
import { deleteArchivedInventory } from "./gateway/agent-inventory.js";
import { ScheduleService } from "./gateway/schedules.js";
import { startGateway } from "./gateway/server.js";
import { WorkspaceOperations } from "./gateway/workspace-operations.js";
import { KubernetesStore, loadKubernetesConfig } from "./kubernetes/client.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const namespace = required("PASEO_NAMESPACE");
  const store = new KubernetesStore(loadKubernetesConfig(process.env.KUBE_CONTEXT), namespace);
  const password = (await readFile(required("GATEWAY_PASSWORD_FILE"), "utf8")).trim();
  const backendPassword = (await readFile(required("BACKEND_PASSWORD_FILE"), "utf8")).trim();
  const serverId = (await readFile(required("GATEWAY_ID_FILE"), "utf8")).trim();
  const signingKey = (await readFile(required("GATEWAY_SIGNING_KEY_FILE"), "utf8")).trim();
  const scopedAuth = { signingKey, audience: serverId };
  const namespaceLimit = z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(process.env.MAX_RUNNING_WORKSPACES ?? 20);
  if (password.length < 32 || backendPassword.length < 32 || !serverId)
    throw new Error("Invalid retained identity Secret");
  const abort = new AbortController();
  const controller = new WorkspaceController(
    store,
    {
      workspaceImage: required("WORKSPACE_IMAGE"),
      storageSize: process.env.WORKSPACE_STORAGE_SIZE ?? "5Gi",
      storageClass: process.env.WORKSPACE_STORAGE_CLASS,
      backendSecret: process.env.BACKEND_SECRET_NAME ?? "paseo-backend",
      imagePullPolicy: z
        .enum(["Always", "IfNotPresent", "Never"])
        .parse(process.env.WORKSPACE_IMAGE_PULL_POLICY ?? "IfNotPresent"),
      gatewayUrl: required("GATEWAY_INTERNAL_URL"),
    },
    {
      namespaceLimit,
      access: new WorkspaceAccess(store, scopedAuth),
      beforeArchive: (workspace) => operations.snapshotInventory(workspace),
      purgeInventory: (workspace) => deleteArchivedInventory(store, workspace),
    },
  );
  const operations = new WorkspaceOperations({
    store,
    namespace,
    backendPassword,
    admission: new WorkspaceAdmission(store, namespaceLimit),
    readyTimeoutMs:
      z.coerce
        .number()
        .int()
        .min(1)
        .max(3600)
        .parse(process.env.WORKSPACE_READY_TIMEOUT_SECONDS ?? 300) * 1000,
  });
  const schedules = new ScheduleService({
    records: store,
    store,
    dispatch: (input) => operations.dispatchSchedule(input),
    observe: (input) => operations.observeSchedule(input),
    onError: (event) => console.error(JSON.stringify({ level: "error", event })),
    historyLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(process.env.SCHEDULE_HISTORY_LIMIT ?? 50),
  });
  await schedules.initialize();
  const broker = new GitHubAppBroker(store);
  await broker.reconcile(await store.credentialProfiles());
  const gateway = await startGateway({
    store,
    namespace,
    password,
    backendPassword,
    serverId,
    scopedAuth,
    workspaceLogs: (workspace, tail) => store.workspaceLogs(workspace, tail),
    inventoryStore: store,
    advertised: { name: process.env.GATEWAY_NAME },
    operations: {
      creationLifecycle: operations.creationLifecycle,
      close: (emit) => operations.close(emit),
      handle: async (message, emit, principal) =>
        (await schedules.handle(message, emit, principal)) ||
        (await operations.handle(message, emit, principal)),
    },
    host: "0.0.0.0",
    port: 8080,
    allowedHosts: (process.env.GATEWAY_ALLOWED_HOSTS ?? "localhost,127.0.0.1").split(","),
    ready: async () => {
      await store.projects();
      return !abort.signal.aborted;
    },
  });
  const loop = runController(controller, store, abort.signal, () => {
    // API bodies can contain Secrets. Log an event, never serialize arbitrary exceptions.
    console.error(JSON.stringify({ level: "error", event: "reconcile_failed" }));
  });
  const periodic = async (action: () => Promise<unknown>, interval: number, event: string) => {
    while (!abort.signal.aborted) {
      try {
        await action();
      } catch {
        console.error(JSON.stringify({ level: "error", event }));
      }
      await delay(interval, undefined, { signal: abort.signal }).catch(() => {});
    }
  };
  const scheduleLoop = periodic(() => schedules.tick(), 1000, "schedule_reconcile_failed");
  const brokerLoop = periodic(
    async () => {
      const states = await broker.reconcile(await store.credentialProfiles());
      for (const state of states.filter(
        (state) => state.state === "Failed" || state.state === "Backoff",
      ))
        console.error(
          JSON.stringify({ level: "error", event: "credential_renewal_failed", ...state }),
        );
    },
    10000,
    "credential_broker_failed",
  );
  console.info(JSON.stringify({ level: "info", event: "gateway_started", namespace }));
  const shutdown = async () => {
    if (abort.signal.aborted) return;
    abort.abort();
    await schedules.close(25000);
    await gateway.close();
    await Promise.all([loop, scheduleLoop, brokerLoop]);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

main().catch(() => {
  console.error(
    JSON.stringify({
      level: "fatal",
      event: "startup_failed",
      message: "Check configuration, Secret mounts, and Kubernetes access",
    }),
  );
  process.exitCode = 1;
});
