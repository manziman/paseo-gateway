import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { WorkspaceLabels } from "../src/gateway/workspace-labels.js";
import type { ControlRecord, RecordStore } from "../src/kubernetes/records.js";
import { MemoryStore, workspace } from "./fixtures.js";

class Records implements RecordStore {
  row?: ControlRecord;
  revision = 0;
  async records<T>() {
    return (this.row ? [structuredClone(this.row)] : []) as ControlRecord<T>[];
  }
  async record<T>() {
    return structuredClone(this.row) as ControlRecord<T> | undefined;
  }
  async createRecord<T>(row: ControlRecord<T>) {
    if (this.row) throw { code: 409 };
    this.row = { ...structuredClone(row), version: String(++this.revision) };
    return this.row as ControlRecord<T>;
  }
  async updateRecord<T>(row: ControlRecord<T>) {
    if (row.version !== this.row?.version) throw { code: 409 };
    this.row = { ...structuredClone(row), version: String(++this.revision) };
    return this.row as ControlRecord<T>;
  }
  async deleteRecord() {
    this.row = undefined;
  }
}

describe("workspace labels", () => {
  it("uses pinned CRUD responses, persists assignments by workspace UID, and scopes the list", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const records = new Records();
    const service = new WorkspaceLabels(records, store, new DirectoryGeneration());
    const original = store.workspaceRows[0];
    if (!original) throw new Error("Missing fixture workspace");
    const owner = { kind: "owner" as const };
    async function rpc(input: object, principal = owner) {
      const messages: unknown[] = [];
      await service.handle(SessionInboundMessageSchema.parse(input), principal, (message) =>
        messages.push(message),
      );
      return messages[0];
    }
    expect(
      await rpc({
        type: "workspace.label.assignment.set.request",
        requestId: "set",
        workspaceId: "one",
        label: { name: "Review", color: "sky" },
        assigned: true,
      }),
    ).toMatchObject({
      type: "workspace.label.assignment.set.response",
      payload: { workspaceLabels: ["Review"] },
    });
    expect(await service.workspaceLabels(original)).toEqual(["Review"]);
    expect(await rpc({ type: "workspace.label.list.request", requestId: "list" })).toMatchObject({
      payload: { labels: [{ name: "Review", color: "sky" }] },
    });
    const replacement = workspace("one");
    replacement.metadata.uid = "replacement-uid";
    store.workspaceRows[0] = replacement;
    expect(await service.workspaceLabels(replacement)).toEqual([]);
    expect(
      await rpc({
        type: "workspace.label.update.request",
        requestId: "rename",
        name: "Review",
        newName: "Reviewed",
        color: "teal",
      }),
    ).toMatchObject({
      payload: { label: { name: "Reviewed", color: "teal" }, affectedWorkspaceCount: 0 },
    });
    expect(
      await rpc({
        type: "workspace.label.delete.inspect.request",
        requestId: "inspect",
        name: "Reviewed",
      }),
    ).toMatchObject({ payload: { affectedWorkspaceCount: 0 } });
    expect(
      await rpc({ type: "workspace.label.delete.request", requestId: "delete", name: "Reviewed" }),
    ).toMatchObject({ payload: { affectedWorkspaceCount: 0 } });
    expect(records.row?.value).toBeDefined();
  });

  it("rejects invalid names and conflicting colors", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const service = new WorkspaceLabels(new Records(), store, new DirectoryGeneration());
    const owner = { kind: "owner" as const };
    const rpc = (input: object) =>
      service.handle(SessionInboundMessageSchema.parse(input), owner, () => {});
    await expect(
      rpc({
        type: "workspace.label.assignment.set.request",
        requestId: "bad",
        workspaceId: "one",
        label: { name: "bad\nname", color: "sky" },
        assigned: true,
      }),
    ).rejects.toThrow();
    await rpc({
      type: "workspace.label.assignment.set.request",
      requestId: "first",
      workspaceId: "one",
      label: { name: "Review", color: "sky" },
      assigned: true,
    });
    await expect(
      rpc({
        type: "workspace.label.assignment.set.request",
        requestId: "conflict",
        workspaceId: "one",
        label: { name: "Review", color: "teal" },
        assigned: true,
      }),
    ).rejects.toThrow("different color");
  });
  it("streams pinned label updates to a subscribed client and releases the subscription", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const service = new WorkspaceLabels(new Records(), store, new DirectoryGeneration());
    const owner = { kind: "owner" as const };
    const events: unknown[] = [];
    const emit = (message: unknown) => events.push(message);
    await service.handle(
      SessionInboundMessageSchema.parse({
        type: "workspace.label.list.request",
        requestId: "list",
        subscribe: {},
      }),
      owner,
      emit,
    );
    const subscriptionId = (events[0] as { payload: { subscriptionId: string } }).payload
      .subscriptionId;
    expect(subscriptionId).toBeTruthy();
    await service.handle(
      SessionInboundMessageSchema.parse({
        type: "workspace.label.assignment.set.request",
        requestId: "set",
        workspaceId: "one",
        label: { name: "Review", color: "sky" },
        assigned: true,
      }),
      owner,
      emit,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "workspace.label.update",
        payload: expect.objectContaining({
          subscriptionId,
          kind: "upsert",
          label: { name: "Review", color: "sky" },
        }),
      }),
    );
    await service.handle(
      SessionInboundMessageSchema.parse({
        type: "subscription.release.request",
        requestId: "release",
        subscriptionId,
      }),
      owner,
      emit,
    );
    const before = events.length;
    await service.handle(
      SessionInboundMessageSchema.parse({
        type: "workspace.label.delete.request",
        requestId: "delete",
        name: "Review",
      }),
      owner,
      emit,
    );
    expect(
      events
        .slice(before)
        .some((message) => (message as { type: string }).type === "workspace.label.update"),
    ).toBe(false);
  });
});
