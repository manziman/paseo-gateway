import { createPaseoClient } from "@getpaseo/client";
import {
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { archiveAgentInventory } from "../src/gateway/agent-inventory.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration, workspaceDescriptor } from "../src/gateway/catalog.js";
import { startGateway } from "../src/gateway/server.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const stamp = "2026-09-24T00:00:00Z";
const agent = AgentSnapshotPayloadSchema.parse({
  id: agentId,
  provider: "claude",
  cwd: "/workspaces/one",
  workspaceId: "local",
  model: null,
  createdAt: stamp,
  updatedAt: stamp,
  lastUserMessageAt: stamp,
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
  title: "Retained fixture",
  labels: {},
});

async function fixture() {
  const store = new MemoryStore();
  const row = workspace("one");
  const records = new MemoryRecordStore();
  const routing = new AgentRouting(new AgentIdentityRegistry(records));
  const backend: Backend = {
    async connect() {},
    async close() {},
    send() {},
    binary() {},
    async request(message) {
      if (message.type !== "fetch_agents_request") throw new Error("No timeline backend expected");
      return SessionOutboundMessageSchema.parse({
        type: "fetch_agents_response",
        payload: {
          requestId: message.requestId,
          entries: [
            {
              agent,
              project: {
                projectKey: "local",
                projectName: "Example",
                checkout: {
                  cwd: agent.cwd,
                  isGit: false,
                  mainRepoRoot: null,
                  currentBranch: null,
                  remoteUrl: null,
                  isPaseoOwnedWorktree: false,
                },
              },
            },
          ],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
      });
    },
  };
  await archiveAgentInventory(records, backend, row, "local", "suspended");
  await routing.claim(row, agentId);
  row.spec.residency = "Suspended";
  row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
  store.workspaceRows = [row];
  const output: unknown[] = [];
  let backendOpened = 0;
  const session = new GatewaySession({
    store,
    inventoryStore: records,
    agentRouting: routing,
    namespace: "test",
    backendPassword: "fixture",
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientType: "browser", clientId: "retained", protocolVersion: 1 },
    emit: (message) => output.push(message),
    emitBinary() {},
    disconnect() {},
    backendFactory() {
      backendOpened++;
      throw new Error("Stopped workspace must not start a backend");
    },
  });
  return { store, row, records, output, session, backendOpened: () => backendOpened };
}

async function request(f: Awaited<ReturnType<typeof fixture>>, message: SessionInboundMessage) {
  const before = f.output.length;
  await f.session.handle(message);
  return f.output.slice(before).map((value) => SessionOutboundMessageSchema.parse(value));
}

function replaceFirstWorkspaceUid(store: MemoryStore) {
  const first = store.workspaceRows[0];
  if (!first) throw new Error("Missing fixture workspace");
  first.metadata.uid = "replacement-uid";
}

describe("retained timeline opening", () => {
  it("acknowledges an authorized closed agent without starting its workspace", async () => {
    const f = await fixture();
    try {
      const replies = await request(f, {
        type: "agent.timeline.set_subscription.request",
        requestId: "subscribe",
        agentIds: [agentId],
      });
      expect(replies).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "subscribe", agentIds: [agentId] },
      });
      expect(f.backendOpened()).toBe(0);
      expect(f.store.workspaceRows[0]?.spec.residency).toBe("Suspended");
    } finally {
      await f.session.close();
    }
  });

  it("reports unavailable retained transcript rather than inventing empty history", async () => {
    const f = await fixture();
    try {
      const replies = await request(f, {
        type: "fetch_agent_timeline_request",
        requestId: "history",
        agentId,
        direction: "tail",
        projection: "projected",
      });
      expect(replies).toContainEqual(
        expect.objectContaining({
          type: "fetch_agent_timeline_response",
          payload: expect.objectContaining({
            requestId: "history",
            agentId,
            error: expect.stringMatching(/stopped|suspended|unavailable/i),
          }),
        }),
      );
      expect(f.backendOpened()).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it("does not imply an archived ephemeral transcript still exists", async () => {
    const f = await fixture();
    f.row.spec.residency = "Archived";
    f.row.spec.retentionPolicy = { storage: "Ephemeral" };
    f.row.status = { phase: "Archived", message: "archived", observedGeneration: 1 };
    try {
      const replies = await request(f, {
        type: "fetch_agent_timeline_request",
        requestId: "ephemeral",
        agentId,
        direction: "tail",
      });
      expect(replies).toContainEqual(
        expect.objectContaining({
          type: "fetch_agent_timeline_response",
          payload: expect.objectContaining({
            error: expect.stringMatching(/ephemeral storage was released/i),
          }),
        }),
      );
      expect(f.backendOpened()).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it("allows the pinned SDK to open a retained agent, then rejects uncached history truthfully", async () => {
    const f = await fixture();
    await f.session.close();
    const password = "0123456789abcdef0123456789abcdef";
    const gateway = await startGateway({
      store: f.store,
      inventoryStore: f.records,
      agentRouting: new AgentRouting(new AgentIdentityRegistry(f.records)),
      namespace: "test",
      backendPassword: password,
      password,
      serverId: "retained-timeline-socket",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
      backendFactory() {
        throw new Error("Stopped workspace must not start a backend");
      },
    });
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Missing socket address");
    const client = createPaseoClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      password,
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      const handle = client.agents.ref(agentId);
      const observation = handle.timeline.subscribe(() => {});
      await observation.ready;
      await expect(handle.timeline.refetch({ direction: "tail" })).rejects.toThrow(
        /stopped.*transcript.*unavailable/i,
      );
      await observation.release();
      expect(f.store.workspaceRows[0]?.spec.residency).toBe("Suspended");
    } finally {
      await client.close();
      await gateway.close();
    }
  });

  it("rejects missing or replaced retained data without backend access", async () => {
    const f = await fixture();
    try {
      const record = await f.records.record("agent-inventory", f.row.metadata.uid ?? "");
      if (!record) throw new Error("Missing fixture inventory");
      await f.records.deleteRecord(record);
      const missing = await request(f, {
        type: "agent.timeline.set_subscription.request",
        requestId: "missing",
        agentIds: [agentId],
      });
      expect(missing).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
      replaceFirstWorkspaceUid(f.store);
      const replaced = await request(f, {
        type: "agent.timeline.set_subscription.request",
        requestId: "replaced",
        agentIds: [agentId],
      });
      expect(replaced).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
      expect(f.backendOpened()).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it("rechecks the workspace after the retained snapshot read", async () => {
    const f = await fixture();
    try {
      const read = f.records.record.bind(f.records);
      f.records.record = async <T>(kind: string, id: string) => {
        const value = await read<T>(kind, id);
        if (kind === "agent-inventory") replaceFirstWorkspaceUid(f.store);
        return value;
      };
      const replies = await request(f, {
        type: "agent.timeline.set_subscription.request",
        requestId: "raced",
        agentIds: [agentId],
      });
      expect(replies).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
      expect(f.backendOpened()).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it("keeps Ready membership on its backend while acknowledging a stopped agent locally", async () => {
    const f = await fixture();
    await f.session.close();
    const liveId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const liveWorkspace = workspace("two");
    f.store.workspaceRows.push(liveWorkspace);
    const routing = new AgentRouting(new AgentIdentityRegistry(f.records));
    await routing.claim(liveWorkspace, liveId);
    const sent: string[][] = [];
    const output: unknown[] = [];
    const backend: Backend = {
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
              workspace: { ...workspaceDescriptor(liveWorkspace, project()), id: "local" },
              error: null,
            },
          });
        if (message.type === "fetch_workspaces_request")
          return SessionOutboundMessageSchema.parse({
            type: "fetch_workspaces_response",
            payload: {
              requestId: message.requestId,
              entries: [],
              emptyProjects: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        if (message.type === "agent.timeline.set_subscription.request") {
          sent.push(message.agentIds);
          return SessionOutboundMessageSchema.parse({
            type: "agent.timeline.set_subscription.response",
            payload: { requestId: message.requestId, agentIds: message.agentIds },
          });
        }
        throw new Error(`Unexpected backend request ${message.type}`);
      },
    };
    const session = new GatewaySession({
      store: f.store,
      inventoryStore: f.records,
      agentRouting: routing,
      namespace: "test",
      backendPassword: "fixture",
      directory: new DirectoryGeneration(),
      hello: { type: "hello", clientType: "browser", clientId: "mixed", protocolVersion: 1 },
      emit: (message) => output.push(message),
      emitBinary() {},
      disconnect() {},
      backendFactory(row) {
        if (row.metadata.uid !== liveWorkspace.metadata.uid)
          throw new Error("Stopped backend opened");
        return backend;
      },
    });
    try {
      await session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "mixed",
        agentIds: [agentId, liveId],
      });
      expect(sent).toEqual([[liveId]]);
      expect(output).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "mixed", agentIds: [agentId, liveId] },
      });
    } finally {
      await session.close();
    }
  });

  it("rejects a shared ACK if an earlier retained workspace changes during a later read", async () => {
    const f = await fixture();
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const second = workspace("two");
    const secondAgent = { ...agent, id: secondId, cwd: "/workspaces/two" };
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type !== "fetch_agents_request") throw new Error("Unexpected backend request");
        return SessionOutboundMessageSchema.parse({
          type: "fetch_agents_response",
          payload: {
            requestId: message.requestId,
            entries: [
              {
                agent: secondAgent,
                project: {
                  projectKey: "local",
                  projectName: "Example",
                  checkout: {
                    cwd: secondAgent.cwd,
                    isGit: false,
                    mainRepoRoot: null,
                    currentBranch: null,
                    remoteUrl: null,
                    isPaseoOwnedWorktree: false,
                  },
                },
              },
            ],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        });
      },
    };
    await archiveAgentInventory(f.records, backend, second, "local", "suspended");
    await new AgentRouting(new AgentIdentityRegistry(f.records)).claim(second, secondId);
    second.spec.residency = "Suspended";
    second.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    f.store.workspaceRows.push(second);
    const read = f.records.record.bind(f.records);
    f.records.record = async <T>(kind: string, id: string) => {
      const result = await read<T>(kind, id);
      if (kind === "agent-inventory" && id === second.metadata.uid)
        replaceFirstWorkspaceUid(f.store);
      return result;
    };
    try {
      const replies = await request(f, {
        type: "agent.timeline.set_subscription.request",
        requestId: "two-stopped",
        agentIds: [agentId, secondId],
      });
      expect(replies).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
      expect(replies).not.toContainEqual(
        expect.objectContaining({ type: "agent.timeline.set_subscription.response" }),
      );
      expect(f.backendOpened()).toBe(0);
    } finally {
      await f.session.close();
    }
  });
});
