import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WSInboundMessageSchema } from "@getpaseo/protocol/messages";
import { WebSocket, WebSocketServer } from "ws";
import { DirectoryGeneration } from "./catalog.js";
import { GatewaySession, type SessionOptions } from "./session.js";

export interface ServerOptions
  extends Omit<SessionOptions, "hello" | "emit" | "emitBinary" | "disconnect" | "directory"> {
  host: string;
  port: number;
  password: string;
  serverId: string;
  allowedHosts: string[];
  ready: () => Promise<boolean>;
}

/** Match Paseo's direct connection bearer mechanisms, including browser WebSocket subprotocol auth. */
export function authorized(request: Pick<IncomingMessage, "headers">, password: string): boolean {
  const header = request.headers.authorization;
  const protocols =
    request.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()) ?? [];
  const token = header?.startsWith("Bearer ")
    ? header.slice(7)
    : protocols.find((p) => p.startsWith("paseo.bearer."))?.slice(13);
  if (!token) return false;
  return timingSafeEqual(
    createHash("sha256").update(token).digest(),
    createHash("sha256").update(password).digest(),
  );
}

export async function startGateway(options: ServerOptions) {
  const directory = new DirectoryGeneration();
  const sessions = new Set<GatewaySession>();
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok\n");
      return;
    }
    if (request.url === "/readyz") {
      const ready = await options.ready().catch(() => false);
      response.writeHead(ready ? 200 : 503).end(ready ? "ready\n" : "unavailable\n");
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      [...protocols].find((p) => p.startsWith("paseo.bearer.")) ?? false,
  });
  server.on("upgrade", (request, socket, head) => {
    const host = (request.headers.host ?? "").split(":")[0] ?? "";
    const origin = request.headers.origin;
    let originAllowed = !origin;
    try {
      if (origin) originAllowed = options.allowedHosts.includes(new URL(origin).hostname);
    } catch {
      originAllowed = false;
    }
    if (
      request.url !== "/ws" ||
      !options.allowedHosts.includes(host) ||
      !originAllowed ||
      !authorized(request, options.password)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    let session: GatewaySession | undefined;
    let lastActivity = Date.now();
    let lease = false;
    let inflight = 0;
    const requestIds = new Set<string>();
    const send = (data: string | Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount + Buffer.byteLength(data) > 8 * 1024 * 1024) {
        ws.terminate();
        return;
      }
      ws.send(data);
    };
    const helloDeadline = setTimeout(() => ws.close(1008, "Hello required"), 10000);
    const timer = setInterval(() => {
      if (lease && Date.now() - lastActivity > 45000) ws.terminate();
      void session?.refreshDirectory().catch(() => {});
    }, 10000);
    ws.on("error", () => {
      /* close handles cleanup; never log frames or credentials */
    });
    ws.on("message", (data, binary) => {
      lastActivity = Date.now();
      if (binary) {
        if (!session) {
          ws.close(1008, "Hello required");
          return;
        }
        void session
          .binary(
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : Buffer.concat(Array.isArray(data) ? data : [data]),
          )
          .catch(() => ws.close(1008, "Invalid binary routing"));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        ws.close(1007, "Invalid JSON");
        return;
      }
      const parsed = WSInboundMessageSchema.safeParse(raw);
      if (!parsed.success) {
        ws.close(1008, "Invalid protocol message");
        return;
      }
      const envelope = parsed.data;
      if (envelope.type === "hello") {
        if (session || envelope.protocolVersion !== 1) {
          ws.close(1008, "Invalid hello");
          return;
        }
        clearTimeout(helloDeadline);
        session = new GatewaySession({
          ...options,
          directory,
          hello: envelope,
          emit: (message) => send(JSON.stringify({ type: "session", message })),
          emitBinary: send,
          disconnect: () =>
            ws.close(1012, "Workspace disconnected; reconnect and inspect before retrying"),
        });
        sessions.add(session);
        send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: options.serverId,
                hostname: "Paseo Kubernetes",
                version: "0.7.1",
                permissions: [
                  "daemon.read",
                  "workspace.read",
                  "workspace.write",
                  "workspace.manage",
                ],
                capabilities: {
                  voice: {
                    dictation: { enabled: false, reason: "Not supported" },
                    voice: { enabled: false, reason: "Not supported" },
                  },
                },
                features: {
                  providersSnapshot: true,
                  providersSnapshotCwd: true,
                  directorySync: true,
                  workspaceLabels: false,
                },
              },
            },
          }),
        );
        return;
      }
      if (!session) {
        ws.close(1008, "Hello required");
        return;
      }
      if (envelope.type === "ping") {
        lease = true;
        send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (envelope.type !== "session") return;
      const requestId =
        "requestId" in envelope.message && typeof envelope.message.requestId === "string"
          ? envelope.message.requestId
          : undefined;
      if (inflight >= 64 || (requestId && requestIds.has(requestId))) {
        ws.close(1008, "Too many or duplicate in-flight requests");
        return;
      }
      inflight++;
      if (requestId) requestIds.add(requestId);
      void session.handle(envelope.message).finally(() => {
        inflight--;
        if (requestId) requestIds.delete(requestId);
      });
    });
    ws.on("close", () => {
      clearInterval(timer);
      clearTimeout(helloDeadline);
      if (session) {
        sessions.delete(session);
        void session.close();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  return {
    server,
    directory,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...sessions].map((s) => s.close()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
