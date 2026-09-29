import { mkdtemp, readFile, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { pruneSnapshots, readAgent, writeSnapshot } from "../docker/retained-history.mjs";
import {
  desiredHistoryReader,
  historyReaderName,
  resourceName,
} from "../src/controller/resources.js";
import type { Backend } from "../src/gateway/backend.js";
import {
  captureRetainedHistory,
  publishRetainedHistoryReceipt,
  type RetainedAgentHistory,
  readRetainedHistoryReceipt,
  retainedHistoryPage,
} from "../src/gateway/retained-history.js";
import { KubernetesStore } from "../src/kubernetes/client.js";
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

describe("retained history snapshots", () => {
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
