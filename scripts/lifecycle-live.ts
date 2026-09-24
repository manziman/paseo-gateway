import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoreV1Api } from "@kubernetes/client-node";
import { resourceName } from "../src/controller/resources.js";
import { API_VERSION, type Workspace } from "../src/domain.js";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { context, namespace } from "./local-config.js";

// Only test-owned workspaces/volumes are modified. No model calls or external Git writes.
const config = loadKubernetesConfig(context);
const store = new KubernetesStore(config, namespace);
const api = config.makeApiClient(CoreV1Api);
const project = (await store.projects()).find(
  (entry) => entry.metadata.name === (process.env.PASEO_TEST_PROJECT ?? "hello-world"),
);
assert.ok(project, "Configure the test project first");
const finalizer = "paseo-gateway.manziman.github.io/acceptance-hold";
let heldVolume: { name: string; uid: string } | undefined;

async function eventually<T>(read: () => Promise<T | undefined>, description: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(2000);
  }
  throw new Error(`Timed out: ${description}`);
}

async function row(name: string) {
  const result = (await store.workspaces()).find((entry) => entry.metadata.name === name);
  assert.ok(result, "Test workspace must remain discoverable");
  return result;
}

async function releaseHold() {
  if (!heldVolume) return;
  const pvc = await api.readNamespacedPersistentVolumeClaim({ namespace, name: heldVolume.name });
  assert.equal(pvc.metadata?.uid, heldVolume.uid, "Never modify replacement storage");
  if (pvc.metadata) {
    pvc.metadata.finalizers = pvc.metadata.finalizers?.filter((entry) => entry !== finalizer);
  }
  await api.replaceNamespacedPersistentVolumeClaim({ namespace, name: heldVolume.name, body: pvc });
  heldVolume = undefined;
}

try {
  for (const storage of ["Retain", "Ephemeral"] as const) {
    const name = `lifecycle-${randomUUID()}`;
    const workspace: Workspace = await store.createWorkspace({
      apiVersion: API_VERSION,
      kind: "PaseoWorkspace",
      metadata: { name, namespace },
      spec: {
        projectRef: project.metadata.name,
        displayName: `Lifecycle acceptance (${storage})`,
        credentialProfile: project.spec.credentialProfile,
        revision: project.spec.revision,
        residency: "Running",
        retentionPolicy: { storage, ttlAfterArchivedSeconds: 0 },
      },
    });
    const resource = resourceName(workspace);
    await eventually(async () => {
      const current = await row(name);
      if (current.status?.phase === "Failed") throw new Error(current.status.message);
      return current.status?.phase === "Ready" ? current : undefined;
    }, `${storage} readiness`);
    if (storage === "Retain") {
      const pvc = await api.readNamespacedPersistentVolumeClaim({ namespace, name: resource });
      assert.ok(pvc.metadata?.uid);
      heldVolume = { name: resource, uid: pvc.metadata.uid };
      pvc.metadata.finalizers = [...(pvc.metadata.finalizers ?? []), finalizer];
      await api.replaceNamespacedPersistentVolumeClaim({ namespace, name: resource, body: pvc });
    } else {
      assert.equal(await store.get("PersistentVolumeClaim", resource), undefined);
    }
    await store.setResidency(await row(name), "Archived");
    if (storage === "Retain") {
      await eventually(async () => {
        const pvc = await store.get("PersistentVolumeClaim", resource);
        return pvc?.metadata?.deletionTimestamp ? pvc : undefined;
      }, "PVC deletion request");
      await delay(3000);
      assert.equal((await row(name)).status?.storageDeletedAt, undefined);
      console.log("PASS TTL waits for actual PVC deletion while a finalizer holds storage");
      await releaseHold();
    }
    const archived = await eventually(async () => {
      const current = await row(name);
      return current.status?.storageDeletedAt ? current : undefined;
    }, `${storage} collection`);
    assert.equal(archived.status?.phase, "Archived");
    assert.ok(archived.status.teardownCompletedAt);
    assert.equal(await store.get("Pod", resource), undefined);
    assert.equal(await store.get("PersistentVolumeClaim", resource), undefined);
    assert.equal(await store.get("Service", resource), undefined);
    assert.equal(await store.readSecret(`${resource}-access`), undefined);
    console.log(`PASS ${storage}: teardown, archive and owned storage collection (${name})`);
  }
} finally {
  await releaseHold();
}
