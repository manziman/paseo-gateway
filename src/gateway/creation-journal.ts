import { createHash, randomUUID } from "node:crypto";
import {
  type CreationSnapshot,
  CreationSnapshotSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import { statusCode } from "../kubernetes/store.js";
import { retainedAgentMetadata } from "./agent-inventory.js";
import type { GatewayPrincipal } from "./auth.js";

type Emit = (message: SessionOutboundMessage | Record<string, unknown>) => void;
const RecordSchema = z.object({
  fingerprint: z.string(),
  actor: z.string(),
  instance: z.string(),
  workspaceId: z.string().optional(),
  workspaceUid: z.string().optional(),
  dispatching: z.boolean(),
  snapshot: CreationSnapshotSchema,
});
type JournalValue = z.infer<typeof RecordSchema>;
export type CreationProgress = (
  patch: Partial<CreationSnapshot>,
  identity?: { workspaceId: string; workspaceUid: string },
  dispatching?: boolean,
) => Promise<void>;
const terminal = (snapshot: CreationSnapshot) =>
  snapshot.phase === "completed" || snapshot.phase === "failed";
const actor = (principal: GatewayPrincipal) =>
  principal.kind === "owner" ? "owner" : principal.originWorkspaceUid;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Durable observation only: an interrupted nonterminal intent is never replayed.
 * Records contain redacted result metadata, not prompts, environment or provider configuration.
 */
export class CreationJournal {
  private readonly instance = randomUUID();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly activeInputs = new Map<string, { fingerprint: string; actor: string }>();
  private readonly listeners = new Map<
    string,
    { id: string; emit: Emit; principal: GatewayPrincipal }
  >();
  constructor(
    private readonly store: RecordStore,
    private readonly authorize: (
      principal: GatewayPrincipal,
      identity?: { workspaceId: string; workspaceUid: string },
    ) => Promise<void>,
  ) {}

  private id(kind: CreationSnapshot["kind"], key: string) {
    return digest([kind, key]);
  }
  private async checked(record: ControlRecord<unknown>, principal: GatewayPrincipal) {
    const value = RecordSchema.parse(record.value);
    await this.authorize(
      principal,
      value.workspaceId && value.workspaceUid
        ? { workspaceId: value.workspaceId, workspaceUid: value.workspaceUid }
        : undefined,
    );
    if (principal.kind !== "owner" && value.actor !== actor(principal))
      throw new Error("Creation access denied");
    return { ...record, value };
  }
  private listen(id: string, emit: Emit, principal: GatewayPrincipal) {
    if ([...this.listeners.values()].filter((row) => row.emit === emit).length >= 64)
      throw new Error("Too many creation subscriptions");
    const subscriptionId = `creation:${randomUUID()}`;
    this.listeners.set(subscriptionId, { id, emit, principal });
    return subscriptionId;
  }
  close(emit: Emit) {
    for (const [key, row] of this.listeners) if (row.emit === emit) this.listeners.delete(key);
  }
  release(subscriptionId: string, emit: Emit) {
    const row = this.listeners.get(subscriptionId);
    if (row?.emit === emit) this.listeners.delete(subscriptionId);
  }
  private async publish(record: ControlRecord<JournalValue>) {
    for (const [subscriptionId, listener] of this.listeners) {
      if (listener.id !== record.id) continue;
      try {
        await this.checked(record, listener.principal);
        const snapshot = record.value.snapshot;
        // Upstream's legacy subscription adapter does not classify creation streams.
        // Untagged updates also feed its CreationClient; revision numbers deduplicate.
        listener.emit({
          type: `${snapshot.kind}.create.update`,
          payload: { ...snapshot, subscriptionId },
        });
        listener.emit({ type: `${snapshot.kind}.create.update`, payload: snapshot });
      } catch {
        this.listeners.delete(subscriptionId);
      }
      if (terminal(record.value.snapshot)) this.listeners.delete(subscriptionId);
    }
  }
  private async recover(record: ControlRecord<JournalValue>, interrupted = false) {
    if (!terminal(record.value.snapshot) && (interrupted || !this.active.has(record.id))) {
      const snapshot: CreationSnapshot = {
        ...record.value.snapshot,
        revision: record.value.snapshot.revision + 1,
        phase: "failed",
        outcomeUnknown: true,
        error:
          "Creation outcome unknown after gateway replacement; inspect the workspace before a new attempt",
        failedStage:
          record.value.dispatching && record.value.snapshot.workspaceId ? "agent" : "workspace",
      };
      try {
        record = await this.store.updateRecord({ ...record, value: { ...record.value, snapshot } });
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
        const current = await this.store.record<JournalValue>("creation-operation", record.id);
        if (!current) throw new Error("Creation record disappeared");
        record = { ...current, value: RecordSchema.parse(current.value) };
      }
    }
    return record;
  }
  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    principal: GatewayPrincipal,
    emit: Emit,
    subscribe = true,
  ) {
    await this.authorize(principal);
    const id = this.id(kind, key);
    const subscriptionId = subscribe ? this.listen(id, emit, principal) : undefined;
    try {
      const raw = await this.store.record("creation-operation", id);
      if (!raw) {
        if (subscriptionId) this.listeners.delete(subscriptionId);
        return { snapshot: null };
      }
      const record = await this.recover(await this.checked(raw, principal));
      if (terminal(record.value.snapshot) && subscriptionId) this.listeners.delete(subscriptionId);
      return { snapshot: record.value.snapshot, subscriptionId };
    } catch (error) {
      if (subscriptionId) this.listeners.delete(subscriptionId);
      throw error;
    }
  }

  private async permittedResult(
    id: string,
    pending: Promise<CreationSnapshot>,
    principal: GatewayPrincipal,
  ) {
    const snapshot = await pending;
    const record = await this.store.record("creation-operation", id);
    if (!record) throw new Error("Creation record disappeared");
    await this.checked(record, principal);
    return snapshot;
  }

  run(
    kind: CreationSnapshot["kind"],
    key: string,
    input: unknown,
    principal: GatewayPrincipal,
    emit: Emit,
    subscribe: boolean,
    execute: (progress: CreationProgress) => Promise<void>,
  ): Promise<CreationSnapshot> {
    const id = this.id(kind, key);
    const fingerprint = digest(input);
    const existing = this.active.get(id);
    if (existing)
      return (async () => {
        const claimed = this.activeInputs.get(id);
        if (!claimed || claimed.fingerprint !== fingerprint)
          throw new Error("Idempotency key conflicts with another creation request");
        if (principal.kind !== "owner" && claimed.actor !== actor(principal))
          throw new Error("Creation access denied");
        const raw = await this.store.record("creation-operation", id);
        if (raw) {
          const row = await this.checked(raw, principal);
          if (row.value.fingerprint !== fingerprint)
            throw new Error("Idempotency key conflicts with another creation request");
        } else await this.authorize(principal);
        if (subscribe) this.listen(id, emit, principal);
        return this.permittedResult(id, existing, principal);
      })();
    const promise = Promise.resolve().then(async () => {
      await this.authorize(principal);
      let record: ControlRecord<JournalValue>;
      const value: JournalValue = {
        fingerprint,
        actor: actor(principal),
        instance: this.instance,
        dispatching: false,
        snapshot: {
          kind,
          idempotencyKey: key,
          revision: 0,
          phase: "accepted",
          workspaceId: null,
          agentId: null,
          error: null,
        },
      };
      try {
        record = await this.store.createRecord({ kind: "creation-operation", id, value });
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
        const raw = await this.store.record("creation-operation", id);
        if (!raw) throw new Error("Creation record disappeared");
        record = await this.checked(raw, principal);
        if (record.value.fingerprint !== fingerprint)
          throw new Error("Idempotency key conflicts with another creation request");
        // The only executing promise for this instance is this replay, not the old mutation.
        return (await this.recover(record, true)).value.snapshot;
      }
      if (subscribe) this.listen(id, emit, principal);
      await this.publish(record);
      const progress: CreationProgress = async (patch, identity, dispatching) => {
        const snapshot = CreationSnapshotSchema.parse({
          ...record.value.snapshot,
          ...patch,
          revision: record.value.snapshot.revision + 1,
        });
        if (snapshot.agent) snapshot.agent = retainedAgentMetadata(snapshot.agent);
        record = await this.store.updateRecord({
          ...record,
          value: {
            ...record.value,
            ...identity,
            dispatching: dispatching ?? record.value.dispatching,
            snapshot,
          },
        });
        await this.publish(record);
      };
      try {
        await execute(progress);
      } catch (error) {
        await progress({
          phase: "failed",
          error: error instanceof Error ? error.message : "Creation failed",
          outcomeUnknown: record.value.dispatching,
          failedStage:
            record.value.dispatching && record.value.snapshot.workspaceId ? "agent" : "workspace",
        });
      }
      if (!terminal(record.value.snapshot)) await progress({ phase: "completed" });
      return record.value.snapshot;
    });
    this.activeInputs.set(id, { fingerprint, actor: actor(principal) });
    this.active.set(id, promise);
    void promise
      .finally(() => {
        if (this.active.get(id) === promise) {
          this.active.delete(id);
          this.activeInputs.delete(id);
        }
      })
      .catch(() => {});
    return this.permittedResult(id, promise, principal);
  }
}
