import { randomUUID } from "node:crypto";
import {
  type SessionInboundMessage,
  WorkspaceLabelDefinitionSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { Workspace } from "../domain.js";
import type { ControlRecord, RecordStore } from "../kubernetes/records.js";
import type { Store } from "../kubernetes/store.js";
import { authorizeWorkspace, type GatewayPrincipal, principalIsActive } from "./auth.js";
import type { DirectoryGeneration } from "./catalog.js";
import type { SessionOptions } from "./session.js";

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => [...value].every((character) => (character.codePointAt(0) ?? 0) >= 32));
const Definition = WorkspaceLabelDefinitionSchema.extend({ name });
const Catalog = z.object({
  labels: z.array(Definition).max(128),
  assignments: z
    .array(
      z.object({
        workspaceId: z.string(),
        workspaceUid: z.string(),
        labels: z.array(name).max(16),
      }),
    )
    .max(256),
});
type CatalogState = z.infer<typeof Catalog>;
const kind = "workspace-label-catalog";
const id = "catalog";

export class WorkspaceLabels {
  private readonly subscriptions = new Map<
    string,
    {
      principal: GatewayPrincipal;
      emit: SessionOptions["emit"];
      seen: Map<string, string>;
    }
  >();
  constructor(
    private readonly records: RecordStore,
    private readonly store: Store,
    private readonly directory: DirectoryGeneration,
  ) {}

  private async read(): Promise<{ record?: ControlRecord<CatalogState>; state: CatalogState }> {
    const record = await this.records.record<CatalogState>(kind, id);
    return { record, state: Catalog.parse(record?.value ?? { labels: [], assignments: [] }) };
  }

  private async scope(principal: GatewayPrincipal) {
    const workspaces = await this.store.workspaces();
    if (!principalIsActive(principal, workspaces))
      throw new Error("Workspace credential expired or revoked");
    return workspaces.filter(
      (w) => !w.metadata.deletionTimestamp && authorizeWorkspace(principal, w),
    );
  }

  private labelsFor(state: CatalogState, workspace: Workspace): string[] {
    return (
      state.assignments.find(
        (a) =>
          a.workspaceId === workspace.metadata.name && a.workspaceUid === workspace.metadata.uid,
      )?.labels ?? []
    );
  }

  async workspaceLabels(workspace: Workspace): Promise<string[]> {
    return this.labelsFor((await this.read()).state, workspace);
  }

  private visible(state: CatalogState, principal: GatewayPrincipal, workspaces: Workspace[]) {
    return principal.kind === "owner"
      ? state.labels
      : state.labels.filter((label) =>
          workspaces.some((workspace) => this.labelsFor(state, workspace).includes(label.name)),
        );
  }

  private async publish() {
    const { state } = await this.read();
    for (const [subscriptionId, subscription] of this.subscriptions) {
      let workspaces: Workspace[];
      try {
        workspaces = await this.scope(subscription.principal);
      } catch {
        this.subscriptions.delete(subscriptionId);
        continue;
      }
      const current = new Map(
        this.visible(state, subscription.principal, workspaces).map((label) => [
          label.name,
          label.color,
        ]),
      );
      for (const [name, color] of current)
        if (subscription.seen.get(name) !== color)
          subscription.emit({
            type: "workspace.label.update",
            payload: {
              subscriptionId,
              kind: "upsert",
              label: { name, color },
              generation: this.directory.id,
              seq: this.directory.next(),
            },
          });
      for (const name of subscription.seen.keys())
        if (!current.has(name))
          subscription.emit({
            type: "workspace.label.update",
            payload: {
              subscriptionId,
              kind: "remove",
              name,
              generation: this.directory.id,
              seq: this.directory.next(),
            },
          });
      subscription.seen = current;
    }
  }

  releaseEmitter(emit: SessionOptions["emit"]) {
    for (const [id, subscription] of this.subscriptions)
      if (subscription.emit === emit) this.subscriptions.delete(id);
  }

