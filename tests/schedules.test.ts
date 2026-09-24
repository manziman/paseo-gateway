import { randomUUID } from "node:crypto";
import {
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { StoredScheduleSchema } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import { issueWorkspaceToken, verifyWorkspaceToken } from "../src/gateway/auth.js";
import {
  nextScheduleTime,
  ScheduleDispatchRejected,
  type ScheduleOptions,
  ScheduleService,
} from "../src/gateway/schedules.js";
import type { ControlRecord, RecordStore } from "../src/kubernetes/records.js";
import { MemoryStore } from "./fixtures.js";

class Records implements RecordStore {
  readonly rows = new Map<string, ControlRecord>();
  revision = 0;
  async records<T>(kind: string) {
    return structuredClone(
      [...this.rows.values()].filter((r) => r.kind === kind),
    ) as ControlRecord<T>[];
  }
  async record<T>(kind: string, id: string) {
    return structuredClone(this.rows.get(`${kind}/${id}`)) as ControlRecord<T> | undefined;
  }
  async createRecord<T>(record: ControlRecord<T>) {
    const key = `${record.kind}/${record.id}`;
    if (this.rows.has(key)) throw { code: 409 };
    const next = { ...structuredClone(record), version: String(++this.revision) };
    this.rows.set(key, next);
    return next;
  }
  async updateRecord<T>(record: ControlRecord<T>) {
    const key = `${record.kind}/${record.id}`;
    if (this.rows.get(key)?.version !== record.version) throw { code: 409 };
    const next = { ...structuredClone(record), version: String(++this.revision) };
    this.rows.set(key, next);
    return next;
  }
  async deleteRecord(record: ControlRecord) {
    const key = `${record.kind}/${record.id}`;
    if (this.rows.get(key)?.version !== record.version) throw { code: 409 };
    this.rows.delete(key);
  }
}
const owner = { kind: "owner" as const };
const create = {
  type: "schedule/create",
  requestId: "create",
  prompt: "Perform scheduled work",
  cadence: { type: "every", everyMs: 60000 },
  target: {
    type: "new-agent",
    config: {
      provider: "claude",
      cwd: "/projects/example",
      model: "model",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
    },
  },
};
function setup(extra: Partial<ScheduleOptions> = {}) {
  const records = new Records();
  const store = new MemoryStore();
  let time = new Date("2026-09-24T00:00:00Z");
  const dispatched: string[] = [];
  const options: ScheduleOptions = {
    records,
    store,
    now: () => time,
    dispatch: async (input) => {
      dispatched.push(input.runId);
      return { agentId: randomUUID(), workspaceId: `worker-${dispatched.length}` };
    },
    ...extra,
  };
  const service = new ScheduleService(options);
  async function rpc(input: unknown, principal = owner) {
    const emitted: unknown[] = [];
    await service.handle(
      SessionInboundMessageSchema.parse(input),
      (message) => emitted.push(message),
      principal,
    );
    const result = emitted[0] as SessionOutboundMessage;
    return result;
  }
  async function add(input: object = {}) {
    const result = await rpc({ ...create, ...input });
    if (result.type !== "schedule/create/response" || !result.payload.schedule)
      throw new Error("No schedule");
    return result.payload.schedule.id;
  }
  async function inspect(id: string) {
    const result = await rpc({ type: "schedule/inspect", requestId: randomUUID(), scheduleId: id });
    if (result.type !== "schedule/inspect/response" || !result.payload.schedule)
      throw new Error("No schedule");
    return StoredScheduleSchema.parse(result.payload.schedule);
  }
  return {
    records,
    store,
    options,
    service,
    rpc,
    add,
    inspect,
    dispatched,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}

describe("durable schedules", () => {
  it("speaks pinned create/list/inspect/update/pause/resume/log/delete schemas", async () => {
    const f = setup();
    const id = await f.add();
    expect((await f.inspect(id)).target).toMatchObject({
      config: { model: "model", modeId: "bypassPermissions", thinkingOptionId: "high" },
    });
    expect(await f.rpc({ type: "schedule/list", requestId: "list" })).toMatchObject({
      type: "schedule/list/response",
      payload: { schedules: [{ id }] },
    });
    await f.rpc({
      type: "schedule/update",
      requestId: "update",
      scheduleId: id,
      prompt: "Changed",
      newAgentConfig: { model: "next", thinkingOptionId: null },
    });
    const updated = await f.inspect(id);
    expect(updated.prompt).toBe("Changed");
    expect(updated.target).toMatchObject({ config: { model: "next" } });
    if (updated.target.type === "new-agent")
      expect(updated.target.config.thinkingOptionId).toBeUndefined();
    await f.rpc({ type: "schedule/pause", requestId: "pause", scheduleId: id });
    f.advance(120000);
    await f.service.tick();
    expect(f.dispatched).toHaveLength(0);
    await f.rpc({ type: "schedule/resume", requestId: "resume", scheduleId: id });
    expect((await f.inspect(id)).nextRunAt).toBe("2026-09-24T00:03:00.000Z");
    expect(await f.rpc({ type: "schedule/logs", requestId: "logs", scheduleId: id })).toMatchObject(
      { payload: { runs: [] } },
    );
    await f.rpc({ type: "schedule/delete", requestId: "delete", scheduleId: id });
    expect(await f.records.records("schedule")).toHaveLength(0);
  });
  it("rejects invalid cron/timezone, unbound cwd, too-fast intervals and self targets", async () => {
    const f = setup();
    for (const cadence of [
      { type: "cron", expression: "* * *" },
      { type: "cron", expression: "* * * * *", timezone: "Mars/Olympus" },
      { type: "every", everyMs: 1 },
    ])
      await expect(f.add({ cadence })).rejects.toThrow();
    await expect(
      f.add({ target: { type: "new-agent", config: { provider: "claude", cwd: "/arbitrary" } } }),
    ).rejects.toThrow();
    await expect(f.add({ target: { type: "self", agentId: randomUUID() } })).rejects.toThrow();
    expect(await f.records.records("schedule")).toHaveLength(0);
  });
  it("handles DST with timezone semantics and skips the repeated fall-back occurrence", () => {
    expect(
      nextScheduleTime(
        { type: "cron", expression: "30 2 * * *", timezone: "America/Chicago" },
        new Date("2026-03-08T07:59:00Z"),
      ),
    ).toBe("2026-03-08T08:30:00.000Z");
    expect(
      nextScheduleTime(
        { type: "cron", expression: "30 1 * * *", timezone: "America/Chicago" },
        new Date("2026-11-01T06:31:00Z"),
      ),
    ).toBe("2026-11-02T07:30:00.000Z");
  });
  it("binds an existing agent to the resolved workspace UID and dispatches without allocation", async () => {
    const agentId = randomUUID();
    const dispatched: unknown[] = [];
    const f = setup({
      resolveAgent: async (id) => {
        expect(id).toBe(agentId);
        return {
          projectId: "example",
          credentialProfile: "claude-default",
          workspaceId: "one",
          workspaceUid: "uid-one",
        };
      },
      dispatch: async (input) => {
        dispatched.push(input);
        return { agentId, workspaceId: "one" };
      },
    });
    const id = await f.add({ target: { type: "agent", agentId } });
    await f.rpc({ type: "schedule/run-once", requestId: "once", scheduleId: id });
    await f.service.close();
    expect(dispatched).toMatchObject([
      {
        schedule: { target: { type: "agent", agentId } },
        targetWorkspaceId: "one",
        targetWorkspaceUid: "uid-one",
      },
    ]);
    expect((await f.records.records("schedule-run"))[0]?.value).toMatchObject({
      run: { agentId, workspaceId: "one" },
    });
  });
  it("reserves a fire durably, deduplicates concurrent ticks and Forbid then observes completion", async () => {
    const f = setup({ observe: async () => ({ status: "succeeded", output: "done" }) });
    const id = await f.add();
    f.advance(60000);
    await Promise.all([f.service.tick(), f.service.tick()]);
    expect(f.dispatched).toHaveLength(1);
    expect((await f.inspect(id)).runs[0]).toMatchObject({
      status: "running",
      workspaceId: "worker-1",
    });
    await expect(
      f.rpc({ type: "schedule/run-once", requestId: "manual", scheduleId: id }),
    ).rejects.toThrow("concurrency");
    await f.service.tick();
    expect((await f.inspect(id)).runs[0]).toMatchObject({ status: "succeeded", output: "done" });
    await f.rpc({ type: "schedule/run-once", requestId: "manual", scheduleId: id });
    await f.rpc({ type: "schedule/run-once", requestId: "manual", scheduleId: id });
    expect(f.dispatched).toHaveLength(2);
  });
  it("allows configured concurrency while keeping fire reservations atomic across service instances", async () => {
    const f = setup({ defaultConcurrency: "Allow" });
    const id = await f.add();
    const second = new ScheduleService(f.options);
    await second.initialize();
    const first = f.rpc({ type: "schedule/run-once", requestId: "a", scheduleId: id });
    const other = second.handle(
      SessionInboundMessageSchema.parse({
        type: "schedule/run-once",
        requestId: "b",
        scheduleId: id,
      }),
      () => {},
      owner,
    );
    const results = await Promise.allSettled([first, other]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.dispatched).toHaveLength(1);
    await f.rpc({ type: "schedule/run-once", requestId: "c", scheduleId: id });
    expect(f.dispatched).toHaveLength(2);
  });
  it("never backfills outage ticks or replays an ambiguous dispatch on restart", async () => {
    let sends = 0;
    const f = setup({
      dispatch: async () => {
        sends++;
        throw new Error("acknowledgement lost");
      },
    });
    const id = await f.add();
    f.advance(180000);
    const restarted = new ScheduleService(f.options);
    await restarted.initialize();
    await restarted.tick();
    expect(sends).toBe(0);
    await f.rpc({ type: "schedule/run-once", requestId: "once", scheduleId: id });
    expect(sends).toBe(1);
    const again = new ScheduleService(f.options);
    await again.initialize();
    await again.tick();
    expect(sends).toBe(1);
    expect((await f.inspect(id)).runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome unknown"),
    });
    await expect(
      f.rpc({ type: "schedule/run-once", requestId: "second", scheduleId: id }),
    ).rejects.toThrow("concurrency");
  });
  it("recovers an intent persisted before a failed run-record write without dispatch", async () => {
    const f = setup();
    const id = await f.add();
    const original = f.records.createRecord.bind(f.records);
    f.records.createRecord = async (row) => {
      if (row.kind === "schedule-run") throw new Error("storage outage");
      return original(row);
    };
    await expect(
      f.rpc({ type: "schedule/run-once", requestId: "once", scheduleId: id }),
    ).rejects.toThrow("storage outage");
    f.records.createRecord = original;
    const again = new ScheduleService(f.options);
    await again.initialize();
    expect(f.dispatched).toHaveLength(0);
    expect((await f.inspect(id)).runs[0]?.error).toContain("outcome unknown");
  });
  it("records definitive failed spawn, bounds history, and cleans deleted schedule logs", async () => {
    const f = setup({
      historyLimit: 2,
      dispatch: async () => {
        throw new ScheduleDispatchRejected("invalid project");
      },
    });
    const id = await f.add();
    for (let n = 0; n < 4; n++) {
      f.advance(1);
      await f.rpc({ type: "schedule/run-once", requestId: String(n), scheduleId: id });
    }
    expect((await f.inspect(id)).runs).toHaveLength(2);
    expect((await f.inspect(id)).runs.every((r) => r.status === "failed")).toBe(true);
    await f.rpc({ type: "schedule/delete", requestId: "delete", scheduleId: id });
    expect(await f.records.records("schedule-run")).toHaveLength(0);
  });
  it("hides another role's schedules and cannot widen a binding on update", async () => {
    const f = setup();
    const id = await f.add();
    const auth = { signingKey: "0123456789abcdef0123456789abcdef", audience: "test" };
    const principal = verifyWorkspaceToken(
      issueWorkspaceToken(auth, {
        projectIds: ["example"],
        credentialProfiles: ["other-role"],
        originWorkspaceId: "one",
        originWorkspaceUid: "uid-one",
        ttlSeconds: 3600,
      }),
      auth,
    );
    if (!principal) throw new Error("No principal");
    const emitted: unknown[] = [];
    await f.service.handle(
      { type: "schedule/list", requestId: "list" },
      (value) => emitted.push(value),
      principal,
    );
    expect(emitted).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ schedules: [] }) }),
    ]);
    await expect(
      f.service.handle(
        { type: "schedule/inspect", requestId: "inspect", scheduleId: id },
        () => {},
        principal,
      ),
    ).rejects.toThrow("does not exist");
    await expect(
      f.service.handle(SessionInboundMessageSchema.parse(create), () => {}, principal),
    ).rejects.toThrow("scope");
  });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("bounded asynchronous schedule execution", () => {
  it.each(["run-once", "runOnCreate"] as const)(
    "acknowledges %s after durable intent while cold dispatch is pending",
    async (mode) => {
      const gate = deferred();
      let calls = 0;
      const f = setup({
        dispatch: async () => {
          calls++;
          await gate.promise;
          return { agentId: randomUUID(), workspaceId: "cold-worker" };
        },
      });
      try {
        const id = await f.add(mode === "runOnCreate" ? { runOnCreate: true } : {});
        if (mode === "run-once") {
          await f.rpc({ type: "schedule/pause", requestId: "pause", scheduleId: id });
          await f.rpc({ type: "schedule/run-once", requestId: "cold", scheduleId: id });
          // Manual dispatch of a paused schedule must not be mistaken for an automatic tick.
          await f.rpc({ type: "schedule/run-once", requestId: "cold", scheduleId: id });
        }
        expect(calls).toBe(1);
        const pending = (await f.inspect(id)).runs[0];
        expect(pending).toMatchObject({ status: "running", agentId: null, workspaceId: null });
        expect(pending?.id).toBeTruthy();
        expect((await f.records.records<{ phase: string }>("schedule-run"))[0]?.value.phase).toBe(
          "dispatching",
        );
      } finally {
        gate.release();
        await f.service.close();
      }
    },
  );
  it("durably admits both same-time fires while the first workspace is still starting", async () => {
    const gate = deferred();
    const started: string[] = [];
    const f = setup({
      dispatch: async ({ schedule }) => {
        started.push(schedule.id);
        await gate.promise;
        return { agentId: randomUUID(), workspaceId: `worker-${schedule.id}` };
      },
    });
    const first = await f.add();
    const second = await f.add();
    f.advance(60000);
    try {
      await f.service.tick();
      expect(started).toEqual([first, second]);
      const runs = await f.records.records<{ phase: string }>("schedule-run");
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.value.phase === "dispatching")).toBe(true);
      // Another poll remains responsive and cannot create another copy of either fire.
      f.advance(1000);
      await f.service.tick();
      expect(started).toHaveLength(2);
    } finally {
      gate.release();
      await f.service.close();
    }
    expect(
      (await f.records.records<{ phase: string }>("schedule-run")).every(
        (run) => run.value.phase === "running",
      ),
    ).toBe(true);
  });
  it("bounds global dispatch capacity, explicitly reports skipped fires, and does not queue backfill", async () => {
    const gate = deferred();
    const started: string[] = [];
    const events: string[] = [];
    const f = setup({
      maxInflightDispatches: 1,
      onError: (event) => events.push(event),
      dispatch: async ({ schedule }) => {
        started.push(schedule.id);
        await gate.promise;
        return { agentId: randomUUID(), workspaceId: `worker-${schedule.id}` };
      },
    });
    const first = await f.add();
    const second = await f.add();
    f.advance(60000);
    try {
      await f.service.tick();
      expect(started).toEqual([first]);
      expect(events).toContain("schedule_dispatch_capacity_exceeded");
      expect((await f.inspect(second)).runs).toHaveLength(0);
      expect((await f.inspect(second)).nextRunAt).toBe("2026-09-24T00:02:00.000Z");
      await expect(
        f.rpc({ type: "schedule/run-once", requestId: "manual", scheduleId: second }),
      ).rejects.toThrow("capacity");
      gate.release();
      await expect.poll(async () => (await f.inspect(first)).runs[0]?.agentId).toBeTruthy();
      await f.service.tick();
      expect(started).toEqual([first]);
    } finally {
      gate.release();
      await f.service.close();
    }
  });
  it("isolates slow observation from dispatch and observes each run at most once concurrently", async () => {
    const gate = deferred();
    const observations: string[] = [];
    const f = setup({
      maxInflightObservations: 1,
      observe: async ({ run }) => {
        observations.push(run.id);
        await gate.promise;
        return undefined;
      },
    });
    const first = await f.add();
    await f.rpc({ type: "schedule/run-once", requestId: "initial", scheduleId: first });
    const second = await f.add();
    f.advance(60000);
    try {
      await f.service.tick();
      expect(observations).toHaveLength(1);
      expect(f.dispatched).toHaveLength(2);
      await f.service.tick();
      expect(observations).toHaveLength(1);
      gate.release();
      // Once the first observation settles, the rotating cursor gives the next run a turn.
      await expect
        .poll(async () => {
          await f.service.tick();
          return observations.length;
        })
        .toBeGreaterThan(1);
      const secondRun = (await f.inspect(second)).runs[0];
      expect(secondRun).toBeDefined();
      expect(observations[1]).toBe(secondRun?.id);
    } finally {
      gate.release();
      await f.service.close();
    }
  });
  it("drains accepted dispatches without admitting new work, and bounds shutdown waiting", async () => {
    const gate = deferred();
    let accepted = 0;
    const f = setup({
      dispatch: async () => {
        accepted++;
        await gate.promise;
        return { agentId: randomUUID(), workspaceId: "worker" };
      },
    });
    const id = await f.add();
    f.advance(60000);
    await f.service.tick();
    expect(await f.service.close(1)).toMatchObject({ drained: false, pendingDispatches: 1 });
    await expect(
      f.rpc({ type: "schedule/run-once", requestId: "after-close", scheduleId: id }),
    ).rejects.toThrow("shutting down");
    await f.service.tick();
    expect(accepted).toBe(1);
    const records = await f.records.records<{ phase: string }>("schedule-run");
    expect(records[0]?.value.phase).toBe("dispatching");
    gate.release();
    expect(await f.service.close(1000)).toEqual({
      drained: true,
      pendingDispatches: 0,
      pendingObservations: 0,
    });
    expect((await f.records.records<{ phase: string }>("schedule-run"))[0]?.value.phase).toBe(
      "running",
    );
  });
  it("reports background observation failure without aborting another due fire or exposing errors", async () => {
    const events: string[] = [];
    const f = setup({
      onError: (event) => events.push(event),
      observe: async () => {
        throw new Error("sensitive-backend-error");
      },
    });
    const id = await f.add();
    await f.rpc({ type: "schedule/run-once", requestId: "first", scheduleId: id });
    await f.add();
    f.advance(60000);
    await f.service.tick();
    expect(f.dispatched).toHaveLength(2);
    await expect.poll(() => events).toContain("schedule_observation_failed");
    expect(events.join(" ")).not.toContain("sensitive");
    await f.service.close();
  });
});
