import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceController } from "../src/controller/controller.js";
import { resourceName } from "../src/controller/resources.js";
import { WORKSPACE_UID_LABEL } from "../src/domain.js";
import { KubernetesStore } from "../src/kubernetes/client.js";
import { MemoryStore, workspace } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  const store = new KubernetesStore(config, "test");
  const row = workspace();
  const name = resourceName(row);
  const service = {
    metadata: {
      name,
      uid: "service-uid",
      labels: { [WORKSPACE_UID_LABEL]: row.metadata.uid ?? "" },
    },
  };
  const secret = {
    metadata: {
      name: `${name}-access`,
      uid: "access-uid",
      labels: { [WORKSPACE_UID_LABEL]: row.metadata.uid ?? "" },
    },
  };
  const readService = vi.spyOn(store, "get").mockResolvedValue(service);
  const readSecret = vi.spyOn(store, "readSecret").mockResolvedValue(secret);
  const deleteService = vi
    .spyOn(CoreV1Api.prototype, "deleteNamespacedService")
    .mockResolvedValue({});
  const deleteSecret = vi
    .spyOn(CoreV1Api.prototype, "deleteNamespacedSecret")
    .mockResolvedValue({});
  return {
    store,
    row,
    name,
    service,
    secret,
    readService,
    readSecret,
    deleteService,
    deleteSecret,
  };
}
describe("owned terminal workspace runtime cleanup", () => {
  it("deletes only the derived Service/access Secret with UID preconditions and observes actual absence", async () => {
    const f = fixture();
    expect(await f.store.deleteRuntime(f.row)).toBe(false);
    expect(f.deleteService).toHaveBeenCalledExactlyOnceWith({
      namespace: "test",
      name: f.name,
      body: { preconditions: { uid: "service-uid" } },
    });
    expect(f.deleteSecret).toHaveBeenCalledExactlyOnceWith({
      namespace: "test",
      name: `${f.name}-access`,
      body: { preconditions: { uid: "access-uid" } },
    });
    expect(f.readSecret).toHaveBeenCalledWith(`${f.name}-access`);
    f.readService.mockResolvedValue(undefined);
    f.readSecret.mockResolvedValue(undefined);
    expect(await f.store.deleteRuntime(f.row)).toBe(true);
    expect(f.deleteService).toHaveBeenCalledTimes(1);
    expect(f.deleteSecret).toHaveBeenCalledTimes(1);
  });
  it("validates both resource owners before deleting either and protects a racing UID replacement", async () => {
    const f = fixture();
    f.readSecret.mockResolvedValue({ metadata: { ...f.secret.metadata, labels: {} } });
    await expect(f.store.deleteRuntime(f.row)).rejects.toThrow("unowned");
    expect(f.deleteService).not.toHaveBeenCalled();
    expect(f.deleteSecret).not.toHaveBeenCalled();
    f.readSecret.mockResolvedValue(f.secret);
    f.deleteService.mockRejectedValue({ code: 409 });
    await expect(f.store.deleteRuntime(f.row)).rejects.toMatchObject({ code: 409 });
    expect(f.deleteSecret).not.toHaveBeenCalled();
  });
  it("does not repeatedly delete terminating resources or accept UID-less workspaces", async () => {
    const f = fixture();
    f.readService.mockResolvedValue({
      metadata: { ...f.service.metadata, deletionTimestamp: new Date() },
    });
    f.readSecret.mockResolvedValue({
      metadata: { ...f.secret.metadata, deletionTimestamp: new Date() },
    });
    expect(await f.store.deleteRuntime(f.row)).toBe(false);
    expect(f.deleteService).not.toHaveBeenCalled();
    expect(f.deleteSecret).not.toHaveBeenCalled();
    delete f.row.metadata.uid;
    await expect(f.store.deleteRuntime(f.row)).rejects.toThrow("UID");
  });
  it("keeps runtime resources during suspension and waits for archive cleanup before purging data", async () => {
    const store = new MemoryStore();
    const row = workspace();
    if (!row.status) throw new Error("No fixture status");
    row.status.teardownCompletedAt = "2026-01-01T00:00:00Z";
    store.workspaceRows = [row];
    row.spec.residency = "Suspended";
    const cleanup = vi.spyOn(store, "deleteRuntime").mockResolvedValue(false);
    const purge = vi.fn(async () => {});
    const controller = new WorkspaceController(
      store,
      {
        workspaceImage: "test",
        storageSize: "1Gi",
        backendSecret: "backend",
        imagePullPolicy: "Never",
      },
      { purgeInventory: purge },
    );
    await controller.reconcile(row, store.projectRows);
    expect(cleanup).not.toHaveBeenCalled();
    row.spec.residency = "Archived";
    row.spec.retentionPolicy = { storage: "Retain", ttlAfterArchivedSeconds: 0 };
    await controller.reconcile(row, store.projectRows);
    expect(cleanup).toHaveBeenCalledWith(row);
    expect(purge).not.toHaveBeenCalled();
    expect(row.status?.storageDeletedAt).toBeUndefined();
    cleanup.mockResolvedValue(true);
    await controller.reconcile(row, store.projectRows);
    expect(purge).toHaveBeenCalledExactlyOnceWith(row);
    expect(row.status?.storageDeletedAt).toBeDefined();
  });
});
