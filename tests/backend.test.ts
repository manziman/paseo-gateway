import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { PaseoBackend } from "../src/gateway/backend.js";

const backends: PaseoBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
  vi.useRealTimers();
});
function backend() {
  vi.useFakeTimers();
  const connection = new PaseoBackend(
    "ws://127.0.0.1:1/ws",
    "test-password",
    { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
    () => {},
    () => {},
    () => {},
  );
  backends.push(connection);
  const send = vi.spyOn(connection, "send").mockImplementation(() => {});
  return { connection, send };
}

describe("backend request deadlines", () => {
  it("honors a long wait-for-finish deadline instead of the ordinary RPC timeout", async () => {
    const { connection, send } = backend();
    const rejected = vi.fn();
    const result = connection
      .request({
        type: "wait_for_finish_request",
        requestId: "wait",
        agentId: "agent",
        timeoutMs: 180000,
      })
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(55000);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(130000);
    await result;
    expect(rejected).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
  it("keeps ordinary mutation timeouts and never resends them", async () => {
    const { connection, send } = backend();
    const rejected = vi.fn();
    const result = connection
      .request({
        type: "cancel_agent_request",
        requestId: "cancel",
        agentId: "agent",
      })
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(55000);
    await result;
    expect(rejected).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
  it("keeps an unbounded wait pending until connection teardown", async () => {
    const { connection, send } = backend();
    const rejected = vi.fn();
    const result = connection
      .request({
        type: "wait_for_finish_request",
        requestId: "wait",
        agentId: "agent",
      })
      .catch(rejected);
    await vi.advanceTimersByTimeAsync(600000);
    expect(rejected).not.toHaveBeenCalled();
    await connection.close();
    await result;
    expect(rejected).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("backend native hello", () => {
  it("advertises legacy provider events and full snapshots even when the Desktop hello requests modern ownership", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No socket address");
      const hello = new Promise<Record<string, unknown>>((resolve) => {
        server.once("connection", (socket) => {
          socket.once("message", (data) => {
            resolve(JSON.parse(data.toString()));
            socket.close();
          });
        });
      });
      const connection = new PaseoBackend(
        `ws://127.0.0.1:${address.port}/ws`,
        "test-password",
        {
          type: "hello",
          clientId: "desktop",
          clientType: "browser",
          protocolVersion: 1,
          capabilities: {
            owned_subscriptions: true,
            selective_agent_timeline: false,
            explicit_event_subscriptions: true,
            compact_provider_snapshots: true,
            provider_snapshot_references: true,
          },
        },
        () => {},
        () => {},
        () => {},
      );
      backends.push(connection);
      const connecting = connection.connect().catch(() => {});
      const observed = await hello;
      expect(observed.capabilities).toMatchObject({
        owned_subscriptions: false,
        selective_agent_timeline: true,
        explicit_event_subscriptions: false,
        compact_provider_snapshots: false,
        provider_snapshot_references: false,
      });
      await connecting;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
