import { posix } from "node:path";
import { parseScopedId, scopedId, type Workspace, workspacePath } from "../domain.js";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as JsonObject;
}

const scopedKeys = new Set([
  "agentId",
  "parentAgentId",
  "terminalId",
  "sourceAgentId",
  "targetAgentId",
  "callerAgentId",
]);
// Never traverse user/provider content: a prompt containing an `agentId` property is still just content.
const opaqueKeys = new Set([
  "env",
  "event",
  "content",
  "message",
  "text",
  "config",
  "labels",
  "request",
  "pendingPermissions",
  "resolution",
  "detail",
  "state",
  "data",
  "arguments",
  "input",
  "output",
  "metadata",
  "extra",
  "outputSchema",
]);

/** Translate routing metadata only. Agent and terminal IDs remain reversible across gateway replacement. */
export function translate(
  value: unknown,
  workspace: Workspace,
  backendWorkspaceId: string,
  direction: "in" | "out",
  context = "",
): unknown {
  if (Array.isArray(value))
    return value.map((item) => translate(item, workspace, backendWorkspaceId, direction, context));
  if (!value || typeof value !== "object") return value;
  const result: JsonObject = {};
  const record = object(value);
  for (const [key, item] of Object.entries(record)) {
    // A caller-chosen ID on creation identifies the new backend resource, not a route.
    if (direction === "in" && record.type === "agent.create.request" && key === "agentId") {
      result[key] = item;
      continue;
    }
    if (
      typeof item === "string" &&
      (scopedKeys.has(key) ||
        (key === "id" &&
          (context === "agent" ||
            context === "agents" ||
            context === "terminal" ||
            context === "terminals")))
    ) {
      if (direction === "out") result[key] = scopedId(workspace.metadata.name, item);
      else {
        const parsed = parseScopedId(item);
        if (parsed.workspaceId !== workspace.metadata.name)
          throw new Error("Cross-workspace routing is not allowed");
        result[key] = parsed.backendId;
      }
    } else if (key === "workspaceId" && typeof item === "string") {
      if (direction === "in" && item !== workspace.metadata.name)
        throw new Error("Workspace routing mismatch");
      result[key] = direction === "in" ? backendWorkspaceId : workspace.metadata.name;
    } else if ((key === "projectId" || key === "projectKey") && direction === "out")
      result[key] = workspace.spec.projectRef;
    else
      result[key] = opaqueKeys.has(key)
        ? item
        : translate(item, workspace, backendWorkspaceId, direction, key);
  }
  return result;
}

/** Paths have a unique, real mount location per workspace, including directory-backed client caches. */
export function selectWorkspace(message: JsonObject, workspaces: Workspace[]): Workspace {
  const candidates = new Set<string>();
  if (typeof message.workspaceId === "string") candidates.add(message.workspaceId);
  for (const key of scopedKeys)
    if (
      typeof message[key] === "string" &&
      !(message.type === "agent.create.request" && key === "agentId")
    )
      candidates.add(parseScopedId(message[key]).workspaceId);
  const config = message.config && typeof message.config === "object" ? object(message.config) : {};
  const cwd = message.cwd ?? config.cwd;
  if (typeof cwd === "string") {
    const normalized = posix.normalize(cwd);
    const match = workspaces.find(
      (w) =>
        normalized === workspacePath(w.metadata.name) ||
        normalized.startsWith(`${workspacePath(w.metadata.name)}/`),
    );
    if (!match) throw new Error("Path is outside configured workspaces");
    candidates.add(match.metadata.name);
  }
  if (candidates.size !== 1)
    throw new Error("A single workspace must be identified for this operation");
  const selected = workspaces.find((w) => candidates.has(w.metadata.name));
  if (!selected) throw new Error("Workspace does not exist");
  return selected;
}

/** Terminal slots are connection-scoped; backend slot 1 in two pods must not collide. */
export class TerminalSlots {
  private readonly bindings = new Map<number, { workspaceId: string; backendSlot: number }>();
  outward(workspaceId: string, backendSlot: number): number {
    for (const [slot, binding] of this.bindings)
      if (binding.workspaceId === workspaceId && binding.backendSlot === backendSlot) return slot;
    for (let slot = 0; slot < 256; slot++)
      if (!this.bindings.has(slot)) {
        this.bindings.set(slot, { workspaceId, backendSlot });
        return slot;
      }
    throw new Error("Terminal slot capacity reached; reconnect to reset subscriptions");
  }
  inward(slot: number) {
    const binding = this.bindings.get(slot);
    if (!binding) throw new Error("Unknown terminal slot");
    return binding;
  }
}
