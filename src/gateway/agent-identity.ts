import { z } from "zod";
import { parseScopedId, scopedId, type Workspace } from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";

const Binding = z
  .object({
    workspaceId: z.string().min(1),
    workspaceUid: z.string().min(1),
    backendAgentId: z.guid(),
  })
  .strict();
const Route = z.discriminatedUnion("state", [
  Binding.extend({ state: z.literal("active") }).strict(),
  Binding.extend({
    state: z.literal("collision"),
    conflictingWorkspaceUid: z.string().min(1),
  }).strict(),
]);
type Route = z.infer<typeof Route>;
const kind = "agent-route";
const CACHE_MS = 30_000;
const MAX_CACHE = 4096;
const MAX_CONCURRENT_CLAIMS = 8;
const MAX_PENDING_CLAIMS = 512;

function conflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && error.code === 409) || ("statusCode" in error && error.statusCode === 409))
  );
}

function binding(workspace: Workspace, backendAgentId: string) {
  return Binding.parse({
    workspaceId: workspace.metadata.name,
    workspaceUid: workspace.metadata.uid,
    backendAgentId,
  });
}

function same(left: z.infer<typeof Binding>, right: z.infer<typeof Binding>) {
  return (
    left.workspaceId === right.workspaceId &&
    left.workspaceUid === right.workspaceUid &&
    left.backendAgentId === right.backendAgentId
  );
}

/** Durable, UID-bound routing of native GUIDs. Cache affects claim performance only;
 * every inbound lookup reads the authoritative record and current caller scope.
 */
export class AgentIdentityRegistry {
  private readonly claims = new Map<string, number>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly claimWaiters: Array<() => void> = [];
  private readonly collisionListeners = new Set<() => void>();
  private activeClaims = 0;
  private pendingReservations = 0;
  constructor(private readonly records: RecordStore) {}

  onCollision(listener: () => void) {
    this.collisionListeners.add(listener);
    return () => this.collisionListeners.delete(listener);
  }

  private cacheKey(value: z.infer<typeof Binding>) {
    return `${value.workspaceUid}:${value.backendAgentId}`;
  }

  private async read(id: string): Promise<ControlRecord<Route> | undefined> {
    const record = await this.records.record<Route>(kind, id);
    if (!record) return undefined;
    if (record.id !== id || record.kind !== kind)
      throw new Error("Malformed agent identity route record");
    const value = Route.parse(record.value);
    if (value.backendAgentId !== id)
      throw new Error("Agent identity route key and backend ID differ");
    return { ...record, value };
  }

  private remember(key: string) {
    this.claims.delete(key);
    this.claims.set(key, Date.now() + CACHE_MS);
    while (this.claims.size > MAX_CACHE) {
      const oldest = this.claims.keys().next().value;
      if (oldest === undefined) break;
      this.claims.delete(oldest);
    }
  }

  private async withClaimPermit<T>(action: () => Promise<T>) {
    if (this.activeClaims >= MAX_CONCURRENT_CLAIMS)
      await new Promise<void>((resolve) => this.claimWaiters.push(resolve));
    else this.activeClaims++;
    try {
      return await action();
    } finally {
      const next = this.claimWaiters.shift();
      if (next) next();
      else this.activeClaims--;
    }
  }

  async claim(workspace: Workspace, backendAgentId: string): Promise<string> {
    const value = binding(workspace, backendAgentId);
    const id = value.backendAgentId;
    const key = this.cacheKey(value);
    if ((this.claims.get(key) ?? 0) > Date.now()) {
      this.remember(key);
      return id;
    }
    this.claims.delete(key);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    if (this.pending.size >= MAX_PENDING_CLAIMS)
      throw new Error("Agent identity claim capacity reached; reconnect and retry inspection");
    const claim = this.withClaimPermit(() => this.claimDurable(value));
    this.pending.set(key, claim);
    try {
      return await claim;
    } finally {
      this.pending.delete(key);
    }
  }

  private async claimDurable(value: z.infer<typeof Binding>): Promise<string> {
    const id = value.backendAgentId;
    const key = this.cacheKey(value);
    try {
      await this.records.createRecord({ kind, id, value: { ...value, state: "active" } });
      this.remember(key);
      return id;
    } catch (error) {
      if (!conflict(error)) throw error;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.read(id);
      if (!existing) throw new Error("Agent identity claim conflicted without a valid route");
      if (existing.value.state === "collision")
        throw new Error("Native agent GUID is quarantined after a workspace collision");
      if (same(existing.value, value)) {
        this.remember(key);
        return id;
      }
      this.claims.delete(this.cacheKey(existing.value));
      try {
        await this.records.updateRecord({
          ...existing,
          value: {
            ...existing.value,
            state: "collision",
            conflictingWorkspaceUid: value.workspaceUid,
          },
        });
        for (const listener of this.collisionListeners) listener();
        throw new Error("Native agent GUID is already bound to another workspace UID");
      } catch (error) {
        if (!conflict(error)) throw error;
      }
    }
    throw new Error("Agent identity collision could not be quarantined; retry inspection");
  }

  /** Called only after the creation journal has reserved the mutation. An explicit
   * duplicate is rejected before reaching a daemon; it is not a native collision.
   */
  async reserveForCreate(workspace: Workspace, requestedId: string): Promise<string> {
    const value = binding(workspace, requestedId);
    if (this.pending.size + this.pendingReservations >= MAX_PENDING_CLAIMS)
      throw new Error("Agent identity reservation capacity reached; retry after inspection");
    this.pendingReservations++;
    try {
      await this.withClaimPermit(() =>
        this.records.createRecord({
          kind,
          id: value.backendAgentId,
          value: { ...value, state: "active" },
        }),
      );
      this.remember(this.cacheKey(value));
      return value.backendAgentId;
    } catch (error) {
      if (conflict(error)) throw new Error("Requested agent GUID is already reserved");
      throw error;
    } finally {
      this.pendingReservations--;
    }
  }

  /** `authorizedWorkspaces` must come from a freshly validated principal. */
  async resolve(
    publicOrLegacyId: string,
    authorizedWorkspaces: readonly Workspace[],
  ): Promise<{ workspace: Workspace; backendAgentId: string }> {
    const legacy = publicOrLegacyId.includes("~") ? parseScopedId(publicOrLegacyId) : undefined;
    const id = z.guid().parse(legacy?.backendId ?? publicOrLegacyId);
    const record = await this.read(id);
    if (!record) throw new Error("Unknown agent identity route; refresh the agent directory");
    const value = record.value;
    if (value.state === "collision")
      throw new Error("Native agent GUID is quarantined after a workspace collision");
    if (legacy && scopedId(value.workspaceId, id) !== publicOrLegacyId)
      throw new Error("Legacy agent ID does not match its durable route");
    const workspace = authorizedWorkspaces.find(
      (row) => row.metadata.name === value.workspaceId && row.metadata.uid === value.workspaceUid,
    );
    if (!workspace || workspace.metadata.deletionTimestamp)
      throw new Error("Agent workspace UID changed or access was revoked");
    return { workspace, backendAgentId: value.backendAgentId };
  }
}
