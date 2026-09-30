import assert from "node:assert/strict";
import type { Workspace } from "../src/domain.js";

/** Resolve a returned worker to its owned project before inspecting its Pod. */
export function privateWorkerWorkspace(
  agent: { id: string; workspaceId?: string | null },
  workspaces: Workspace[],
  projectId: string,
  parentWorkspaceId: string,
): Workspace {
  assert.ok(agent.workspaceId, "Worker must include explicit workspace membership");
  const workspace = workspaces.find((row) => row.metadata.name === agent.workspaceId);
  assert.ok(workspace, "Worker workspace must exist");
  assert.equal(workspace.spec.projectRef, projectId, "Worker must remain in the selected project");
  assert.notEqual(
    workspace.metadata.name,
    parentWorkspaceId,
    "Worker must use a separate workspace",
  );
  return workspace;
}
