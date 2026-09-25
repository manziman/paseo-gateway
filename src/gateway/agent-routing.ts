import { z } from "zod";
import { parseScopedId, scopedId, type Workspace } from "../domain.js";
import type { AgentIdentityRegistry } from "./agent-identity.js";
import { type JsonObject, object } from "./routing.js";

const agentKeys = new Set([
  "agentId",
  "parentAgentId",
  "sourceAgentId",
  "targetAgentId",
  "callerAgentId",
]);
const parentLabel = "paseo.parent-agent-id";
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
function agentField(key: string, context: string) {
  return agentKeys.has(key) || (key === "id" && (context === "agent" || context === "agents"));
}
async function mapBounded<T, R>(values: readonly T[], map: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await map(values[index] as T);
      }
    }),
  );
  return output;
}
function projectedId(value: string, workspace: Workspace) {
  if (!value.includes("~")) return z.guid().parse(value);
  const route = parseScopedId(value);
  if (route.workspaceId !== workspace.metadata.name)
    throw new Error("Backend agent identity escaped its workspace");
  return route.backendId;
}

/** Agent identity projection is separate from workspace/terminal/path translation.
 * Only routing metadata is walked; provider payload and user content stay opaque.
 */
export class AgentRouting {
  constructor(private readonly registry: AgentIdentityRegistry) {}

  onCollision(listener: () => void) {
    return this.registry.onCollision(listener);
  }

  claim(workspace: Workspace, backendAgentId: string) {
    return this.registry.claim(workspace, backendAgentId);
  }

  reserveForCreate(workspace: Workspace, requestedId: string) {
    return this.registry.reserveForCreate(workspace, requestedId);
  }

  resolveAgent(id: string, authorizedWorkspaces: readonly Workspace[]) {
    return this.registry.resolve(id, authorizedWorkspaces);
  }

  private verifiedClaim(workspace: Workspace, id: string, memo: Map<string, Promise<string>>) {
    let pending = memo.get(id);
    if (!pending) {
      pending = (async () => {
        const publicId = await this.registry.claim(workspace, id);
        // A second registry may have quarantined a cached claim. Outward identity
        // must be checked against the durable record before publishing it.
        await this.registry.resolve(publicId, [workspace]);
        return publicId;
      })();
      memo.set(id, pending);
    }
    return pending;
  }

  async project(
    value: unknown,
    workspace: Workspace,
    context = "",
    memo = new Map<string, Promise<string>>(),
  ): Promise<unknown> {
    if (Array.isArray(value))
      return mapBounded(value, (item) => this.project(item, workspace, context, memo));
    if (!value || typeof value !== "object") return value;
    const record = object(value);
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "string" && agentField(key, context)) {
        result[key] = await this.verifiedClaim(workspace, projectedId(item, workspace), memo);
      } else if (key === "agentIds" && Array.isArray(item)) {
        result[key] = await mapBounded(item, async (id) => {
          if (typeof id !== "string") throw new Error("Invalid agent ID array");
          return this.verifiedClaim(workspace, projectedId(id, workspace), memo);
        });
      } else if (key === "labels" && item && typeof item === "object" && !Array.isArray(item)) {
        const labels = { ...object(item) };
        const parent = labels[parentLabel];
        if (typeof parent === "string" && parent.includes("~")) {
          try {
            const legacy = parseScopedId(parent);
            if (z.guid().safeParse(legacy.backendId).success)
              labels[parentLabel] = legacy.backendId;
          } catch {
            // Preserve malformed legacy metadata verbatim; it cannot authorize routing.
          }
        }
        result[key] = labels;
      } else {
        result[key] = opaqueKeys.has(key) ? item : await this.project(item, workspace, key, memo);
      }
    }
    return result;
  }

  async route(
    value: unknown,
    authorizedWorkspaces: readonly Workspace[],
    context = "",
  ): Promise<unknown> {
    if (Array.isArray(value))
      return mapBounded(value, (item) => this.route(item, authorizedWorkspaces, context));
    if (!value || typeof value !== "object") return value;
    const record = object(value);
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(record)) {
      if (
        typeof item === "string" &&
        agentField(key, context) &&
        !(record.type === "agent.create.request" && key === "agentId")
      ) {
        const resolved = await this.registry.resolve(item, authorizedWorkspaces);
        result[key] = scopedId(resolved.workspace.metadata.name, resolved.backendAgentId);
      } else if (key === "agentIds" && Array.isArray(item)) {
        result[key] = await mapBounded(item, async (id) => {
          if (typeof id !== "string") throw new Error("Invalid agent ID array");
          const resolved = await this.registry.resolve(id, authorizedWorkspaces);
          return scopedId(resolved.workspace.metadata.name, resolved.backendAgentId);
        });
      } else {
        result[key] = opaqueKeys.has(key)
          ? item
          : await this.route(item, authorizedWorkspaces, key);
      }
    }
    return result;
  }
}
