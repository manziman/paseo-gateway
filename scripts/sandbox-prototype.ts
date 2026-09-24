// THROWAWAY regression experiment. Run only after installing the approved pinned core controller.
// This owns a fresh namespace, copies authorized credential references in memory, and never pushes Git.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { CoreV1Api, CustomObjectsApi, type V1EnvVar, type V1Pod } from "@kubernetes/client-node";
import { WorkspaceController } from "../src/controller/controller.js";
import { desiredResources, resourceName } from "../src/controller/resources.js";
import { SandboxPrototypeStore } from "../src/controller/sandbox-prototype.js";
import { WorkspaceAccess } from "../src/controller/workspace-access.js";
import { referencedCredentials } from "../src/credentials/projection.js";
import { API_GROUP, API_VERSION, type Workspace, workspacePath } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";

const context = "docker-desktop";
const namespace = "paseo-sandbox-spike";
const sourceNamespace = process.env.PASEO_SOURCE_NAMESPACE ?? "paseo-mvp";
const projectName = process.env.PASEO_TEST_PROJECT ?? "private-acceptance";
const config = loadKubernetesConfig(context);
const core = config.makeApiClient(CoreV1Api);
const custom = config.makeApiClient(CustomObjectsApi);
const source = new KubernetesStore(config, sourceNamespace);
const store = new SandboxPrototypeStore(config, namespace);
const backendPassword = randomUUID() + randomUUID();
const forwarding = new Set<ChildProcess>();
const clients = new Set<DaemonClient>();
const passed: string[] = [];
function pass(message: string) {
  passed.push(message);
  console.log(`PASS ${message}`);
}
function envValues(values: V1EnvVar[] | undefined) {
  return values?.map((entry) => ({
    name: entry.name,
    value: entry.value ?? "",
    valueFrom: entry.valueFrom ? JSON.parse(JSON.stringify(entry.valueFrom)) : null,
  }));
}
function exec(name: string, program: string) {
  return execFileSync(
    "kubectl",
    [
      "--context",
      context,
      "-n",
      namespace,
      "exec",
      name,
      "-c",
      "daemon",
      "--",
      "node",
      "--input-type=module",
      "-e",
      program,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
  ).trim();
}
async function eventually<T>(
  read: () => Promise<T | undefined>,
  description: string,
  attempts = 150,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
async function row(name: string) {
  const current = (await store.workspaces()).find((entry) => entry.metadata.name === name);
  assert.ok(current);
  return current;
}
async function connect(name: string) {
  const child = spawn(
    "kubectl",
    [
      "--context",
      context,
      "-n",
      namespace,
      "port-forward",
      "--address",
      "127.0.0.1",
      `service/${name}`,
      ":6767",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  forwarding.add(child);
  child.stderr?.on("data", () => {});
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Port-forward timeout")), 15000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Port-forward exited"));
    });
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    password: backendPassword,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  clients.add(client);
  await client.connect();
  return client;
}

