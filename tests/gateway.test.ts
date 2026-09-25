import { createPaseoClient } from "@getpaseo/client";
import {
  type SessionInboundMessage,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { scopedId } from "../src/domain.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration, workspaceDescriptor } from "../src/gateway/catalog.js";
import { authorized, startGateway } from "../src/gateway/server.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "0123456789abcdef0123456789abcdef";

describe("Paseo client contract", () => {
  it.each([
    { origin: "paseo://app", token: password, host: "127.0.0.1", status: 101 },
    { origin: "paseo://app", token: "wrong", host: "127.0.0.1", status: 401 },
    { origin: "paseo://app", token: password, host: "untrusted.example", status: 401 },
    { origin: "https://app", token: password, host: "127.0.0.1", status: 401 },
    { origin: "paseo://app.evil.example", token: password, host: "127.0.0.1", status: 401 },
    { origin: "paseo://app@evil.example", token: password, host: "127.0.0.1", status: 401 },
  ])(
    "enforces desktop origin, Host and bearer boundaries: $origin / $host / $status",
    async (input) => {
      const gateway = await startGateway({
        store: new MemoryStore(),
        namespace: "test",
        backendPassword: password,
        password,
        serverId: "desktop-origin-fixture",
        host: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        ready: async () => true,
      });
      cleanups.push(() => gateway.close());
      const address = gateway.server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${address.port}/ws`,
          [`paseo.bearer.${input.token}`],
          {
            origin: input.origin,
            headers: { host: input.host },
            handshakeTimeout: 2000,
          },
        );
        ws.on("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("error", reject);
      });
      expect(status).toBe(input.status);
    },
  );
  it("authenticates and lists configured projects before any workspace exists", async () => {
    const store = new MemoryStore();
    const gateway = await startGateway({
      store,
      namespace: "test",
      backendPassword: password,
      password,
      serverId: "retained-host",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
    });
    cleanups.push(() => gateway.close());
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const client = createPaseoClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      password,
      reconnect: { enabled: false },
    });
    cleanups.push(() => client.close());
    await client.connect();
    const result = await client.projects.list();
    expect(result.projects[0]?.projectId).toBe("example");
    const created = await client.workspaces.create({
      title: "First",
      source: { kind: "directory", path: "/projects/example", projectId: "example" },
    });
    expect(created.name).toBe("First");
    expect(store.workspaceRows).toHaveLength(1);
    const list = await client.workspaces.list();
    expect(list.entries).toHaveLength(1);
  });
  it("accepts both upstream direct authentication mechanisms and rejects missing credentials", () => {
    expect(authorized({ headers: { authorization: `Bearer ${password}` } }, password)).toBe(true);
    expect(
      authorized({ headers: { "sec-websocket-protocol": `paseo.bearer.${password}` } }, password),
    ).toBe(true);
    expect(authorized({ headers: {} }, password)).toBe(false);
    expect(authorized({ headers: { authorization: "Bearer wrong" } }, password)).toBe(false);
  });
  it("rejects an unauthenticated WebSocket upgrade", async () => {
    const gateway = await startGateway({
      store: new MemoryStore(),
      namespace: "test",
      backendPassword: password,
      password,
      serverId: "retained-host",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
    });
    cleanups.push(() => gateway.close());
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      ws.on("error", () => resolve());
      ws.on("open", () => {
        ws.close();
        reject(new Error("Unauthenticated connection accepted"));
      });
    });
  });
});

describe("gateway failure contract", () => {
  it("does not turn unavailable backend inventory into an authoritative empty snapshot", async () => {
    const store = new MemoryStore();
    const row = workspace();
    row.status = { phase: "Pending", message: "starting", observedGeneration: 1 };
    store.workspaceRows = [row];
    const emitted: unknown[] = [];
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: password,
      hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (value) => emitted.push(value),
      emitBinary() {},
      disconnect() {},
    });
    await session.handle({ type: "fetch_agents_request", requestId: "list" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { requestId: "list" } });
  });
  it("dispatches a mutation once when a backend loses its response", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    let mutations = 0;
    const emitted: unknown[] = [];
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message: SessionInboundMessage): Promise<SessionOutboundMessage> {
        if (message.type === "open_project_request")
          return SessionOutboundMessageSchema.parse({
            type: "open_project_response",
            payload: {
              requestId: message.requestId,
              workspace: { ...workspaceDescriptor(workspace(), project()), id: "local" },
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
              subscriptionId: null,
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        mutations++;
        throw new Error("Response lost; inspect before retrying");
      },
    };
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: password,
      hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (value) => emitted.push(value),
      emitBinary() {},
      disconnect() {},
      backendFactory: () => backend,
    });
    await session.handle({
      type: "cancel_agent_request",
      requestId: "mutation",
      agentId: scopedId("one", "abc"),
    });
    expect(mutations).toBe(1);
    expect(emitted[0]).toMatchObject({
      type: "rpc_error",
      payload: { error: "Response lost; inspect before retrying" },
    });
    await session.close();
  });
});

describe("aggregate workspace and timeline subscriptions", () => {
  it("pinned SDK observes selective streams across workspaces and releases membership", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const requests = new Map<string, string[][]>();
    const callbacks = new Map<string, (message: SessionOutboundMessage) => void>();
    const gateway = await startGateway({
      store,
      namespace: "test",
      backendPassword: password,
      password,
      serverId: "selective-timeline-fixture",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
      backendFactory: (row, onMessage) => {
        const id = row.metadata.name;
        callbacks.set(id, onMessage);
        const descriptor = { ...workspaceDescriptor(row, project()), id: "local" };
        return {
          async connect() {},
          async close() {},
          send() {},
          binary() {},
          async request(message) {
            if (message.type === "open_project_request")
              return SessionOutboundMessageSchema.parse({
                type: "open_project_response",
                payload: { requestId: message.requestId, workspace: descriptor, error: null },
              });
            if (message.type === "fetch_workspaces_request")
              return SessionOutboundMessageSchema.parse({
                type: "fetch_workspaces_response",
                payload: {
                  requestId: message.requestId,
                  entries: [descriptor],
                  emptyProjects: [],
                  subscriptionId: message.subscribe?.subscriptionId,
                  pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
                },
              });
            if (message.type === "agent.timeline.set_subscription.request") {
              requests.set(id, [...(requests.get(id) ?? []), message.agentIds]);
              return {
                type: "agent.timeline.set_subscription.response",
                payload: { requestId: message.requestId, agentIds: message.agentIds },
              };
            }
            throw new Error(`Unexpected request ${message.type}`);
          },
        };
      },
    });
    cleanups.push(() => gateway.close());
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const client = createPaseoClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      password,
      reconnect: { enabled: false },
    });
    cleanups.push(() => client.close());
    await client.connect();
    const events: Array<{ agentId: string; type: string; itemType?: string }> = [];
    const a = client.agents.ref(scopedId("one", "agent-a")).timeline.subscribe((message) => {
      events.push({
        agentId: message.agentId,
        type: message.event.type,
        itemType: message.event.type === "timeline" ? message.event.item.type : undefined,
      });
    });
    const b = client.agents.ref(scopedId("two", "agent-b")).timeline.subscribe((message) => {
      events.push({ agentId: message.agentId, type: message.event.type });
    });
    await Promise.all([a.ready, b.ready]);
    expect(requests.get("one")?.at(-1)).toEqual(["agent-a"]);
    expect(requests.get("two")?.at(-1)).toEqual(["agent-b"]);
    callbacks.get("one")?.(
      SessionOutboundMessageSchema.parse({
        type: "agent_stream",
        payload: {
          agentId: "agent-a",
          timestamp: new Date(0).toISOString(),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "reasoning", text: "synthetic thinking" },
          },
        },
      }),
    );
    callbacks.get("two")?.(
      SessionOutboundMessageSchema.parse({
        type: "agent_stream",
        payload: {
          agentId: "agent-b",
          timestamp: new Date(0).toISOString(),
          event: {
            type: "timeline",
            provider: "claude",
            item: {
              type: "tool_call",
              callId: "synthetic-call",
              name: "Read",
              detail: { type: "plain_text", text: "synthetic tool" },
              status: "completed",
              error: null,
            },
          },
        },
      }),
    );
    await expect
      .poll(() => events)
      .toEqual([
        { agentId: scopedId("one", "agent-a"), type: "timeline", itemType: "reasoning" },
        { agentId: scopedId("two", "agent-b"), type: "timeline" },
      ]);
    await a.release();
    await expect.poll(() => requests.get("one")?.at(-1)).toEqual([]);
    expect(requests.get("two")?.at(-1)).toEqual(["agent-b"]);
    await b.release();
    await expect.poll(() => requests.get("two")?.at(-1)).toEqual([]);
  });

  it("projects runtime status under cluster identity and partitions timeline subscriptions", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const emitted: unknown[] = [];
    const callbacks = new Map<string, (message: SessionOutboundMessage) => void>();
    const timelineRequests = new Map<string, string[]>();
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: password,
      hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (value) => emitted.push(value),
      emitBinary() {},
      disconnect() {},
      backendFactory: (row, onMessage) => {
        const id = row.metadata.name;
        callbacks.set(id, onMessage);
        const descriptor = {
          ...workspaceDescriptor(row, project()),
          id: "local",
          status: "running",
        };
        return {
          async connect() {},
          async close() {},
          send() {},
          binary() {},
          async request(message) {
            if (message.type === "open_project_request")
              return SessionOutboundMessageSchema.parse({
                type: "open_project_response",
                payload: { requestId: message.requestId, workspace: descriptor, error: null },
              });
            if (message.type === "fetch_workspaces_request")
              return SessionOutboundMessageSchema.parse({
                type: "fetch_workspaces_response",
                payload: {
                  requestId: message.requestId,
                  entries: [descriptor],
                  emptyProjects: [],
                  subscriptionId: message.subscribe?.subscriptionId,
                  pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
                },
              });
            if (message.type === "agent.timeline.set_subscription.request") {
              timelineRequests.set(id, message.agentIds);
              return {
                type: "agent.timeline.set_subscription.response",
                payload: { requestId: message.requestId, agentIds: message.agentIds },
              };
            }
            throw new Error(`Unexpected request ${message.type}`);
          },
        };
      },
    });
    cleanups.push(() => session.close());
    await session.handle({
      type: "fetch_workspaces_request",
      requestId: "list",
      subscribe: { subscriptionId: "desktop" },
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "fetch_workspaces_response",
        payload: expect.objectContaining({
          entries: [
            expect.objectContaining({ id: "one", projectId: "example", status: "running" }),
            expect.objectContaining({ id: "two", projectId: "example", status: "running" }),
          ],
        }),
      }),
    );
    callbacks.get("one")?.(
      SessionOutboundMessageSchema.parse({
        type: "workspace_update",
        payload: {
          kind: "upsert",
          workspace: {
            ...workspaceDescriptor(workspace(), project()),
            id: "local",
            name: "backend name",
            status: "needs_input",
          },
        },
      }),
    );
    await expect
      .poll(() => emitted)
      .toContainEqual(
        expect.objectContaining({
          type: "workspace_update",
          payload: expect.objectContaining({
            workspace: expect.objectContaining({ id: "one", name: "one", status: "needs_input" }),
          }),
        }),
      );
    await session.handle({
      type: "agent.timeline.set_subscription.request",
      requestId: "timeline",
      agentIds: [scopedId("one", "agent-a"), scopedId("two", "agent-b")],
    });
    expect(timelineRequests.get("one")).toEqual(["agent-a"]);
    expect(timelineRequests.get("two")).toEqual(["agent-b"]);
    await session.handle({
      type: "agent.timeline.set_subscription.request",
      requestId: "timeline-reset",
      agentIds: [scopedId("two", "agent-b")],
    });
    expect(timelineRequests.get("one")).toEqual([]);
    expect(timelineRequests.get("two")).toEqual(["agent-b"]);
  });
});
