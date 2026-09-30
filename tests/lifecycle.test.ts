import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAdmission } from "../src/controller/admission.js";
import { WorkspaceController } from "../src/controller/controller.js";
import { checkoutTerminationDiagnostic, podDiagnostic } from "../src/controller/diagnostics.js";
import { resourceName } from "../src/controller/resources.js";
import { MemoryStore, workspace } from "./fixtures.js";

const config = {
  workspaceImage: "test",
  storageSize: "1Gi",
  backendSecret: "backend",
  imagePullPolicy: "Never" as const,
};
async function fixture() {
  const store = new MemoryStore();
  const row = workspace();
  store.workspaceRows = [row];
  let now = Date.parse("2026-01-01T00:00:00Z");
  const controller = new WorkspaceController(store, config, { now: () => now });
  await controller.reconcile(row, store.projectRows);
  const pod = store.objects.get(`Pod/${resourceName(row)}`) as V1Pod;
  pod.status = { conditions: [{ type: "Ready", status: "True" }] };
  return {
    store,
    row,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe("retention and lifecycle failure safety", () => {
  it("refuses archive when teardown fails without deleting compute or storage", async () => {
    const { store, row, controller } = await fixture();
    store.teardown = vi.fn().mockRejectedValue(new Error("secret must not enter status"));
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(row.status?.message).not.toContain("secret");
    expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(true);
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
  });
  it("collects only after successful teardown, stopped compute and archived TTL", async () => {
    const { store, row, controller, advance } = await fixture();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 60 };
    const hook = vi.spyOn(store, "teardown");
    for (let i = 0; i < 3; i++) await controller.reconcile(row, store.projectRows);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(row.status?.archivedAt).toBeDefined();
    advance(59000);
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
    advance(1000);
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(false);
    expect(row.status?.storageDeletedAt).toBeDefined();
  });
  it("never garbage collects a replacement foreign PVC", async () => {
    const { store, row, controller } = await fixture();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    const pvc = store.objects.get(`PersistentVolumeClaim/${resourceName(row)}`);
    if (!pvc?.metadata) throw new Error("fixture");
    pvc.metadata.labels = {};
    await expect(controller.reconcile(row, store.projectRows)).rejects.toThrow("unowned volume");
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
  });
  it("reports OOM interruption without including raw container messages", () => {
    const result = podDiagnostic({
      status: {
        containerStatuses: [
          {
            name: "daemon",
            ready: false,
            restartCount: 1,
            image: "test",
            imageID: "test",
            lastState: {
              terminated: { exitCode: 137, reason: "OOMKilled", message: "TOKEN=secret" },
            },
          },
        ],
      },
    });
    expect(result?.reason).toBe("OOMKilled");
    expect(JSON.stringify(result)).not.toContain("TOKEN");
  });
  it("accepts only fixed checkout termination codes and carries them into workspace status", async () => {
    const { store, row, controller } = await fixture();
    const pod = store.objects.get(`Pod/${resourceName(row)}`);
    if (pod?.kind !== "Pod") throw new Error("Missing checkout Pod");
    const safe = JSON.stringify({
      version: 1,
      stage: "fetch",
      code: "CheckoutDnsUnavailable",
      attempts: 3,
    });
    pod.status = {
      phase: "Pending",
      initContainerStatuses: [
        {
          name: "checkout",
          ready: false,
          restartCount: 1,
          image: "test",
          imageID: "test",
          state: { terminated: { exitCode: 1, reason: "Error", message: safe } },
        },
      ],
    };
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(row.status?.lastFailure?.reason).toBe("CheckoutDnsUnavailable");
    expect(row.status?.message).toContain("after 3 attempts");
    expect(JSON.stringify(row.status)).not.toContain("private");
  });
  it("rejects unsafe or forged termination messages and uses a generic fallback", () => {
    const safe = JSON.stringify({
      version: 1,
      stage: "fetch",
      code: "CheckoutAuthenticationFailed",
      attempts: 1,
    });
    expect(checkoutTerminationDiagnostic(safe)?.reason).toBe("CheckoutAuthenticationFailed");
    for (const message of [
      `${safe}TOKEN=secret`,
      JSON.stringify({ ...JSON.parse(safe), raw: "TOKEN=secret" }),
      JSON.stringify({ ...JSON.parse(safe), code: "TOKEN=secret" }),
      JSON.stringify({ ...JSON.parse(safe), attempts: 99 }),
      JSON.stringify({ ...JSON.parse(safe), stage: ["fetch"] }),
    ]) {
      expect(checkoutTerminationDiagnostic(message)).toBeUndefined();
      const diagnostic = podDiagnostic({
        status: {
          initContainerStatuses: [
            {
              name: "checkout",
              ready: false,
              restartCount: 1,
              image: "test",
              imageID: "test",
              state: { terminated: { exitCode: 1, reason: "Error", message } },
            },
          ],
        },
      });
      expect(diagnostic?.reason).toBe("ContainerFailed");
      expect(JSON.stringify(diagnostic)).not.toContain("secret");
    }
    expect(
      podDiagnostic({
        status: {
          initContainerStatuses: [
            {
              name: "checkout",
              ready: false,
              restartCount: 1,
              image: "test",
              imageID: "test",
              state: { terminated: { exitCode: 137, reason: "OOMKilled", message: safe } },
            },
          ],
        },
      })?.reason,
    ).toBe("OOMKilled");
  });
  it("atomically refuses concurrent over-cap API creates", async () => {
    const store = new MemoryStore();
    const admission = new WorkspaceAdmission(store, 1);
    const project = store.projectRows[0];
    if (!project) throw new Error("fixture");
    const results = await Promise.allSettled([
      admission.create(workspace("a"), project),
      admission.create(workspace("b"), project),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(store.workspaceRows).toHaveLength(1);
  });
  it("gates direct CRs without deleting an already-running pod", async () => {
    const { store, row } = await fixture();
    const other = workspace("two");
    store.workspaceRows.push(other);
    const controller = new WorkspaceController(store, config, { namespaceLimit: 1 });
    await controller.reconcile(other, store.projectRows);
    expect(other.status?.message).toContain("capacity");
    expect(store.objects.has(`Pod/${resourceName(other)}`)).toBe(false);
    expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(true);
  });
});

describe("observed deletion and immutable resource ownership", () => {
  it("waits for actual PVC disappearance before purging inventory or marking storage released", async () => {
    const { store, row, controller } = await fixture();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    const name = resourceName(row);
    const pvc = store.objects.get(`PersistentVolumeClaim/${name}`);
    if (!pvc?.metadata?.uid) throw new Error("Missing PVC");
    const deletedUid = pvc.metadata.uid;
    store.deleteStorage = vi.fn(async (_name, uid) => {
      expect(uid).toBe(deletedUid);
      if (pvc.metadata) pvc.metadata.deletionTimestamp = new Date("2026-01-01T00:00:00Z");
    });
    const purge = vi.fn(async () => {});
    const observing = new WorkspaceController(store, config, { purgeInventory: purge });
    await observing.reconcile(row, store.projectRows);
    await observing.reconcile(row, store.projectRows);
    expect(purge).not.toHaveBeenCalled();
    expect(row.status?.storageDeletedAt).toBeUndefined();
    expect(row.status?.message).toContain("deletion to finish");
    store.objects.delete(`PersistentVolumeClaim/${name}`);
    await observing.reconcile(row, store.projectRows);
    expect(purge).toHaveBeenCalledExactlyOnceWith(row);
    expect(row.status?.storageDeletedAt).toBeDefined();
  });
  it("does not request PVC deletion while the owned pod is still terminating", async () => {
    const { store, row, controller } = await fixture();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    const pod = store.objects.get(`Pod/${resourceName(row)}`);
    if (!pod?.metadata?.uid) throw new Error("Missing pod");
    store.deletePod = vi.fn(async (_name, uid) => {
      expect(uid).toBe(pod.metadata?.uid);
      if (pod.metadata) pod.metadata.deletionTimestamp = new Date("2026-01-01T00:00:00Z");
    });
    const deleteStorage = vi.spyOn(store, "deleteStorage");
    const deleteRuntime = vi.spyOn(store, "deleteRuntime");
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    expect(deleteStorage).not.toHaveBeenCalled();
    expect(deleteRuntime).not.toHaveBeenCalled();
    expect(row.status?.storageDeletedAt).toBeUndefined();
    expect(row.status?.phase).toBe("Pending");
  });
  it("passes the observed PVC UID to deletion and never purges a racing replacement", async () => {
    const { store, row, controller } = await fixture();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    const key = `PersistentVolumeClaim/${resourceName(row)}`;
    const original = store.objects.get(key);
    if (!original?.metadata?.uid) throw new Error("Missing PVC");
    const deleteStorage = store.deleteStorage.bind(store);
    store.deleteStorage = async (name, uid) => {
      expect(uid).toBe(original.metadata?.uid);
      store.objects.set(key, {
        ...original,
        metadata: { ...original.metadata, uid: "replacement-pvc", labels: {} },
      });
      await deleteStorage(name, uid);
    };
    const purge = vi.fn(async () => {});
    const observing = new WorkspaceController(store, config, { purgeInventory: purge });
    await expect(observing.reconcile(row, store.projectRows)).rejects.toMatchObject({ code: 409 });
    expect(store.objects.get(key)?.metadata?.uid).toBe("replacement-pvc");
    expect(purge).not.toHaveBeenCalled();
    expect(row.status?.storageDeletedAt).toBeUndefined();
    await expect(observing.reconcile(row, store.projectRows)).rejects.toThrow("unowned volume");
  });
  it("requires a workspace UID even for terminal lifecycle actions", async () => {
    const store = new MemoryStore();
    const row = workspace();
    delete row.metadata.uid;
    row.spec.residency = "Archived";
    if (!row.status) throw new Error("Missing status");
    row.status.teardownCompletedAt = "2026-01-01T00:00:00Z";
    store.workspaceRows = [row];
    const name = resourceName(row);
    store.objects.set(`Pod/${name}`, { metadata: { name, uid: "unrelated-pod" } });
    await expect(
      new WorkspaceController(store, config).reconcile(row, store.projectRows),
    ).rejects.toThrow("UID");
    expect(store.deletions).toEqual([]);
    expect(store.objects.has(`Pod/${name}`)).toBe(true);
  });
});

describe("persistent pod diagnostics", () => {
  it("keeps a current image pull failure visible across repeated reconciliation, then reports recovery", async () => {
    const { store, row, controller } = await fixture();
    const pod = store.objects.get(`Pod/${resourceName(row)}`) as V1Pod;
    pod.status = {
      phase: "Pending",
      containerStatuses: [
        {
          name: "daemon",
          image: "test",
          imageID: "",
          ready: false,
          restartCount: 0,
          state: { waiting: { reason: "ImagePullBackOff", message: "sensitive detail" } },
        },
      ],
    };
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(row.status?.message).toContain("ImagePullBackOff");
    expect(JSON.stringify(row.status)).not.toContain("sensitive detail");
    pod.status = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Ready");
    expect(row.status?.lastFailure?.reason).toBe("ImagePullBackOff");
  });
  it("retains historical OOM information without declaring a recovered pod failed", async () => {
    const { store, row, controller } = await fixture();
    const pod = store.objects.get(`Pod/${resourceName(row)}`) as V1Pod;
    pod.status = {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "daemon",
          image: "test",
          imageID: "",
          ready: true,
          restartCount: 1,
          state: { running: {} },
          lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } },
        },
      ],
    };
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Ready");
    expect(row.status?.lastFailure?.reason).toBe("OOMKilled");
  });
});
