// THROWAWAY SPIKE: core Agent Sandbox v1.0.3 compatibility, not a production backend.
// Preserve gateway-owned storage, Services, admission, hooks and diagnostics; delegate Pods only.
import { CustomObjectsApi, type KubeConfig, type V1Pod } from "@kubernetes/client-node";
import type { Workspace } from "../domain.js";
import { KubernetesStore } from "../kubernetes/client.js";
import { type Infrastructure, statusCode } from "../kubernetes/store.js";
import { resourceName } from "./resources.js";

export class SandboxPrototypeStore extends KubernetesStore {
  readonly sandboxApi: CustomObjectsApi;

  constructor(config: KubeConfig, namespace: string) {
    super(config, namespace);
    this.sandboxApi = config.makeApiClient(CustomObjectsApi);
  }

  args(name?: string) {
    return {
      group: "agents.x-k8s.io",
      version: "v1beta1",
      plural: "sandboxes",
      namespace: this.namespace,
      ...(name ? { name } : {}),
    };
  }

  async sandbox(name: string) {
    try {
      return await this.sandboxApi.getNamespacedCustomObject({ ...this.args(), name });
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
  }

  async mode(name: string, operatingMode: "Running" | "Suspended") {
    const current = await this.sandbox(name);
    if (!current || current.spec.operatingMode === operatingMode) return;
    await this.sandboxApi.replaceNamespacedCustomObject({
      ...this.args(),
      name,
      body: { ...current, spec: { ...current.spec, operatingMode } },
    });
  }

  override async create(object: Infrastructure): Promise<void> {
    if (object.kind !== "Pod") return super.create(object);
    const pod = object as V1Pod;
    const name = pod.metadata?.name;
    if (!name) throw new Error("Prototype requires a deterministic Pod name");
    if (await this.sandbox(name)) return this.mode(name, "Running");
    await this.sandboxApi.createNamespacedCustomObject({
      ...this.args(),
      body: {
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        metadata: pod.metadata,
        spec: {
          service: false,
          operatingMode: "Running",
          podTemplate: { metadata: { labels: pod.metadata?.labels }, spec: pod.spec },
        },
      },
    });
  }

  override async deletePod(name: string, uid: string) {
    const workspace = (await this.workspaces()).find((entry) => resourceName(entry) === name);
    if (workspace && workspace.spec.residency !== "Running") {
      // Deleting only the Pod would allow the upstream controller to recreate it.
      await this.mode(name, "Suspended");
      return;
    }
    await super.deletePod(name, uid);
  }

  override async deleteRuntime(workspace: Workspace) {
    if (!(await super.deleteRuntime(workspace))) return false;
    const name = resourceName(workspace);
    const sandbox = await this.sandbox(name);
    if (!sandbox) return true;
    await this.sandboxApi.deleteNamespacedCustomObject({
      ...this.args(),
      name,
      body: { preconditions: { uid: sandbox.metadata.uid } },
    });
    return false;
  }
}
