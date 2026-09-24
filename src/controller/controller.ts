import type { V1Pod } from "@kubernetes/client-node";
import { referencedCredentials } from "../credentials/projection.js";
import {
  type Project,
  WORKSPACE_UID_LABEL,
  type Workspace,
  type WorkspaceStatus,
} from "../domain.js";
import type { Infrastructure, InfrastructureKind, Store } from "../kubernetes/store.js";
import { statusCode } from "../kubernetes/store.js";
import { podDiagnostic } from "./diagnostics.js";
import { desiredResources, type RuntimeConfig, resourceName } from "./resources.js";

/** Reconcile current desired state; events are hints, and may be repeated or missed. */
export class WorkspaceController {
  constructor(
    private readonly store: Store,
    private readonly config: RuntimeConfig,
    private readonly options: {
      namespaceLimit?: number;
      now?: () => number;
      access?: { ensure(workspace: Workspace): Promise<void> };
      beforeArchive?: (workspace: Workspace) => Promise<void>;
      purgeInventory?: (workspace: Workspace) => Promise<void>;
    } = {},
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

  private async report(
    workspace: Workspace,
    phase: WorkspaceStatus["phase"],
    message: string,
    fields: Partial<WorkspaceStatus> = {},
  ) {
    const previous = workspace.status;
    const observedGeneration = workspace.metadata.generation ?? 1;
    if (
      previous?.phase === phase &&
      previous.message === message &&
      previous.observedGeneration === observedGeneration &&
      Object.keys(fields).length === 0
    )
      return;
    const status: WorkspaceStatus = {
      ...previous,
      ...fields,
      phase,
      message,
      observedGeneration,
      pvcName:
        workspace.spec.retentionPolicy?.storage === "Ephemeral"
          ? undefined
          : resourceName(workspace),
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

  private async stop(workspace: Workspace): Promise<boolean> {
    const name = resourceName(workspace);
    const pod = (await this.store.get("Pod", name)) as V1Pod | undefined;
    if (pod && pod.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid)
      throw new Error("Refusing to delete an unowned pod");
    const ephemeral = workspace.spec.retentionPolicy?.storage === "Ephemeral";
    if (workspace.spec.residency === "Suspended" && ephemeral) {
      await this.report(
        workspace,
        "Failed",
        "Ephemeral workspaces cannot suspend; archive to release their data",
      );
      return true;
    }
    if (workspace.spec.residency === "Archived" && !workspace.status?.teardownCompletedAt) {
      if (!pod) {
        if (ephemeral && workspace.status) {
          await this.report(
            workspace,
            "Failed",
            "Ephemeral pod was lost before teardown; automatic cleanup refused",
          );
          return true;
        }
        // A suspended retained workspace must be restored to run its hooks.
        return false;
      }
      if (
        pod.metadata?.deletionTimestamp ||
        !pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")
      ) {
        await this.report(workspace, "Pending", "Waiting for workspace readiness to run teardown");
        return true;
      }
      try {
        await this.options.beforeArchive?.(workspace);
        await this.store.teardown(workspace);
      } catch {
        await this.report(
          workspace,
          "Failed",
          "Teardown failed or outcome unknown; compute and storage retained",
        );
        return true;
      }
      await this.report(workspace, "Pending", "Teardown completed; stopping compute", {
        teardownCompletedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      });
      return true;
    }
    if (pod?.metadata?.uid && !pod.metadata.deletionTimestamp)
      await this.store.deletePod(name, pod.metadata.uid);
    if (pod) {
      await this.report(workspace, "Pending", "Waiting for compute to stop; storage retained");
      return true;
    }
    if (workspace.spec.residency === "Archived" && !(await this.store.deleteRuntime(workspace))) {
      await this.report(workspace, "Pending", "Waiting for owned runtime resources to be removed");
      return true;
    }
    const now = (this.options.now ?? Date.now)();
    const archivedAt = workspace.status?.archivedAt ?? new Date(now).toISOString();
    const ttl = workspace.spec.retentionPolicy?.ttlAfterArchivedSeconds;
    if (
      workspace.spec.residency === "Archived" &&
      ttl !== undefined &&
      !workspace.status?.storageDeletedAt &&
      now >= Date.parse(archivedAt) + ttl * 1000
    ) {
      const pvc = await this.store.get("PersistentVolumeClaim", name);
      if (
        pvc &&
        (pvc.metadata?.labels?.[WORKSPACE_UID_LABEL] !== workspace.metadata.uid ||
          !pvc.metadata?.uid)
      )
        throw new Error("Refusing to collect an unowned volume");
      if (pvc?.metadata?.uid) await this.store.deleteStorage(name, pvc.metadata.uid);
      if (await this.store.get("PersistentVolumeClaim", name)) {
        await this.report(workspace, "Archived", "Waiting for owned storage deletion to finish", {
          archivedAt,
        });
        return true;
      }
      await this.options.purgeInventory?.(workspace);
      await this.report(workspace, "Archived", "Retention expired; owned storage released", {
        archivedAt,
        storageDeletedAt: new Date(now).toISOString(),
      });
      return true;
    }
    await this.report(
      workspace,
      workspace.spec.residency === "Archived" ? "Archived" : "Suspended",
      workspace.status?.storageDeletedAt
        ? "Retention expired; owned storage released"
        : ephemeral
          ? "Compute stopped; ephemeral data released"
          : "Compute stopped; storage retained",
      workspace.spec.residency === "Archived" && !workspace.status?.archivedAt
        ? { archivedAt }
        : {},
    );
    return true;
  }

  async reconcile(workspace: Workspace, projects: Project[]) {
    if (workspace.metadata.deletionTimestamp) return;
    if (!workspace.metadata.uid) throw new Error("Workspace UID required for reconciliation");
    const name = resourceName(workspace);
    if (workspace.spec.residency !== "Running" && (await this.stop(workspace))) return;
    const project = projects.find((p) => p.metadata.name === workspace.spec.projectRef);
    if (!project) {
      await this.report(workspace, "Failed", "Referenced project does not exist");
      return;
    }
    if (!(await this.store.get("Pod", name)) && workspace.spec.residency === "Running") {
      let total = 0;
      let perProject = 0;
      for (const other of await this.store.workspaces()) {
        if (other.metadata.name === workspace.metadata.name) continue;
        if (await this.store.get("Pod", resourceName(other))) {
          total++;
          if (other.spec.projectRef === project.metadata.name) perProject++;
        }
      }
      if (
        (this.options.namespaceLimit !== undefined && total >= this.options.namespaceLimit) ||
        (project.spec.maxRunningWorkspaces !== undefined &&
          perProject >= project.spec.maxRunningWorkspaces)
      ) {
        await this.report(workspace, "Pending", "Workspace capacity reached; waiting for a slot");
        return;
      }
    }
    const profile = await this.store.credentialProfile(workspace.spec.credentialProfile);
    try {
      if (profile) {
        for (const reference of referencedCredentials(profile)) {
          const object =
            reference.kind === "Secret"
              ? await this.store.secret(reference.name)
              : await this.store.configMap(reference.name);
          if (!(reference.key in (object.data ?? {}))) {
            await this.report(
              workspace,
              "Failed",
              "Credential profile reference has a missing key",
            );
            return;
          }
        }
      } else {
        const secret = await this.store.secret(workspace.spec.credentialProfile);
        if (!secret.data?.token) {
          await this.report(workspace, "Failed", "Legacy credential profile has no token");
          return;
        }
      }
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
      await this.report(workspace, "Failed", "Credential profile does not exist");
      return;
    }
    const desired = desiredResources(
      workspace,
      project,
      {
        ...this.config,
        referenceCacheAvailable:
          !project.spec.cache ||
          !!(await this.store.get("PersistentVolumeClaim", project.spec.cache.claimName)),
      },
      profile,
    );
    if (this.config.gatewayUrl) {
      if (!this.options.access) throw new Error("Workspace gateway access is not configured");
      await this.options.access.ensure(workspace);
    }
    if (workspace.spec.retentionPolicy?.storage !== "Ephemeral")
      await this.ensure("PersistentVolumeClaim", desired.pvc, workspace);
    await this.ensure("Service", desired.service, workspace);
    const pod = (await this.ensure("Pod", desired.pod, workspace)) as V1Pod | undefined;
    const ready =
      !pod?.metadata?.deletionTimestamp &&
      pod?.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
    const diagnostic = podDiagnostic(pod);
    const newFailure = diagnostic && workspace.status?.lastFailure?.reason !== diagnostic.reason;
    const terminated = pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed";
    if (diagnostic && (newFailure || (!ready && !terminated))) {
      await this.report(
        workspace,
        ready ? "Ready" : diagnostic.failed ? "Failed" : "Pending",
        ready ? "Workspace daemon is ready" : diagnostic.message,
        newFailure
          ? {
              lastFailure: {
                reason: diagnostic.reason,
                message: diagnostic.message,
                at: new Date().toISOString(),
              },
            }
          : {},
      );
      return;
    }
    if (pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed") {
      if (workspace.spec.retentionPolicy?.storage === "Ephemeral") {
        await this.report(
          workspace,
          "Failed",
          "Ephemeral workspace pod terminated; automatic replacement would lose history",
        );
        return;
      }
      if (pod.metadata?.uid && !pod.metadata.deletionTimestamp)
        await this.store.deletePod(name, pod.metadata.uid);
      await this.report(workspace, "Pending", "Replacing terminated pod; storage retained");
      return;
    }
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
