import { readFile } from "node:fs/promises";
import { runController, WorkspaceController } from "./controller/controller.js";
import { startGateway } from "./gateway/server.js";
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
  if (password.length < 32 || backendPassword.length < 32 || !serverId)
    throw new Error("Invalid retained identity Secret");
  const abort = new AbortController();
  const controller = new WorkspaceController(store, {
    workspaceImage: required("WORKSPACE_IMAGE"),
    storageSize: process.env.WORKSPACE_STORAGE_SIZE ?? "5Gi",
    storageClass: process.env.WORKSPACE_STORAGE_CLASS,
    backendSecret: process.env.BACKEND_SECRET_NAME ?? "paseo-backend",
    imagePullPolicy: process.env.WORKSPACE_IMAGE_PULL_POLICY === "Never" ? "Never" : "IfNotPresent",
  });
  const gateway = await startGateway({
    store,
    namespace,
    password,
    backendPassword,
    serverId,
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
  console.info(JSON.stringify({ level: "info", event: "gateway_started", namespace }));
  const shutdown = async () => {
    if (abort.signal.aborted) return;
    abort.abort();
    await gateway.close();
    await loop;
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
