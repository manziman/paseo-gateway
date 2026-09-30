import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { scopedId } from "../src/domain.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { UploadStaging } from "../src/gateway/uploads.js";
import { MemoryStore, workspace } from "./fixtures.js";

describe("late-bound file uploads", () => {
  it("stages pinned unscoped frames, then uploads only on an explicit agent operation", async () => {
    const replies: SessionOutboundMessage[] = [];
    const staging = new UploadStaging((reply) => replies.push(reply));
    const upload = SessionInboundMessageSchema.parse({
      type: "file.upload.request",
      requestId: "upload-1",
      fileName: "same.txt",
      mimeType: "text/plain",
      size: 4,
      modifiedAt: "2026-09-24T00:00:00Z",
    });
    if (upload.type !== "file.upload.request") throw new Error("Invalid fixture");
    staging.begin(upload);
    staging.binary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: upload.requestId,
        metadata: {
          mime: upload.mimeType,
          size: 4,
          encoding: "binary",
          modifiedAt: upload.modifiedAt,
          fileName: upload.fileName,
        },
      }),
    );
    staging.binary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: upload.requestId,
        payload: new Uint8Array([0, 1, 2, 255]),
      }),
    );
    staging.binary(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: upload.requestId }),
    );
    const synthetic = replies[0];
    expect(synthetic).toMatchObject({
      type: "file.upload.response",
      payload: { file: { size: 4 } },
    });
    if (synthetic?.type !== "file.upload.response" || !synthetic.payload.file)
      throw new Error("No upload response");
    const seen: number[] = [];
    let finish!: (reply: SessionOutboundMessage) => void;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      request: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      binary(data) {
        const frame = decodeFileTransferFrame(data);
        if (frame?.opcode === FileTransferOpcode.FileChunk) seen.push(...frame.payload);
        if (frame?.opcode === FileTransferOpcode.FileEnd)
          finish({
            type: "file.upload.response",
            payload: {
              requestId: frame.requestId,
              file: {
                type: "uploaded_file",
                id: "backend-file",
                fileName: "same.txt",
                mimeType: "text/plain",
                size: 4,
                path: "/workspaces/one/same.txt",
              },
              error: null,
            },
          });
      },
    };
    const message = SessionInboundMessageSchema.parse({
      type: "send_agent_message_request",
      requestId: "send",
      agentId: "one~YWdlbnQ",
      text: "Review this",
      attachments: [synthetic.payload.file],
    });
    const bound = await staging.replace(message, backend);
    expect(seen).toEqual([0, 1, 2, 255]);
    expect(bound).toMatchObject({ attachments: [{ id: "backend-file" }] });
    await expect(staging.replace(message, backend)).rejects.toThrow("expired, unknown");
  });

  it("rejects oversized uploads and mismatched binary metadata", () => {
    const staging = new UploadStaging(() => {});
    const oversized = SessionInboundMessageSchema.parse({
      type: "file.upload.request",
      requestId: "large",
      fileName: "a.bin",
      mimeType: "application/octet-stream",
      size: 32 * 1024 * 1024 + 1,
      modifiedAt: "now",
    });
    if (oversized.type !== "file.upload.request") throw new Error("Invalid fixture");
    expect(() => staging.begin(oversized)).toThrow("exceeds");
    staging.begin({ ...oversized, size: 1 });
    expect(() =>
      staging.binary(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileBegin,
          requestId: "large",
          metadata: {
            mime: "wrong",
            size: 1,
            encoding: "binary",
            modifiedAt: "now",
            fileName: "a.bin",
          },
        }),
      ),
    ).toThrow("does not match");
    staging.clear();
  });

  it("rejects zero-byte and excessive tiny frames without allocating per-frame payloads", () => {
    const staging = new UploadStaging(() => {});
    const request = SessionInboundMessageSchema.parse({
      type: "file.upload.request",
      requestId: "tiny-frames",
      fileName: "tiny.bin",
      mimeType: "application/octet-stream",
      size: 1000,
      modifiedAt: "now",
    });
    if (request.type !== "file.upload.request") throw new Error("Invalid fixture");
    staging.begin(request);
    staging.binary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: request.requestId,
        metadata: {
          mime: request.mimeType,
          size: request.size,
          encoding: "binary",
          modifiedAt: request.modifiedAt,
          fileName: request.fileName,
        },
      }),
    );
    const chunk = (payload: Uint8Array) =>
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: request.requestId,
        payload,
      });
    expect(() => staging.binary(chunk(new Uint8Array()))).toThrow("chunk exceeds");
    for (let index = 0; index < 17; index++)
      expect(staging.binary(chunk(new Uint8Array([1])))).toBe(true);
    expect(() => staging.binary(chunk(new Uint8Array([1])))).toThrow("chunk exceeds");
    staging.clear();
  });

  it("never sends an attached prompt after the workspace stops during backend upload", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const emitted: SessionOutboundMessage[] = [];
    let promptCalls = 0;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
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
        if (message.type === "file.upload.request") return new Promise(() => {});
        if (message.type === "send_agent_message_request") promptCalls++;
        throw new Error("Unexpected backend request");
      },
      binary(data) {
        const frame = decodeFileTransferFrame(data);
        if (frame?.opcode === FileTransferOpcode.FileChunk) {
          const target = store.workspaceRows[0];
          if (!target) throw new Error("Missing target workspace");
          target.spec.residency = "Archived";
        }
      },
    };
    const session = new GatewaySession({
      store,
      namespace: "test",
      backendPassword: "backend",
      directory: new DirectoryGeneration(),
      hello: { type: "hello", clientType: "cli", clientId: "fixture", protocolVersion: 1 },
      emit: (message) => emitted.push(message as SessionOutboundMessage),
      emitBinary() {},
      disconnect() {},
      backendFactory: () => backend,
    });
    const request = {
      type: "file.upload.request" as const,
      requestId: "upload",
      fileName: "a.txt",
      mimeType: "text/plain",
      size: 1,
      modifiedAt: "now",
    };
    await session.handle(request);
    await session.binary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "upload",
        metadata: {
          mime: "text/plain",
          size: 1,
          encoding: "binary",
          modifiedAt: "now",
          fileName: "a.txt",
        },
      }),
    );
    await session.binary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "upload",
        payload: new Uint8Array([7]),
      }),
    );
    await session.binary(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "upload" }),
    );
    const uploaded = emitted.find((message) => message.type === "file.upload.response");
    if (uploaded?.type !== "file.upload.response" || !uploaded.payload.file)
      throw new Error("No staged upload");
    // Restore readiness for routing, then let the backend upload stop the workspace.
    const target = store.workspaceRows[0];
    if (!target) throw new Error("Missing target workspace");
    target.spec.residency = "Running";
    await session.handle({
      type: "send_agent_message_request",
      requestId: "send",
      agentId: scopedId("one", "agent"),
      text: "Use this",
      attachments: [uploaded.payload.file],
    });
    expect(promptCalls).toBe(0);
    expect(emitted.some((message) => message.type === "rpc_error")).toBe(true);
    await session.close();
  });
});
