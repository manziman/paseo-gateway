import { createServer, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { WSInboundMessageSchema } from "@getpaseo/protocol/messages";
import { WebSocket, WebSocketServer } from "ws";
import type { Workspace } from "../domain.js";
import {
  type GatewayPrincipal,
  principalIsActive,
  type ScopedAuthOptions,
  validateScopedAuth,
} from "./auth.js";
import { allowedRequest, authenticateRequest, handleTokenRequest } from "./auth-http.js";
import { handleDiagnostics } from "./diagnostics-http.js";
import { gatewayRuntime } from "./runtime-status.js";
import { buildServerInfo, type ServerInfoConfig } from "./server-info.js";

export { authorized } from "./auth.js";

import { DirectoryGeneration } from "./catalog.js";
import { DownloadHandles } from "./downloads.js";
import { GatewaySession, type SessionOptions } from "./session.js";
import { WorkspaceLabels } from "./workspace-labels.js";

export interface ServerOptions
  extends Omit<SessionOptions, "hello" | "emit" | "emitBinary" | "disconnect" | "directory"> {
  tls?: { cert: Buffer; key: Buffer };
  host: string;
  port: number;
  password: string;
  serverId: string;
  allowedHosts: string[];
  ready: () => Promise<boolean>;
  scopedAuth?: ScopedAuthOptions;
  advertised?: ServerInfoConfig;
  workspaceLogs?: (workspace: Workspace, tail: number) => Promise<string>;
}

export async function startGateway(options: ServerOptions) {
  const runtime = gatewayRuntime(options.serverId, `${options.host}:${options.port}`);
  buildServerInfo(
    options.serverId,
    options.advertised,
    { kind: "owner" },
    !!options.operations?.creationLifecycle,
    !!options.inventoryStore,
  );
  if (options.scopedAuth) {
    validateScopedAuth(options.scopedAuth);
    if (
      options.scopedAuth.signingKey === options.password ||
      options.scopedAuth.signingKey === options.backendPassword
    )
      throw new Error("Scoped signing key must be separate from owner and backend credentials");
  }
  const principals = new WeakMap<WebSocket, GatewayPrincipal>();
  const directory = new DirectoryGeneration();
  const agentRouting = options.agentRouting;
  const labels = options.inventoryStore
    ? new WorkspaceLabels(options.inventoryStore, options.store, directory)
    : undefined;
  const downloadHandles = new DownloadHandles({
    store: options.store,
    namespace: options.namespace,
    backendPassword: options.backendPassword,
    backendSecure: options.backendSecure,
    allowedHosts: options.allowedHosts,
    scopedAuth: options.scopedAuth,
  });
  const sessions = new Set<GatewaySession>();
  const releaseCollision = agentRouting?.onCollision(() => {
    for (const session of sessions) session.invalidateAgentDirectory();
  });
  const listener: RequestListener = async (request, response) => {
    try {
      if (request.url === "/healthz") {
        response.writeHead(200).end("ok\n");
        return;
      }
      if (request.url === "/readyz") {
        const ready = await options.ready().catch(() => false);
        response.writeHead(ready ? 200 : 503).end(ready ? "ready\n" : "unavailable\n");
        return;
      }
      if (await handleTokenRequest(request, response, options)) return;
      if (await downloadHandles.handle(request, response)) return;
      if (await handleDiagnostics(request, response, options)) return;
      response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
  };
  const server = options.tls
    ? createSecureServer({ ...options.tls, minVersion: "TLSv1.2" }, listener)
    : createServer(listener);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      [...protocols].find((p) => p.startsWith("paseo.bearer.")) ?? false,
  });
  server.on("upgrade", (request, socket, head) => {
    // HTTP stops owning upgraded sockets before asynchronous authentication.
    // A denied or disconnected peer can reset here before ws installs handlers.
    const onSocketError = () => socket.destroy();
    socket.on("error", onSocketError);
    socket.once("close", () => socket.off("error", onSocketError));
    const rejectUpgrade = (status: string) => {
      if (!socket.destroyed && !socket.writableEnded)
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    void (async () => {
      if (request.url !== "/ws" || !allowedRequest(request, options.allowedHosts)) {
        rejectUpgrade("401 Unauthorized");
        return;
      }
      const principal = await authenticateRequest(
        request,
        options.password,
        options.store,
        options.scopedAuth,
      );
      if (socket.destroyed || socket.writableEnded) return;
      if (!principal) {
        rejectUpgrade("401 Unauthorized");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // ws has now installed its own socket error handler.
        socket.off("error", onSocketError);
        principals.set(ws, principal);
        wss.emit("connection", ws);
      });
    })().catch(() => rejectUpgrade("503 Service Unavailable"));
  });
  wss.on("connection", (ws: WebSocket) => {
    const principal = principals.get(ws);
    if (!principal) {
      ws.close(1008, "Authentication required");
      return;
    }
    const expired = () =>
      principal.kind === "workspace" &&
      (principal.expiresAt <= Math.floor(Date.now() / 1000) ||
        !!options.scopedAuth?.revokedTokenIds?.has(principal.tokenId));
    let session: GatewaySession | undefined;
    let lastActivity = Date.now();
    let lease = false;
    let inflight = 0;
    const requestIds = new Set<string>();
    let transferQueue: Promise<void> = Promise.resolve();
    let queuedBinaryBytes = 0;
    const enqueueTransfer = (action: () => Promise<void>, bytes = 0) => {
      if (queuedBinaryBytes + bytes > 64 * 1024 * 1024) {
        ws.close(1009, "Binary transfer queue full");
        return false;
      }
      queuedBinaryBytes += bytes;
      transferQueue = transferQueue.then(action, action).finally(() => {
        queuedBinaryBytes -= bytes;
      });
      void transferQueue.catch(() => ws.close(1008, "Invalid binary routing"));
      return true;
    };
    const send = (data: string | Uint8Array) => {
      if (expired()) {
        ws.close(1008, "Credential expired or revoked");
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount + Buffer.byteLength(data) > 8 * 1024 * 1024) {
        ws.terminate();
        return;
      }
      ws.send(data);
    };
    const helloDeadline = setTimeout(() => ws.close(1008, "Hello required"), 10000);
    const timer = setInterval(() => {
      if (expired()) {
        ws.close(1008, "Credential expired or revoked");
        return;
      }
      if (lease && Date.now() - lastActivity > 45000) ws.terminate();
      if (principal.kind === "workspace")
        void options.store
          .workspaces()
          .then((rows) => {
            if (!principalIsActive(principal, rows)) ws.close(1008, "Credential revoked");
          })
          .catch(() => ws.close(1013, "Authorization state unavailable"));
      void session?.refreshDirectory().catch(() => {});
    }, 10000);
    ws.on("error", () => {
      /* close handles cleanup; never log frames or credentials */
    });
    ws.on("message", (data, binary) => {
      if (expired()) {
        ws.close(1008, "Credential expired or revoked");
        return;
      }
      lastActivity = Date.now();
      if (binary) {
        const currentSession = session;
        if (!currentSession) {
          ws.close(1008, "Hello required");
          return;
        }
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : Buffer.concat(Array.isArray(data) ? data : [data]);
        enqueueTransfer(() => currentSession.binary(bytes), bytes.byteLength);
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
          runtime,
          directory,
          labels,
          agentRouting,
          downloadHandles,
          principal,
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
              payload: buildServerInfo(
                options.serverId,
                options.advertised,
                principal,
                options.operations?.creationLifecycle,
                !!options.inventoryStore,
              ),
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
      const currentSession = session;
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
      const action = () => currentSession.handle(envelope.message);
      const handled =
        envelope.message.type === "file.upload.request"
          ? new Promise<void>(
              (resolve) =>
                enqueueTransfer(async () => {
                  try {
                    await action();
                  } finally {
                    resolve();
                  }
                }) || resolve(),
            )
          : action();
      void handled.finally(() => {
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
      releaseCollision?.();
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...sessions].map((s) => s.close()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
