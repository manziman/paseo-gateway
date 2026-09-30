import { randomUUID } from "node:crypto";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { issueWorkspaceToken, verifyWorkspaceToken } from "../src/gateway/auth.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { buildServerInfo } from "../src/gateway/server-info.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, workspace } from "./fixtures.js";

const auth = { signingKey: "file-edit-signing-key-0123456789abcdef", audience: "file-edit-host" };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Desktop workspace file editing", () => {
  it("advertises editing for owner and scoped workspace callers", () => {
    const scoped = verifyWorkspaceToken(
      issueWorkspaceToken(auth, {
        projectIds: ["example"],
        credentialProfiles: ["claude-default"],
        originWorkspaceId: "one",
        originWorkspaceUid: "uid-one",
        ttlSeconds: 3600,
      }),
      auth,
    );
    if (!scoped) throw new Error("Missing scoped principal");
    expect(buildServerInfo("host").features?.workspaceFileEditing).toBe(true);
    expect(buildServerInfo("host", {}, scoped).features?.workspaceFileEditing).toBe(true);
  });

  it("routes subscription, change, versioned write and release only to the authorized Pod", async () => {
    const store = new MemoryStore();
    const one = workspace("one");
    const two = workspace("two");
    two.spec.credentialProfile = "different-profile";
    store.workspaceRows = [one, two];
    const scoped = verifyWorkspaceToken(
      issueWorkspaceToken(auth, {
        projectIds: ["example"],
        credentialProfiles: ["claude-default"],
        originWorkspaceId: "one",
        originWorkspaceUid: "uid-one",
        ttlSeconds: 3600,
      }),
      auth,
    );
    if (!scoped) throw new Error("Missing scoped principal");
    const emitted: SessionOutboundMessage[] = [];
    const received = new Map<string, SessionInboundMessage[]>();
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: "backend",
      directory: new DirectoryGeneration(),
      principal: scoped,
      scopedAuth: auth,
      hello: { type: "hello", clientType: "browser", clientId: "file-editor", protocolVersion: 1 },
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {},
      disconnect() {},
      backendFactory: (row, onMessage): Backend => {
        received.set(row.metadata.name, []);
        return {
          async connect() {},
          async close() {},
          send() {},
          binary() {},
          async request(message) {
            received.get(row.metadata.name)?.push(message);
            if (message.type === "open_project_request")
              return {
                type: "open_project_response",
                payload: { workspace: { id: "local" } },
              } as SessionOutboundMessage;
            if (message.type === "fetch_workspaces_request")
              return {
                type: "fetch_workspaces_response",
                payload: {
                  requestId: message.requestId,
                  entries: [],
                  emptyProjects: [],
                  pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
                },
              };
            if (message.type === "fs.file.subscribe.request")
              return {
                type: "fs.file.subscribe.response",
                payload: {
                  requestId: message.requestId,
                  subscriptionId: message.subscriptionId ?? "file-sub",
                  initial: {
                    status: "ready",
                    cwd: message.cwd,
                    path: message.path,
                    size: 3,
                    modifiedAt: "before",
                    revision: "one",
                  },
                },
              };
            if (message.type === "fs.file.write.request") {
              onMessage({
                type: "fs.file.update",
                payload: {
                  subscriptionId: "file-sub",
                  version: {
                    status: "ready",
                    cwd: message.cwd,
                    path: message.path,
                    size: message.content.length,
                    modifiedAt: "after",
                    revision: "two",
                  },
                },
              });
              return {
                type: "fs.file.write.response",
                payload: {
                  requestId: message.requestId,
                  result: {
                    status: "written",
                    modifiedAt: "after",
                    size: message.content.length,
                    revision: "two",
                  },
                },
              };
            }
            if (message.type === "fs.file.unsubscribe.request")
              return {
                type: "fs.file.unsubscribe.response",
                payload: { requestId: message.requestId, subscriptionId: message.subscriptionId },
              };
            throw new Error(`Unexpected ${message.type}`);
          },
        };
      },
    });
    try {
      await session.handle({
        type: "fs.file.subscribe.request",
        cwd: "/workspaces/one",
        path: "note.txt",
        subscriptionId: "file-sub",
        requestId: "subscribe",
      });
      expect(emitted.map((row) => row.type)).toContain("fs.file.subscribe.response");
      expect(emitted.find((row) => row.type === "fs.file.subscribe.response")).toMatchObject({
        payload: { initial: { status: "ready", cwd: "/workspaces/one" } },
      });
      await session.handle({
        type: "fs.file.write.request",
        cwd: "/workspaces/one",
        path: "note.txt",
        content: "new",
        expectedModifiedAt: "before",
        expectedRevision: "one",
        requestId: "write",
      });
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(1);
      expect(emitted.find((row) => row.type === "fs.file.write.response")).toMatchObject({
        payload: { result: { status: "written" } },
      });
      await session.handle({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "file-sub",
        requestId: "unsubscribe",
      });
      expect(received.get("one")?.map((row) => row.type)).toContain("fs.file.unsubscribe.request");
      const oneWrites =
        received.get("one")?.filter((row) => row.type === "fs.file.write.request").length ?? 0;
      await session.handle({
        type: "fs.file.write.request",
        cwd: "/workspaces/two",
        path: "note.txt",
        content: "cross-role",
        expectedModifiedAt: "before",
        requestId: "denied",
      });
      expect(
        emitted.find((row) => row.type === "rpc_error" && row.payload.requestId === "denied"),
      ).toBeDefined();
      expect(received.has("two")).toBe(false);
      expect(
        received.get("one")?.filter((row) => row.type === "fs.file.write.request"),
      ).toHaveLength(oneWrites);
      const replaced = store.workspaceRows[0];
      if (!replaced) throw new Error("Missing first workspace");
      replaced.metadata.uid = randomUUID();
      await session.handle({
        type: "fs.file.write.request",
        cwd: "/workspaces/one",
        path: "note.txt",
        content: "stale",
        expectedModifiedAt: "after",
        requestId: "replaced",
      });
      expect(
        emitted.find((row) => row.type === "rpc_error" && row.payload.requestId === "replaced"),
      ).toBeDefined();
      expect(
        received.get("one")?.filter((row) => row.type === "fs.file.write.request"),
      ).toHaveLength(oneWrites);
    } finally {
      await session.close();
    }
  });

  it("keeps two owner Pod subscriptions distinct and ignores updates after release", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace("one"), workspace("two")];
    const emitted: SessionOutboundMessage[] = [];
    const received = new Map<string, SessionInboundMessage[]>();
    const pushes = new Map<string, (message: SessionOutboundMessage) => void>();
    const firstSubscribeStarted = deferred();
    const releaseFirstSubscribe = deferred();
    const updateReadStarted = deferred();
    const releaseUpdateRead = deferred();
    let pauseFirstSubscribe = true;
    let pauseNextRead = false;
    const originalWorkspaces = store.workspaces.bind(store);
    store.workspaces = async () => {
      if (pauseNextRead) {
        pauseNextRead = false;
        updateReadStarted.resolve();
        await releaseUpdateRead.promise;
      }
      return originalWorkspaces();
    };
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: "backend",
      directory: new DirectoryGeneration(),
      hello: {
        type: "hello",
        clientType: "browser",
        clientId: "owner-file-editor",
        protocolVersion: 1,
      },
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {},
      disconnect() {},
      backendFactory: (row, onMessage): Backend => {
        const id = row.metadata.name;
        received.set(id, []);
        pushes.set(id, onMessage);
        return {
          async connect() {},
          async close() {},
          send() {},
          binary() {},
          async request(message) {
            received.get(id)?.push(message);
            if (message.type === "open_project_request")
              return {
                type: "open_project_response",
                payload: { workspace: { id: `local-${id}` } },
              } as SessionOutboundMessage;
            if (message.type === "fetch_workspaces_request")
              return {
                type: "fetch_workspaces_response",
                payload: {
                  requestId: message.requestId,
                  entries: [],
                  emptyProjects: [],
                  pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
                },
              };
            if (message.type === "subscribe_checkout_diff_request")
              return {
                type: "subscribe_checkout_diff_response",
                payload: {
                  requestId: message.requestId,
                  subscriptionId: message.subscriptionId ?? "generated-diff",
                  cwd: message.cwd,
                  files: [],
                  error: null,
                },
              };
            if (message.type === "fs.file.subscribe.request") {
              if (id === "one" && message.subscriptionId === "shared" && pauseFirstSubscribe) {
                pauseFirstSubscribe = false;
                firstSubscribeStarted.resolve();
                await releaseFirstSubscribe.promise;
              }
              if (id === "one" && message.subscriptionId === "race-first") {
                onMessage({
                  type: "fs.file.update",
                  payload: {
                    subscriptionId: "race-first",
                    version: { status: "missing", cwd: message.cwd, path: "note.txt" },
                  },
                });
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              return {
                type: "fs.file.subscribe.response",
                payload: {
                  requestId: message.requestId,
                  subscriptionId: message.subscriptionId?.trim() || `generated-${id}`,
                  initial:
                    message.path === "missing.txt"
                      ? {
                          status: "error",
                          cwd: message.cwd,
                          path: message.path,
                          error: "not found",
                        }
                      : {
                          status: "ready",
                          cwd: message.cwd,
                          path: message.path,
                          size: 1,
                          modifiedAt: "now",
                        },
                },
              };
            }
            if (message.type === "fs.file.unsubscribe.request")
              return {
                type: "fs.file.unsubscribe.response",
                payload: { requestId: message.requestId, subscriptionId: message.subscriptionId },
              };
            throw new Error(`Unexpected ${message.type}`);
          },
        };
      },
    });
    const subscribe = (
      cwd: string,
      requestId: string,
      subscriptionId?: string,
      path = "note.txt",
    ) =>
      session.handle({
        type: "fs.file.subscribe.request",
        cwd,
        path,
        ...(subscriptionId !== undefined ? { subscriptionId } : {}),
        requestId,
      });
    const update = (id: string, subscriptionId: string) => {
      const push = pushes.get(id);
      if (!push) throw new Error("Missing Pod event callback");
      push({
        type: "fs.file.update",
        payload: {
          subscriptionId,
          version: { status: "missing", cwd: `/workspaces/${id}`, path: "note.txt" },
        },
      });
    };
    try {
      const pendingOne = subscribe("/workspaces/one", "sub-one", "shared");
      await firstSubscribeStarted.promise;
      await subscribe("/workspaces/two", "collision", "shared");
      expect(
        emitted.find((row) => row.type === "rpc_error" && row.payload.requestId === "collision"),
      ).toBeDefined();
      expect(received.get("two")?.some((row) => row.type === "fs.file.subscribe.request")).toBe(
        false,
      );
      releaseFirstSubscribe.resolve();
      await pendingOne;
      update("one", "shared");
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(1);
      await session.handle({
        type: "subscribe_checkout_diff_request",
        cwd: "/workspaces/two",
        subscriptionId: "shared",
        compare: { mode: "uncommitted" },
        requestId: "other-family",
      });
      expect(
        received.get("two")?.some((row) => row.type === "subscribe_checkout_diff_request"),
      ).toBe(true);
      await subscribe("/workspaces/one", "renew", "shared");
      expect(
        emitted.find(
          (row) => row.type === "fs.file.subscribe.response" && row.payload.requestId === "renew",
        ),
      ).toBeDefined();
      update("one", "shared");
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(2);
      pauseNextRead = true;
      update("one", "shared");
      await updateReadStarted.promise;
      const pendingRelease = session.handle({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "shared",
        requestId: "unsub-one",
      });
      await expect
        .poll(
          () =>
            received.get("one")?.filter((row) => row.type === "fs.file.unsubscribe.request").length,
        )
        .toBe(1);
      releaseUpdateRead.resolve();
      await pendingRelease;
      expect(emitted.filter((row) => row.type === "fs.file.update")).toHaveLength(2);
      expect(received.get("one")?.some((row) => row.type === "fs.file.unsubscribe.request")).toBe(
        true,
      );
      update("one", "shared");
      await subscribe("/workspaces/two", "sub-two", "shared");
      expect(
        emitted.find(
          (row) => row.type === "fs.file.subscribe.response" && row.payload.requestId === "sub-two",
        ),
      ).toBeDefined();
      update("one", "shared");
      update("two", "shared");
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(3);
      const updates = emitted.filter((row) => row.type === "fs.file.update");
      expect(updates[0]?.payload.version.cwd).toBe("/workspaces/one");
      expect(updates[2]?.payload.version.cwd).toBe("/workspaces/two");
      await subscribe("/workspaces/one", "generated");
      const generated = emitted.find(
        (row) => row.type === "fs.file.subscribe.response" && row.payload.requestId === "generated",
      );
      if (generated?.type !== "fs.file.subscribe.response")
        throw new Error("Missing generated subscription");
      expect(generated.payload.subscriptionId).toMatch(/^[0-9a-f-]{36}$/i);
      update("one", generated.payload.subscriptionId);
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(4);
      await session.handle({
        type: "fs.file.unsubscribe.request",
        subscriptionId: generated.payload.subscriptionId,
        requestId: "unsub-generated",
      });
      expect(
        received
          .get("one")
          ?.some(
            (row) =>
              row.type === "fs.file.unsubscribe.request" &&
              row.subscriptionId === generated.payload.subscriptionId,
          ),
      ).toBe(true);
      const nativeReleases =
        received.get("one")?.filter((row) => row.type === "fs.file.unsubscribe.request").length ??
        0;
      await session.handle({
        type: "fs.file.unsubscribe.request",
        subscriptionId: generated.payload.subscriptionId,
        requestId: "unsub-repeat",
      });
      expect(
        emitted.find(
          (row) =>
            row.type === "fs.file.unsubscribe.response" && row.payload.requestId === "unsub-repeat",
        ),
      ).toBeDefined();
      expect(
        received.get("one")?.filter((row) => row.type === "fs.file.unsubscribe.request"),
      ).toHaveLength(nativeReleases);
      await subscribe("/workspaces/one", "trimmed", "  file-sub  ", "/workspaces/one/note.txt");
      const trimmed = emitted.find(
        (row) => row.type === "fs.file.subscribe.response" && row.payload.requestId === "trimmed",
      );
      expect(
        trimmed?.type === "fs.file.subscribe.response" ? trimmed.payload.subscriptionId : undefined,
      ).toBe("file-sub");
      update("one", "file-sub");
      await expect
        .poll(() => emitted.filter((row) => row.type === "fs.file.update").length)
        .toBe(5);
      await session.handle({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "file-sub",
        requestId: "unsub-trimmed",
      });
      await subscribe("/workspaces/one", "empty-id", "");
      const emptyId = emitted.find(
        (row) => row.type === "fs.file.subscribe.response" && row.payload.requestId === "empty-id",
      );
      expect(
        emptyId?.type === "fs.file.subscribe.response" ? emptyId.payload.subscriptionId : undefined,
      ).toMatch(/^[0-9a-f-]{36}$/i);
      const priorSubscribes =
        received.get("one")?.filter((row) => row.type === "fs.file.subscribe.request").length ?? 0;
      await subscribe("/workspaces/one", "traversal", "traversal-id", "../two/note.txt");
      expect(
        emitted.find((row) => row.type === "rpc_error" && row.payload.requestId === "traversal"),
      ).toBeDefined();
      expect(
        received.get("one")?.filter((row) => row.type === "fs.file.subscribe.request"),
      ).toHaveLength(priorSubscribes);
      await subscribe("/workspaces/one", "error-initial", "error-id", "missing.txt");
      expect(
        emitted.find(
          (row) =>
            row.type === "fs.file.subscribe.response" && row.payload.requestId === "error-initial",
        ),
      ).toMatchObject({ payload: { initial: { status: "error" } } });
      await subscribe("/workspaces/two", "reuse-after-error", "error-id");
      expect(
        emitted.find(
          (row) =>
            row.type === "fs.file.subscribe.response" &&
            row.payload.requestId === "reuse-after-error",
        ),
      ).toBeDefined();
      await subscribe("/workspaces/one", "first-race", "race-first");
      const raceAck = emitted.findIndex(
        (row) =>
          row.type === "fs.file.subscribe.response" && row.payload.requestId === "first-race",
      );
      const raceUpdate = emitted.findIndex(
        (row) => row.type === "fs.file.update" && row.payload.subscriptionId === "race-first",
      );
      expect(raceAck).toBeGreaterThanOrEqual(0);
      expect(raceUpdate).toBeGreaterThan(raceAck);
    } finally {
      releaseFirstSubscribe.resolve();
      releaseUpdateRead.resolve();
      await session.close();
    }
  });
});
