import type { Project, Workspace } from "../domain.js";
import type { Store } from "../kubernetes/store.js";

/** Serialize API admission in the one supported gateway process, including concurrent clients. */
export class WorkspaceAdmission {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: Store,
    private readonly namespaceLimit?: number,
  ) {}
  async create(workspace: Workspace, project: Project) {
    const operation = this.tail.then(async () => {
      const rows = await this.store.workspaces();
      const existing = rows.find((row) => row.metadata.name === workspace.metadata.name);
      if (existing) return existing;
      const running = rows.filter(
        (row) => row.spec.residency === "Running" && !row.metadata.deletionTimestamp,
      );
      if (this.namespaceLimit !== undefined && running.length >= this.namespaceLimit)
        throw new Error("Namespace running-workspace capacity reached");
      if (
        project.spec.maxRunningWorkspaces !== undefined &&
        running.filter((row) => row.spec.projectRef === project.metadata.name).length >=
          project.spec.maxRunningWorkspaces
      )
        throw new Error("Project running-workspace capacity reached");
      return this.store.createWorkspace(workspace);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
