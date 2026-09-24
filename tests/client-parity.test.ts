import { randomUUID } from "node:crypto";
import { createPaseoClient } from "@getpaseo/client";
import {
  AgentSnapshotPayloadSchema,
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { afterEach, expect, it } from "vitest";
import type { Workspace } from "../src/domain.js";
import { scopedId } from "../src/domain.js";
import { archiveAgentInventory } from "../src/gateway/agent-inventory.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, project, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const password = "0123456789abcdef0123456789abcdef";
// Pinned SDK's public list type omits the wire sync field, though fetchAgents
// returns the complete payload at runtime. Keep this assertion at the wire edge.
type WireSync = { sync?: { generation: string; mode: string; reason: string } };
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
});

function agent(row: Workspace, index: number, status: "idle" | "error" = "idle") {
  return AgentSnapshotPayloadSchema.parse({
    id: randomUUID(),
    provider: "claude",
    cwd: `/workspaces/${row.metadata.name}`,
    workspaceId: "local",
    model: null,
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
    lastUserMessageAt: null,
    status,
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
    title: `agent-${index}`,
    labels: { role: status === "error" ? "failed" : "worker" },
    ...(status === "error" ? { lastError: "fixture spawn failed" } : {}),
  });
}

function backendFor(row: Workspace, agents: ReturnType<typeof agent>[]) {
  return {
    async connect() {},
    async close() {},
    send() {},
    binary() {},
    async request(message: SessionInboundMessage) {
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (message.type === "open_project_request")
        return SessionOutboundMessageSchema.parse({
          type: "open_project_response",
          payload: {
            requestId,
            workspace: { ...workspaceDescriptor(row, project()), id: "local" },
            error: null,
          },
        });
      if (message.type === "fetch_workspaces_request")
        return SessionOutboundMessageSchema.parse({
          type: "fetch_workspaces_response",
          payload: {
            requestId,
            entries: [],
            emptyProjects: [],
            subscriptionId: null,
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        });
      if (message.type === "fetch_agents_request") {
        const filtered = agents.filter(
          (item) =>
            (!message.filter?.statuses?.length || message.filter.statuses.includes(item.status)) &&
            (!message.filter?.labels ||
              Object.entries(message.filter.labels).every(
                ([key, value]) => item.labels[key] === value,
              )),
        );
        const offset = Number(message.page?.cursor ?? 0);
        const end = offset + (message.page?.limit ?? filtered.length);
        return SessionOutboundMessageSchema.parse({
          type: "fetch_agents_response",
          payload: {
            requestId,
            entries: filtered.slice(offset, end).map((item) => ({
              agent: item,
              project: {
                projectKey: "local",
                projectName: "Example",
                checkout: {
                  cwd: item.cwd,
                  isGit: true,
                  currentBranch: "main",
                  isPaseoOwnedWorktree: false,
                  remoteUrl: null,
                },
              },
            })),
            pageInfo: {
              nextCursor: end < filtered.length ? String(end) : null,
              prevCursor: null,
              hasMore: end < filtered.length,
            },
          },
        });
      }
      throw new Error(`Unexpected fixture request ${message.type}`);
    },
  };
}

async function connect(
  store: MemoryStore,
  agents: Map<string, ReturnType<typeof agent>[]>,
  inventoryStore?: MemoryRecordStore,
) {
  const gateway = await startGateway({
    store,
    inventoryStore,
    namespace: "test",
    backendPassword: password,
    password,
    serverId: "client-parity",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    ready: async () => true,
    backendFactory: (row) => backendFor(row, agents.get(row.metadata.name) ?? []),
  });
  close.push(() => gateway.close());
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const client = createPaseoClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    password,
    reconnect: { enabled: false },
  });
  close.push(() => client.close());
  await client.connect();
  return client;
}

