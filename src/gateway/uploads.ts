import { randomUUID } from "node:crypto";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  type SessionInboundMessage,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { Backend } from "./backend.js";

type UploadRequest = Extract<SessionInboundMessage, { type: "file.upload.request" }>;
type UploadedFile = NonNullable<
  Extract<SessionOutboundMessage, { type: "file.upload.response" }>["payload"]["file"]
>;
interface Pending {
  request: UploadRequest;
  begun: boolean;
  buffer: Uint8Array;
  bytes: number;
  chunks: number;
  expiresAt: number;
}
interface Staged {
  file: UploadedFile;
  bytes: Uint8Array;
  modifiedAt: string;
  expiresAt: number;
}
const maxFile = 32 * 1024 * 1024;
const maxTotal = 64 * 1024 * 1024;
const maxEntries = 16;
const ttl = 5 * 60_000;
const prefix = "pgw-upload:";

/** An unscoped pinned upload is staged until a later agent operation names its workspace. */
export class UploadStaging {
  private static reservedBytes = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly staged = new Map<string, Staged>();
  private expiryTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly emit: (message: SessionOutboundMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private expire() {
    const now = this.now();
    for (const [id, row] of this.pending)
      if (row.expiresAt <= now) {
        this.pending.delete(id);
        UploadStaging.reservedBytes -= row.request.size;
      }
    for (const [id, row] of this.staged)
      if (row.expiresAt <= now) {
        this.staged.delete(id);
        UploadStaging.reservedBytes -= row.file.size;
      }
    if (!this.pending.size && !this.staged.size && this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }
  private total() {
    return (
      [...this.pending.values()].reduce((n, row) => n + row.request.size, 0) +
      [...this.staged.values()].reduce((n, row) => n + row.file.size, 0)
    );
  }

  begin(request: UploadRequest) {
    this.expire();
    if (this.pending.has(request.requestId)) throw new Error("Duplicate upload request ID");
    if (
      !Number.isSafeInteger(request.size) ||
      request.size < 0 ||
      request.size > maxFile ||
      Buffer.byteLength(request.requestId) > 255 ||
      !request.fileName ||
      request.fileName.length > 255 ||
      /[/\\\r\n]/.test(request.fileName) ||
      !request.mimeType ||
      request.mimeType.length > 200 ||
      /[\r\n]/.test(request.mimeType)
    )
      throw new Error("Upload metadata is invalid or exceeds the gateway limit");
    if (
      this.pending.size + this.staged.size >= maxEntries ||
      this.total() + request.size > maxTotal ||
      UploadStaging.reservedBytes + request.size > maxTotal
    )
      throw new Error("Upload staging capacity reached");
    this.pending.set(request.requestId, {
      request,
      begun: false,
      buffer: new Uint8Array(request.size),
      bytes: 0,
      chunks: 0,
      expiresAt: this.now() + ttl,
    });
    UploadStaging.reservedBytes += request.size;
    this.expiryTimer ??= setInterval(() => this.expire(), 30_000);
    this.expiryTimer.unref();
  }

  binary(bytes: Uint8Array): boolean {
    this.expire();
    const frame = decodeFileTransferFrame(bytes);
    if (!frame) return false;
    const row = this.pending.get(frame.requestId);
    if (!row) throw new Error("Unknown or expired upload transfer");
    if (frame.opcode === FileTransferOpcode.FileBegin) {
      if (
        row.begun ||
        frame.metadata.size !== row.request.size ||
        frame.metadata.mime !== row.request.mimeType ||
        frame.metadata.fileName !== row.request.fileName ||
        frame.metadata.modifiedAt !== row.request.modifiedAt ||
        frame.metadata.encoding !== "binary"
      )
        throw new Error("Upload begin frame does not match request");
      row.begun = true;
      return true;
    }
    if (!row.begun) throw new Error("Upload begin frame required");
    if (frame.opcode === FileTransferOpcode.FileChunk) {
      if (
        frame.payload.byteLength === 0 ||
        frame.payload.byteLength > 256 * 1024 ||
        row.bytes + frame.payload.byteLength > row.request.size ||
        ++row.chunks > Math.ceil(row.request.size / 16_384) + 16
      )
        throw new Error("Upload chunk exceeds declared size");
      row.buffer.set(frame.payload, row.bytes);
      row.bytes += frame.payload.byteLength;
      return true;
    }
    if (frame.opcode !== FileTransferOpcode.FileEnd || row.bytes !== row.request.size)
      throw new Error("Upload ended before declared size");
    this.pending.delete(frame.requestId);
    const id = `${prefix}${randomUUID()}`;
    const file: UploadedFile = {
      type: "uploaded_file",
      id,
      fileName: row.request.fileName,
      mimeType: row.request.mimeType,
      size: row.bytes,
      path: id,
    };
    this.staged.set(id, {
      file,
      bytes: row.buffer,
      modifiedAt: row.request.modifiedAt,
      expiresAt: this.now() + ttl,
    });
    this.emit({
      type: "file.upload.response",
      payload: { requestId: frame.requestId, file, error: null },
    });
    return true;
  }

  /** Consume before backend upload; a lost acknowledgment cannot replay file chunks or prompt. */
  async replace(
    message: SessionInboundMessage,
    backend: Backend,
    validate?: () => Promise<void>,
  ): Promise<SessionInboundMessage> {
    if (!("attachments" in message) || !message.attachments?.length) return message;
    this.expire();
    const attachments: unknown[] = [];
    for (const attachment of message.attachments) {
      if (attachment.type !== "uploaded_file") {
        attachments.push(attachment);
        continue;
      }
      const staged = this.staged.get(attachment.id);
      if (
        !staged ||
        !attachment.id.startsWith(prefix) ||
        attachment.fileName !== staged.file.fileName ||
        attachment.mimeType !== staged.file.mimeType ||
        attachment.size !== staged.file.size ||
        attachment.path !== staged.file.path
      )
        throw new Error("Uploaded file handle expired, unknown, or changed");
      this.staged.delete(attachment.id);
      try {
        await validate?.();
        const requestId = randomUUID();
        const reply = backend.request({
          type: "file.upload.request",
          requestId,
          fileName: staged.file.fileName,
          mimeType: staged.file.mimeType,
          size: staged.file.size,
          modifiedAt: staged.modifiedAt,
        });
        void reply.catch(() => {});
        const send = async (bytes: Uint8Array) => {
          if (backend.binaryPaced) await backend.binaryPaced(bytes);
          else backend.binary(bytes);
        };
        try {
          await send(
            encodeFileTransferFrame({
              opcode: FileTransferOpcode.FileBegin,
              requestId,
              metadata: {
                mime: staged.file.mimeType,
                size: staged.file.size,
                encoding: "binary",
                modifiedAt: staged.modifiedAt,
                fileName: staged.file.fileName,
              },
            }),
          );
          let checkedBytes = 0;
          for (let offset = 0; offset < staged.bytes.length; offset += 256 * 1024) {
            const chunk = staged.bytes.subarray(offset, offset + 256 * 1024);
            if (checkedBytes >= 1024 * 1024) {
              await validate?.();
              checkedBytes = 0;
            }
            await send(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileChunk,
                requestId,
                payload: chunk,
              }),
            );
            checkedBytes += chunk.byteLength;
          }
          await validate?.();
          await send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
        } catch (error) {
          await backend.close();
          throw error;
        }
        const response = await reply;
        if (
          response.type !== "file.upload.response" ||
          !response.payload.file ||
          response.payload.error
        )
          throw new Error("Workspace upload failed; inspect before retrying");
        attachments.push(response.payload.file);
      } finally {
        UploadStaging.reservedBytes -= staged.file.size;
      }
    }
    return SessionInboundMessageSchema.parse({ ...message, attachments });
  }

  clear() {
    for (const row of this.pending.values()) UploadStaging.reservedBytes -= row.request.size;
    for (const row of this.staged.values()) UploadStaging.reservedBytes -= row.file.size;
    this.pending.clear();
    this.staged.clear();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
