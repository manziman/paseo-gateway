import { randomUUID } from "node:crypto";
import {
  getAgentStatusPriority,
  getWorkspaceStateBucketPriority,
} from "@getpaseo/protocol/agent-state-bucket";
import type {
  AgentSnapshotPayload,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
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

/** Provides generation IDs for full snapshots and partial merge responses.
 * Partial responses carry verified rows/removals; this is not a general delta journal.
 */
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

/** Session-local immutable pages prevent duplicates when other pods change between reads.
 * Cursors expire on disconnect/replacement and never authorize access by themselves.
 */
export class DirectoryPages {
  private readonly syncByPage = new Map<
    string,
    NonNullable<
      Extract<SessionOutboundMessage, { type: "fetch_agents_response" }>["payload"]["sync"]
    >
  >();
  private readonly snapshots = new Map<
    string,
    { key: string; entries: unknown[]; expiresAt: number; bytes: number }
  >();
  constructor(private readonly now: () => number = Date.now) {}

  read<T>(
    key: string,
    page: { limit: number; cursor?: string } | undefined,
    entries?: T[],
    sync?: NonNullable<
      Extract<SessionOutboundMessage, { type: "fetch_agents_response" }>["payload"]["sync"]
    >,
  ) {
    for (const [id, snapshot] of this.snapshots)
      if (snapshot.expiresAt <= this.now()) {
        this.snapshots.delete(id);
        this.syncByPage.delete(id);
      }
    let id: string;
    let offset = 0;
    let rows: T[];
    if (page?.cursor) {
      const [token, index, ...extra] = page.cursor.split(":");
      const snapshot = token ? this.snapshots.get(token) : undefined;
      offset = Number(index);
      if (
        !snapshot ||
        snapshot.key !== key ||
        extra.length ||
        !/^\d+$/.test(index ?? "") ||
        !Number.isSafeInteger(offset) ||
        offset >= snapshot.entries.length
      )
        throw new Error("Directory cursor expired or invalid; restart the listing");
      id = token as string;
      rows = snapshot.entries as T[];
      sync = this.syncByPage.get(id);
    } else {
      rows = entries ?? [];
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      // Leave framing headroom under the gateway's 8 MiB socket limit.
      if (bytes > 6 * 1024 * 1024 || rows.length > 10000)
        throw new Error("Directory snapshot capacity exceeded; narrow the filter");
      id = randomUUID();
      if (page && rows.length > page.limit) {
        while (
          this.snapshots.size >= 4 ||
          [...this.snapshots.values()].reduce((total, item) => total + item.bytes, 0) + bytes >
            12 * 1024 * 1024
        ) {
          const oldest = this.snapshots.keys().next().value;
          if (!oldest) break;
          this.snapshots.delete(oldest);
          this.syncByPage.delete(oldest);
        }
        this.snapshots.set(id, {
          key,
          entries: rows,
          bytes,
          expiresAt: this.now() + 5 * 60 * 1000,
        });
        if (sync) this.syncByPage.set(id, sync);
      }
    }
    const limit = page?.limit ?? rows.length;
    const end = offset + limit;
    return {
      entries: rows.slice(offset, end),
      ...(sync ? { sync } : {}),
      pageInfo: {
        nextCursor: end < rows.length ? `${id}:${end}` : null,
        prevCursor: offset ? `${id}:${Math.max(0, offset - limit)}` : null,
        hasMore: end < rows.length,
      },
    };
  }
}

function compare(left: string | number, right: string | number) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Apply ordering after merging pods, using the same state buckets as the pinned daemon. */
export function sortAgents<T extends { agent: AgentSnapshotPayload }>(
  entries: T[],
  sort?: {
    key: "status_priority" | "created_at" | "updated_at" | "title";
    direction: "asc" | "desc";
  }[],
) {
  const fields = sort?.length ? sort : [{ key: "updated_at" as const, direction: "desc" as const }];
  const value = (agent: AgentSnapshotPayload, key: (typeof fields)[number]["key"]) => {
    if (key === "status_priority")
      return getAgentStatusPriority({
        status: agent.status,
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
      });
    if (key === "title") return agent.title?.toLocaleLowerCase() ?? "";
    return Date.parse(key === "created_at" ? agent.createdAt : agent.updatedAt) || 0;
  };
  return entries.sort((left, right) => {
    for (const field of fields) {
      const result = compare(value(left.agent, field.key), value(right.agent, field.key));
      if (result) return field.direction === "asc" ? result : -result;
    }
    return left.agent.id.localeCompare(right.agent.id);
  });
}

export function sortWorkspaces<T extends WorkspaceDescriptorPayload>(
  entries: T[],
  sort?: {
    key: "status_priority" | "activity_at" | "name" | "project_id";
    direction: "asc" | "desc";
  }[],
) {
  const fields = sort?.length
    ? sort
    : [{ key: "activity_at" as const, direction: "desc" as const }];
  const value = (workspace: WorkspaceDescriptorPayload, key: (typeof fields)[number]["key"]) => {
    if (key === "status_priority") return getWorkspaceStateBucketPriority(workspace.status);
    if (key === "name") return workspace.name.toLocaleLowerCase();
    if (key === "project_id") return workspace.projectId.toLocaleLowerCase();
    return workspace.activityAt ? Date.parse(workspace.activityAt) || 0 : 0;
  };
  return entries.sort((left, right) => {
    for (const field of fields) {
      const result = compare(value(left, field.key), value(right, field.key));
      if (result) return field.direction === "asc" ? result : -result;
    }
    return left.id.localeCompare(right.id);
  });
}