it("pinned SDK sees more than 200 agents, stable pages, filters and lastError across Pods", async () => {
  const store = new MemoryStore();
  const one = workspace("one");
  const two = workspace("two");
  store.workspaceRows = [one, two];
  const oneAgents = Array.from({ length: 220 }, (_, index) =>
    agent(one, index, index < 3 ? "error" : "idle"),
  );
  const twoAgents = Array.from({ length: 20 }, (_, index) => agent(two, index + 220));
  const agents = new Map([
    ["one", oneAgents],
    ["two", twoAgents],
  ]);
  const client = await connect(store, agents);

  const unpaged = await client.agents.list();
  expect(unpaged.entries).toHaveLength(240);
  expect(new Set(unpaged.entries.map((entry) => entry.agent.id)).size).toBe(240);
  expect(unpaged.entries.some((entry) => entry.agent.id.startsWith("one~"))).toBe(true);
  expect(unpaged.entries.some((entry) => entry.agent.id.startsWith("two~"))).toBe(true);

  const first = await client.agents.list({ page: { limit: 75 } });
  expect(first.entries).toHaveLength(75);
  oneAgents.splice(0, 1); // Gateway cursor must retain the original snapshot.
  const entries = [...first.entries];
  let cursor = first.pageInfo.nextCursor;
  while (cursor) {
    const page = await client.agents.list({ page: { limit: 75, cursor } });
    entries.push(...page.entries);
    cursor = page.pageInfo.nextCursor;
  }
  expect(entries).toHaveLength(240);
  expect(new Set(entries.map((entry) => entry.agent.id)).size).toBe(240);

  const failures = await client.agents.list({
    filter: { statuses: ["error"], labels: { role: "failed" } },
  });
  expect(failures.entries).toHaveLength(2);
  expect(failures.entries.map((entry) => entry.agent.lastError)).toEqual([
    "fixture spawn failed",
    "fixture spawn failed",
  ]);
  await expect(
    client.agents.list({ page: { limit: 75, cursor: "not-a-session-cursor" } }),
  ).rejects.toThrow(/cursor/i);
});

it("pinned SDK reports retained suspended and archived agents, then a fresh directory generation", async () => {
  const store = new MemoryStore();
  const suspended = workspace("suspended");
  const archived = workspace("archived");
  const agents = new Map([
    ["suspended", [agent(suspended, 1, "error")]],
    ["archived", [agent(archived, 2)]],
  ]);
  const records = new MemoryRecordStore();
  await archiveAgentInventory(
    records,
    backendFor(suspended, agents.get("suspended") ?? []),
    suspended,
    "local",
    "suspended",
  );
  await archiveAgentInventory(
    records,
    backendFor(archived, agents.get("archived") ?? []),
    archived,
    "local",
    "archived",
  );
  suspended.spec.residency = "Suspended";
  archived.spec.residency = "Archived";
  store.workspaceRows = [suspended, archived];

  const first = await connect(store, agents, records);
  const listed = await first.agents.list({ filter: { includeArchived: true } });
  expect(listed.entries).toHaveLength(2);
  expect(
    listed.entries.find(
      (entry) => entry.agent.id === scopedId("suspended", agents.get("suspended")?.[0]?.id ?? ""),
    )?.agent,
  ).toMatchObject({
    status: "closed",
    lastError: "fixture spawn failed",
    labels: { "paseo-gateway.availability": "suspended" },
  });
  expect(
    listed.entries.find((entry) => entry.agent.id.startsWith("archived~"))?.agent.labels,
  ).toMatchObject({ "paseo-gateway.availability": "archived" });
  const previousGeneration = (listed as WireSync).sync?.generation;
  expect(previousGeneration).toBeTruthy();

  const replacement = await connect(store, agents, records);
  const refreshed = await replacement.agents.list({
    filter: { includeArchived: true },
    sync: { generation: previousGeneration },
  });
  expect(refreshed.entries).toHaveLength(2);
  expect((refreshed as WireSync).sync).toMatchObject({
    mode: "snapshot",
    reason: "generation_changed",
  });
  expect((refreshed as WireSync).sync?.generation).not.toBe(previousGeneration);
});

it("pinned SDK acknowledges provider refresh with no workspace and returns an empty catalog", async () => {
  const store = new MemoryStore();
  const client = await connect(store, new Map());

  await expect(client.providers.refresh()).resolves.toMatchObject({ acknowledged: true });
  await expect(client.providers.snapshot()).resolves.toMatchObject({ entries: [] });
});
