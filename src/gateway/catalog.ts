import { randomUUID } from "node:crypto";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Project, Workspace } from "../domain.js";
import { projectPath, workspacePath } from "../domain.js";

export function projectDescriptor(project: Project) {
  return {
    projectId: project.metadata.name,
    projectKey: project.metadata.name,
    projectDisplayName: project.spec.displayName,
    projectRootPath: projectPath(project.metadata.name),
    projectKind: "git" as const,
  };
}

export function workspaceDescriptor(
  workspace: Workspace,
  project: Project,
  runtime?: WorkspaceDescriptorPayload,
): WorkspaceDescriptorPayload {
  const available = workspace.spec.residency === "Running" && workspace.status?.phase === "Ready";
  return {
    ...projectDescriptor(project),
    id: workspace.metadata.name,
    workspaceDirectory: workspacePath(workspace.metadata.name),
    workspaceKind: "local_checkout" as const,
    name: workspace.spec.displayName,
    title: workspace.spec.displayName,
    status: available ? (runtime?.status ?? "done") : "failed",
    statusEnteredAt:
      (available ? runtime?.statusEnteredAt : undefined) ??
      workspace.status?.conditions?.[0]?.lastTransitionTime ??
      null,
    activityAt: runtime?.activityAt ?? workspace.metadata.creationTimestamp ?? null,
    archivingAt: null,
    scripts: [],
    gitRuntime: runtime?.gitRuntime ?? null,
    githubRuntime: runtime?.githubRuntime ?? null,
    diffStat: runtime?.diffStat,
  };
}

/** Full snapshots intentionally replace expired cursors. No incremental journal is implied. */
export class DirectoryGeneration {
  readonly id = randomUUID();
  private sequence = 0;
  next() {
    return ++this.sequence;
  }
  snapshot(previousGeneration?: string) {
    return {
      generation: this.id,
      headSeq: this.next(),
      mode: "snapshot" as const,
      reason:
        previousGeneration && previousGeneration !== this.id
          ? ("generation_changed" as const)
          : ("no_cursor" as const),
      removals: [],
    };
  }
}
