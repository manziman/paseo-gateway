import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore } from "./fixtures.js";

it("preserves upload request and binary frame order across a slow workspace lookup", async () => {
  const store = new MemoryStore();
  const originalWorkspaces = store.workspaces.bind(store);
  let lookupStarted!: () => void;
  let releaseLookup!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let delayed = false;
  store.workspaces = async () => {
    if (!delayed) {
      delayed = true;
      lookupStarted();
      await hold;
    }
    return originalWorkspaces();
  };
  const password = "test-gateway-password";
  const gateway = await startGateway({
    store,
    namespace: "test",
    backendPassword: password,
    password,
    serverId: "transfer-order",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    ready: async () => true,
  });
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("Gateway port unavailable");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: { authorization: `Bearer ${password}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Upload response timed out")), 3000);
      ws.on("message", (data) => {
        const envelope = JSON.parse(data.toString());
        if (envelope.type !== "session") return;
        if (envelope.message.type === "file.upload.response") {
          clearTimeout(timer);
          resolve(envelope.message);
        }
        if (envelope.message.type === "rpc_error") {
          clearTimeout(timer);
          reject(new Error(envelope.message.payload.error));
        }
      });
      ws.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Socket closed before upload completed"));
      });
    });
    ws.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, clientType: "cli", clientId: "test" }),
    );
    ws.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "file.upload.request",
          requestId: "ordered-upload",
          fileName: "one.txt",
          mimeType: "text/plain",
          size: 1,
          modifiedAt: "now",
        },
      }),
    );
    ws.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "ordered-upload",
        metadata: {
          mime: "text/plain",
          size: 1,
          encoding: "binary",
          modifiedAt: "now",
          fileName: "one.txt",
        },
      }),
    );
    ws.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "ordered-upload",
        payload: new Uint8Array([65]),
      }),
    );
    ws.send(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "ordered-upload" }),
    );
    await started;
    releaseLookup();
    expect(await result).toMatchObject({
      type: "file.upload.response",
      payload: { requestId: "ordered-upload", file: { size: 1 } },
    });
  } finally {
    releaseLookup();
    ws.terminate();
    await gateway.close();
  }
});
