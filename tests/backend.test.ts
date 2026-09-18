import { afterEach, describe, expect, it, vi } from "vitest";
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
