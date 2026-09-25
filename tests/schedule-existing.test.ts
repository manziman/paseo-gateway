import { randomUUID } from "node:crypto";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { StoredScheduleSchema } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAdmission } from "../src/controller/admission.js";
import { AgentIdentityRegistry } from "../src/gateway/agent-identity.js";
import { AgentRouting } from "../src/gateway/agent-routing.js";
import type { Backend } from "../src/gateway/backend.js";
import { ScheduleDispatchRejected } from "../src/gateway/schedules.js";
import { WorkspaceOperations } from "../src/gateway/workspace-operations.js";
import type { RecordStore } from "../src/kubernetes/records.js";
import { MemoryStore, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

function fixture(backend: Backend) {
  const store = new MemoryStore();
  store.workspaceRows = [workspace()];
  const operations = new WorkspaceOperations({
    store: store as MemoryStore & RecordStore,
    namespace: "test",
    backendPassword: "backend",
    admission: new WorkspaceAdmission(store, 10),
    backendFactory: () => backend,
  });
  return { store, operations };
}
const agentId = randomUUID();
const schedule = StoredScheduleSchema.parse({
  id: randomUUID(),
  name: null,
  prompt: "Scheduled prompt",
  cadence: { type: "every", everyMs: 60000 },
  target: { type: "agent", agentId },
  status: "active",
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
});
const outbound = (message: object) => message as unknown as SessionOutboundMessage;

describe("existing-agent schedule target", () => {
  it("binds an exact ready agent despite unrelated suspended workspaces", async () => {
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type === "open_project_request")
          return outbound({
            type: "open_project_response",
            payload: { workspace: { id: "local" } },
          });
        if (message.type === "fetch_agent_request")
          return outbound({
            type: "fetch_agent_response",
            payload: { agent: { id: agentId } },
          });
        throw new Error("Unexpected backend request");
      },
    };
    const { store, operations } = fixture(backend);
    const unrelated = workspace("two");
    unrelated.spec.residency = "Suspended";
    unrelated.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    store.workspaceRows.push(unrelated);
    await expect(
      operations.resolveScheduleAgent(agentId, { kind: "owner" }),
    ).resolves.toMatchObject({
      workspaceId: "one",
      workspaceUid: "uid-one",
    });
  });

  it("rejects replacement during lookup before sending a scheduled prompt", async () => {
    let finishLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const lookup = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    let sends = 0;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type === "open_project_request")
          return outbound({
            type: "open_project_response",
            payload: { workspace: { id: "local" } },
          });
        if (message.type === "fetch_agent_request") {
          lookupStarted();
          await lookup;
          return outbound({ type: "fetch_agent_response", payload: { agent: { id: agentId } } });
        }
        if (message.type === "send_agent_message_request") sends++;
        throw new Error("Unexpected request");
      },
    };
    const { store, operations } = fixture(backend);
    const dispatch = operations.dispatchSchedule({
      schedule,
      runId: randomUUID(),
      projectId: "example",
      credentialProfile: "claude-default",
      targetWorkspaceId: "one",
      targetWorkspaceUid: "uid-one",
    });
    await started;
    const target = store.workspaceRows[0];
    if (!target) throw new Error("Missing target workspace");
    target.metadata.uid = "replacement";
    finishLookup();
    await expect(dispatch).rejects.toBeInstanceOf(ScheduleDispatchRejected);
    expect(sends).toBe(0);
  });

  it("rejects a stopped target after the final durable agent-route lookup", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const records = new MemoryRecordStore();
    const combined = Object.assign(store, {
      records: records.records.bind(records),
      record: records.record.bind(records),
      createRecord: records.createRecord.bind(records),
      updateRecord: records.updateRecord.bind(records),
      deleteRecord: records.deleteRecord.bind(records),
    });
    const routing = new AgentRouting(new AgentIdentityRegistry(combined));
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
    let sends = 0;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type === "open_project_request")
          return outbound({
            type: "open_project_response",
            payload: { workspace: { id: "local" } },
          });
        if (message.type === "fetch_agent_request")
          return outbound({ type: "fetch_agent_response", payload: { agent: { id: agentId } } });
        if (message.type === "send_agent_message_request") sends++;
        throw new Error("Unexpected request");
      },
    };
    const operations = new WorkspaceOperations({
      store: combined,
      namespace: "test",
      backendPassword: "backend",
      admission: new WorkspaceAdmission(store, 10),
      agentRouting: routing,
      backendFactory: () => backend,
    });
    const dispatch = operations.dispatchSchedule({
      schedule,
      runId: randomUUID(),
      projectId: "example",
      credentialProfile: "claude-default",
      targetWorkspaceId: "one",
      targetWorkspaceUid: "uid-one",
    });
    await lookup;
    const target = store.workspaceRows[0];
    if (!target) throw new Error("Missing target workspace");
    target.spec.residency = "Suspended";
    release();
    await expect(dispatch).rejects.toBeInstanceOf(ScheduleDispatchRejected);
    expect(sends).toBe(0);
  });

  it("waits for its own timeline message and later assistant before accepting idle", async () => {
    const runId = randomUUID();
    let phase = 0;
    let archives = 0;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type === "open_project_request")
          return outbound({
            type: "open_project_response",
            payload: { workspace: { id: "local" } },
          });
        if (message.type === "wait_for_finish_request")
          return outbound({
            type: "wait_for_finish_response",
            payload: { status: "idle", lastMessage: "old" },
          });
        if (message.type === "fetch_agent_timeline_request") {
          const entries: object[] =
            phase === 0
              ? []
              : [
                  {
                    item: { type: "user_message", text: "Scheduled prompt", messageId: runId },
                    seqStart: 10,
                    seqEnd: 10,
                    turnId: "turn",
                  },
                ];
          if (phase === 2)
            entries.push({
              item: { type: "assistant_message", text: "new result" },
              seqStart: 11,
              seqEnd: 11,
              turnId: "turn",
            });
          return outbound({
            type: "fetch_agent_timeline_response",
            payload: {
              entries,
              hasOlder: false,
              startCursor: null,
              error: null,
            },
          });
        }
        throw new Error("Unexpected request");
      },
    };
    const { store, operations } = fixture(backend);
    store.teardown = async () => {
      archives++;
    };
    const input = {
      scheduleId: schedule.id,
      targetWorkspaceUid: "uid-one",
      run: {
        id: runId,
        scheduledFor: "2026-09-24T00:00:00Z",
        startedAt: "2026-09-24T00:00:00Z",
        endedAt: null,
        status: "running" as const,
        agentId,
        workspaceId: "one",
        output: null,
        error: null,
      },
    };
    expect(await operations.observeSchedule(input)).toBeUndefined();
    phase = 1;
    expect(await operations.observeSchedule(input)).toBeUndefined();
    phase = 2;
    expect(await operations.observeSchedule(input)).toMatchObject({ status: "succeeded" });
    expect(archives).toBe(0);
    expect(store.workspaceRows[0]?.spec.residency).toBe("Running");
  });
});

