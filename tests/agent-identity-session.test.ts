import {
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { scopedId } from "../src/domain.js";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration, workspaceDescriptor } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const date = "2026-09-24T00:00:00Z";
const agent = AgentSnapshotPayloadSchema.parse({
  id: nativeId,
  provider: "claude",
  cwd: "/workspaces/one",
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
  title: "Fixture",
  labels: {},
});

function fixture() {
  const store = new MemoryStore();
  const row = workspace("one");
  store.workspaceRows = [row];
  const records = new MemoryRecordStore();
  const routing = new AgentRouting(new AgentIdentityRegistry(records));
  const output: unknown[] = [];
  const requests: SessionInboundMessage[] = [];
  let respond:
    | ((message: SessionInboundMessage) => ReturnType<typeof SessionOutboundMessageSchema.parse>)
    | undefined;
  let backendMessage:
    | ((message: ReturnType<typeof SessionOutboundMessageSchema.parse>) => void)
    | undefined;
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
            workspace: { ...workspaceDescriptor(row, project()), id: "local" },
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
      if (message.type === "fetch_agents_request")
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
      requests.push(message);
      if (respond) return respond(message);
      throw new Error("Mutation outcome unknown");
    },
  };
  const session = new GatewaySession({
    store,
    agentRouting: routing,
    namespace: "test",
    backendPassword: "backend",
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientId: "fixture", clientType: "cli", protocolVersion: 1 },
    emit: (message) => output.push(message),
    emitBinary() {},
    disconnect() {},
    backendFactory: (_workspace, onMessage) => {
      backendMessage = onMessage;
      return backend;
    },
  });
  return {
    store,
    records,
    routing,
    output,
    requests,
    setResponder: (next: typeof respond) => {
      respond = next;
    },
    session,
    emitBackend: (message: ReturnType<typeof SessionOutboundMessageSchema.parse>) =>
      backendMessage?.(message),
  };
}

describe("GUID agent session routing", () => {
  it("publishes one GUID directory entry and accepts GUID and legacy commands", async () => {
    const f = fixture();
    await f.session.handle({ type: "fetch_agents_request", requestId: "list" });
    const reply = f.output.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "fetch_agents_response",
    );
    if (!reply) throw new Error(JSON.stringify(f.output));
    const parsed = SessionOutboundMessageSchema.parse(reply);
    if (parsed.type !== "fetch_agents_response") throw new Error("No directory response");
    expect(parsed.payload.entries.map((entry) => entry.agent.id)).toEqual([nativeId]);
    for (const id of [nativeId, scopedId("one", nativeId)])
      await f.session.handle({ type: "cancel_agent_request", requestId: id, agentId: id });
    expect(f.requests.map((request) => ("agentId" in request ? request.agentId : null))).toEqual([
      nativeId,
      nativeId,
    ]);
    await f.session.close();
  });

  it("rejects a route quarantined while backend connection is pending before a mutation", async () => {
    const f = fixture();
    await f.routing.claim(workspace("one"), nativeId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.store.workspaces.bind(f.store);
    let calls = 0;
    f.store.workspaces = async () => {
      calls++;
      if (calls === 2) {
        entered();
        await pending;
      }
      return original();
    };
    const action = f.session.handle({
      type: "cancel_agent_request",
      requestId: "paused",
      agentId: nativeId,
    });
    await reached;
    await expect(
      new AgentIdentityRegistry(f.records).claim(workspace("two"), nativeId),
    ).rejects.toThrow();
    release();
    await action;
    expect(f.requests).toHaveLength(0);
    expect(f.output).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
    await f.session.close();
  });

  it("rechecks workspace residency after the final awaited identity lookup", async () => {
    const f = fixture();
    await f.routing.claim(workspace("one"), nativeId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.routing.route.bind(f.routing);
    let calls = 0;
    f.routing.route = async (...args) => {
      const value = await original(...args);
      if (++calls === 3) {
        entered();
        await held;
      }
      return value;
    };
    const action = f.session.handle({
      type: "cancel_agent_request",
      requestId: "after-route",
      agentId: nativeId,
    });
    await lookup;
    const current = f.store.workspaceRows[0];
    if (!current) throw new Error("Missing fixture workspace");
    current.spec.residency = "Suspended";
    release();
    await action;
    expect(f.requests).toHaveLength(0);
    expect(f.output).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
    await f.session.close();
  });

  it("fences timeline subscriptions after their final agent-route lookup", async () => {
    const f = fixture();
    await f.routing.claim(workspace("one"), nativeId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const lookup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.routing.resolveAgent.bind(f.routing);
    let calls = 0;
    f.routing.resolveAgent = async (...args) => {
      const result = await original(...args);
      if (++calls === 2) {
        entered();
        await held;
      }
      return result;
    };
    const action = f.session.handle({
      type: "agent.timeline.set_subscription.request",
      requestId: "timeline",
      agentIds: [nativeId],
    });
    await lookup;
    const current = f.store.workspaceRows[0];
    if (!current) throw new Error("Missing fixture workspace");
    current.spec.residency = "Suspended";
    release();
    await action;
    expect(f.requests).toHaveLength(0);
    expect(f.output).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
    await f.session.close();
  });

  it("projects ordered native backend updates as the same GUID directory identity", async () => {
    const f = fixture();
    await f.session.handle({ type: "fetch_agents_request", requestId: "prime" });
    const prior = f.output.length;
    for (const title of ["first", "second"])
      f.emitBackend(
        SessionOutboundMessageSchema.parse({
          type: "agent_update",
          payload: { kind: "upsert", agent: { ...agent, title } },
        }),
      );
    await vi.waitFor(() => {
      expect(
        f.output.filter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "agent_update",
        ),
      ).toHaveLength(2);
    });
    const updates = f.output.slice(prior).map((value) => SessionOutboundMessageSchema.parse(value));
    expect(
      updates.map((value) =>
        value.type === "agent_update" && value.payload.kind === "upsert"
          ? [value.payload.agent.id, value.payload.agent.title]
          : null,
      ),
    ).toEqual([
      [nativeId, "first"],
      [nativeId, "second"],
    ]);
    await f.session.close();
  });

  it("emits a reply before a later backend update while its GUID projection is delayed", async () => {
    const f = fixture();
    await f.session.handle({ type: "fetch_agents_request", requestId: "prime" });
    f.setResponder((message) => {
      if (message.type !== "fetch_agent_request") throw new Error("Unexpected request");
      return SessionOutboundMessageSchema.parse({
        type: "fetch_agent_response",
        payload: { requestId: message.requestId, agent, error: null },
      });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const projecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.routing.project.bind(f.routing);
    f.routing.project = async (...args) => {
      const value = args[0];
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "fetch_agent_response"
      ) {
        entered();
        await held;
      }
      return original(...args);
    };
    const prior = f.output.length;
    const request = f.session.handle({
      type: "fetch_agent_request",
      requestId: "fetch",
      agentId: nativeId,
    });
    await projecting;
    f.emitBackend(
      SessionOutboundMessageSchema.parse({
        type: "agent_update",
        payload: { kind: "upsert", agent: { ...agent, title: "later" } },
      }),
    );
    release();
    await request;
    await vi.waitFor(() => expect(f.output.slice(prior)).toHaveLength(2));
    expect(f.output.slice(prior).map((value) => (value as { type: string }).type)).toEqual([
      "fetch_agent_response",
      "agent_update",
    ]);
    await f.session.close();
  });
});
