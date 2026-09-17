import type { V1Pod } from "@kubernetes/client-node";
import {
  type Project,
  WORKSPACE_UID_LABEL,
  type Workspace,
  type WorkspaceStatus,
} from "../domain.js";
import type { Infrastructure, InfrastructureKind, Store } from "../kubernetes/store.js";
import { statusCode } from "../kubernetes/store.js";
import { desiredResources, type RuntimeConfig, resourceName } from "./resources.js";

/** Reconcile current desired state; events are hints, and may be repeated or missed. */
export class WorkspaceController {
  constructor(
    private readonly store: Store,
    private readonly config: RuntimeConfig,
  ) {}

  private async ensure(kind: InfrastructureKind, desired: Infrastructure, workspace: Workspace) {
    const existing = await this.store.get(kind, resourceName(workspace));
    if (existing) {
      if (existing.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid) {
        throw new Error("Resource name collision: refusing to adopt an unowned resource");
      }
      return existing;
    }
    await this.store.create(desired);
    return undefined;
  }

  private async report(workspace: Workspace, phase: WorkspaceStatus["phase"], message: string) {
    const previous = workspace.status;
    const observedGeneration = workspace.metadata.generation ?? 1;
    if (
      previous?.phase === phase &&
      previous.message === message &&
      previous.observedGeneration === observedGeneration
    )
      return;
    const status: WorkspaceStatus = {
      ...previous,
      phase,
      message,
      observedGeneration,
      pvcName: resourceName(workspace),
      conditions: [
        {
          type: "Ready",
          status: phase === "Ready" ? "True" : "False",
          reason: phase,
          message,
          observedGeneration,
          lastTransitionTime:
            previous?.phase === phase
              ? (previous.conditions?.[0]?.lastTransitionTime ?? new Date().toISOString())
              : new Date().toISOString(),
        },
      ],
    };
    await this.store.status(workspace, status);
  }

  async reconcile(workspace: Workspace, projects: Project[]) {
    if (workspace.metadata.deletionTimestamp) return;
    const name = resourceName(workspace);
    if (workspace.spec.residency !== "Running") {
      const pod = await this.store.get("Pod", name);
      if (pod && pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
        throw new Error("Refusing to delete an unowned pod");
      if (pod?.metadata?.uid && !pod.metadata.deletionTimestamp)
        await this.store.deletePod(name, pod.metadata.uid);
      await this.report(
        workspace,
        pod ? "Pending" : workspace.spec.residency,
        pod ? "Waiting for compute to stop; storage retained" : "Compute stopped; storage retained",
      );
      return;
    }
    const project = projects.find((p) => p.metadata.name === workspace.spec.projectRef);
    if (!project) {
      await this.report(workspace, "Failed", "Referenced project does not exist");
      return;
    }
    try {
      const secret = await this.store.secret(workspace.spec.credentialProfile);
      if (!secret.data?.token) {
        await this.report(workspace, "Failed", "Credential profile has no token");
        return;
      }
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      await this.report(workspace, "Failed", "Credential profile does not exist");
      return;
    }
    const desired = desiredResources(workspace, project, this.config);
    await this.ensure("PersistentVolumeClaim", desired.pvc, workspace);
    await this.ensure("Service", desired.service, workspace);
    const pod = (await this.ensure("Pod", desired.pod, workspace)) as V1Pod | undefined;
    if (pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed") {
      if (pod.metadata?.uid && !pod.metadata.deletionTimestamp)
        await this.store.deletePod(name, pod.metadata.uid);
      await this.report(workspace, "Pending", "Replacing terminated pod; storage retained");
      return;
    }
    const ready =
      !pod?.metadata?.deletionTimestamp &&
      pod?.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
    await this.report(
      workspace,
      ready ? "Ready" : "Pending",
      ready ? "Workspace daemon is ready" : "Waiting for workspace daemon",
    );
  }
}

/** A bounded, serialized resync loop suits the small POC and repairs missed changes without a journal. */
export async function runController(
  controller: WorkspaceController,
  store: Store,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  intervalMs = 5000,
) {
  const retry = new Map<string, { failures: number; after: number }>();
  while (!signal.aborted) {
    try {
      const [projects, workspaces] = await Promise.all([store.projects(), store.workspaces()]);
      for (const workspace of workspaces) {
        if (signal.aborted) break;
        const key = workspace.metadata.uid ?? workspace.metadata.name;
        const previous = retry.get(key);
        if (previous && previous.after > Date.now()) continue;
        try {
          await controller.reconcile(workspace, projects);
          retry.delete(key);
        } catch (error) {
          const failures = (previous?.failures ?? 0) + 1;
          retry.set(key, {
            failures,
            after: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(failures, 6)),
          });
          onError(error);
        }
      }
      for (const key of retry.keys())
        if (!workspaces.some((w) => (w.metadata.uid ?? w.metadata.name) === key)) retry.delete(key);
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
