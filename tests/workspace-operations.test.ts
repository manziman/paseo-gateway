import {
  type SessionInboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAdmission } from "../src/controller/admission.js";
import { type Workspace, workspacePath } from "../src/domain.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { WorkspaceOperations } from "../src/gateway/workspace-operations.js";
import type { ControlRecord } from "../src/kubernetes/records.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

class OperationStore extends MemoryStore {
  control = new Map<string, ControlRecord>();
  async records<T>(kind: string) {
    return structuredClone(
      [...this.control.values()].filter((row) => row.kind === kind),
    ) as ControlRecord<T>[];
  }
  async record<T>(kind: string, id: string) {
    return structuredClone(this.control.get(`${kind}/${id}`)) as ControlRecord<T> | undefined;
  }
  async createRecord<T>(row: ControlRecord<T>) {
    if (this.control.has(`${row.kind}/${row.id}`)) throw { code: 409 };
    const next = { ...row, version: "1" };
    this.control.set(`${row.kind}/${row.id}`, next);
    return structuredClone(next);
  }
  async updateRecord<T>(row: ControlRecord<T>) {
    if (this.control.get(`${row.kind}/${row.id}`)?.version !== row.version) throw { code: 409 };
    const next = { ...row, version: String(Number(row.version) + 1) };
    this.control.set(`${row.kind}/${row.id}`, next);
    return structuredClone(next);
  }
  async deleteRecord(row: ControlRecord) {
    this.control.delete(`${row.kind}/${row.id}`);
  }
}

function setup(failure = false) {
  const store = new OperationStore();
  const requests: SessionInboundMessage[] = [];
  const service = new WorkspaceOperations({
    store,
    namespace: "test",
    backendPassword: "fixture",
    admission: new WorkspaceAdmission(store),
    readyTimeoutMs: 25,
    pollMs: 1,
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
        requests.push(message);
        if (message.type === "fetch_agents_request")
          return {
            type: "fetch_agents_response",
            payload: {
              requestId: message.requestId,
              entries: [],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          };
        if (failure) throw new Error("Response lost");
        return {
          type: "status",
          payload: {
            status: "agent_create_failed",
            requestId: "requestId" in message ? message.requestId : "",
            error: "Provider unavailable",
          },
        };
      },
    }),
  });
  return { store, requests, service };
}

