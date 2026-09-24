import { createHash, randomUUID } from "node:crypto";
import {
  type SessionInboundMessage,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { parseCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import {
  type ScheduleCadence,
  type ScheduleRun,
  ScheduleRunSchema,
  type StoredSchedule,
  StoredScheduleSchema,
} from "@getpaseo/protocol/schedule/types";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { projectPath, workspacePath } from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import type { Store } from "../kubernetes/store.js";
import { authorizeProject, authorizeWorkspace, type GatewayPrincipal } from "./auth.js";
import type { SessionOptions } from "./session.js";

const RunStateSchema = z.object({
  scheduleId: z.string(),
  projectId: z.string(),
  credentialProfile: z.string(),
  phase: z.enum(["dispatching", "running", "finished", "unknown"]),
  run: ScheduleRunSchema,
});
const ScheduleStateSchema = z.object({
  schedule: StoredScheduleSchema,
  projectId: z.string(),
  credentialProfile: z.string(),
  concurrency: z.enum(["Forbid", "Allow"]),
  totalRuns: z.number().int().nonnegative(),
  reservations: z.array(RunStateSchema).max(16),
});
type ScheduleState = z.infer<typeof ScheduleStateSchema>;
type RunState = z.infer<typeof RunStateSchema>;
export interface ScheduleDispatch {
  schedule: StoredSchedule;
  runId: string;
  projectId: string;
  credentialProfile: string;
}
export interface ScheduleOutcome {
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
}
export interface ScheduleOptions {
  records: RecordStore;
  store: Store;
  dispatch(input: ScheduleDispatch): Promise<{ agentId: string; workspaceId: string }>;
  observe?(input: { scheduleId: string; run: ScheduleRun }): Promise<ScheduleOutcome | undefined>;
  defaultConcurrency?: "Forbid" | "Allow";
  historyLimit?: number;
  maxInflightDispatches?: number;
  maxInflightObservations?: number;
  onError?: (event: string) => void;
  now?: () => Date;
}
/** Only throw this when the adapter knows no agent mutation was accepted. */
export class ScheduleDispatchRejected extends Error {}
class ScheduleCapacityReached extends Error {}

export function nextScheduleTime(cadence: ScheduleCadence, after: Date): string {
  if (cadence.type === "every") {
    if (cadence.everyMs < 1000 || !Number.isSafeInteger(cadence.everyMs))
      throw new Error("Schedule intervals must be safe integers of at least one second");
    return new Date(after.getTime() + cadence.everyMs).toISOString();
  }
  parseCronExpression(cadence.expression); // Preserve the pinned protocol's five-field syntax.
  const timezone = cadence.timezone ?? "UTC";
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(after);
  const next = CronExpressionParser.parse(cadence.expression, { currentDate: after, tz: timezone })
    .next()
    .toISOString();
  if (!next) throw new Error("Cron expression has no next occurrence");
  return next;
}
function allowed(
  principal: GatewayPrincipal,
  state: { projectId: string; credentialProfile: string },
) {
  return (
    authorizeProject(principal, state.projectId) &&
    (principal.kind === "owner" || principal.credentialProfiles.includes(state.credentialProfile))
  );
}
function conflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === 409) || ("statusCode" in error && error.statusCode === 409))
  );
}
function summary(schedule: StoredSchedule) {
  const { runs: _runs, ...result } = schedule;
  return result;
}

