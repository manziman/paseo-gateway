import {
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { scopedId } from "../src/domain.js";
import { issueWorkspaceToken, verifyWorkspaceToken } from "../src/gateway/auth.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { startGateway } from "../src/gateway/server.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const password = "0123456789abcdef0123456789abcdef";
const scopedAuth = {
  signingKey: "permission-signing-key-0123456789abcdef",
  audience: "permission-close-test",
  revokedTokenIds: new Set<string>(),
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  scopedAuth.revokedTokenIds.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  config: {
    scoped?: boolean;
    graceMs?: number;
    holdOnRead?: number;
    disconnectOnBackendClose?: boolean;
    backendCloseDelayMs?: number;
    holdSecondBackendConnect?: boolean;
  } = {},
) {
  const store = new MemoryStore();
  const row = workspace("one");
  store.workspaceRows = [row];
  const originalWorkspaces = store.workspaces.bind(store);
  let hold = false;
  let heldReads = 0;
  let reads = 0;
  let releaseRead: (() => void) | undefined;
  let readEntered: (() => void) | undefined;
  let secondReadEntered: (() => void) | undefined;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    readEntered = resolve;
  });
  const secondEntered = new Promise<void>((resolve) => {
    secondReadEntered = resolve;
  });
  store.workspaces = async () => {
    if (hold) {
      reads++;
      if (config.holdOnRead === undefined || reads === config.holdOnRead) {
        heldReads++;
        readEntered?.();
        if (heldReads >= 2) secondReadEntered?.();
        if (config.holdOnRead !== undefined) hold = false;
        await heldRead;
      }
    }
    return originalWorkspaces();
  };
  const forwarded: unknown[] = [];
  const otherMutations: unknown[] = [];
  const backendEvents: ((message: SessionOutboundMessage) => void)[] = [];
  let releaseSecondConnect: (() => void) | undefined;
  let secondConnectEntered: (() => void) | undefined;
  const secondConnectWait = new Promise<void>((resolve) => {
    releaseSecondConnect = resolve;
  });
  const secondConnectStarted = new Promise<void>((resolve) => {
    secondConnectEntered = resolve;
  });
  let backendConnects = 0;
  let backendCloses = 0;
  const gateway = await startGateway({
    store,
    namespace: "test",
    backendPassword: password,
    password,
    serverId: "permission-close-test",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    ready: async () => true,
    scopedAuth: config.scoped ? scopedAuth : undefined,
    permissionCloseGraceMs: config.graceMs,
    backendFactory: (_row, onMessage, _onBinary, onDisconnect) => ({
      async connect() {
        backendConnects++;
        if (config.holdSecondBackendConnect && backendConnects === 2) {
          secondConnectEntered?.();
          await secondConnectWait;
        }
        backendEvents.push(onMessage);
      },
      async close() {
        backendCloses++;
        if (config.backendCloseDelayMs)
          await new Promise((resolve) => setTimeout(resolve, config.backendCloseDelayMs));
        if (config.disconnectOnBackendClose) onDisconnect();
      },
      binary() {},
      send(message) {
        forwarded.push(message);
      },
      async request(message) {
        if (message.type === "send_agent_message_request") {
          otherMutations.push(message);
          throw new Error("Unexpected post-disconnect mutation");
        }
        if (message.type === "open_project_request")
          return SessionOutboundMessageSchema.parse({
            type: "open_project_response",
            payload: {
              requestId: message.requestId,
              workspace: { ...workspaceDescriptor(row, project()), id: "local" },
              error: null,
            },
          });
        if (message.type === "fetch_workspaces_request")
          return SessionOutboundMessageSchema.parse({
            type: "fetch_workspaces_response",
            payload: {
              requestId: message.requestId,
              entries: [],
              emptyProjects: [],
              subscriptionId: null,
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        throw new Error("Unexpected backend request");
      },
    }),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    releaseSecondConnect?.();
    await gateway.close();
  };
  cleanups.push(stop);
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("No listening port");
  const token = config.scoped
    ? issueWorkspaceToken(scopedAuth, {
        projectIds: ["example"],
        credentialProfiles: ["claude-default"],
        originWorkspaceId: "one",
        originWorkspaceUid: row.metadata.uid ?? "",
        ttlSeconds: 3600,
      })
    : password;
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, [`paseo.bearer.${token}`]);
  cleanups.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const helloResponse = new Promise<void>((resolve, reject) => {
    ws.on("message", function onMessage(data) {
      try {
        const packet = JSON.parse(data.toString());
        if (packet.type === "session" && packet.message?.type === "status") {
          ws.off("message", onMessage);
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      clientId: "cli-fixture",
      clientType: "cli",
      protocolVersion: 1,
    }),
  );
  await helloResponse;
  const send = (workspaceName = "one", requestId = "permission-one") => {
    hold = true;
    ws.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "agent_permission_response",
          agentId: scopedId(workspaceName, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          requestId,
          response: { behavior: "deny" },
        },
      }),
    );
  };
  const sendOther = () => {
    ws.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_request",
          requestId: "ordinary-send",
          agentId: scopedId("one", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          text: "synthetic fixture",
          attachments: [],
        },
      }),
    );
  };
  const close = async (code?: number) => {
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close(code);
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return {
    forwarded,
    otherMutations,
    backendEvents,
    backendCounts: () => ({ connects: backendConnects, closes: backendCloses }),
    secondConnectStarted,
    releaseSecondConnect,
    entered,
    secondEntered,
    releaseRead,
    send,
    sendOther,
    close,
    stop,
    token,
    ws,
  };
}