describe("cluster workspace lifecycle", () => {
  it("publishes pending creation and lets reconnect observe terminal failure without replay", async () => {
    const { store, service, requests } = setup();
    store.workspaceRows = [workspace()];
    const messages: unknown[] = [];
    const input = {
      type: "agent.create.request" as const,
      requestId: "modern",
      idempotencyKey: "modern-key",
      workspaceId: "one",
      config: { provider: "claude" as const, cwd: "/workspaces/one" },
      labels: {},
      subscribe: true,
    };
    await service.handle(input, (message) => messages.push(message), { kind: "owner" });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "agent.create.update",
        payload: expect.objectContaining({ phase: "accepted" }),
      }),
    );
    expect(
      await service.handle(
        {
          type: "creation.subscribe.request",
          requestId: "observe",
          kind: "agent",
          idempotencyKey: "modern-key",
        },
        (message) => messages.push(message),
        { kind: "owner" },
      ),
    ).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      type: "creation.subscribe.response",
      payload: {
        snapshot: { phase: "failed", error: "Provider unavailable", outcomeUnknown: false },
      },
    });
    await service.handle({ ...input, requestId: "replay" }, () => {}, { kind: "owner" });
    expect(requests).toHaveLength(1);
  });

  it("reports a lost Kubernetes create acknowledgment as unknown workspace outcome", async () => {
    const { store, service } = setup();
    const create = store.createWorkspace.bind(store);
    store.createWorkspace = async (input) => {
      await create(input);
      throw new Error("Kubernetes acknowledgment lost");
    };
    const messages: unknown[] = [];
    const input = {
      type: "workspace.create.request" as const,
      requestId: "allocate",
      idempotencyKey: "lost-create",
      source: { kind: "directory" as const, path: "/projects/example" },
    };
    await service.handle(input, (message) => messages.push(message), { kind: "owner" });
    expect(messages.at(-1)).toMatchObject({
      type: "workspace.create.response",
      payload: { creation: { phase: "failed", failedStage: "workspace", outcomeUnknown: true } },
    });
    await service.handle({ ...input, requestId: "retry" }, () => {}, { kind: "owner" });
    expect(store.workspaceRows).toHaveLength(1);
  });

  it("maps branch-off/base and PR checkouts and deduplicates keyed allocation", async () => {
    const { service, store } = setup();
    const input = {
      type: "workspace.create.request" as const,
      requestId: "one",
      idempotencyKey: "branch-work",
      title: "Worker",
      source: {
        kind: "worktree" as const,
        projectId: "example",
        action: "branch-off" as const,
        branchName: "feature/work",
        baseBranch: "origin/main",
      },
    };
    const created = await service.createWorkspace(input);
    expect(created.workspace.spec).toMatchObject({
      revision: "main",
      branch: "feature/work",
      fetchDepth: 0,
    });
    expect(
      (await service.createWorkspace({ ...input, requestId: "two" })).workspace.metadata.name,
    ).toBe(created.workspace.metadata.name);
    expect(store.workspaceRows).toHaveLength(1);
    await expect(service.createWorkspace({ ...input, title: "different" })).rejects.toThrow(
      "conflicts",
    );
    expect(
      (
        await service.createWorkspace({
          type: "workspace.create.request",
          requestId: "pr",
          source: { kind: "worktree", projectId: "example", githubPrNumber: 42 },
        })
      ).workspace.spec.pullRequest,
    ).toBe(42);
  });

  it("waits for readiness and reports failed scheduling before attempting a provider mutation", async () => {
    const { store, service, requests } = setup();
    const row = workspace();
    row.status = {
      phase: "Pending",
      message: "Unschedulable: insufficient memory",
      observedGeneration: 1,
    };
    store.workspaceRows = [row];
    await expect(
      service.createAgent({
        type: "create_agent_request",
        requestId: "spawn",
        workspaceId: "one",
        config: { provider: "claude", cwd: "/workspaces/one" },
        labels: {},
      }),
    ).rejects.toThrow("Unschedulable");
    expect(requests).toHaveLength(0);
  });

  it("never repeats a keyed mutation after an ambiguous response, including a new service instance", async () => {
    const { store, service, requests } = setup(true);
    store.workspaceRows = [workspace()];
    const input = {
      type: "create_agent_request" as const,
      requestId: "spawn",
      idempotencyKey: "attempt",
      workspaceId: "one",
      config: { provider: "codex" as const, cwd: "/workspaces/one" },
      env: { IDENTITY: "worker" },
      labels: {},
    };
    await expect(service.createAgent(input)).rejects.toThrow("Response lost");
    await expect(service.createAgent({ ...input, requestId: "again" })).rejects.toThrow(
      "outcome unknown",
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify([...store.control.values()])).not.toContain("IDENTITY");
  });

  it("retains a failed creation response, preserving last provider error without replay", async () => {
    const { store, service, requests } = setup();
    store.workspaceRows = [workspace()];
    const input = {
      type: "create_agent_request" as const,
      requestId: "spawn",
      idempotencyKey: "failure",
      workspaceId: "one",
      config: { provider: "claude" as const, cwd: "/workspaces/one" },
      labels: {},
    };
    expect(await service.createAgent(input)).toMatchObject({
      payload: { error: "Provider unavailable" },
    });
    expect(await service.createAgent({ ...input, requestId: "again" })).toMatchObject({
      payload: { requestId: "again", error: "Provider unavailable" },
    });
    expect(requests).toHaveLength(1);
  });

  it("refuses archive when teardown fails, retaining compute and data", async () => {
    const { service, store } = setup();
    store.workspaceRows = [workspace()];
    store.teardown = async () => {
      throw new Error("Teardown failed");
    };
    await expect(service.archive("one", { kind: "owner" })).rejects.toThrow("Teardown failed");
    expect(store.workspaceRows[0]?.spec.residency).toBe("Running");
    expect(store.deletions).toEqual([]);
  });

  it("archives only after successful teardown and persists completion before stopping", async () => {
    const { service, store } = setup();
    store.workspaceRows = [workspace()];
    const calls: string[] = [];
    store.teardown = async (_row: Workspace) => {
      calls.push("teardown");
    };
    const status = store.status.bind(store);
    store.status = async (row, next) => {
      calls.push("status");
      await status(row, next);
      const current = store.workspaceRows.find(
        (entry) => entry.metadata.name === row.metadata.name,
      );
      if (current) current.metadata.resourceVersion = "2";
    };
    const setResidency = store.setResidency.bind(store);
    store.setResidency = async (row, residency) => {
      if (row.metadata.resourceVersion !== "2") throw { code: 409 };
      await setResidency(row, residency);
    };
    await service.archive("one", { kind: "owner" });
    expect(calls).toEqual(["teardown", "status"]);
    expect(store.workspaceRows[0]?.status?.teardownCompletedAt).toBeTruthy();
    expect(store.workspaceRows[0]?.spec.residency).toBe("Archived");
    expect(workspacePath("one")).toBe("/workspaces/one");
  });
});