  private async change<T>(
    principal: GatewayPrincipal,
    fn: (state: CatalogState, workspaces: Workspace[]) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const workspaces = await this.store.workspaces();
      if (!principalIsActive(principal, workspaces))
        throw new Error("Workspace credential expired or revoked");
      const { record, state } = await this.read();
      state.assignments = state.assignments.filter((assignment) =>
        workspaces.some(
          (row) =>
            row.metadata.name === assignment.workspaceId &&
            row.metadata.uid === assignment.workspaceUid &&
            !row.metadata.deletionTimestamp,
        ),
      );
      const result = fn(state, workspaces);
      Catalog.parse(state);
      if (Buffer.byteLength(JSON.stringify(state)) > 500_000)
        throw new Error("Workspace label catalog exceeds its metadata budget");
      try {
        if (record) await this.records.updateRecord({ ...record, value: state });
        else await this.records.createRecord({ kind, id, value: state });
        return result;
      } catch (error) {
        const conflict =
          typeof error === "object" &&
          error !== null &&
          (("code" in error && error.code === 409) ||
            ("statusCode" in error && error.statusCode === 409));
        if (!conflict || attempt === 4) throw error;
      }
    }
    throw new Error("Workspace label catalog update conflicted");
  }

  async handle(
    message: SessionInboundMessage,
    principal: GatewayPrincipal,
    emit: SessionOptions["emit"],
  ): Promise<boolean> {
    if (message.type === "subscription.release.request") {
      const subscription = this.subscriptions.get(message.subscriptionId);
      if (!subscription || subscription.emit !== emit) return false;
      this.subscriptions.delete(message.subscriptionId);
      emit({
        type: "subscription.release.response",
        payload: {
          requestId: message.requestId,
          subscriptionId: message.subscriptionId,
        },
      });
      return true;
    }
    if (!message.type.startsWith("workspace.label.")) return false;
    const workspaces = await this.scope(principal);
    const requestId =
      "requestId" in message && typeof message.requestId === "string" ? message.requestId : "";
    const reply = (type: string, payload: object) =>
      emit({ type, payload: { requestId, ...payload } });
    if (message.type === "workspace.label.list.request") {
      const { state } = await this.read();
      const visible = this.visible(state, principal, workspaces);
      let subscriptionId: string | undefined;
      if (message.subscribe) {
        subscriptionId = message.subscribe.subscriptionId ?? randomUUID();
        if (!this.subscriptions.has(subscriptionId) && this.subscriptions.size >= 256)
          throw new Error("Workspace label subscription capacity reached");
        const prior = this.subscriptions.get(subscriptionId);
        if (prior && prior.emit !== emit)
          throw new Error("Workspace label subscription belongs to another session");
        this.subscriptions.set(subscriptionId, {
          principal,
          emit,
          seen: new Map(visible.map((label) => [label.name, label.color])),
        });
      }
      reply("workspace.label.list.response", {
        labels: visible,
        ...(subscriptionId ? { subscriptionId } : {}),
        sync: this.directory.snapshot(message.sync?.generation),
      });
      return true;
    }
    if (message.type === "workspace.label.assignment.set.request") {
      const workspace = workspaces.find((w) => w.metadata.name === message.workspaceId);
      if (!workspace?.metadata.uid)
        throw new Error("Workspace label target unavailable or access denied");
      const uid = workspace.metadata.uid;
      const label = Definition.parse(message.label);
      const result = await this.change(principal, (state, currentWorkspaces) => {
        const current = currentWorkspaces.find(
          (row) => row.metadata.name === workspace.metadata.name,
        );
        if (
          !current ||
          current.metadata.uid !== workspace.metadata.uid ||
          current.metadata.deletionTimestamp ||
          !authorizeWorkspace(principal, current)
        )
          throw new Error("Workspace label target changed or access revoked");
        const existing = state.labels.find((row) => row.name === label.name);
        if (existing && existing.color !== label.color)
          throw new Error("Workspace label name already has a different color");
        if (!existing && message.assigned) state.labels.push(label);
        let assignment = state.assignments.find(
          (row) =>
            row.workspaceId === workspace.metadata.name &&
            row.workspaceUid === workspace.metadata.uid,
        );
        if (!assignment && message.assigned) {
          assignment = { workspaceId: workspace.metadata.name, workspaceUid: uid, labels: [] };
          state.assignments = state.assignments.filter(
            (row) => row.workspaceId !== workspace.metadata.name,
          );
          state.assignments.push(assignment);
        }
        if (assignment) {
          assignment.labels = message.assigned
            ? [...new Set([...assignment.labels, label.name])]
            : assignment.labels.filter((name) => name !== label.name);
          if (!assignment.labels.length)
            state.assignments = state.assignments.filter((row) => row !== assignment);
        }
        return { label: existing ?? label, workspaceLabels: assignment?.labels ?? [] };
      });
      reply("workspace.label.assignment.set.response", result);
      await this.publish();
      return true;
    }
    if (principal.kind !== "owner")
      throw new Error("Workspace label catalog management requires owner access");
    if (message.type === "workspace.label.update.request") {
      const current = name.parse(message.name);
      const next = message.newName === undefined ? current : name.parse(message.newName);
      const result = await this.change(principal, (state) => {
        const label = state.labels.find((row) => row.name === current);
        if (!label && message.color === undefined)
          throw new Error("Workspace label does not exist");
        if (next !== current && state.labels.some((row) => row.name === next))
          throw new Error("Workspace label already exists");
        const updated = Definition.parse({ name: next, color: message.color ?? label?.color });
        if (label) Object.assign(label, updated);
        else state.labels.push(updated);
        const affectedWorkspaceCount = state.assignments.filter((row) =>
          row.labels.includes(current),
        ).length;
        if (next !== current)
          for (const row of state.assignments)
            row.labels = row.labels.map((value) => (value === current ? next : value));
        return { label: updated, affectedWorkspaceCount };
      });
      reply("workspace.label.update.response", result);
      await this.publish();
      return true;
    }
    if (
      message.type === "workspace.label.delete.request" ||
      message.type === "workspace.label.delete.inspect.request"
    ) {
      const labelName = name.parse(message.name);
      const count = (state: CatalogState) =>
        state.assignments.filter((row) => row.labels.includes(labelName)).length;
      const affectedWorkspaceCount =
        message.type === "workspace.label.delete.inspect.request"
          ? count((await this.read()).state)
          : await this.change(principal, (state) => {
              const affected = count(state);
              state.labels = state.labels.filter((row) => row.name !== labelName);
              for (const row of state.assignments)
                row.labels = row.labels.filter((value) => value !== labelName);
              return affected;
            });
      reply(
        message.type === "workspace.label.delete.request"
          ? "workspace.label.delete.response"
          : "workspace.label.delete.inspect.response",
        { affectedWorkspaceCount },
      );
      if (message.type === "workspace.label.delete.request") await this.publish();
      return true;
    }
    return false;
  }
}
