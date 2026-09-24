import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { scopedId } from "../src/domain.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, workspace } from "./fixtures.js";

describe("terminal binary authority", () => {
  it("stops an existing slot when its workspace UID changes", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const emitted: SessionOutboundMessage[] = [];
    let binaryCalls = 0;
    let backendCloses = 0;
    let backendMessage!: (message: SessionOutboundMessage) => void;
    let backendBinary!: (data: Uint8Array) => void;
    let outwardBinaryCalls = 0;
    const backend: Backend = {
      async connect() {},
      async close() {
        backendCloses++;
      },
      send() {},
      binary() {
        binaryCalls++;
      },
      async request(message) {
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
          } as SessionOutboundMessage;
        if (message.type === "subscribe_terminal_request")
          return {
            type: "subscribe_terminal_response",
            payload: {
              requestId: message.requestId,
              terminalId: message.terminalId,
              slot: 7,
              error: null,
            },
          } as SessionOutboundMessage;
        throw new Error("Unexpected backend request");
      },
    };
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: "backend",
      directory: new DirectoryGeneration(),
      hello: { type: "hello", clientType: "cli", clientId: "fixture", protocolVersion: 1 },
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {
        outwardBinaryCalls++;
      },
      disconnect() {},
      backendFactory: (_workspace, onMessage, onBinary) => {
        backendMessage = onMessage;
        backendBinary = onBinary;
        return backend;
      },
    });
    await session.handle({
      type: "subscribe_terminal_request",
      requestId: "subscribe",
      terminalId: scopedId("one", "terminal"),
    });
    const subscribed = emitted.find((message) => message.type === "subscribe_terminal_response");
    if (subscribed?.type !== "subscribe_terminal_response" || !("slot" in subscribed.payload))
      throw new Error("Terminal subscription missing");
    const frame = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      slot: subscribed.payload.slot,
      payload: "pwd\n",
    });
    await session.binary(frame);
    expect(binaryCalls).toBe(1);
    await session.handle({ type: "fetch_workspaces_request", requestId: "watch", subscribe: {} });
    const target = store.workspaceRows[0];
    if (!target) throw new Error("Target workspace missing");
    target.metadata.uid = "replacement";
    await expect(session.binary(frame)).rejects.toThrow("stopped or replaced");
    expect(binaryCalls).toBe(1);
    target.spec.residency = "Archived";
    await session.refreshDirectory();
    expect(backendCloses).toBe(1);
    const emittedBeforeLateFrame = emitted.length;
    backendMessage({ type: "agent_update", payload: {} } as SessionOutboundMessage);
    backendBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        slot: 7,
        payload: "late output",
      }),
    );
    expect(emitted).toHaveLength(emittedBeforeLateFrame);
    expect(outwardBinaryCalls).toBe(0);
    await session.close();
  });
});
