import { randomUUID } from "node:crypto";
import {
  type AgentSnapshotPayload,
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { Workspace } from "../domain.js";
import type { RecordStore } from "../kubernetes/records.js";
import type { Backend } from "./backend.js";
import { object, translate } from "./routing.js";

type Entry = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"]["entries"][number];
interface ArchivedInventory {
  workspaceId: string;
  workspaceUid: string;
  capturedAt: string;
  entries: Entry[];
}
const kind = "agent-inventory";
const ArchivedInventorySchema = z.object({
  workspaceId: z.string(),
  workspaceUid: z.string(),
  capturedAt: z.string(),
  entries: z.array(z.unknown()),
});

/** Whitelist durable metadata; provider handles, arbitrary extras and permission inputs
 * may contain sensitive content and must never be copied into control ConfigMaps.
 */
export function retainedAgentMetadata(agent: AgentSnapshotPayload, archivedAt?: string) {
  return AgentSnapshotPayloadSchema.parse({
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    effectiveThinkingOptionId: agent.effectiveThinkingOptionId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    status: archivedAt ? "closed" : agent.status,
    activeTurn: archivedAt ? null : agent.activeTurn,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: archivedAt
      ? []
      : agent.pendingPermissions.map(({ id, provider, name, kind }) => ({
          id,
          provider,
          name,
          kind,
        })),
    persistence: null,
    lastError: agent.lastError,
    title: agent.title,
    labels: {
      ...agent.labels,
      ...(archivedAt ? { "paseo-gateway.availability": "archived" } : {}),
    },
    archivedAt: agent.archivedAt ?? archivedAt,
    requiresAttention: archivedAt ? false : agent.requiresAttention,
    attentionReason: archivedAt ? null : agent.attentionReason,
    attentionTimestamp: agent.attentionTimestamp,
  });
}

/** Retain only directory metadata before releasing compute; transcripts and credentials
 * stay on the workspace volume. Failure to snapshot refuses archive rather than losing inventory.
 */
export async function archiveAgentInventory(
  records: RecordStore,
  backend: Backend,
  workspace: Workspace,
  localId: string,
) {
  const uid = workspace.metadata.uid;
  if (!uid) throw new Error("Workspace UID is required for inventory retention");
  const capturedAt = new Date().toISOString();
  const entries: Entry[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await backend.request({
      type: "fetch_agents_request",
      requestId: randomUUID(),
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    if (response.type !== "fetch_agents_response")
      throw new Error("Unexpected archive inventory response");
    for (const entry of response.payload.entries) {
      const translated = object(translate(entry, workspace, localId, "out"));
      const agent = AgentSnapshotPayloadSchema.parse(translated.agent);
      entries.push({
        project: { ...entry.project, projectKey: workspace.spec.projectRef },
        agent: retainedAgentMetadata(agent, capturedAt),
      });
    }
    if (Buffer.byteLength(JSON.stringify(entries)) > 600000)
      throw new Error(
        "Workspace archive inventory exceeds its metadata budget; split agents across workspaces before archiving",
      );
    cursor = response.payload.pageInfo.hasMore
      ? (response.payload.pageInfo.nextCursor ?? undefined)
      : undefined;
    if (cursor && seen.has(cursor))
      throw new Error("Backend repeated its archive inventory cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const previous = await records.record<ArchivedInventory>(kind, uid);
  const record = {
    kind,
    id: uid,
    version: previous?.version,
    value: { workspaceId: workspace.metadata.name, workspaceUid: uid, capturedAt, entries },
  };
  if (previous) await records.updateRecord(record);
  else await records.createRecord(record);
}

export async function readArchivedInventory(
  records: RecordStore,
  workspace: Workspace,
  message?: Extract<
    SessionInboundMessage,
    { type: "fetch_agents_request" | "fetch_agent_history_request" }
  >,
) {
  if (workspace.status?.storageDeletedAt) return [];
  const record = workspace.metadata.uid
    ? await records.record<ArchivedInventory>(kind, workspace.metadata.uid)
    : undefined;
  const snapshot = ArchivedInventorySchema.safeParse(record?.value);
  if (
    !snapshot.success ||
    snapshot.data.workspaceId !== workspace.metadata.name ||
    snapshot.data.workspaceUid !== workspace.metadata.uid
  )
    throw new Error(
      `Archived workspace ${workspace.metadata.name} has no retained inventory; metadata unavailable, inspect the retained PVC`,
    );
  const response = SessionOutboundMessageSchema.parse({
    type: "fetch_agents_response",
    payload: {
      requestId: "retained",
      entries: snapshot.data.entries,
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    },
  });
  if (response.type !== "fetch_agents_response") throw new Error("Invalid archived inventory");
  return response.payload.entries.filter(({ agent, project }) => {
    const filter = message?.filter;
    if (
      filter?.labels &&
      Object.entries(filter.labels).some(([key, value]) => agent.labels[key] !== value)
    )
      return false;
    if (filter?.statuses?.length && !filter.statuses.includes(agent.status)) return false;
    if (
      filter?.requiresAttention !== undefined &&
      !!agent.requiresAttention !== filter.requiresAttention
    )
      return false;
    if (
      filter?.thinkingOptionId !== undefined &&
      agent.effectiveThinkingOptionId !== filter.thinkingOptionId
    )
      return false;
    const search = message && "search" in message ? message.search?.toLowerCase() : undefined;
    return (
      !search ||
      [
        agent.title,
        project.workspaceName,
        project.projectName,
        project.checkout.currentBranch,
      ].some((value) => value?.toLowerCase().includes(search))
    );
  });
}

/** Run when the workspace retention deadline releases its data, using its immutable UID. */
export async function deleteArchivedInventory(records: RecordStore, workspace: Workspace) {
  if (!workspace.metadata.uid) return;
  const record = await records.record(kind, workspace.metadata.uid);
  if (record) await records.deleteRecord(record);
  // Creation receipts share the workspace's retention lifetime. Match immutable
  // identity, never just a reusable Kubernetes name; legacy unscoped records stay put.
  for (const receipt of [
    ...(await records.records("creation")),
    ...(await records.records("creation-operation")),
  ]) {
    const value = z
      .object({ workspaceId: z.string(), workspaceUid: z.string() })
      .safeParse(receipt.value);
    if (
      value.success &&
      value.data.workspaceUid === workspace.metadata.uid &&
      value.data.workspaceId === workspace.metadata.name
    )
      await records.deleteRecord(receipt);
  }
}