it("delivers a one-way permission denial accepted before the CLI closes, exactly once", async () => {
  const test = await fixture();
  test.send();
  await test.entered;
  await test.close();
  test.releaseRead?.();
  const { forwarded } = test;
  await expect.poll(() => forwarded.length, { timeout: 1000, interval: 10 }).toBe(1);
  expect(forwarded[0]).toMatchObject({
    type: "agent_permission_response",
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    requestId: "permission-one",
    response: { behavior: "deny" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(forwarded).toHaveLength(1);
});

it("drains every distinct accepted decision from CLI --all without replay", async () => {
  const test = await fixture();
  test.send("one", "permission-one");
  await test.entered;
  test.send("one", "permission-two");
  await test.secondEntered;
  await test.close();
  test.releaseRead?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(2);
  expect(test.forwarded).toContainEqual(
    expect.objectContaining({ requestId: "permission-one", response: { behavior: "deny" } }),
  );
  expect(test.forwarded).toContainEqual(
    expect.objectContaining({ requestId: "permission-two", response: { behavior: "deny" } }),
  );
});

it("bounds the drain and cannot send after the grace expires", async () => {
  const test = await fixture({ graceMs: 35 });
  test.send();
  await test.entered;
  await test.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("rechecks a revoked scoped credential during the drain", async () => {
  const test = await fixture({ scoped: true });
  test.send();
  await test.entered;
  await test.close();
  const claims = verifyWorkspaceToken(test.token, scopedAuth);
  if (!claims) throw new Error("Missing scoped claims");
  scopedAuth.revokedTokenIds.add(claims.tokenId);
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("rechecks an expired scoped credential during the drain", async () => {
  const test = await fixture({ scoped: true });
  test.send();
  await test.entered;
  await test.close();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 3_700_000);
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("does not drain an accepted decision after a policy-error close", async () => {
  const test = await fixture();
  test.send();
  await test.entered;
  await test.close(1008);
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("cancels the decision when the gateway initiates an invalid-frame close", async () => {
  const closeSpy = vi.spyOn(GatewaySession.prototype, "close");
  const test = await fixture();
  test.send();
  await test.entered;
  const closed = new Promise<number>((resolve) => test.ws.once("close", resolve));
  test.ws.send("{");
  expect(await closed).toBe(1007);
  await expect.poll(() => closeSpy.mock.calls.length, { timeout: 1000, interval: 10 }).toBe(2);
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("cancels a pending decision on gateway shutdown", async () => {
  const test = await fixture();
  test.send();
  await test.entered;
  await test.stop();
  test.releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(test.forwarded).toHaveLength(0);
});

it("keeps unrelated in-flight mutations canceled while the permission decision drains", async () => {
  const test = await fixture();
  test.send();
  await test.entered;
  test.sendOther();
  await test.secondEntered;
  await test.close();
  test.releaseRead?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(1);
  expect(test.otherMutations).toHaveLength(0);
});

it("still reports a connected client's permission routing error once", async () => {
  const test = await fixture();
  const error = new Promise<unknown>((resolve) => {
    test.ws.on("message", (data) => {
      const packet = JSON.parse(data.toString());
      if (packet.type === "session" && packet.message?.type === "rpc_error")
        resolve(packet.message);
    });
  });
  test.send("missing");
  await test.entered;
  test.releaseRead?.();
  expect(await error).toMatchObject({
    type: "rpc_error",
    payload: { requestType: "agent_permission_response", requestId: "permission-one" },
  });
  expect(test.forwarded).toHaveLength(0);
});

it("releases each settled permission backend and recreates it for a later batch", async () => {
  const test = await fixture({ disconnectOnBackendClose: true });
  test.send("one", "permission-one");
  await test.entered;
  test.releaseRead?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(1);
  await expect.poll(() => test.backendCounts().closes).toBe(1);
  expect(test.backendCounts()).toEqual({ connects: 1, closes: 1 });
  expect(test.ws.readyState).toBe(WebSocket.OPEN);

  test.send("one", "permission-two");
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(2);
  await expect.poll(() => test.backendCounts().closes).toBe(2);
  expect(test.backendCounts()).toEqual({ connects: 2, closes: 2 });
  expect(test.ws.readyState).toBe(WebSocket.OPEN);
  expect(test.forwarded).toContainEqual(
    expect.objectContaining({ requestId: "permission-two", response: { behavior: "deny" } }),
  );
});

it("an old backend close cannot disconnect a newer permission batch", async () => {
  const test = await fixture({
    disconnectOnBackendClose: true,
    backendCloseDelayMs: 80,
    holdSecondBackendConnect: true,
  });
  test.send("one", "permission-one");
  await test.entered;
  test.releaseRead?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(1);
  await expect.poll(() => test.backendCounts().closes).toBe(1);
  test.send("one", "permission-two");
  await test.secondConnectStarted;
  await new Promise((resolve) => setTimeout(resolve, 110));
  expect(test.ws.readyState).toBe(WebSocket.OPEN);
  expect(test.backendCounts()).toEqual({ connects: 2, closes: 1 });
  test.releaseSecondConnect?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(2);
  await expect.poll(() => test.backendCounts().closes).toBe(2);
});

it("does not relay unsolicited backend catalog updates from a pending permission session", async () => {
  const test = await fixture({ holdOnRead: 3 });
  const received: string[] = [];
  test.ws.on("message", (data) => {
    const packet = JSON.parse(data.toString());
    if (packet.type === "session") received.push(packet.message.type);
  });
  test.send();
  await test.entered;
  expect(test.backendCounts().connects).toBe(1);
  test.backendEvents[0]?.(
    SessionOutboundMessageSchema.parse({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/workspaces/one",
        entries: [],
        generatedAt: new Date().toISOString(),
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(received).not.toContain("providers_snapshot_update");
  test.releaseRead?.();
  await expect.poll(() => test.forwarded.length, { timeout: 1000, interval: 10 }).toBe(1);
  await expect.poll(() => test.backendCounts().closes).toBe(1);
});

it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 60_001])(
  "rejects an invalid permission drain deadline %s",
  async (graceMs) => {
    const store = new MemoryStore();
    await expect(
      startGateway({
        store,
        namespace: "test",
        backendPassword: password,
        password,
        serverId: "permission-close-test",
        host: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        ready: async () => true,
        permissionCloseGraceMs: graceMs,
      }),
    ).rejects.toThrow("Permission close grace");
  },
);
