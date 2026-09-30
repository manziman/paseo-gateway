import {
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { scopedId } from "../src/domain.js";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import type { GatewayPrincipal } from "../src/gateway/auth.js";
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

function fixture(principal?: GatewayPrincipal) {
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
    principal,
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

  it("keeps a valid timeline subscription when another durable route lost its workspace", async () => {
    const f = fixture();
    const staleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await f.routing.claim(workspace("one"), nativeId);
    await f.routing.claim(workspace("deleted"), staleId);
    f.setResponder((message) => {
      if (message.type !== "agent.timeline.set_subscription.request")
        throw new Error("Unexpected request");
      return SessionOutboundMessageSchema.parse({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: message.requestId, agentIds: message.agentIds },
      });
    });
    try {
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "valid-only",
        agentIds: [nativeId],
      });
      expect(f.output).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "valid-only", agentIds: [nativeId] },
      });
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "mixed-stale",
        agentIds: [staleId, nativeId],
      });
      expect(f.output).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "mixed-stale", agentIds: [nativeId] },
      });
      expect(f.requests).toHaveLength(2);
      expect(
        f.requests.every(
          (message) =>
            message.type === "agent.timeline.set_subscription.request" &&
            message.agentIds.length === 1 &&
            message.agentIds[0] === nativeId,
        ),
      ).toBe(true);
    } finally {
      await f.session.close();
    }
  });

  it.each(["missing", "replaced", "revoked-profile", "revoked-project"])(
    "omits an initially %s route without leaking or starving authorized membership",
    async (unavailable) => {
      const principal: GatewayPrincipal = {
        kind: "workspace",
        version: 1,
        audience: "test",
        issuedAt: 0,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        tokenId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        projectIds: ["example"],
        credentialProfiles: ["claude-default"],
        originWorkspaceId: "one",
        originWorkspaceUid: "uid-one",
      };
      const f = fixture(principal);
      const staleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await f.routing.claim(workspace("one"), nativeId);
      if (unavailable !== "missing") {
        const stale = workspace("other");
        await f.routing.claim(stale, staleId);
        if (unavailable === "replaced") stale.metadata.uid = "replacement";
        if (unavailable === "revoked-profile") stale.spec.credentialProfile = "other-profile";
        if (unavailable === "revoked-project") stale.spec.projectRef = "other-project";
        f.store.workspaceRows.push(stale);
      }
      f.setResponder((message) => {
        if (message.type !== "agent.timeline.set_subscription.request")
          throw new Error("Unexpected request");
        return SessionOutboundMessageSchema.parse({
          type: "agent.timeline.set_subscription.response",
          payload: { requestId: message.requestId, agentIds: message.agentIds },
        });
      });
      try {
        await f.session.handle({
          type: "agent.timeline.set_subscription.request",
          requestId: "mixed",
          agentIds: [nativeId, staleId, nativeId],
        });
        expect(f.output).toContainEqual({
          type: "agent.timeline.set_subscription.response",
          payload: { requestId: "mixed", agentIds: [nativeId] },
        });
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ agentIds: [nativeId] });
        await f.session.handle({
          type: "fetch_agent_timeline_request",
          requestId: "direct",
          agentId: staleId,
        });
        expect(f.output).toContainEqual(
          expect.objectContaining({
            type: "rpc_error",
            payload: expect.objectContaining({ requestId: "direct" }),
          }),
        );
        expect(f.requests).toHaveLength(1);
      } finally {
        await f.session.close();
      }
    },
  );

  it("acknowledges no unavailable timelines and clears a previous valid subscription", async () => {
    const f = fixture();
    const missingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await f.routing.claim(workspace("one"), nativeId);
    f.setResponder((message) => {
      if (message.type !== "agent.timeline.set_subscription.request")
        throw new Error("Unexpected request");
      return SessionOutboundMessageSchema.parse({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: message.requestId, agentIds: message.agentIds },
      });
    });
    try {
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "all-missing",
        agentIds: [missingId],
      });
      expect(f.output).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "all-missing", agentIds: [] },
      });
      expect(f.requests).toHaveLength(0);
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "live",
        agentIds: [nativeId],
      });
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "clear",
        agentIds: [missingId],
      });
      expect(f.output).toContainEqual({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "clear", agentIds: [] },
      });
      expect(f.requests.at(-1)).toMatchObject({ agentIds: [] });
    } finally {
      await f.session.close();
    }
  });

  it.each(["storage", "corrupt", "collision"])(
    "fails closed on %s errors in a mixed timeline batch",
    async (failure) => {
      const f = fixture();
      const invalidId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await f.routing.claim(workspace("one"), nativeId);
      if (failure === "storage") {
        const original = f.records.record.bind(f.records);
        f.records.record = async <T>(kind: string, id: string) => {
          if (kind === "agent-route" && id === invalidId) throw new Error("Storage unavailable");
          return original<T>(kind, id);
        };
      } else if (failure === "corrupt") {
        await f.records.createRecord({
          kind: "agent-route",
          id: invalidId,
          value: { state: "invalid" },
        });
      } else {
        await f.routing.claim(workspace("one"), invalidId);
        await expect(f.routing.claim(workspace("other"), invalidId)).rejects.toThrow(
          "already bound",
        );
      }
      try {
        await f.session.handle({
          type: "agent.timeline.set_subscription.request",
          requestId: "fail",
          agentIds: [nativeId, invalidId],
        });
        expect(f.output).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
        expect(f.output).not.toContainEqual(
          expect.objectContaining({ type: "agent.timeline.set_subscription.response" }),
        );
        expect(f.requests).toHaveLength(0);
      } finally {
        await f.session.close();
      }
    },
  );

  it("does not acknowledge membership revoked while the backend subscription was awaited", async () => {
    const f = fixture();
    await f.routing.claim(workspace("one"), nativeId);
    f.setResponder((message) => {
      if (message.type !== "agent.timeline.set_subscription.request")
        throw new Error("Unexpected request");
      const current = f.store.workspaceRows[0];
      if (!current) throw new Error("Missing workspace");
      current.spec.credentialProfile = "changed-profile";
      return SessionOutboundMessageSchema.parse({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: message.requestId, agentIds: message.agentIds },
      });
    });
    try {
      await f.session.handle({
        type: "agent.timeline.set_subscription.request",
        requestId: "revoked",
        agentIds: [nativeId],
      });
      expect(f.output).toContainEqual(expect.objectContaining({ type: "rpc_error" }));
      expect(f.output).not.toContainEqual(
        expect.objectContaining({ type: "agent.timeline.set_subscription.response" }),
      );
    } finally {
      await f.session.close();
    }
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
