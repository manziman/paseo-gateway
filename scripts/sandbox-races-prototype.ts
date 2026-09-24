// THROWAWAY negative probes: reproduce lifecycle regressions in the minimal adapter.
// Run AFTER prototype:sandbox completes; pauses ONLY the temporary core controller.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api, CustomObjectsApi, type V1Pod } from "@kubernetes/client-node";
import { WorkspaceController } from "../src/controller/controller.js";
import { desiredResources, resourceName } from "../src/controller/resources.js";
import { SandboxPrototypeStore } from "../src/controller/sandbox-prototype.js";
import { WorkspaceAccess } from "../src/controller/workspace-access.js";
import { API_GROUP, API_VERSION, WORKSPACE_UID_LABEL, type Workspace } from "../src/domain.js";
import { loadKubernetesConfig } from "../src/kubernetes/client.js";

const context = "docker-desktop";
const namespace = "paseo-sandbox-spike";
const config = loadKubernetesConfig(context);
const core = config.makeApiClient(CoreV1Api);
const custom = config.makeApiClient(CustomObjectsApi);
const store = new SandboxPrototypeStore(config, namespace);
function scale(replicas: number) {
  execFileSync(
    "kubectl",
    [
      "--context",
      context,
      "-n",
      "agent-sandbox-system",
      "scale",
      "deployment/agent-sandbox-controller",
      `--replicas=${replicas}`,
    ],
    { stdio: "ignore" },
  );
}
async function until(read: () => Promise<boolean>, description: string) {
  for (let index = 0; index < 300; index++) {
    if (await read()) return;
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
async function row(workspace: Workspace) {
  const current = (await store.workspaces()).find(
    (entry) => entry.metadata.name === workspace.metadata.name,
  );
  assert.ok(current);
  return current;
}
let paused = false;
try {
  assert.equal(
    (await core.listNamespacedPod({ namespace })).items.length,
    0,
    "First spike must finish before race probes",
  );
  const projects = await store.projects();
  const project =
    projects[0] ??
    (() => {
      throw new Error("Missing spike project");
    })();
  const existingSandbox = (await store.sandboxApi.listNamespacedCustomObject(store.args()))
    .items[0];
  assert.ok(existingSandbox);
  const runtime = {
    workspaceImage: existingSandbox.spec.podTemplate.spec.containers[0].image as string,
    storageSize: "1Gi",
    backendSecret: "spike-backend",
    imagePullPolicy: "Never" as const,
    gatewayUrl: `ws://paseo-gateway.${namespace}.svc:8080/ws`,
  };
  const controller = new WorkspaceController(store, runtime, {
    namespaceLimit: 1,
    access: new WorkspaceAccess(store, {
      signingKey: randomUUID() + randomUUID(),
      audience: randomUUID(),
    }),
  });
  const create = () =>
    store.createWorkspace({
      apiVersion: API_VERSION,
      kind: "PaseoWorkspace",
      metadata: { name: `race-${randomUUID()}`, namespace },
      spec: {
        projectRef: project.metadata.name,
        credentialProfile: project.spec.credentialProfile,
        displayName: "Negative compatibility probe",
        revision: project.spec.revision,
        residency: "Running",
      },
    });
  scale(0);
  paused = true;
  await until(
    async () =>
      (await core.listNamespacedPod({ namespace: "agent-sandbox-system" })).items.length === 0,
    "temporary controller stopped",
  );
  const first = await create();
  const second = await create();
  await controller.reconcile(first, projects);
  await controller.reconcile(second, projects);
  assert.ok(await store.sandbox(resourceName(first)));
  assert.ok(await store.sandbox(resourceName(second)));
  assert.equal((await core.listNamespacedPod({ namespace })).items.length, 0);
  await store.setResidency(await row(first), "Suspended");
  await controller.reconcile(await row(first), projects);
  assert.equal((await row(first)).status?.phase, "Suspended");
  assert.equal((await store.sandbox(resourceName(first))).spec.operatingMode, "Running");
  console.log(
    "REPRODUCED early suspend: Workspace reports Suspended while queued Sandbox remains Running",
  );

  const collision = await create();
  const desired = desiredResources(
    collision,
    project,
    runtime,
    await store.credentialProfile(project.spec.credentialProfile),
  );
  const collisionName = resourceName(collision);
  await store.sandboxApi.createNamespacedCustomObject({
    ...store.args(),
    body: {
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: {
        name: collisionName,
        labels: { [WORKSPACE_UID_LABEL]: "different-workspace-uid" },
      },
      spec: { operatingMode: "Suspended", service: false, podTemplate: { spec: desired.pod.spec } },
    },
  });
  await store.create(desired.pod);
  assert.equal((await store.sandbox(collisionName)).spec.operatingMode, "Running");
  assert.equal(
    (await store.sandbox(collisionName)).metadata.labels[WORKSPACE_UID_LABEL],
    "different-workspace-uid",
  );
  console.log(
    "REPRODUCED adapter ownership gap: a same-name Sandbox with a different workspace UID is resumed",
  );
  await store.sandboxApi.deleteNamespacedCustomObject({ ...store.args(), name: collisionName });
  await custom.deleteNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseoworkspaces",
    namespace,
    name: collision.metadata.name,
  });

  scale(1);
  paused = false;
  await until(
    async () =>
      !!(await store.get("Pod", resourceName(first))) &&
      !!(await store.get("Pod", resourceName(second))),
    "two queued Pods materialize",
  );
  assert.equal((await core.listNamespacedPod({ namespace })).items.length, 2);
  assert.equal((await row(first)).status?.phase, "Suspended");
  console.log(
    "REPRODUCED capacity regression: two Pods start with namespaceLimit=1; one belongs to reported-Suspended workspace",
  );
  // Explicitly stop the incorrectly started fixture to free the slot for the next probe.
  await store.mode(resourceName(first), "Suspended");
  await until(
    async () => !(await store.get("Pod", resourceName(first))),
    "incorrectly started fixture stopped",
  );
  await until(async () => {
    await controller.reconcile(await row(second), projects);
    return (await row(second)).status?.phase === "Ready";
  }, "second workspace ready");
  const before = (await store.get("Pod", resourceName(second))) as V1Pod;
  const priorMemory = before.spec?.containers[0]?.resources?.requests?.memory;
  assert.notEqual(priorMemory, "768Mi");
  await store.setResidency(await row(second), "Suspended");
  await until(async () => {
    await controller.reconcile(await row(second), projects);
    return (await row(second)).status?.phase === "Suspended";
  }, "second workspace suspended");
  const currentProject = (await store.projects())[0];
  assert.ok(currentProject);
  await custom.replaceNamespacedCustomObject({
    group: API_GROUP,
    version: "v1alpha1",
    plural: "paseoprojects",
    namespace,
    name: project.metadata.name,
    body: {
      ...currentProject,
      spec: {
        ...currentProject.spec,
        runtime: { ...currentProject.spec.runtime, resources: { requests: { memory: "768Mi" } } },
      },
    },
  });
  const updatedProjects = await store.projects();
  await store.setResidency(await row(second), "Running");
  await until(async () => {
    await controller.reconcile(await row(second), updatedProjects);
    return (await row(second)).status?.phase === "Ready";
  }, "second workspace resumed with changed project");
  const after = (await store.get("Pod", resourceName(second))) as V1Pod;
  assert.equal(after.spec?.containers[0]?.resources?.requests?.memory, priorMemory);
  assert.equal(updatedProjects[0]?.spec.runtime?.resources?.requests?.memory, "768Mi");
  console.log(
    "REPRODUCED stale template: resume ignores changed project memory request and reuses original PodSpec",
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : error instanceof Error && error.message.startsWith("Timed out:")
        ? error.message
        : "Race probe failed; inspect spike resources without printing credentials",
  );
  process.exitCode = 1;
} finally {
  if (paused) scale(1);
}
