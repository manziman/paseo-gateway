import { mkdtemp, readFile, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { CoreV1Api, KubeConfig, type V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { pruneSnapshots, readAgent, writeSnapshot } from "../docker/retained-history.mjs";
import {
  desiredHistoryReader,
  historyReaderName,
  resourceName,
} from "../src/controller/resources.js";
import { WORKSPACE_UID_LABEL, type Workspace } from "../src/domain.js";
import type { Backend } from "../src/gateway/backend.js";
import {
  captureRetainedHistory,
  publishRetainedHistoryReceipt,
  type RetainedAgentHistory,
  readRetainedHistoryReceipt,
  retainedHistoryPage,
} from "../src/gateway/retained-history.js";
import { KubernetesStore } from "../src/kubernetes/client.js";
import type { Infrastructure } from "../src/kubernetes/store.js";
import { workspace } from "./fixtures.js";
import { MemoryRecordStore } from "./record-store.js";

const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const stamp = "2026-09-25T00:00:00Z";
const entry = (seq: number) => ({
  provider: "claude" as const,
  item: { type: "assistant_message" as const, text: `row ${seq}` },
  timestamp: stamp,
  seqStart: seq,
  seqEnd: seq,
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
  collapsed: [] as [],
});
const history: RetainedAgentHistory = {
  epoch: "epoch-one",
  window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
  entries: [entry(1), entry(2), entry(3)],
  truncated: false,
};
const readerOwner = (row: Workspace) => [
  {
    apiVersion: row.apiVersion,
    kind: row.kind,
    name: row.metadata.name,
    uid: row.metadata.uid ?? "",
    controller: true,
  },
];

describe("retained history snapshots", () => {
  it("never mounts an active workspace as a retained history reader", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.status = { phase: "Ready", message: "running", observedGeneration: 1 };
    const get = vi.spyOn(store, "get");
    const create = vi.spyOn(CoreV1Api.prototype, "createNamespacedPod");
    try {
      await expect(
        store.readRetainedHistory(row, agentId, "image", "receipt.json"),
      ).rejects.toThrow(/storage is unavailable/i);
      expect(get).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      create.mockRestore();
    }
  });
  it("allows an immediate second read after delete ACK while the old reader is terminating", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    let reader: V1Pod | undefined;
    let terminatingReads = 0;
    let creates = 0;
    const get = vi
      .spyOn(store, "get")
      .mockImplementation(async (kind): Promise<Infrastructure | undefined> => {
        if (kind === "PersistentVolumeClaim")
          return { kind, metadata: { uid: "pvc-uid", labels: { [WORKSPACE_UID_LABEL]: uid } } };
        if (kind === "Pod") {
          if (reader?.metadata?.deletionTimestamp && ++terminatingReads === 3) reader = undefined;
          return reader;
        }
        return undefined;
      });
    const workspaces = vi.spyOn(store, "workspaces").mockResolvedValue([row]);
    const create = vi
      .spyOn(CoreV1Api.prototype, "createNamespacedPod")
      .mockImplementation(async () => {
        if (reader) throw new Error("Reader name reused before old Pod disappeared");
        reader = {
          kind: "Pod",
          metadata: {
            uid: `reader-${++creates}`,
            labels: {
              [WORKSPACE_UID_LABEL]: uid,
              "app.kubernetes.io/component": "history-reader",
            },
            ownerReferences: readerOwner(row),
          },
          status: { phase: "Running" },
        };
        return reader;
      });
    const deletion = vi.spyOn(store, "deletePod").mockImplementation(async (_name, expectedUid) => {
      expect(reader?.metadata?.uid).toBe(expectedUid);
      if (!reader?.metadata) throw new Error("Missing reader metadata");
      reader.metadata.deletionTimestamp = new Date();
      terminatingReads = 0;
    });
    Object.assign(store, {
      async execHistory() {
        return Buffer.from(JSON.stringify({ found: false }));
      },
    });
    try {
      expect(await store.readRetainedHistory(row, agentId, "image", "receipt.json")).toEqual({
        found: false,
      });
      expect(await store.readRetainedHistory(row, agentId, "image", "receipt.json")).toEqual({
        found: false,
      });
      expect(creates).toBe(2);
      expect(deletion).toHaveBeenCalledTimes(2);
    } finally {
      get.mockRestore();
      workspaces.mockRestore();
      create.mockRestore();
      deletion.mockRestore();
    }
  });
  it("keeps later reads behind an active reader when an intermediate queued read cancels", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    let reader: V1Pod | undefined;
    let creates = 0;
    let entered!: () => void;
    const firstExec = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const get = vi.spyOn(store, "get").mockImplementation(async (kind) => {
      if (kind === "PersistentVolumeClaim")
        return { kind, metadata: { uid: "pvc-uid", labels: { [WORKSPACE_UID_LABEL]: uid } } };
      if (kind === "Pod") {
        if (reader?.metadata?.deletionTimestamp) reader = undefined;
        return reader;
      }
      return undefined;
    });
    const workspaces = vi.spyOn(store, "workspaces").mockResolvedValue([row]);
    const create = vi
      .spyOn(CoreV1Api.prototype, "createNamespacedPod")
      .mockImplementation(async () => {
        if (reader) throw new Error("Overlapping reader Pods");
        reader = {
          kind: "Pod",
          metadata: {
            uid: `reader-${++creates}`,
            labels: { [WORKSPACE_UID_LABEL]: uid, "app.kubernetes.io/component": "history-reader" },
            ownerReferences: readerOwner(row),
          },
          status: { phase: "Running" },
        };
        return reader;
      });
    const deletion = vi.spyOn(store, "deletePod").mockImplementation(async (_name, expectedUid) => {
      expect(reader?.metadata?.uid).toBe(expectedUid);
      if (!reader?.metadata) throw new Error("Missing reader metadata");
      reader.metadata.deletionTimestamp = new Date();
    });
    let execs = 0;
    Object.assign(store, {
      async execHistory() {
        if (++execs === 1) {
          entered();
          await firstPending;
        }
        return Buffer.from(JSON.stringify({ found: false }));
      },
    });
    try {
      const first = store.readRetainedHistory(row, agentId, "image", "receipt.json");
      await firstExec;
      const cancel = new AbortController();
      const canceled = store.readRetainedHistory(
        row,
        agentId,
        "image",
        "receipt.json",
        Date.now() + 35000,
        cancel.signal,
      );
      cancel.abort();
      await expect(canceled).rejects.toThrow(/closed/i);
      const second = store.readRetainedHistory(row, agentId, "image", "receipt.json");
      let secondSettled = false;
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondSettled).toBe(false);
      expect(creates).toBe(1);
      finish();
      expect(await first).toEqual({ found: false });
      expect(await second).toEqual({ found: false });
      expect(creates).toBe(2);
      expect(deletion).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      get.mockRestore();
      workspaces.mockRestore();
      create.mockRestore();
      deletion.mockRestore();
    }
  });
  it("does not create a reader when the terminating Pod is replaced while waiting", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    let reads = 0;
    const get = vi
      .spyOn(store, "get")
      .mockImplementation(async (kind): Promise<Infrastructure | undefined> => {
        if (kind === "PersistentVolumeClaim")
          return { kind, metadata: { uid: "pvc-uid", labels: { [WORKSPACE_UID_LABEL]: uid } } };
        if (kind === "Pod")
          return {
            kind,
            metadata: {
              uid: `reader-${++reads}`,
              deletionTimestamp: new Date(),
              labels: {
                [WORKSPACE_UID_LABEL]: uid,
                "app.kubernetes.io/component": "history-reader",
              },
              ownerReferences: readerOwner(row),
            },
          };
        return undefined;
      });
    const create = vi.spyOn(CoreV1Api.prototype, "createNamespacedPod").mockResolvedValue({});
    try {
      await expect(
        store.readRetainedHistory(row, agentId, "image", "receipt.json"),
      ).rejects.toThrow(/already active/i);
      expect(reads).toBe(2);
      expect(create).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      create.mockRestore();
    }
  });
  it("does not wait for a label-spoofed reader without the Workspace owner UID", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    const get = vi
      .spyOn(store, "get")
      .mockImplementation(async (kind): Promise<Infrastructure | undefined> => {
        if (kind === "PersistentVolumeClaim")
          return { kind, metadata: { uid: "pvc-uid", labels: { [WORKSPACE_UID_LABEL]: uid } } };
        if (kind === "Pod")
          return {
            kind,
            metadata: {
              uid: "lookalike",
              deletionTimestamp: new Date(),
              labels: {
                [WORKSPACE_UID_LABEL]: uid,
                "app.kubernetes.io/component": "history-reader",
              },
            },
          };
        return undefined;
      });
    const create = vi.spyOn(CoreV1Api.prototype, "createNamespacedPod").mockResolvedValue({});
    try {
      await expect(
        store.readRetainedHistory(row, agentId, "image", "receipt.json"),
      ).rejects.toThrow(/already active/i);
      expect(create).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      create.mockRestore();
    }
  });
  it("does not create a reader if workspace generation changes during the terminating-Pod wait", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    const changed = structuredClone(row);
    changed.metadata.generation = (row.metadata.generation ?? 1) + 1;
    let podReads = 0;
    const get = vi
      .spyOn(store, "get")
      .mockImplementation(async (kind): Promise<Infrastructure | undefined> => {
        if (kind === "PersistentVolumeClaim")
          return { kind, metadata: { uid: "pvc-uid", labels: { [WORKSPACE_UID_LABEL]: uid } } };
        if (kind === "Pod" && ++podReads === 1)
          return {
            kind,
            metadata: {
              uid: "old-reader-uid",
              deletionTimestamp: new Date(),
              labels: {
                [WORKSPACE_UID_LABEL]: uid,
                "app.kubernetes.io/component": "history-reader",
              },
              ownerReferences: readerOwner(row),
            },
          };
        return undefined;
      });
    const workspaces = vi.spyOn(store, "workspaces").mockResolvedValue([changed]);
    const create = vi.spyOn(CoreV1Api.prototype, "createNamespacedPod").mockResolvedValue({});
    try {
      await expect(
        store.readRetainedHistory(row, agentId, "image", "receipt.json"),
      ).rejects.toThrow(/workspace changed before reader creation/i);
      expect(create).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      workspaces.mockRestore();
      create.mockRestore();
    }
  });
  it("never creates a reader after cancellation during the PVC ownership read", async () => {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: "https://kubernetes.invalid" }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const store = new KubernetesStore(config, "test");
    const row = workspace("one");
    row.metadata.uid = uid;
    row.spec.residency = "Suspended";
    row.status = { phase: "Suspended", message: "stopped", observedGeneration: 1 };
    let release!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const get = vi.spyOn(store, "get").mockImplementation(async () => pending as never);
    const create = vi.spyOn(CoreV1Api.prototype, "createNamespacedPod").mockResolvedValue({});
    const signal = new AbortController();
    try {
      const read = store.readRetainedHistory(
        row,
        agentId,
        "image",
        "receipt.json",
        Date.now() + 10000,
        signal.signal,
      );
      signal.abort();
      await expect(read).rejects.toThrow(/closed/i);
      release({ metadata: { labels: { "paseo.dev/workspace-uid": uid } } });
      await Promise.resolve();
      expect(create).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      create.mockRestore();
    }
  });
  it("does not dispatch another native request after the capture deadline", async () => {
    const row = workspace("one");
    row.metadata.uid = uid;
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    let calls = 0;
    const backend: Backend = {
      connect: async () => {},
      close: async () => {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type !== "fetch_agents_request") throw new Error("Unexpected request");
        calls++;
        now.mockReturnValue(start + 60_001);
        return SessionOutboundMessageSchema.parse({
          type: "fetch_agents_response",
          payload: {
            requestId: message.requestId,
            entries: [],
            pageInfo: { nextCursor: "next", prevCursor: null, hasMore: true },
          },
        });
      },
    };
    try {
      await expect(captureRetainedHistory(backend, row)).rejects.toThrow(/deadline/i);
      expect(calls).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
  it("keeps a later generation receipt when an older capture finishes late", async () => {
    const records = new MemoryRecordStore();
    const row = workspace("one");
    row.metadata.uid = uid;
    const base = {
      version: 1 as const,
      workspaceId: "one",
      workspaceUid: uid,
      capturedAt: stamp,
      agents: { [agentId]: history },
    };
    await publishRetainedHistoryReceipt(
      records,
      { ...base, workspaceGeneration: 2 },
      `${uid}-2-1790294400000-cccccccc-cccc-4ccc-8ccc-cccccccccccc.json`,
    );
    await publishRetainedHistoryReceipt(
      records,
      { ...base, workspaceGeneration: 1 },
      `${uid}-1-1790208000000-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json`,
    );
    row.metadata.generation = 2;
    expect((await readRetainedHistoryReceipt(records, row))?.workspaceGeneration).toBe(2);
    row.metadata.generation = 1;
    expect(await readRetainedHistoryReceipt(records, row)).toBeUndefined();
  });
  it("isolates the UID-owned reader with read-only storage and no credential mounts", () => {
    const row = workspace("one");
    row.metadata.uid = uid;
    const pod = desiredHistoryReader(row, "paseo-workspace:test", "test");
    expect(pod.metadata?.name).toBe(historyReaderName(row));
    expect(pod.metadata?.ownerReferences?.[0]?.uid).toBe(uid);
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
    expect(pod.spec?.activeDeadlineSeconds).toBe(90);
    expect(pod.spec?.containers).toHaveLength(1);
    expect(pod.spec?.containers[0]?.env).toEqual([
      { name: "PASEO_RETAINED_HISTORY_ROOT", value: "/history" },
    ]);
    expect(pod.spec?.containers[0]?.volumeMounts).toEqual([
      {
        name: "data",
        mountPath: "/history",
        subPath: "home/.paseo/gateway-history",
        readOnly: true,
      },
    ]);
    expect(pod.spec?.volumes?.[0]?.persistentVolumeClaim).toEqual({
      claimName: resourceName(row),
      readOnly: true,
    });
  });
  it("captures native projected pages without a provider mutation", async () => {
    const row = workspace("one");
    row.metadata.uid = uid;
    const calls: string[] = [];
    const backend: Backend = {
      connect: async () => {},
      close: async () => {},
      send() {},
      binary() {},
      async request(message) {
        calls.push(message.type);
        if (message.type === "fetch_agents_request")
          return SessionOutboundMessageSchema.parse({
            type: "fetch_agents_response",
            payload: {
              requestId: message.requestId,
              entries: [
                {
                  agent: {
                    id: agentId,
                    provider: "claude",
                    cwd: "/workspaces/one",
                    model: null,
                    createdAt: stamp,
                    updatedAt: stamp,
                    lastUserMessageAt: null,
                    status: "closed",
                    capabilities: {
                      supportsStreaming: true,
                      supportsSessionPersistence: true,
                      supportsDynamicModes: false,
                      supportsMcpServers: false,
                      supportsReasoningStream: false,
                      supportsToolInvocations: true,
                    },
                    currentModeId: null,
                    availableModes: [],
                    pendingPermissions: [],
                    persistence: null,
                    labels: {},
                    title: "Retained fixture",
                  },
                  project: {
                    projectKey: "one",
                    projectName: "Example",
                    checkout: {
                      cwd: "/workspaces/one",
                      isGit: false,
                      mainRepoRoot: null,
                      currentBranch: null,
                      remoteUrl: null,
                      isPaseoOwnedWorktree: false,
                    },
                  },
                },
              ],
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        if (message.type === "fetch_agent_timeline_request") {
          const older = message.direction === "before";
          const entries = older ? [entry(1)] : [entry(2), entry(3)];
          return SessionOutboundMessageSchema.parse({
            type: "fetch_agent_timeline_response",
            payload: {
              requestId: message.requestId,
              agentId,
              agent: null,
              direction: message.direction,
              projection: "projected",
              epoch: "epoch-one",
              reset: false,
              staleCursor: false,
              gap: false,
              window: history.window,
              startCursor: { epoch: "epoch-one", seq: entries[0]?.seqStart },
              endCursor: { epoch: "epoch-one", seq: entries.at(-1)?.seqEnd },
              hasOlder: !older,
              hasNewer: false,
              entries,
              error: null,
            },
          });
        }
        throw new Error("Snapshot issued a mutation");
      },
    };
    const captured = await captureRetainedHistory(backend, row);
    expect(captured.workspaceUid).toBe(uid);
    expect(captured.workspaceGeneration).toBe(1);
    expect(captured.agents[agentId]?.entries.map((item) => item.seqStart)).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      "fetch_agents_request",
      "fetch_agent_timeline_request",
      "fetch_agent_timeline_request",
    ]);
    const stableRequest = backend.request.bind(backend);
    backend.request = async (message) => {
      const reply = await stableRequest(message);
      if (
        message.type === "fetch_agent_timeline_request" &&
        message.direction === "before" &&
        reply.type === "fetch_agent_timeline_response"
      )
        return { ...reply, payload: { ...reply.payload, epoch: "next-live-epoch" } };
      return reply;
    };
    const changed = await captureRetainedHistory(backend, row);
    expect(changed.agents[agentId]).toMatchObject({
      truncated: true,
      epoch: "epoch-one",
    });
    expect(changed.agents[agentId]?.entries.map((item) => item.seqStart)).toEqual([2, 3]);
  });

  it("serves bounded before pages and reports a truncated older boundary", () => {
    const tail = retainedHistoryPage(
      {
        type: "fetch_agent_timeline_request",
        requestId: "tail",
        agentId,
        direction: "tail",
        limit: 2,
      },
      null,
      history,
    );
    expect(tail.payload.entries.map((item) => item.seqStart)).toEqual([2, 3]);
    expect(tail.payload.hasOlder).toBe(true);
    const before = retainedHistoryPage(
      {
        type: "fetch_agent_timeline_request",
        requestId: "before",
        agentId,
        direction: "before",
        cursor: { epoch: "epoch-one", seq: 2 },
        limit: 2,
      },
      null,
      history,
    );
    expect(before.payload.entries.map((item) => item.seqStart)).toEqual([1]);
    const truncated = retainedHistoryPage(
      {
        type: "fetch_agent_timeline_request",
        requestId: "old",
        agentId,
        direction: "before",
        cursor: { epoch: "epoch-one", seq: 2 },
      },
      null,
      { ...history, entries: history.entries.slice(1), truncated: true },
    );
    expect(truncated.payload.error).toMatch(/earlier transcript/i);
    expect(truncated.payload.entries).toEqual([]);
  });

  it("publishes immutable generation files and rejects a symlinked source", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "retained-history-"));
    try {
      const snapshot = {
        version: 1,
        workspaceId: "one",
        workspaceUid: uid,
        workspaceGeneration: 1,
        capturedAt: stamp,
        agents: { [agentId]: history },
      };
      const first = await writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot)));
      expect(await readAgent(root, uid, agentId, 1, first)).toMatchObject({ found: true, history });
      for (const invalid of [
        `../${first}`,
        first.replace(uid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
      ]) {
        await expect(readAgent(root, uid, agentId, 1, invalid)).rejects.toThrow(/filename/);
        await expect(pruneSnapshots(root, uid, invalid)).rejects.toThrow(/filename/);
      }
      await expect(readAgent(root, uid, agentId, 2, first)).rejects.toThrow(/filename/);
      const newer = await writeSnapshot(
        root,
        uid,
        Buffer.from(
          JSON.stringify({
            ...snapshot,
            workspaceGeneration: 2,
            agents: {},
          }),
        ),
      );
      const lateOld = await writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot)));
      expect(await readAgent(root, uid, agentId, 2, newer)).toEqual({ found: false });
      expect(await readAgent(root, uid, agentId, 1, lateOld)).toMatchObject({ found: true });
      const outside = join(root, "outside");
      await rm(join(root, first));
      await symlink(outside, join(root, first));
      await expect(readAgent(root, uid, agentId, 1, first)).rejects.toThrow();
      await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("prunes only obsolete captures and caps abandoned snapshots", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "retained-history-"));
    const snapshot = {
      version: 1,
      workspaceId: "one",
      workspaceUid: uid,
      workspaceGeneration: 1,
      capturedAt: stamp,
      agents: { [agentId]: history },
    };
    try {
      const older = await writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot)));
      const committed = await writeSnapshot(
        root,
        uid,
        Buffer.from(JSON.stringify({ ...snapshot, workspaceGeneration: 2 })),
      );
      const future = await writeSnapshot(
        root,
        uid,
        Buffer.from(JSON.stringify({ ...snapshot, workspaceGeneration: 3 })),
      );
      await utimes(join(root, future), new Date(0), new Date(0));
      await pruneSnapshots(root, uid, committed);
      expect(await readAgent(root, uid, agentId, 1, older)).toEqual({ found: false });
      expect(await readAgent(root, uid, agentId, 2, committed)).toMatchObject({ found: true });
      expect(await readAgent(root, uid, agentId, 3, future)).toMatchObject({ found: true });
      for (let i = 0; i < 14; i++)
        await writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot)));
      await expect(writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot)))).rejects.toThrow(
        /file budget/i,
      );
      await pruneSnapshots(root, uid, future);
      await expect(
        writeSnapshot(root, uid, Buffer.from(JSON.stringify(snapshot))),
      ).resolves.toMatch(/\.json$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves aged finalized files without a receipt and fails closed at the file cap", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "retained-history-"));
    const snapshot = {
      version: 1,
      workspaceId: "one",
      workspaceUid: uid,
      workspaceGeneration: 1,
      capturedAt: stamp,
      agents: {},
    };
    const bytes = Buffer.from(JSON.stringify(snapshot));
    try {
      for (let i = 0; i < 16; i++) {
        const name = await writeSnapshot(root, uid, bytes);
        await utimes(join(root, name), new Date(0), new Date(0));
      }
      await expect(writeSnapshot(root, uid, bytes)).rejects.toThrow(/file budget/i);
      await pruneSnapshots(root, uid);
      await expect(writeSnapshot(root, uid, bytes)).rejects.toThrow(/file budget/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("allows the first capture when no history directory or receipt exists", async () => {
    const parent = await mkdtemp(join(await realpath(tmpdir()), "retained-history-"));
    const root = join(parent, "new-history");
    try {
      await expect(pruneSnapshots(root, uid)).resolves.toBeUndefined();
      const name = await writeSnapshot(
        root,
        uid,
        Buffer.from(
          JSON.stringify({
            version: 1,
            workspaceId: "one",
            workspaceUid: uid,
            workspaceGeneration: 1,
            capturedAt: stamp,
            agents: {},
          }),
        ),
      );
      expect(await readAgent(root, uid, agentId, 1, name)).toEqual({ found: false });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
