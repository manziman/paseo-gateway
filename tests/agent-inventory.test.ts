import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  archiveAgentInventory,
  deleteArchivedInventory,
  readArchivedInventory,
  retainedAgentMetadata,
} from "../src/gateway/agent-inventory.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import type { ControlRecord, RecordStore } from "../src/kubernetes/records.js";
import { MemoryStore, workspace } from "./fixtures.js";

describe("durable archived agent inventory", () => {
  it("purges creation receipts only for the retained workspace UID, preserving reused names", async () => {
    const deleted: string[] = [];
    const rows: ControlRecord[] = [
      {
        kind: "creation",
        id: "matching",
        version: "1",
        value: { workspaceId: "one", workspaceUid: "uid-one" },
      },
      {
        kind: "creation",
        id: "replacement",
        version: "1",
        value: { workspaceId: "one", workspaceUid: "uid-replacement" },
      },
      { kind: "creation", id: "legacy", version: "1", value: { workspaceId: "one" } },
    ];
    const records: RecordStore = {
      async records<T>(kind: string) {
        return structuredClone(rows.filter((row) => row.kind === kind)) as ControlRecord<T>[];
      },
      async record() {
        return undefined;
      },
      async createRecord<T>(record: ControlRecord<T>) {
        return record;
      },
      async updateRecord<T>(record: ControlRecord<T>) {
        return record;
      },
      async deleteRecord(record) {
        deleted.push(record.id);
      },
    };
    await deleteArchivedInventory(records, workspace());
    expect(deleted).toEqual(["matching"]);
  });
  it("retains CLI metadata after pod deletion, strips runtime/provider details, filters and expires with storage", async () => {
    let saved: ControlRecord | undefined;
    const records: RecordStore = {
      async records<T>() {
        return saved ? [structuredClone(saved) as ControlRecord<T>] : [];
      },
      async record<T>() {
        return structuredClone(saved) as ControlRecord<T> | undefined;
      },
      async createRecord<T>(value: ControlRecord<T>) {
        saved = { ...value, version: "1" };
        return { ...value, version: "1" };
      },
      async updateRecord<T>(value: ControlRecord<T>) {
        saved = value;
        return value;
      },
      async deleteRecord() {
        saved = undefined;
      },
    };
    const row = workspace();
    const agent = AgentSnapshotPayloadSchema.parse({
      id: "agent",
      provider: "claude",
      cwd: "/workspaces/one",
      workspaceId: "local",
      model: null,
      createdAt: "2026-09-24T00:00:00Z",
      updatedAt: "2026-09-24T00:00:00Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [
        {
          id: "permission",
          provider: "claude",
          kind: "tool",
          name: "Bash",
          input: { sensitive: "permission-secret" },
        },
      ],
      persistence: {
        provider: "claude",
        sessionId: "session",
        metadata: { token: "persistence-secret" },
      },
      runtimeInfo: { provider: "claude", sessionId: null, extra: { token: "runtime-secret" } },
      title: "Worker",
      labels: { role: "reviewer" },
      lastError: "Provider exited",
    });
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        return {
          type: "fetch_agents_response",
          payload: {
            requestId: "requestId" in message ? (message.requestId ?? "") : "",
            entries: [
              {
                agent,
                project: {
                  projectKey: "local",
                  projectName: "Example",
                  checkout: {
                    cwd: agent.cwd,
                    isGit: false,
                    currentBranch: null,
                    remoteUrl: null,
                    isPaseoOwnedWorktree: false,
                    mainRepoRoot: null,
                    worktreeRoot: null,
                  },
                },
              },
            ],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        };
      },
    };
    const receiptMetadata = retainedAgentMetadata(agent);
    expect(receiptMetadata.status).toBe("idle");
    expect(receiptMetadata.pendingPermissions).toEqual([
      { id: "permission", provider: "claude", kind: "tool", name: "Bash" },
    ]);
    expect(receiptMetadata.persistence).toBeNull();
    expect(receiptMetadata.runtimeInfo).toBeUndefined();
    await archiveAgentInventory(records, backend, row, "local");
    const data = JSON.stringify(saved);
    expect(data).not.toContain("permission-secret");
    expect(data).not.toContain("persistence-secret");
    expect(data).not.toContain("runtime-secret");
    const entries = await readArchivedInventory(records, row);
    expect(entries[0]).toMatchObject({
      agent: {
        id: "one~YWdlbnQ",
        status: "closed",
        pendingPermissions: [],
        persistence: null,
        title: "Worker",
        lastError: "Provider exited",
        labels: { role: "reviewer", "paseo-gateway.availability": "archived" },
      },
      project: { projectKey: "example" },
    });
    const store = new MemoryStore();
    row.spec.residency = "Archived";
    store.workspaceRows = [row];
    const emitted: unknown[] = [];
    const session = new GatewaySession({
      store,
      inventoryStore: records,
      namespace: "test",
      backendPassword: "fixture",
      hello: { type: "hello", clientType: "cli", clientId: "test", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (message) => emitted.push(message),
      emitBinary() {},
      disconnect() {},
      backendFactory() {
        throw new Error("Deleted pod must not be contacted");
      },
    });
    await session.handle({
      type: "fetch_agents_request",
      requestId: "all",
      filter: { includeArchived: true },
    });
    expect(emitted[0]).toMatchObject({
      type: "fetch_agents_response",
      payload: {
        entries: [
          expect.objectContaining({
            agent: expect.objectContaining({ title: "Worker", status: "closed" }),
          }),
        ],
      },
    });
    await session.handle({
      type: "fetch_agent_request",
      requestId: "inspect",
      agentId: "one~YWdlbnQ",
    });
    expect(emitted[1]).toMatchObject({
      type: "fetch_agent_response",
      payload: { agent: expect.objectContaining({ lastError: "Provider exited" }) },
    });
    await session.close();
    expect(
      await readArchivedInventory(records, row, {
        type: "fetch_agents_request",
        requestId: "filter",
        filter: { labels: { role: "other" } },
      }),
    ).toEqual([]);
    await expect(
      readArchivedInventory(records, { ...row, metadata: { ...row.metadata, uid: "replacement" } }),
    ).rejects.toThrow("no retained inventory");
    await deleteArchivedInventory(records, row);
    await expect(readArchivedInventory(records, row)).rejects.toThrow("no retained inventory");
  });
});
