import { once } from "node:events";
import WebSocket, { type RawData, WebSocketServer } from "ws";

/** Isolated native-contract fault: lose one acknowledged mutation, never replay it. */
export async function lostAckProxy(target: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 8 * 1024 * 1024 });
  const sockets = new Set<WebSocket>();
  let active:
    | {
        type: string;
        responseType: string;
        requestId?: string;
        connection?: WebSocket;
        count: number;
        dropped: boolean;
        resolve: (payload: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const message = (data: RawData, binary: boolean): Record<string, unknown> | undefined => {
    if (binary) return;
    try {
      const parsed = JSON.parse(data.toString());
      return parsed.type === "session" && typeof parsed.message === "object"
        ? parsed.message
        : undefined;
    } catch {
      return;
    }
  };
  server.on("connection", (front, request) => {
    // The fixture has exactly one fixed destination; a client cannot reroute it.
    const url = new URL(target);
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((part) => part.trim());
    const upstream = new WebSocket(url, protocols, {
      headers: request.headers.authorization
        ? { authorization: request.headers.authorization }
        : {},
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    for (const socket of [front, upstream]) sockets.add(socket);
    const queue: { data: RawData; binary: boolean }[] = [];
    let queuedBytes = 0;
    const stop = () => {
      front.terminate();
      upstream.terminate();
      sockets.delete(front);
      sockets.delete(upstream);
      queue.length = 0;
    };
    front.on("close", stop);
    upstream.on("close", stop);
    front.on("error", stop);
    upstream.on("error", stop);
    upstream.on("open", () => {
      for (const frame of queue) upstream.send(frame.data, { binary: frame.binary });
      queue.length = 0;
      queuedBytes = 0;
    });
    front.on("message", (data, binary) => {
      const frame = message(data, binary);
      if (active && frame?.type === active.type) {
        active.count++;
        if (!active.requestId && typeof frame.requestId === "string") {
          active.requestId = frame.requestId;
          active.connection = front;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING) {
        queuedBytes += Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
        if (queue.length >= 16 || queuedBytes > 1024 * 1024) stop();
        else queue.push({ data, binary });
      }
    });
    upstream.on("message", (data, binary) => {
      const fault = active;
      if (fault?.connection === front && !fault.dropped) {
        const frame = message(data, binary);
        const payload = frame?.payload;
        if (
          frame?.type === fault.responseType &&
          typeof payload === "object" &&
          payload !== null &&
          "requestId" in payload &&
          payload.requestId === fault.requestId
        ) {
          fault.dropped = true;
          clearTimeout(fault.timer);
          fault.resolve(payload as Record<string, unknown>);
          stop();
        }
        // Suppress progress/events too, so no alternative success reaches the caller.
        return;
      }
      if (front.readyState === WebSocket.OPEN) front.send(data, { binary });
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fault proxy did not bind");
  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    arm(type: string, responseType: string) {
      if (active && !active.dropped) throw new Error("A fault is already pending");
      let resolve!: (payload: Record<string, unknown>) => void;
      let reject!: (error: Error) => void;
      const acknowledged = new Promise<Record<string, unknown>>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      active = {
        type,
        responseType,
        count: 0,
        dropped: false,
        resolve,
        reject,
        timer: setTimeout(() => reject(new Error("Native acknowledgement deadline")), 20_000),
      };
      const fault = active;
      return { acknowledged, dispatches: () => fault.count };
    },
    async close() {
      if (active) {
        clearTimeout(active.timer);
        if (!active.dropped) active.reject(new Error("Fault proxy closed"));
      }
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
