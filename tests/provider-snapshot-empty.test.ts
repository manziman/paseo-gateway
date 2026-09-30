import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore } from "./fixtures.js";

describe("provider snapshot without a ready workspace", () => {
  it("uses the pinned refresh acknowledgement and snapshot shapes", async () => {
    const output: unknown[] = [];
    const session = new GatewaySession({
      store: new MemoryStore(),
      namespace: "test",
      backendPassword: "backend",
      directory: new DirectoryGeneration(),
      hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
      emit: (message) => output.push(message),
      emitBinary() {},
      disconnect() {},
    });
    await session.handle({ type: "refresh_providers_snapshot_request", requestId: "refresh" });
    await session.handle({ type: "get_providers_snapshot_request", requestId: "get" });
    expect(output.map((message) => SessionOutboundMessageSchema.parse(message))).toMatchObject([
      {
        type: "refresh_providers_snapshot_response",
        payload: { requestId: "refresh", acknowledged: true },
      },
      { type: "get_providers_snapshot_response", payload: { requestId: "get", entries: [] } },
    ]);
    await session.close();
  });
});