/** Durable control plane; dispatch and backend observation stay behind injected adapters. */
export class ScheduleService {
  private readonly now: () => Date;
  private readonly historyLimit: number;
  private initialization?: Promise<void>;
  private tickTask?: Promise<void>;
  private readonly dispatches = new Map<string, Promise<void>>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly maxInflightDispatches: number;
  private readonly maxInflightObservations: number;
  private observationCursor = 0;
  private stopping = false;
  constructor(private readonly options: ScheduleOptions) {
    this.now = options.now ?? (() => new Date());
    this.historyLimit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.historyLimit ?? 50);
    z.enum(["Forbid", "Allow"]).parse(options.defaultConcurrency ?? "Forbid");
    const concurrency = z.number().int().min(1).max(64);
    this.maxInflightDispatches = concurrency.parse(options.maxInflightDispatches ?? 8);
    this.maxInflightObservations = concurrency.parse(options.maxInflightObservations ?? 8);
  }
  private async read(id: string): Promise<ControlRecord<ScheduleState>> {
    const record = await this.options.records.record("schedule", id);
    if (!record) throw new Error("Schedule does not exist");
    return { ...record, value: ScheduleStateSchema.parse(record.value) };
  }
  private async runs(id: string) {
    return (await this.options.records.records("schedule-run"))
      .map((record) => ({ ...record, value: RunStateSchema.parse(record.value) }))
      .filter((record) => record.value.scheduleId === id)
      .sort((a, b) => b.value.run.startedAt.localeCompare(a.value.run.startedAt));
  }
  private async save(record: ControlRecord<ScheduleState>) {
    return this.options.records.updateRecord({
      ...record,
      value: ScheduleStateSchema.parse(record.value),
    });
  }
  /** Call before readiness. Reserved/ambiguous dispatches are recorded but never retried. */
  initialize(): Promise<void> {
    this.initialization ??= this.recover();
    return this.initialization;
  }
  private async recover() {
    for (const raw of await this.options.records.records("schedule")) {
      const record = { ...raw, value: ScheduleStateSchema.parse(raw.value) };
      for (const reservation of record.value.reservations) {
        const stored = await this.options.records.record("schedule-run", reservation.run.id);
        const state = stored ? RunStateSchema.parse(stored.value) : reservation;
        if (state.phase === "dispatching") {
          const unknown = this.unknown(state);
          if (stored) await this.options.records.updateRecord({ ...stored, value: unknown });
          else
            await this.options.records.createRecord({
              kind: "schedule-run",
              id: state.run.id,
              value: unknown,
            });
        }
        if (state.phase === "finished")
          record.value.reservations = record.value.reservations.filter(
            (r) => r.run.id !== state.run.id,
          );
      }
      const schedule = record.value.schedule;
      if (
        schedule.status === "active" &&
        schedule.nextRunAt &&
        Date.parse(schedule.nextRunAt) < this.now().getTime()
      )
        schedule.nextRunAt = nextScheduleTime(schedule.cadence, this.now());
      await this.save(record);
    }
  }
  private unknown(state: RunState): RunState {
    return {
      ...state,
      phase: "unknown",
      run: {
        ...state.run,
        status: "failed",
        endedAt: this.now().toISOString(),
        error:
          "Dispatch interrupted; outcome unknown. Inspect the workspace before resolving or retrying.",
      },
    };
  }
  private async bind(schedule: StoredSchedule, principal: GatewayPrincipal) {
    if (schedule.target.type !== "new-agent")
      throw new Error(
        "Gateway schedules require a new-agent target with a configured project or workspace cwd",
      );
    const [projects, workspaces] = await Promise.all([
      this.options.store.projects(),
      this.options.store.workspaces(),
    ]);
    const cwd = schedule.target.config.cwd;
    const origin = workspaces.find(
      (row) => workspacePath(row.metadata.name) === cwd && !row.metadata.deletionTimestamp,
    );
    const project = projects.find(
      (row) =>
        projectPath(row.metadata.name) === cwd || row.metadata.name === origin?.spec.projectRef,
    );
    if (
      !project ||
      !authorizeProject(principal, project.metadata.name) ||
      (origin && !authorizeWorkspace(principal, origin))
    )
      throw new Error("Select an authorized configured Kubernetes project");
    const credentialProfile = origin?.spec.credentialProfile ?? project.spec.credentialProfile;
    const binding = { projectId: project.metadata.name, credentialProfile };
    if (!allowed(principal, binding))
      throw new Error("Credential profile is outside the caller scope");
    if (schedule.prompt.length > 65536) throw new Error("Schedule prompt exceeds 64 KiB");
    if (schedule.expiresAt && !Number.isFinite(Date.parse(schedule.expiresAt)))
      throw new Error("Invalid schedule expiration");
    nextScheduleTime(schedule.cadence, this.now());
    // Nested advanced agent configuration is not safely expressible in the lifecycle adapter yet.
    if (
      schedule.target.config.systemPrompt ||
      schedule.target.config.mcpServers ||
      schedule.target.config.featureValues ||
      schedule.target.config.providerOptions
    )
      throw new Error("Advanced agent configuration is not supported for gateway schedules");
    return binding;
  }
  async handle(
    message: SessionInboundMessage,
    emit: SessionOptions["emit"],
    principal: GatewayPrincipal,
  ): Promise<boolean> {
    if (!message.type.startsWith("schedule/")) return false;
    if (this.stopping) throw new Error("Scheduler is shutting down");
    await this.initialize();
    const input = SessionInboundMessageSchema.parse(message);
    const requestId = "requestId" in input ? input.requestId : "";
    if (typeof requestId !== "string") throw new Error("Schedule request ID required");
    const reply = (payload: object) =>
      emit(
        SessionOutboundMessageSchema.parse({
          type: `${input.type}/response`,
          payload: { requestId, error: null, ...payload },
        }),
      );
    if (input.type === "schedule/list") {
      const records = await this.options.records.records("schedule");
      reply({
        schedules: records
          .map((r) => ScheduleStateSchema.parse(r.value))
          .filter((s) => allowed(principal, s))
          .map((s) => summary(s.schedule)),
      });
      return true;
    }
    if (input.type === "schedule/create") {
      if (input.target.type !== "new-agent")
        throw new Error("Gateway schedules require a new-agent target");
      const now = this.now().toISOString();
      const schedule = StoredScheduleSchema.parse({
        id: randomUUID(),
        name: input.name ?? null,
        prompt: input.prompt,
        cadence: input.cadence,
        target: input.target,
        status: "active",
        createdAt: now,
        updatedAt: now,
        nextRunAt: nextScheduleTime(input.cadence, this.now()),
        lastRunAt: null,
        pausedAt: null,
        expiresAt: input.expiresAt ?? null,
        maxRuns: input.maxRuns ?? null,
        runs: [],
      });
      const binding = await this.bind(schedule, principal);
      await this.options.records.createRecord({
        kind: "schedule",
        id: schedule.id,
        value: {
          schedule,
          ...binding,
          concurrency: this.options.defaultConcurrency ?? "Forbid",
          totalRuns: 0,
          reservations: [],
        },
      });
      if (input.runOnCreate) await this.fire(schedule.id, now, `create:${requestId}`);
      reply({ schedule: summary((await this.read(schedule.id)).value.schedule) });
      return true;
    }
    if (!("scheduleId" in input) || typeof input.scheduleId !== "string")
      throw new Error("Unsupported schedule operation");
    const record = await this.read(input.scheduleId);
    const state = record.value;
    if (!allowed(principal, state)) throw new Error("Schedule does not exist");
    const schedule = state.schedule;
    switch (input.type) {
      case "schedule/inspect":
        reply({
          schedule: { ...schedule, runs: (await this.runs(schedule.id)).map((r) => r.value.run) },
        });
        break;
      case "schedule/logs":
        reply({ runs: (await this.runs(schedule.id)).map((r) => r.value.run) });
        break;
      case "schedule/delete":
        if (state.reservations.length)
          throw new Error("Resolve active or unknown schedule runs before deleting");
        await this.options.records.deleteRecord(record);
        for (const run of await this.runs(schedule.id))
          await this.options.records.deleteRecord(run);
        reply({ scheduleId: schedule.id });
        break;
      case "schedule/pause":
        schedule.status = "paused";
        schedule.pausedAt = this.now().toISOString();
        schedule.nextRunAt = null;
        schedule.updatedAt = this.now().toISOString();
        await this.save(record);
        reply({ schedule: summary(schedule) });
        break;
      case "schedule/resume":
        schedule.status = "active";
        schedule.pausedAt = null;
        schedule.nextRunAt = nextScheduleTime(schedule.cadence, this.now());
        schedule.updatedAt = this.now().toISOString();
        await this.save(record);
        reply({ schedule: summary(schedule) });
        break;
      case "schedule/update": {
        if (input.name !== undefined) schedule.name = input.name;
        if (input.prompt !== undefined) schedule.prompt = input.prompt;
        if (input.cadence !== undefined) schedule.cadence = input.cadence;
        if (input.maxRuns !== undefined) schedule.maxRuns = input.maxRuns;
        if (input.expiresAt !== undefined) schedule.expiresAt = input.expiresAt;
        if (input.newAgentConfig) {
          if (schedule.target.type !== "new-agent")
            throw new Error("Schedule target is not a new agent");
          const config: Record<string, unknown> = { ...schedule.target.config };
          for (const [key, value] of Object.entries(input.newAgentConfig)) {
            if (value === null) delete config[key];
            else config[key] = value;
          }
          schedule.target = StoredScheduleSchema.shape.target.parse({ type: "new-agent", config });
        }
        const binding = await this.bind(schedule, principal);
        if (
          binding.projectId !== state.projectId ||
          binding.credentialProfile !== state.credentialProfile
        )
          throw new Error("Create a new schedule to change project or credential profile");
        schedule.updatedAt = this.now().toISOString();
        if (schedule.status === "active" && input.cadence)
          schedule.nextRunAt = nextScheduleTime(schedule.cadence, this.now());
        await this.save(record);
        reply({
          schedule: { ...schedule, runs: (await this.runs(schedule.id)).map((r) => r.value.run) },
        });
        break;
      }
      case "schedule/run-once":
        await this.fire(schedule.id, this.now().toISOString(), `manual:${requestId}`);
        reply({
          schedule: {
            ...(await this.read(schedule.id)).value.schedule,
            runs: (await this.runs(schedule.id)).map((r) => r.value.run),
          },
        });
        break;
      default:
        throw new Error("Unsupported schedule operation");
    }
    return true;
  }
  async setConcurrency(id: string, concurrency: "Forbid" | "Allow", principal: GatewayPrincipal) {
    const record = await this.read(id);
    if (!allowed(principal, record.value)) throw new Error("Schedule does not exist");
    record.value.concurrency = z.enum(["Forbid", "Allow"]).parse(concurrency);
    await this.save(record);
  }
  private report(event: string) {
    try {
      this.options.onError?.(event);
    } catch {
      /* Diagnostics cannot break task tracking. */
    }
  }
  private track(tasks: Map<string, Promise<void>>, id: string, task: Promise<void>, event: string) {
    tasks.set(id, task);
    // Both branches handle settlement; never leave a background rejection unobserved.
    void task.then(
      () => {
        tasks.delete(id);
      },
      () => {
        tasks.delete(id);
        this.report(event);
      },
    );
  }
  private async fire(id: string, scheduledFor: string, key: string, automatic = false) {
    if (this.stopping) throw new Error("Scheduler is shutting down");
    const runId = createHash("sha256").update(`${id}:${key}`).digest("hex");
    const existing = this.dispatches.get(runId);
    if (existing) {
      await this.preparations.get(runId);
      return;
    }
    if (this.dispatches.size >= this.maxInflightDispatches)
      throw new ScheduleCapacityReached(
        "Scheduler dispatch capacity reached; retry explicitly later",
      );
    let prepared!: () => void;
    let preparationFailed!: (error: unknown) => void;
    const durable = new Promise<void>((resolve, reject) => {
      prepared = resolve;
      preparationFailed = reject;
    });
    this.preparations.set(runId, durable);
    void durable.then(
      () => {
        this.preparations.delete(runId);
      },
      () => {
        this.preparations.delete(runId);
      },
    );
    const task = this.executeFire(id, scheduledFor, runId, prepared, automatic).catch((error) => {
      preparationFailed(error);
      throw error;
    });
    this.track(this.dispatches, runId, task, "schedule_dispatch_failed");
    await durable;
  }
  private async executeFire(
    id: string,
    scheduledFor: string,
    runId: string,
    prepared: () => void,
    automatic: boolean,
  ) {
    if (await this.options.records.record("schedule-run", runId)) {
      prepared();
      return;
    }
    const record = await this.read(id);
    const state = record.value;
    const schedule = state.schedule;
    if (automatic && (schedule.status !== "active" || schedule.nextRunAt !== scheduledFor)) {
      prepared();
      return;
    }
    if (state.reservations.some((r) => r.run.id === runId)) {
      prepared();
      return;
    }
    if (
      (schedule.expiresAt && Date.parse(schedule.expiresAt) <= this.now().getTime()) ||
      (schedule.maxRuns && state.totalRuns >= schedule.maxRuns)
    )
      throw new Error("Schedule has reached its expiration or run limit");
    if (
      state.reservations.length >= 16 ||
      (state.concurrency === "Forbid" && state.reservations.length)
    )
      throw new Error("Schedule has an active or unknown run; concurrency policy forbids dispatch");
    const run: RunState = {
      scheduleId: id,
      projectId: state.projectId,
      credentialProfile: state.credentialProfile,
      phase: "dispatching",
      run: {
        id: runId,
        scheduledFor,
        startedAt: this.now().toISOString(),
        endedAt: null,
        status: "running",
        agentId: null,
        workspaceId: null,
        output: null,
        error: null,
      },
    };
    state.reservations.push(run);
    state.totalRuns++;
    schedule.lastRunAt = scheduledFor;
    schedule.updatedAt = this.now().toISOString();
    if (schedule.status === "active")
      schedule.nextRunAt = nextScheduleTime(schedule.cadence, this.now());
    if (schedule.maxRuns && state.totalRuns >= schedule.maxRuns) {
      schedule.status = "completed";
      schedule.nextRunAt = null;
    }
    // CAS reserves the fire and concurrency slot BEFORE any lifecycle/backend side effect.
    await this.save(record);
    let persisted = await this.options.records.createRecord({
      kind: "schedule-run",
      id: runId,
      value: run,
    });
    prepared();
    try {
      const result = await this.options.dispatch({
        schedule,
        runId,
        projectId: state.projectId,
        credentialProfile: state.credentialProfile,
      });
      run.run = ScheduleRunSchema.parse({ ...run.run, ...result });
      run.phase = "running";
      persisted = await this.options.records.updateRecord({ ...persisted, value: run });
    } catch (error) {
      const failed = error instanceof ScheduleDispatchRejected;
      const outcome = failed
        ? {
            ...run,
            phase: "finished" as const,
            run: {
              ...run.run,
              status: "failed" as const,
              endedAt: this.now().toISOString(),
              error: "Agent dispatch was rejected before acceptance",
            },
          }
        : this.unknown(run);
      await this.options.records.updateRecord({ ...persisted, value: outcome });
      if (failed) await this.release(id, runId);
    }
    await this.prune(id);
  }
  private async release(id: string, runId: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await this.read(id);
      record.value.reservations = record.value.reservations.filter((r) => r.run.id !== runId);
      try {
        await this.save(record);
        return;
      } catch (error) {
        if (!conflict(error) || attempt === 3) throw error;
      }
    }
  }
  /** Explicit operator/observer resolution; unknown dispatches never auto-replay. */
  async completeRun(runId: string, outcome: ScheduleOutcome) {
    const record = await this.options.records.record("schedule-run", runId);
    if (!record) throw new Error("Schedule run does not exist");
    const state = RunStateSchema.parse(record.value);
    if (state.phase === "finished") {
      await this.release(state.scheduleId, runId);
      await this.prune(state.scheduleId);
      return;
    }
    state.phase = "finished";
    state.run = ScheduleRunSchema.parse({
      ...state.run,
      status: outcome.status,
      endedAt: this.now().toISOString(),
      output: outcome.output?.slice(0, 8192) ?? null,
      error: outcome.error?.slice(0, 2048) ?? null,
    });
    await this.options.records.updateRecord({ ...record, value: state });
    await this.release(state.scheduleId, runId);
    await this.prune(state.scheduleId);
  }
  private async prune(id: string) {
    const terminal = (await this.runs(id)).filter((r) => r.value.phase === "finished");
    for (const record of terminal.slice(this.historyLimit))
      await this.options.records.deleteRecord(record);
  }
  private observe(state: RunState) {
    const observer = this.options.observe;
    if (
      !observer ||
      this.stopping ||
      this.observations.has(state.run.id) ||
      this.observations.size >= this.maxInflightObservations
    )
      return;
    const task = (async () => {
      const outcome = await observer({ scheduleId: state.scheduleId, run: state.run });
      if (outcome) await this.completeRun(state.run.id, outcome);
    })();
    this.track(this.observations, state.run.id, task, "schedule_observation_failed");
  }
  /** Stop accepting fires and drain tracked work; a timeout never replays or cancels a mutation. */
  async close(timeoutMs = 30000) {
    this.stopping = true;
    z.number().int().min(0).max(60000).parse(timeoutMs);
    const tasks = [...this.dispatches.values(), ...this.observations.values()];
    if (this.tickTask) tasks.push(this.tickTask);
    if (this.initialization) tasks.push(this.initialization);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return {
      drained,
      pendingDispatches: this.dispatches.size,
      pendingObservations: this.observations.size,
    };
  }
  /** Poll once per second. Backend dispatch and observation cannot block durable fire admission. */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.tickTask) return this.tickTask;
    const task = this.tickOnce();
    this.tickTask = task;
    void task.then(
      () => {
        this.tickTask = undefined;
      },
      () => {
        this.tickTask = undefined;
      },
    );
    return task;
  }
  private async tickOnce() {
    await this.initialize();
    if (this.stopping) return;
    const tickTime = this.now();
    const running = (await this.options.records.records("schedule-run"))
      .map((raw) => RunStateSchema.parse(raw.value))
      .filter((state) => state.phase === "running");
    const start = this.observationCursor % Math.max(running.length, 1);
    for (
      let offset = 0;
      offset < running.length && this.observations.size < this.maxInflightObservations;
      offset++
    ) {
      const index = (start + offset) % running.length;
      const state = running[index];
      if (state) this.observe(state);
      this.observationCursor = index + 1;
    }
    for (const raw of await this.options.records.records("schedule")) {
      if (this.stopping) return;
      const record = { ...raw, value: ScheduleStateSchema.parse(raw.value) };
      const schedule = record.value.schedule;
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        Date.parse(schedule.nextRunAt) > tickTime.getTime()
      )
        continue;
      if (
        (schedule.expiresAt && Date.parse(schedule.expiresAt) <= tickTime.getTime()) ||
        (schedule.maxRuns && record.value.totalRuns >= schedule.maxRuns)
      ) {
        schedule.status = "completed";
        schedule.nextRunAt = null;
        try {
          await this.save(record);
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        continue;
      }
      const due = schedule.nextRunAt;
      const saturated = this.dispatches.size >= this.maxInflightDispatches;
      // Evaluate lateness at poll entry, not after another schedule's API writes or pod startup.
      if (
        tickTime.getTime() - Date.parse(due) > 1000 ||
        record.value.reservations.length >= 16 ||
        (record.value.concurrency === "Forbid" && record.value.reservations.length) ||
        saturated
      ) {
        schedule.nextRunAt = nextScheduleTime(schedule.cadence, tickTime);
        try {
          await this.save(record);
        } catch (error) {
          if (!conflict(error)) throw error;
        }
        if (saturated) this.report("schedule_dispatch_capacity_exceeded");
        continue;
      }
      try {
        await this.fire(schedule.id, due, due, true);
      } catch (error) {
        if (this.stopping) return;
        if (error instanceof ScheduleCapacityReached) {
          this.report("schedule_dispatch_capacity_exceeded");
          continue;
        }
        if (!conflict(error)) throw error;
      }
    }
  }
}
