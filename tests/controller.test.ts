import type { V1PersistentVolumeClaim, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { WorkspaceController } from "../src/controller/controller.js";
import { desiredResources, resourceName } from "../src/controller/resources.js";
import { API_VERSION, CredentialProfileSchema } from "../src/domain.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const config = {
  workspaceImage: "paseo:test",
  storageSize: "5Gi",
  backendSecret: "paseo-backend",
  imagePullPolicy: "Never" as const,
};
describe("workspace lifecycle", () => {
  it("keeps the checkout retry receipt on Pod-local storage while daemon restarts remain enabled", () => {
    const { pod } = desiredResources(workspace(), project(), config);
    expect(pod.spec?.restartPolicy ?? "Always").toBe("Always");
    expect(pod.spec?.volumes?.find((volume) => volume.name === "tmp")).toMatchObject({
      emptyDir: { sizeLimit: "512Mi" },
    });
    expect(
      pod.spec?.initContainers?.find((container) => container.name === "checkout")?.volumeMounts,
    ).toContainEqual({ name: "tmp", mountPath: "/tmp" });
  });

  it("reconciles twice without duplicate resources or repeated status writes", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    const controller = new WorkspaceController(store, config);
    await controller.reconcile(row, store.projectRows);
    const writes = store.writes;
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.size).toBe(3);
    expect(store.writes).toBe(writes);
  });
  it("recreates a deleted pod against the exact same retained PVC", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    const controller = new WorkspaceController(store, config);
    await controller.reconcile(row, store.projectRows);
    const pvc = store.objects.get(`PersistentVolumeClaim/${resourceName(row)}`);
    store.objects.delete(`Pod/${resourceName(row)}`);
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.get(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(pvc);
    expect(pvc?.metadata?.ownerReferences).toBeUndefined();
  });
  it("retains an existing RWO claim across an RWOP config switch while new claims use RWOP", async () => {
    const store = new MemoryStore();
    const old = workspace("old");
    store.workspaceRows = [old];
    await new WorkspaceController(store, config).reconcile(old, store.projectRows);
    const oldKey = `PersistentVolumeClaim/${resourceName(old)}`;
    const retained = store.objects.get(oldKey) as V1PersistentVolumeClaim;
    expect(retained.spec?.accessModes).toEqual(["ReadWriteOnce"]);

    const rwop = new WorkspaceController(store, {
      ...config,
      storageAccessMode: "ReadWriteOncePod",
    });
    await rwop.reconcile(old, store.projectRows);
    expect(store.objects.get(oldKey)).toBe(retained);
    expect(retained.spec?.accessModes).toEqual(["ReadWriteOnce"]);

    const fresh = workspace("fresh");
    store.workspaceRows.push(fresh);
    await rwop.reconcile(fresh, store.projectRows);
    const freshClaim = store.objects.get(
      `PersistentVolumeClaim/${resourceName(fresh)}`,
    ) as V1PersistentVolumeClaim;
    expect(freshClaim.spec?.accessModes).toEqual(["ReadWriteOncePod"]);
  });
  it.each(["Suspended", "Archived"] as const)(
    "%s removes compute and retains storage",
    async (state) => {
      const store = new MemoryStore();
      const row = workspace();
      store.workspaceRows = [row];
      const controller = new WorkspaceController(store, config);
      await controller.reconcile(row, store.projectRows);
      const pod = store.objects.get(`Pod/${resourceName(row)}`) as V1Pod;
      pod.status = { conditions: [{ type: "Ready", status: "True" }] };
      row.spec.residency = state;
      await controller.reconcile(row, store.projectRows);
      await controller.reconcile(row, store.projectRows);
      await controller.reconcile(row, store.projectRows);
      expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(false);
      expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
      expect(row.status?.phase).toBe(state);
    },
  );
  it("does not adopt another workspace's resources", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.objects.set(`PersistentVolumeClaim/${resourceName(row)}`, {
      metadata: { name: resourceName(row) },
    });
    await expect(
      new WorkspaceController(store, config).reconcile(row, store.projectRows),
    ).rejects.toThrow("unowned");
    expect(store.writes).toBe(0);
  });
  it("does not overlap a replacement with a terminating pod", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    const controller = new WorkspaceController(store, config);
    await controller.reconcile(row, store.projectRows);
    const pod = store.objects.get(`Pod/${resourceName(row)}`) as V1Pod;
    if (!pod.metadata) throw new Error("Expected pod metadata");
    pod.metadata.deletionTimestamp = new Date();
    pod.status = { conditions: [{ type: "Ready", status: "True" }] };
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.get(`Pod/${resourceName(row)}`)).toBe(pod);
    expect(row.status?.phase).toBe("Pending");
  });
  it("fails clearly when credentials are missing without starting a pod", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    store.secretRows.clear();
    await new WorkspaceController(store, config).reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(store.objects.size).toBe(0);
  });
  it("keeps a workspace stopped when its Codex access is invalidated, while empty ConfigMap data stays valid", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    store.profileRows.set(
      "claude-default",
      CredentialProfileSchema.parse({
        apiVersion: API_VERSION,
        kind: "PaseoCredentialProfile",
        metadata: { name: "claude-default", namespace: "test" },
        spec: {
          codexSubscription: {
            authSecretRef: { name: "codex-authority", key: "auth.json" },
            outputSecretName: "codex-access",
          },
          files: [
            {
              path: ".config/empty-feature",
              valueFrom: { configMapKeyRef: { name: "feature-config", key: "config" } },
            },
          ],
        },
      }),
    );
    store.secretRows.set("codex-access", { data: { "access.json": "" } });
    store.configMapRows.set("feature-config", { data: { config: "" } });
    const controller = new WorkspaceController(store, config);
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(row.status?.message).toContain("Codex credential authority");
    expect(store.objects.size).toBe(0);

    store.secretRows.set("codex-access", {
      data: {
        "access.json": Buffer.from(
          JSON.stringify({
            accessToken: "fixture-token",
            chatgptAccountId: "fixture",
            chatgptPlanType: null,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        ).toString("base64"),
      },
    });
    await controller.reconcile(row, store.projectRows);
    expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(true);
  });
  it("isolates homes and working directories without Kubernetes credentials", () => {
    const a = desiredResources(workspace("one"), project(), config);
    const b = desiredResources(workspace("two"), project(), config);
    expect(a.pvc.metadata?.name).not.toBe(b.pvc.metadata?.name);
    expect(a.pod.spec?.automountServiceAccountToken).toBe(false);
    expect(a.pod.spec?.containers[0]?.workingDir).toBe("/workspaces/one");
    expect(a.pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(
      a.pod.spec?.containers[0]?.env?.find((e) => e.name === "CLAUDE_CODE_OAUTH_TOKEN")?.value,
    ).toBeUndefined();
  });
});
