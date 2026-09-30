import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { GatewayPrincipal } from "../src/gateway/auth.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

class CountingRecords extends MemoryRecordStore {
  catalogReads = 0;

  override async record<T>(kind: string, id: string) {
    if (kind === "workspace-label-catalog" && id === "catalog") this.catalogReads++;
    return super.record<T>(kind, id);
  }
}

describe("workspace directory labels", () => {
  it("reads one fresh catalog per snapshot and refresh, retaining UID-scoped labels", async () => {
    const store = new MemoryStore();
    store.workspaceRows = Array.from({ length: 23 }, (_, index) => {
      const row = workspace(`w-${index}`);
      row.spec.residency = "Suspended";
      row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
      return row;
    });
    const records = new CountingRecords();
    const catalog = await records.createRecord({
      kind: "workspace-label-catalog",
      id: "catalog",
      value: {
        labels: [
          { name: "Review", color: "sky" },
          { name: "Ready", color: "teal" },
        ],
        assignments: [
          { workspaceId: "w-0", workspaceUid: "uid-w-0", labels: ["Review"] },
          { workspaceId: "w-1", workspaceUid: "uid-w-1", labels: ["Ready"] },
          { workspaceId: "w-2", workspaceUid: "stale-uid", labels: ["Review"] },
        ],
      },
    });
    const emitted: SessionOutboundMessage[] = [];
    const session = new GatewaySession({
      store,
      inventoryStore: records,
      namespace: "test",
      backendPassword: "test",
      hello: { type: "hello", clientType: "cli", clientId: "fixture", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {},
      disconnect() {},
    });

    await session.handle({ type: "fetch_workspaces_request", requestId: "list", subscribe: {} });
    const snapshot = emitted.find((message) => message.type === "fetch_workspaces_response");
    if (snapshot?.type !== "fetch_workspaces_response") throw new Error("Missing workspace list");
    expect(snapshot.payload.entries).toHaveLength(23);
    expect(snapshot.payload.entries.find((row) => row.id === "w-0")?.labels).toEqual(["Review"]);
    expect(snapshot.payload.entries.find((row) => row.id === "w-1")?.labels).toEqual(["Ready"]);
    expect(snapshot.payload.entries.find((row) => row.id === "w-2")?.labels).toEqual([]);
    expect(records.catalogReads).toBe(1);

    await records.updateRecord({
      ...catalog,
      value: {
        ...catalog.value,
        assignments: [{ workspaceId: "w-0", workspaceUid: "uid-w-0", labels: ["Ready"] }],
      },
    });
    await session.refreshDirectory();
    expect(records.catalogReads).toBe(2);
    const update = emitted.find(
      (message) =>
        message.type === "workspace_update" &&
        message.payload.kind === "upsert" &&
        message.payload.workspace.id === "w-0",
    );
    expect(update).toMatchObject({ payload: { workspace: { labels: ["Ready"] } } });
    await session.close();
  });

  it("batches only workspaces authorized for a scoped caller", async () => {
    const store = new MemoryStore();
    const origin = workspace("origin");
    origin.status = { phase: "Pending", message: "starting", observedGeneration: 1 };
    const allowed = workspace("allowed");
    allowed.spec.residency = "Suspended";
    const hidden = workspace("hidden");
    hidden.spec.residency = "Suspended";
    hidden.spec.credentialProfile = "other-profile";
    store.workspaceRows = [origin, allowed, hidden];
    const records = new CountingRecords();
    await records.createRecord({
      kind: "workspace-label-catalog",
      id: "catalog",
      value: {
        labels: [{ name: "Private", color: "sky" }],
        assignments: [
          { workspaceId: "allowed", workspaceUid: "uid-allowed", labels: ["Private"] },
          { workspaceId: "hidden", workspaceUid: "uid-hidden", labels: ["Private"] },
        ],
      },
    });
    const principal: GatewayPrincipal = {
      kind: "workspace",
      version: 1,
      audience: "test",
      issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      tokenId: "11111111-1111-4111-8111-111111111111",
      projectIds: ["example"],
      credentialProfiles: ["claude-default"],
      originWorkspaceId: "origin",
      originWorkspaceUid: "uid-origin",
    };
    const emitted: SessionOutboundMessage[] = [];
    const session = new GatewaySession({
      store,
      inventoryStore: records,
      principal,
      namespace: "test",
      backendPassword: "test",
      hello: { type: "hello", clientType: "cli", clientId: "fixture", protocolVersion: 1 },
      directory: new DirectoryGeneration(),
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {},
      disconnect() {},
    });
    await session.handle({ type: "fetch_workspaces_request", requestId: "scoped" });
    const response = emitted.find((message) => message.type === "fetch_workspaces_response");
    if (response?.type !== "fetch_workspaces_response") throw new Error("Missing scoped list");
    expect(response.payload.entries.map((row) => row.id)).toEqual(["allowed", "origin"]);
    expect(response.payload.entries.find((row) => row.id === "allowed")?.labels).toEqual([
      "Private",
    ]);
    expect(records.catalogReads).toBe(1);
    await session.close();
  });
});
