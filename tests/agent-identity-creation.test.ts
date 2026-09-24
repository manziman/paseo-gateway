import { createHash } from "node:crypto";
import {
  AgentSnapshotPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { WorkspaceAdmission } from "../src/controller/admission.js";
import { scopedId } from "../src/domain.js";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { WorkspaceOperations } from "../src/gateway/workspace-operations.js";
import type { ControlRecord } from "../src/kubernetes/records.js";
import { MemoryStore, project, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const date = "2026-09-24T00:00:00Z";
const oldAgent = AgentSnapshotPayloadSchema.parse({
  id: nativeId,
  provider: "claude",
  cwd: "/workspaces/two",
  workspaceId: "local",
  model: null,
  createdAt: date,
  updatedAt: date,
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
  pendingPermissions: [],
  persistence: null,
  title: "Earlier agent",
  labels: {},
});
class StoreWithRecords extends MemoryStore {
  private readonly recordsStore = new MemoryRecordStore();
  records<T>(kind: string) {
    return this.recordsStore.records<T>(kind);
  }
  record<T>(kind: string, id: string) {
    return this.recordsStore.record<T>(kind, id);
  }
  createRecord<T>(record: ControlRecord<T>) {
    return this.recordsStore.createRecord(record);
  }
  updateRecord<T>(record: ControlRecord<T>) {
    return this.recordsStore.updateRecord(record);
  }
  deleteRecord(record: ControlRecord) {
    return this.recordsStore.deleteRecord(record);
  }
}

describe("GUID creation reservation", () => {
  it("does not send a new agent after its reserved-route lookup if the workspace stops", async () => {
    const store = new StoreWithRecords();
    const row = workspace("one");
    store.workspaceRows = [row];
    const routing = new AgentRouting(new AgentIdentityRegistry(store));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = routing.resolveAgent.bind(routing);
    routing.resolveAgent = async (...args) => {
      const result = await original(...args);
      entered();
      await held;
      return result;
    };
    let mutations = 0;
    const operations = new WorkspaceOperations({
      store,
      namespace: "test",
      backendPassword: "backend",
      admission: new WorkspaceAdmission(store),
      agentRouting: routing,
      backendFactory: (workspaceRow) => ({
        async connect() {},
        async close() {},
        send() {},
        binary() {},
        async request(message) {
          if (message.type === "open_project_request")
            return SessionOutboundMessageSchema.parse({
              type: "open_project_response",
              payload: {
                requestId: message.requestId,
                workspace: { ...workspaceDescriptor(workspaceRow, project()), id: "local" },
                error: null,
              },
            });
          mutations++;
          throw new Error("Creation mutation must not reach backend");
        },
      }),
    });
    const input = SessionInboundMessageSchema.parse({
      type: "agent.create.request",
      requestId: "stopped-after-route",
      workspaceId: "one",
      config: { provider: "claude", cwd: "/workspaces/one" },
    });
    if (input.type !== "agent.create.request") throw new Error("Wrong fixture");
    const action = operations.createAgent(input);
    await lookup;
    row.spec.residency = "Suspended";
    release();
    await expect(action).rejects.toThrow("Creation workspace access denied");
    expect(mutations).toBe(0);
  });
  it("projects a pre-upgrade journal subscription and idempotent replay without another mutation", async () => {
    const store = new StoreWithRecords();
    const row = workspace("two");
    store.workspaceRows = [row];
    const routing = new AgentRouting(new AgentIdentityRegistry(store));
    const oldId = scopedId("two", nativeId);
    const message = SessionInboundMessageSchema.parse({
      type: "agent.create.request",
      requestId: "replay",
      idempotencyKey: "old-key",
      workspaceId: "two",
      config: { provider: "claude", cwd: "/workspaces/two" },
    });
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await store.createRecord({
      kind: "creation-operation",
      id: digest(["agent", "old-key"]),
      value: {
        fingerprint: digest({ ...message, requestId: undefined, subscribe: undefined }),
        actor: "owner",
        instance: "previous-gateway",
        workspaceId: "two",
        workspaceUid: row.metadata.uid,
        dispatching: false,
        snapshot: {
          kind: "agent",
          idempotencyKey: "old-key",
          revision: 3,
          phase: "completed",
          workspaceId: "two",
          agentId: oldId,
          agent: { ...oldAgent, id: oldId, workspaceId: "two" },
          error: null,
        },
      },
    });
    let mutations = 0;
    const operations = new WorkspaceOperations({
      store,
      namespace: "test",
      backendPassword: "backend",
      admission: new WorkspaceAdmission(store),
      agentRouting: routing,
      backendFactory: () => {
        mutations++;
        throw new Error("Replay must not connect to the backend");
      },
    });
    const emitted: unknown[] = [];
    const emit = (value: unknown) => emitted.push(value);
    await operations.handle(
      SessionInboundMessageSchema.parse({
        type: "creation.subscribe.request",
        requestId: "observe",
        kind: "agent",
        idempotencyKey: "old-key",
        subscribe: false,
      }),
      emit,
      { kind: "owner" },
    );
    await operations.handle(message, emit, { kind: "owner" });
    const payloads = emitted.map(
      (value) => (value as { payload: Record<string, unknown> }).payload,
    );
    expect(payloads[0]?.snapshot).toMatchObject({ agentId: nativeId });
    expect(payloads[1]?.creation).toMatchObject({ agentId: nativeId });
    expect(payloads[1]?.agent).toMatchObject({ id: nativeId });
    expect(mutations).toBe(0);
  });
  it("backfills a pre-upgrade agent before rejecting a duplicate without quarantining the victim", async () => {
    const store = new StoreWithRecords();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const routing = new AgentRouting(new AgentIdentityRegistry(store));
    let mutations = 0;
    const operations = new WorkspaceOperations({
      store,
      namespace: "test",
      backendPassword: "backend",
      admission: new WorkspaceAdmission(store),
      agentRouting: routing,
      backendFactory: (row) => ({
        async connect() {},
        async close() {},
        send() {},
        binary() {},
        async request(message) {
          if (message.type === "open_project_request")
            return SessionOutboundMessageSchema.parse({
              type: "open_project_response",
              payload: {
                requestId: message.requestId,
                workspace: { ...workspaceDescriptor(row, project()), id: "local" },
                error: null,
              },
            });
          if (message.type === "fetch_agents_request")
            return SessionOutboundMessageSchema.parse({
              type: "fetch_agents_response",
              payload: {
                requestId: message.requestId,
                entries:
                  row.metadata.name === "two"
                    ? [
                        {
                          agent: oldAgent,
                          project: {
                            projectKey: "local",
                            projectName: "Example",
                            checkout: {
                              cwd: oldAgent.cwd,
                              isGit: false,
                              mainRepoRoot: null,
                              currentBranch: null,
                              remoteUrl: null,
                              isPaseoOwnedWorktree: false,
                            },
                          },
                        },
                      ]
                    : [],
                pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
              },
            });
          mutations++;
          throw new Error("Unexpected backend mutation");
        },
      }),
    });
    const input = SessionInboundMessageSchema.parse({
      type: "agent.create.request",
      requestId: "create",
      workspaceId: "one",
      agentId: nativeId,
      config: { provider: "claude", cwd: "/workspaces/one" },
    });
    if (input.type !== "agent.create.request") throw new Error("Wrong fixture");
    await expect(operations.createAgent(input)).rejects.toThrow("already reserved");
    expect(mutations).toBe(0);
    await expect(routing.resolveAgent(nativeId, [workspace("two")])).resolves.toMatchObject({
      backendAgentId: nativeId,
    });
  });

  it("blocks caller-chosen GUIDs while a resumed workspace has only stale retained inventory", async () => {
    const store = new StoreWithRecords();
    const pending = workspace("two");
    pending.status = { phase: "Pending", message: "restarting", observedGeneration: 1 };
    store.workspaceRows = [workspace("one"), pending];
    await store.createRecord({
      kind: "agent-inventory",
      id: pending.metadata.uid ?? "",
      value: {
        workspaceId: "two",
        workspaceUid: pending.metadata.uid,
        capturedAt: date,
        availability: "suspended",
        entries: [],
      },
    });
    const routing = new AgentRouting(new AgentIdentityRegistry(store));
    let mutations = 0;
    const operations = new WorkspaceOperations({
      store,
      namespace: "test",
      backendPassword: "backend",
      admission: new WorkspaceAdmission(store),
      agentRouting: routing,
      backendFactory: (row) => ({
        async connect() {},
        async close() {},
        send() {},
        binary() {},
        async request(message) {
          if (message.type === "open_project_request")
            return SessionOutboundMessageSchema.parse({
              type: "open_project_response",
              payload: {
                requestId: message.requestId,
                workspace: { ...workspaceDescriptor(row, project()), id: "local" },
                error: null,
              },
            });
          if (message.type === "fetch_agents_request")
            return SessionOutboundMessageSchema.parse({
              type: "fetch_agents_response",
              payload: {
                requestId: message.requestId,
                entries: [],
                pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
              },
            });
          mutations++;
          throw new Error("Mutation must not reach backend");
        },
      }),
    });
    const input = SessionInboundMessageSchema.parse({
      type: "agent.create.request",
      requestId: "explicit",
      workspaceId: "one",
      agentId: nativeId,
      config: { provider: "claude", cwd: "/workspaces/one" },
    });
    if (input.type !== "agent.create.request") throw new Error("Wrong fixture");
    await expect(operations.createAgent(input)).rejects.toThrow("restarting workspace");
    expect(mutations).toBe(0);
    expect(await store.record("agent-route", nativeId)).toBeUndefined();
  });
});