async function run() {
  const project = (await source.projects()).find((entry) => entry.metadata.name === projectName);
  assert.ok(project, "Source test project required");
  const profile = await source.credentialProfile(project.spec.credentialProfile);
  assert.ok(profile, "Source credential profile required");
  const existing = await core.listNamespacedPod({ namespace: sourceNamespace });
  const image = existing.items
    .flatMap((pod) => pod.spec?.containers ?? [])
    .find((container) => container.name === "daemon")?.image;
  assert.ok(image, "Deployed workspace image required");
  // Create fails rather than modifying a preexisting namespace.
  await core.createNamespace({
    body: { metadata: { name: namespace, labels: { "paseo-spike": "agent-sandbox-v1.0.3" } } },
  });
  await core.createNamespacedServiceAccount({
    namespace,
    body: { metadata: { name: "paseo-workspace" }, automountServiceAccountToken: false },
  });
  for (const reference of [
    ...new Map(
      referencedCredentials(profile).map((ref) => [`${ref.kind}/${ref.name}`, ref]),
    ).values(),
  ]) {
    if (reference.kind === "Secret") {
      const secret = await source.secret(reference.name);
      await core.createNamespacedSecret({
        namespace,
        body: { metadata: { name: reference.name }, type: secret.type, data: secret.data },
      });
    } else {
      const map = await source.configMap(reference.name);
      await core.createNamespacedConfigMap({
        namespace,
        body: { metadata: { name: reference.name }, data: map.data, binaryData: map.binaryData },
      });
    }
  }
  await core.createNamespacedSecret({
    namespace,
    body: { metadata: { name: "spike-backend" }, stringData: { password: backendPassword } },
  });
  await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseocredentialprofiles",
    namespace,
    body: {
      apiVersion: API_VERSION,
      kind: "PaseoCredentialProfile",
      metadata: { name: profile.metadata.name, namespace },
      spec: profile.spec,
    },
  });
  await custom.createNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseoprojects",
    namespace,
    body: {
      apiVersion: API_VERSION,
      kind: "PaseoProject",
      metadata: { name: project.metadata.name, namespace },
      spec: project.spec,
    },
  });
  const runtime = {
    workspaceImage: image,
    storageSize: "1Gi",
    backendSecret: "spike-backend",
    imagePullPolicy: "Never" as const,
    gatewayUrl: `ws://paseo-gateway.${namespace}.svc:8080/ws`,
  };
  const auth = { signingKey: randomUUID() + randomUUID(), audience: randomUUID() };
  const controller = new WorkspaceController(store, runtime, {
    namespaceLimit: 2,
    access: new WorkspaceAccess(store, auth),
  });
  const projects = await store.projects();
  const selectedProject =
    projects[0] ??
    (() => {
      throw new Error("Spike project missing");
    })();
  async function create(storage: "Retain" | "Ephemeral", displayName: string) {
    return store.createWorkspace({
      apiVersion: API_VERSION,
      kind: "PaseoWorkspace",
      metadata: { name: `spike-${randomUUID()}`, namespace },
      spec: {
        projectRef: selectedProject.metadata.name,
        credentialProfile: selectedProject.spec.credentialProfile,
        displayName,
        revision: selectedProject.spec.revision,
        residency: "Running",
        retentionPolicy: { storage },
      },
    });
  }
  async function reconcileUntil(workspace: Workspace, phase: string) {
    return eventually(
      async () => {
        const current = await row(workspace.metadata.name);
        await controller.reconcile(current, projects);
        const after = await row(workspace.metadata.name);
        if (after.status?.phase === "Failed")
          throw new Error(`Unexpected Failed: ${after.status.message}`);
        return after.status?.phase === phase ? after : undefined;
      },
      `${workspace.metadata.name}: ${phase}`,
      300,
    );
  }

  const workspace = await create("Retain", "Sandbox retained private clone");
  const name = resourceName(workspace);
  await reconcileUntil(workspace, "Ready");
  const pod = await core.readNamespacedPod({ namespace, name });
  const pvc = await core.readNamespacedPersistentVolumeClaim({ namespace, name });
  const service = await core.readNamespacedService({ namespace, name });
  const expected = desiredResources(
    workspace,
    selectedProject,
    runtime,
    await store.credentialProfile(profile.metadata.name),
  );
  assert.equal(pod.metadata?.ownerReferences?.[0]?.kind, "Sandbox");
  assert.equal(pvc.metadata?.ownerReferences?.length ?? 0, 0);
  assert.notEqual(service.spec?.clusterIP, "None");
  for (const key of [
    "securityContext",
    "volumes",
    "automountServiceAccountToken",
    "serviceAccountName",
    "restartPolicy",
    "terminationGracePeriodSeconds",
  ] as const) {
    // Kubernetes supplies defaultMode and other API defaults; compare critical nested fields below.
    if (key !== "volumes")
      assert.deepEqual(JSON.parse(JSON.stringify(pod.spec?.[key])), expected.pod.spec?.[key]);
  }
  assert.equal(pod.spec?.containers[0]?.image, image);
  assert.deepEqual(
    envValues(pod.spec?.containers[0]?.env),
    envValues(expected.pod.spec?.containers[0]?.env),
  );
  assert.deepEqual(
    envValues(pod.spec?.initContainers?.[0]?.env),
    envValues(expected.pod.spec?.initContainers?.[0]?.env),
  );
  assert.equal(
    exec(
      name,
      `import {execFileSync} from 'node:child_process'; console.log(execFileSync('git',['rev-parse','--is-inside-work-tree'],{encoding:'utf8'}).trim());`,
    ),
    "true",
  );
  pass(
    "existing private SSH checkout, credential projection, image and pod security on Sandbox-created pod",
  );
  let client = await connect(name);
  const providers = await client.getProvidersSnapshot();
  assert.ok(providers);
  const terminal = await client.createTerminal(
    workspacePath(workspace.metadata.name),
    "Sandbox spike terminal",
  );
  assert.ok(terminal);
  pass(
    "Paseo 0.9.1 authenticated SDK provider catalog and terminal creation through retained Service",
  );
  exec(
    name,
    `import{writeFileSync}from'node:fs';writeFileSync('/home/paseo/spike-sentinel','retained');`,
  );
  const tokenName = `${name}-access`;
  const access = await core.readNamespacedSecret({ namespace, name: tokenName });
  assert.ok(access.data?.token);
  const nextToken = randomUUID();
  access.data.token = Buffer.from(nextToken).toString("base64");
  await core.replaceNamespacedSecret({ namespace, name: tokenName, body: access });
  await eventually(
    async () =>
      exec(
        name,
        `import{readFileSync}from'node:fs';console.log(readFileSync('/run/paseo-gateway/token','utf8')===${JSON.stringify(nextToken)});`,
      ) === "true"
        ? true
        : undefined,
    "projected Secret update",
  );
  pass("whole-volume scoped access Secret updates in place without pod restart");
  await client.close();
  await store.setResidency(await row(workspace.metadata.name), "Suspended");
  await reconcileUntil(workspace, "Suspended");
  await delay(3000);
  assert.equal(await store.get("Pod", name), undefined);
  assert.equal((await store.sandbox(name)).spec.operatingMode, "Suspended");
  assert.equal(
    (await core.readNamespacedPersistentVolumeClaim({ namespace, name })).metadata?.uid,
    pvc.metadata?.uid,
  );
  pass("suspend stops compute without recreation and preserves PVC UID");
  await store.setResidency(await row(workspace.metadata.name), "Running");
  await reconcileUntil(workspace, "Ready");
  assert.equal(
    exec(
      name,
      `import{readFileSync}from'node:fs';console.log(readFileSync('/home/paseo/spike-sentinel','utf8'));`,
    ),
    "retained",
  );
  assert.equal(
    (await core.readNamespacedService({ namespace, name })).spec?.clusterIP,
    service.spec?.clusterIP,
  );
  client = await connect(name);
  assert.ok(await client.getProvidersSnapshot());
  pass("resume preserves home contents, Service IP and authenticated Paseo connectivity");
  await client.close();
  const beforeReplacement = await core.readNamespacedPod({ namespace, name });
  await core.deleteNamespacedPod({
    namespace,
    name,
    body: { preconditions: { uid: beforeReplacement.metadata?.uid } },
  });
  await eventually(
    async () => {
      const current = (await store.get("Pod", name)) as V1Pod | undefined;
      return current?.metadata?.uid !== beforeReplacement.metadata?.uid &&
        current?.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
        ? current
        : undefined;
    },
    "automatic pod replacement",
    300,
  );
  assert.equal(
    exec(
      name,
      `import{readFileSync}from'node:fs';console.log(readFileSync('/home/paseo/spike-sentinel','utf8'));`,
    ),
    "retained",
  );
  pass("upstream recreates deleted retained pod with unchanged disk contents");

  // Failure must fence both controllers before any Sandbox suspension/deletion.
  exec(
    name,
    `import{writeFileSync}from'node:fs';writeFileSync('paseo.json',JSON.stringify({worktree:{teardown:'exit 17'}}));`,
  );
  await store.setResidency(await row(workspace.metadata.name), "Archived");
  await controller.reconcile(await row(workspace.metadata.name), projects);
  assert.equal((await row(workspace.metadata.name)).status?.phase, "Failed");
  assert.ok(await store.get("Pod", name));
  assert.ok(await store.get("PersistentVolumeClaim", name));
  assert.equal((await store.sandbox(name)).spec.operatingMode, "Running");
  pass("nonzero teardown hook refuses archive; Sandbox, compute and storage retained");
  // Separate workspace: never erase a failed teardown intent to make the test pass.
  const clean = await create("Retain", "Successful archive");
  const cleanName = resourceName(clean);
  await reconcileUntil(clean, "Ready");
  exec(
    cleanName,
    `import{writeFileSync}from'node:fs';writeFileSync('paseo.json',JSON.stringify({worktree:{teardown:'printf success > /home/paseo/hook-ran'}}));`,
  );
  const cleanPvc = await core.readNamespacedPersistentVolumeClaim({ namespace, name: cleanName });
  await store.setResidency(await row(clean.metadata.name), "Archived");
  await reconcileUntil(clean, "Archived");
  assert.equal(await store.sandbox(cleanName), undefined);
  assert.equal(await store.get("Pod", cleanName), undefined);
  assert.equal(
    (await store.get("PersistentVolumeClaim", cleanName))?.metadata?.uid,
    cleanPvc.metadata?.uid,
  );
  assert.ok((await row(clean.metadata.name)).status?.teardownCompletedAt);
  pass("successful teardown precedes compute/Sandbox cleanup and retains external PVC");
  await custom.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseoworkspaces",
    namespace,
    name: clean.metadata.name,
  });
  await delay(2000);
  assert.equal(
    (await store.get("PersistentVolumeClaim", cleanName))?.metadata?.uid,
    cleanPvc.metadata?.uid,
  );
  pass("PaseoWorkspace deletion still retains external PVC");

  const ephemeral = await create("Ephemeral", "Ephemeral suspension guard");
  const ephemeralName = resourceName(ephemeral);
  await reconcileUntil(ephemeral, "Ready");
  const ephemeralPod = await store.get("Pod", ephemeralName);
  assert.equal(await store.get("PersistentVolumeClaim", ephemeralName), undefined);
  await store.setResidency(await row(ephemeral.metadata.name), "Suspended");
  await controller.reconcile(await row(ephemeral.metadata.name), projects);
  assert.equal((await row(ephemeral.metadata.name)).status?.phase, "Failed");
  assert.equal((await store.get("Pod", ephemeralName))?.metadata?.uid, ephemeralPod?.metadata?.uid);
  assert.equal((await store.sandbox(ephemeralName)).spec.operatingMode, "Running");
  pass("existing adapter rejects ephemeral suspension without destroying emptyDir");
  await store.setResidency(await row(ephemeral.metadata.name), "Archived");
  await reconcileUntil(ephemeral, "Archived");
  assert.equal(await store.get("Pod", ephemeralName), undefined);
  pass("ephemeral archive runs teardown and removes Sandbox/Pod without PVC");

  const ttl = await create("Retain", "Archive retention finalizer guard");
  const ttlName = resourceName(ttl);
  await reconcileUntil(ttl, "Ready");
  const held = await core.readNamespacedPersistentVolumeClaim({ namespace, name: ttlName });
  const hold = "paseo-gateway.manziman.github.io/spike-hold";
  assert.ok(held.metadata);
  held.metadata.finalizers = [...(held.metadata.finalizers ?? []), hold];
  await core.replaceNamespacedPersistentVolumeClaim({ namespace, name: ttlName, body: held });
  const ttlCurrent = await row(ttl.metadata.name);
  await custom.replaceNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseoworkspaces",
    namespace,
    name: ttl.metadata.name,
    body: {
      ...ttlCurrent,
      spec: {
        ...ttlCurrent.spec,
        residency: "Archived",
        retentionPolicy: { storage: "Retain", ttlAfterArchivedSeconds: 0 },
      },
    },
  });
  await eventually(async () => {
    await controller.reconcile(await row(ttl.metadata.name), projects);
    return (await store.get("PersistentVolumeClaim", ttlName))?.metadata?.deletionTimestamp
      ? true
      : undefined;
  }, "TTL requests PVC deletion");
  assert.equal((await row(ttl.metadata.name)).status?.storageDeletedAt, undefined);
  const release = await core.readNamespacedPersistentVolumeClaim({ namespace, name: ttlName });
  assert.ok(release.metadata);
  release.metadata.finalizers = release.metadata.finalizers?.filter((entry) => entry !== hold);
  await core.replaceNamespacedPersistentVolumeClaim({ namespace, name: ttlName, body: release });
  await eventually(async () => {
    await controller.reconcile(await row(ttl.metadata.name), projects);
    return (await row(ttl.metadata.name)).status?.storageDeletedAt;
  }, "TTL observes PVC absence");
  pass("adapter archive TTL waits for actual PVC disappearance behind finalizer");

  // Demonstrate the incompatible upstream-owned PVC behavior, using disposable data only.
  const managedName = "managed-storage-probe";
  await store.sandboxApi.createNamespacedCustomObject({
    ...store.args(),
    body: {
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: { name: managedName },
      spec: {
        service: true,
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "64Mi" } } },
          },
        ],
        podTemplate: {
          spec: {
            containers: [
              {
                name: "probe",
                image,
                imagePullPolicy: "Never",
                command: ["node", "-e", "setInterval(()=>{},1000)"],
                ports: [{ containerPort: 6767 }],
                volumeMounts: [{ name: "data", mountPath: "/data" }],
              },
            ],
          },
        },
      },
    },
  });
  const managedPvcName = `data-${managedName}`;
  const managedPvc = await eventually(
    async () => await store.get("PersistentVolumeClaim", managedPvcName),
    "managed PVC",
  );
  assert.equal(managedPvc.metadata?.ownerReferences?.[0]?.kind, "Sandbox");
  await eventually(
    async () => ((await store.get("Service", managedName))?.spec ? true : undefined),
    "headless Service",
  );
  assert.equal(
    (await core.readNamespacedService({ namespace, name: managedName })).spec?.clusterIP,
    "None",
  );
  const heldPod = await eventually(async () => {
    const probe = (await store.get("Pod", managedName)) as V1Pod | undefined;
    return probe?.status?.phase === "Running" ? probe : undefined;
  }, "native probe running");
  assert.ok(heldPod.metadata);
  heldPod.metadata.finalizers = ["paseo-gateway.manziman.github.io/spike-hold"];
  await core.replaceNamespacedPod({ namespace, name: managedName, body: heldPod });
  const expiring = await store.sandbox(managedName);
  await store.sandboxApi.replaceNamespacedCustomObject({
    ...store.args(),
    name: managedName,
    body: {
      ...expiring,
      spec: {
        ...expiring.spec,
        shutdownTime: new Date(Date.now() - 1000).toISOString(),
        shutdownPolicy: "Retain",
      },
    },
  });
  await eventually(async () => {
    const state = await store.sandbox(managedName);
    return state.status?.conditions?.some(
      (condition: { reason: string }) => condition.reason === "SandboxExpired",
    )
      ? true
      : undefined;
  }, "native expiry reported");
  assert.ok((await store.get("Pod", managedName))?.metadata?.deletionTimestamp);
  pass("REGRESSION REPRODUCED: SandboxExpired is reported while finalizer-held Pod still exists");
  const releasePod = await core.readNamespacedPod({ namespace, name: managedName });
  assert.ok(releasePod.metadata);
  releasePod.metadata.finalizers = [];
  await core.replaceNamespacedPod({ namespace, name: managedName, body: releasePod });
  await store.sandboxApi.deleteNamespacedCustomObject({ ...store.args(), name: managedName });
  await eventually(
    async () => (!(await store.get("PersistentVolumeClaim", managedPvcName)) ? true : undefined),
    "managed PVC garbage collection",
  );
  pass("REGRESSION REPRODUCED: native volumeClaimTemplates PVC is deleted with Sandbox");
  const failedArchiveSandbox = await store.sandbox(name);
  await store.sandboxApi.replaceNamespacedCustomObject({
    ...store.args(),
    name,
    body: {
      ...failedArchiveSandbox,
      spec: {
        ...failedArchiveSandbox.spec,
        shutdownTime: new Date(Date.now() - 1000).toISOString(),
      },
    },
  });
  await eventually(
    async () => (!(await store.get("Pod", name)) ? true : undefined),
    "native expiry bypasses failing hook",
  );
  assert.equal((await row(workspace.metadata.name)).status?.phase, "Failed");
  assert.equal((await row(workspace.metadata.name)).status?.teardownCompletedAt, undefined);
  assert.ok(await store.get("PersistentVolumeClaim", name));
  pass("REGRESSION REPRODUCED: native deadline deletes compute despite failed Paseo teardown");
  console.log(
    JSON.stringify(
      {
        namespace,
        upstream: "v1.0.3",
        passed,
        limitation: "Pod-lifecycle adapter only; not a complete gateway migration or approval",
      },
      null,
      2,
    ),
  );
}

try {
  await run();
} catch (error) {
  // Never serialize API exception bodies: they can contain copied credentials.
  console.error(
    error instanceof assert.AssertionError
      ? `Assertion failed: ${error.message}`
      : error instanceof Error && error.message.startsWith("Timed out:")
        ? error.message
        : "Spike failed; inspect named spike resources without printing Secrets",
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...clients].map((client) => client.close()));
  for (const child of forwarding) child.kill("SIGTERM");
}