describe("new-agent schedule archive preference", () => {
  it.each([
    { status: "idle", archiveOnFinish: false },
    { status: "error", archiveOnFinish: false },
    { status: "idle", archiveOnFinish: true },
    { status: "idle", archiveOnFinish: undefined },
    { status: "error", archiveOnFinish: true },
    { status: "timeout", archiveOnFinish: true },
    { status: "idle", archiveOnFinish: true, teardownFailure: true },
  ])(
    "honors lifecycle preference $archiveOnFinish for $status (teardown failure $teardownFailure)",
    async ({ status, archiveOnFinish, teardownFailure }) => {
      const backend: Backend = {
        async connect() {},
        async close() {},
        send() {},
        binary() {},
        async request(message) {
          if (message.type === "open_project_request")
            return outbound({
              type: "open_project_response",
              payload: { workspace: { id: "local" } },
            });
          if (message.type === "wait_for_finish_request")
            return outbound({
              type: "wait_for_finish_response",
              payload: {
                status,
                lastMessage: "done",
                error: status === "error" ? "Provider failed" : undefined,
              },
            });
          throw new Error("Unexpected request");
        },
      };
      const { store, operations } = fixture(backend);
      const archive = vi.spyOn(operations, "archive").mockImplementation(async () => {
        if (teardownFailure) throw new Error("Teardown failed");
        const row = store.workspaceRows[0];
        if (!row) throw new Error("Missing workspace");
        row.spec.residency = "Archived";
      });
      const input = {
        scheduleId: randomUUID(),
        archiveOnFinish,
        run: {
          id: randomUUID(),
          scheduledFor: "2026-09-24T00:00:00Z",
          startedAt: "2026-09-24T00:00:00Z",
          endedAt: null,
          status: "running" as const,
          agentId,
          workspaceId: "one",
          output: null,
          error: null,
        },
      };
      const outcome = await operations.observeSchedule(input);
      if (status === "timeout") expect(outcome).toBeUndefined();
      else
        expect(outcome).toMatchObject({
          status: status === "idle" && !teardownFailure ? "succeeded" : "failed",
        });
      const shouldArchive = archiveOnFinish !== false && status !== "timeout";
      expect(archive).toHaveBeenCalledTimes(shouldArchive ? 1 : 0);
      expect(store.workspaceRows[0]?.spec.residency).toBe(
        shouldArchive && !teardownFailure ? "Archived" : "Running",
      );
      if (teardownFailure)
        expect(outcome?.error).toContain("teardown failed; compute and storage retained");
    },
  );
});
