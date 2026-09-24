import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { API_VERSION } from "../src/domain.js";
import { ProviderCatalog } from "../src/gateway/provider-catalog-service.js";
import type { ProviderProbeReceipts, ProviderProbeResult } from "../src/gateway/provider-probe.js";
import type { ControlRecord, RecordStore } from "../src/kubernetes/records.js";
import { MemoryStore, project } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

class CatalogStore extends MemoryStore implements RecordStore {
  readonly recordsStore = new MemoryRecordStore();
  records<T>(kind: string) {
    return this.recordsStore.records<T>(kind);
  }
  record<T>(kind: string, id: string) {
    return this.recordsStore.record<T>(kind, id);
  }
  createRecord<T>(row: ControlRecord<T>) {
    return this.recordsStore.createRecord(row);
  }
  updateRecord<T>(row: ControlRecord<T>) {
    return this.recordsStore.updateRecord(row);
  }
  deleteRecord(row: ControlRecord) {
    return this.recordsStore.deleteRecord(row);
  }
}

const ready: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    models: [{ provider: "claude", id: "model", label: "Model" }],
  },
];
function setup() {
  const store = new CatalogStore();
  const configuredProject = store.projectRows[0];
  if (!configuredProject) throw new Error("Test project is unavailable");
  configuredProject.metadata.uid = "project-uid";
  store.profileRows.set("claude-default", {
    apiVersion: API_VERSION,
    kind: "PaseoCredentialProfile",
    metadata: { name: "claude-default", namespace: "test", uid: "profile-uid" },
    spec: { env: [], files: [] },
  });
  const calls: string[] = [];
  const completions: Array<(result: ProviderProbeResult) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const cleanups: Array<{ runId: string; receipts?: ProviderProbeReceipts }> = [];
  let now = Date.parse("2026-01-01T00:00:00Z");
  const catalog = new ProviderCatalog({
    store,
    namespace: "test",
    backendPassword: "backend",
    backendSecure: true,
    runtime: {
      workspaceImage: "runtime:v1",
      storageSize: "5Gi",
      backendSecret: "backend",
      imagePullPolicy: "IfNotPresent",
    },
    now: () => now,
    probe: {
      async run({ runId, onResourceCreated }) {
        if (!runId) throw new Error("Test run ID is unavailable");
        calls.push(runId);
        await onResourceCreated?.("Service", `service-${runId}`);
        await onResourceCreated?.("Pod", `pod-${runId}`);
        return await new Promise<ProviderProbeResult>((resolve, reject) => {
          completions.push(resolve);
          failures.push(reject);
        });
      },
      async cleanup(_name, _projectUid, runId, receipts) {
        cleanups.push({ runId, receipts });
      },
    },
  });
  return {
    store,
    catalog,
    calls,
    completions,
    failures,
    cleanups,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

async function settled(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

describe("durable cold provider catalog", () => {
  it("starts with zero workspaces, publishes verified daemon output, and invalidates a changed profile", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    const updates: ProviderSnapshotEntry[][] = [];
    fixture.catalog.watch("example", (entries) => updates.push(entries));
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await settled(() => updates.length === 1);
    expect(updates).toEqual([ready]);
    expect(await fixture.catalog.snapshot(row)).toEqual(ready);
    expect(
      (
        await fixture.store.record<{ state: string; receipts?: ProviderProbeReceipts }>(
          "provider-catalog",
          "example",
        )
      )?.value.state,
    ).toBe("verified");
    const profile = fixture.store.profileRows.get("claude-default");
    if (!profile) throw new Error("Test profile is unavailable");
    profile.spec.runtime = { image: "runtime:v2" };
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 2);
    expect(fixture.calls).toHaveLength(2);
  });

  it("does not reclaim a still-running rollout, then reclaims an expired run by fenced identity", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    const record = await fixture.store.record<{
      state: string;
      runId: string;
      receipts: ProviderProbeReceipts;
    }>("provider-catalog", "example");
    expect(record?.value.receipts).toEqual({
      serviceUid: `service-${record?.value.runId}`,
      podUid: `pod-${record?.value.runId}`,
    });
    const replacement = new ProviderCatalog({
      store: fixture.store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
      now: () => fixture.now,
      probe: {
        async run() {
          throw new Error("not expected");
        },
        async cleanup(_name, _uid, runId, receipts) {
          fixture.cleanups.push({ runId, receipts });
        },
      },
    });
    await replacement.initialize();
    expect(fixture.cleanups).toEqual([]);
    expect(await replacement.snapshot(row)).toEqual([]);
    fixture.advance(6 * 60_000 + 1);
    await replacement.initialize();
    expect(fixture.cleanups).toEqual([
      { runId: record?.value.runId, receipts: record?.value.receipts },
    ]);
    expect(
      (await fixture.store.record<{ state: string }>("provider-catalog", "example"))?.value.state,
    ).toBe("failed");
  });

  it("treats a missing access projection as unavailable until it appears", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    const profile = fixture.store.profileRows.get("claude-default");
    if (!profile) throw new Error("Test profile is unavailable");
    profile.spec.env = [
      {
        name: "PASEO_TEST_ACCESS",
        valueFrom: { secretKeyRef: { name: "access-output", key: "access.json" } },
      },
    ];
    await expect(fixture.catalog.snapshot(row)).rejects.toThrow("unavailable");
    expect(fixture.calls).toEqual([]);
    fixture.store.secretRows.set("access-output", {
      metadata: { name: "access-output", uid: "access-uid", resourceVersion: "1" },
      data: { "access.json": "dGVzdA==" },
    });
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
  });

  it("starts the stale deadline only after a queued probe receives a permit", async () => {
    const fixture = setup();
    const rows = ["one", "two", "three"].map((name) => {
      const row = project();
      row.metadata.name = name;
      row.metadata.uid = `uid-${name}`;
      return row;
    });
    fixture.store.projectRows = rows;
    for (const row of rows) expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 2);
    expect(await fixture.store.record("provider-catalog", "three")).toBeUndefined();
    fixture.advance(6 * 60_000 + 1);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await settled(() => fixture.completions.length === 3);
    const third = await fixture.store.record<{ state: string; startedAt: string }>(
      "provider-catalog",
      "three",
    );
    expect(third?.value.state).toBe("probing");
    expect(Date.parse(third?.value.startedAt ?? "")).toBe(fixture.now);
  });

  it("runs a new daemon probe for an explicit refresh within the verified TTL", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await settled(() => fixture.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await fixture.catalog.snapshot(row)).toEqual(ready);
    expect(await fixture.catalog.snapshot(row, true)).toEqual([]);
    await settled(() => fixture.completions.length === 2);
    expect(fixture.calls).toHaveLength(2);
  });

  it("publishes a fixed error row for a provider verified under the same configuration", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    const updates: ProviderSnapshotEntry[][] = [];
    const release = fixture.catalog.watch("example", (entries) => updates.push(entries));
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await settled(() => updates.some((entries) => entries[0]?.status === "ready"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await fixture.catalog.snapshot(row, true)).toEqual([]);
    await settled(() => fixture.failures.length === 2);
    fixture.failures[1]?.(new Error("Authorization: Bearer secret"));
    await settled(() => updates.some((entries) => entries[0]?.status === "error"));
    const failed = await fixture.catalog.snapshot(row);
    expect(failed).toMatchObject([
      { provider: "claude", status: "error", enabled: true, models: [] },
    ]);
    expect(JSON.stringify(failed)).not.toContain("Bearer");
    expect(JSON.stringify(failed)).not.toContain("secret");
    release();
  });

  it("publishes a verified update after the client reconnects to another gateway", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    const replacement = new ProviderCatalog({
      store: fixture.store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
      now: () => fixture.now,
      pollMs: 5,
      probe: {
        async run() {
          throw new Error("Unexpected duplicate probe");
        },
        async cleanup() {},
      },
    });
    const updates: ProviderSnapshotEntry[][] = [];
    const release = replacement.watch("example", (entries) => updates.push(entries));
    expect(await replacement.snapshot(row)).toEqual([]);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await settled(() => updates.some((entries) => entries[0]?.status === "ready"));
    expect(await replacement.snapshot(row)).toEqual(ready);
    release();
  });

  it("refreshes a watched Project after its profile configuration changes", async () => {
    const fixture = setup();
    const row = project();
    row.metadata.uid = "project-uid";
    expect(await fixture.catalog.snapshot(row)).toEqual([]);
    await settled(() => fixture.completions.length === 1);
    fixture.completions[0]?.({ entries: ready, fetchedAt: new Date(fixture.now).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let reprobes = 0;
    const auditor = new ProviderCatalog({
      store: fixture.store,
      namespace: "test",
      backendPassword: "backend",
      backendSecure: true,
      runtime: {
        workspaceImage: "runtime:v1",
        storageSize: "5Gi",
        backendSecret: "backend",
        imagePullPolicy: "IfNotPresent",
      },
      now: () => fixture.now,
      pollMs: 5,
      configAuditMs: 5,
      probe: {
        async run() {
          reprobes++;
          return { entries: ready, fetchedAt: new Date(fixture.now).toISOString() };
        },
        async cleanup() {},
      },
    });
    const release = auditor.watch("example", () => {});
    await new Promise((resolve) => setTimeout(resolve, 15));
    const profile = fixture.store.profileRows.get("claude-default");
    if (!profile) throw new Error("Test profile is unavailable");
    profile.spec.runtime = { image: "runtime:v2" };
    fixture.advance(10);
    await settled(() => reprobes === 1);
    release();
  });
});