// Exercise the durable protocol independently of Kubernetes scheduling latency.
describe("creation observation and recovery", () => {
  it("observes pending work across reconnect and emits monotonically revised terminal snapshots", async () => {
    const { CreationJournal } = await import("../src/gateway/creation-journal.js");
    const store = new OperationStore();
    const journal = new CreationJournal(store, async () => {});
    let finish: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first: unknown[] = [];
    const reconnected: unknown[] = [];
    const firstEmit = (message: unknown) => first.push(message);
    const running = journal.run(
      "workspace",
      "pending",
      {},
      { kind: "owner" },
      firstEmit,
      true,
      async (progress) => {
        await progress({ workspaceId: "one" }, { workspaceId: "one", workspaceUid: "uid-one" });
        await barrier;
        await progress({ phase: "workspace_ready" });
      },
    );
    await vi.waitFor(() => expect(first).not.toHaveLength(0));
    journal.close(firstEmit);
    const observed = await journal.subscribe("workspace", "pending", { kind: "owner" }, (message) =>
      reconnected.push(message),
    );
    expect(observed.snapshot?.phase).toBe("accepted");
    finish();
    expect((await running).phase).toBe("completed");
    expect(reconnected.at(-1)).toMatchObject({
      type: "workspace.create.update",
      payload: { phase: "completed" },
    });
    const revisions = reconnected.map(
      (row) => (row as { payload: { revision: number } }).payload.revision,
    );
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  });

  it("marks interrupted durable intent unknown after replacement and never dispatches it again", async () => {
    const { CreationJournal } = await import("../src/gateway/creation-journal.js");
    const store = new OperationStore();
    const journal = new CreationJournal(store, async () => {});
    const before = await journal.run(
      "agent",
      "interrupted",
      {},
      { kind: "owner" },
      () => {},
      false,
      async (progress) => {
        await progress({}, undefined, true);
        throw new Error("Acknowledgment lost");
      },
    );
    expect(before).toMatchObject({ phase: "failed", outcomeUnknown: true });
    const raw = [...store.control.values()].find((row) => row.kind === "creation-operation");
    if (!raw) throw new Error("Missing journal");
    const value = raw.value as { snapshot: { phase: string; error: string | null } };
    value.snapshot.phase = "workspace_ready";
    value.snapshot.error = null;
    const replacement = new CreationJournal(store, async () => {});
    expect(
      (await replacement.subscribe("agent", "interrupted", { kind: "owner" }, () => {})).snapshot,
    ).toMatchObject({ phase: "failed", outcomeUnknown: true });
    let dispatched = false;
    expect(
      await replacement.run(
        "agent",
        "interrupted",
        {},
        { kind: "owner" },
        () => {},
        false,
        async () => {
          dispatched = true;
        },
      ),
    ).toMatchObject({ phase: "failed", outcomeUnknown: true });
    expect(dispatched).toBe(false);
  });

  it("rejects cross-principal key collisions before the durable claim exists", async () => {
    const { CreationJournal } = await import("../src/gateway/creation-journal.js");
    const { issueWorkspaceToken, verifyWorkspaceToken } = await import("../src/gateway/auth.js");
    const auth = { signingKey: "a".repeat(32), audience: "test" };
    const principal = verifyWorkspaceToken(
      issueWorkspaceToken(auth, {
        projectIds: ["example"],
        credentialProfiles: ["claude-default"],
        originWorkspaceId: "two",
        originWorkspaceUid: "uid-two",
        ttlSeconds: 60,
      }),
      auth,
    );
    if (!principal) throw new Error("Missing scoped fixture");
    const store = new OperationStore();
    const journal = new CreationJournal(store, async () => {});
    let unblock: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const create = store.createRecord.bind(store);
    store.createRecord = async (row) => {
      await barrier;
      return create(row);
    };
    const running = journal.run(
      "agent",
      "race",
      {},
      { kind: "owner" },
      () => {},
      false,
      async () => {},
    );
    await expect(
      journal.run(
        "agent",
        "race",
        {},
        principal,
        () => {},
        true,
        async () => {},
      ),
    ).rejects.toThrow("access denied");
    await expect(
      journal.run(
        "agent",
        "race",
        { different: true },
        { kind: "owner" },
        () => {},
        true,
        async () => {},
      ),
    ).rejects.toThrow("conflicts");
    unblock();
    await running;
  });

  it("revalidates scoped workspace access for observers and suppresses updates after revocation", async () => {
    const { CreationJournal } = await import("../src/gateway/creation-journal.js");
    const store = new OperationStore();
    let authorized = true;
    const journal = new CreationJournal(store, async () => {
      if (!authorized) throw new Error("Scope revoked");
    });
    let finish: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const messages: unknown[] = [];
    const running = journal.run(
      "workspace",
      "revoked",
      {},
      { kind: "owner" },
      (message) => messages.push(message),
      true,
      async () => {
        await barrier;
      },
    );
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
    const previous = messages.length;
    authorized = false;
    await expect(
      journal.subscribe("workspace", "revoked", { kind: "owner" }, () => {}),
    ).rejects.toThrow("revoked");
    finish();
    await expect(running).rejects.toThrow("revoked");
    expect(messages).toHaveLength(previous);
  });
});
