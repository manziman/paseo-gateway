import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import {
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WSHelloMessage,
  WSOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import WebSocket from "ws";

export interface Backend {
  connect(): Promise<void>;
  request(message: SessionInboundMessage): Promise<SessionOutboundMessage>;
  send(message: SessionInboundMessage): void;
  binary(data: Uint8Array): void;
  close(): Promise<void>;
}

/** Own the exported transport adapter; the SDK supplies hello/liveness, and never replays requests. */
export class PaseoBackend implements Backend {
  private readonly client: DaemonClient;
  private transport?: DaemonTransport;
  private readonly pending = new Map<
    string,
    {
      resolve: (message: SessionOutboundMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();

  constructor(
    url: string,
    password: string,
    hello: WSHelloMessage,
    private readonly onMessage: (message: SessionOutboundMessage) => void,
    private readonly onBinary: (data: Uint8Array) => void,
    private readonly onDisconnect: () => void,
    private readonly timeoutMs = 55000,
  ) {
    const factory = createWebSocketTransportFactory((address, options) => {
      const socket = new WebSocket(address, options?.protocols, {
        headers: options?.headers,
        maxPayload: 8 * 1024 * 1024,
        perMessageDeflate: false,
      });
      // Expose the EventEmitter surface only; ws's browser overloads are narrower than the SDK adapter.
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => {
          if (socket.bufferedAmount > 8 * 1024 * 1024) {
            socket.close(1013, "Workspace backpressure");
            throw new Error("Workspace output buffer full; inspect before retrying a mutation");
          }
          socket.send(data);
        },
        close: (code, reason) => socket.close(code, reason),
        on: (event, listener) => socket.on(event, listener),
        off: (event, listener) => socket.off(event, listener),
      };
    });
    this.client = new DaemonClient({
      url,
      password,
      clientId: randomUUID(),
      clientType: "cli",
      reconnect: { enabled: false },
      connectTimeoutMs: 10000,
      capabilities: hello.capabilities,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      transportFactory: (options) => {
        const transport = factory(options);
        this.transport = transport;
        transport.onMessage((data, binary) => {
          if (binary) {
            if (data instanceof ArrayBuffer) this.onBinary(new Uint8Array(data));
            else if (data instanceof Uint8Array) this.onBinary(data);
            return;
          }
          try {
            const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(String(data)));
            if (!parsed.success || parsed.data.type !== "session") return;
            const message = parsed.data.message;
            const payload = "payload" in message ? message.payload : undefined;
            const id =
              payload && "requestId" in payload && typeof payload.requestId === "string"
                ? payload.requestId
                : undefined;
            const waiter = id ? this.pending.get(id) : undefined;
            if (id && waiter) {
              clearTimeout(waiter.timer);
              this.pending.delete(id);
              if (message.type === "rpc_error") waiter.reject(new Error(message.payload.error));
              else waiter.resolve(message);
            } else this.onMessage(message);
          } catch {
            this.onDisconnect();
          }
        });
        transport.onClose(() => {
          this.transport = undefined;
          this.rejectPending();
          this.onDisconnect();
        });
        return transport;
      },
    });
  }

  connect() {
    return this.client.connect();
  }

  send(message: SessionInboundMessage) {
    if (!this.transport)
      throw new Error("Workspace disconnected; inspect before retrying a mutation");
    this.transport.send(JSON.stringify({ type: "session", message }));
  }

  binary(data: Uint8Array) {
    if (!this.transport) throw new Error("Workspace disconnected");
    this.transport.send(data);
  }

  request(message: SessionInboundMessage): Promise<SessionOutboundMessage> {
    if (!("requestId" in message) || typeof message.requestId !== "string")
      throw new Error("Correlated request required");
    const requestId = message.requestId;
    if (this.pending.has(requestId)) throw new Error("Duplicate in-flight request ID");
    // Upstream wait-for-finish is a long poll: omitted/nonpositive timeouts wait until
    // completion or disconnect. Match the SDK's five-second response grace period.
    const deadline =
      message.type === "wait_for_finish_request"
        ? message.timeoutMs && message.timeoutMs > 0
          ? Math.min(message.timeoutMs + 5000, 2 ** 31 - 1)
          : undefined
        : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer =
        deadline === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(requestId);
              reject(
                new Error(
                  "Workspace response lost or timed out; outcome may be unknown. Inspect before retrying.",
                ),
              );
            }, deadline);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Workspace connection lost; outcome may be unknown. Inspect before retrying."),
      );
    }
    this.pending.clear();
  }

  async close() {
    this.rejectPending();
    await this.client.close();
  }
}
