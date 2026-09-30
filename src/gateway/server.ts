import { randomUUID } from "node:crypto";
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
  /** Time allowed for an accepted, one-way permission response after normal CLI close. */
  permissionCloseGraceMs?: number;
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
  if (
    options.permissionCloseGraceMs !== undefined &&
    (!Number.isSafeInteger(options.permissionCloseGraceMs) ||
      options.permissionCloseGraceMs < 1 ||
      options.permissionCloseGraceMs > 60_000)
  )
    throw new Error("Permission close grace must be 1–60000 milliseconds");
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
  const sessionClosers = new Map<GatewaySession, () => Promise<void>>();
  const trackSession = (current: GatewaySession) => {
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      sessions.delete(current);
      closing = current.close().finally(() => sessionClosers.delete(current));
      return closing;
    };
    sessions.add(current);
    sessionClosers.set(current, close);
    return close;
  };
  const shutdown = new AbortController();
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
    let policyClosing = false;
    const closeForPolicy = (code: number, reason: string) => {
      policyClosing = true;
      ws.close(code, reason);
    };
    const terminateForPolicy = () => {
      policyClosing = true;
      ws.terminate();
    };
    let session: GatewaySession | undefined;
    let initialHello: ConstructorParameters<typeof GatewaySession>[0]["hello"] | undefined;
    let permissionSession: GatewaySession | undefined;
    let closeMain = () => Promise.resolve();
    let closePermission = () => Promise.resolve();
    let lastActivity = Date.now();
    let lease = false;
    let inflight = 0;
    const requestIds = new Set<string>();
    let transferQueue: Promise<void> = Promise.resolve();
    let queuedBinaryBytes = 0;
    const pendingPermissions = new Set<Promise<void>>();
    const enqueueTransfer = (action: () => Promise<void>, bytes = 0) => {
      if (queuedBinaryBytes + bytes > 64 * 1024 * 1024) {
        closeForPolicy(1009, "Binary transfer queue full");
        return false;
      }
      queuedBinaryBytes += bytes;
      transferQueue = transferQueue.then(action, action).finally(() => {
        queuedBinaryBytes -= bytes;
      });
      void transferQueue.catch(() => closeForPolicy(1008, "Invalid binary routing"));
      return true;
    };
    const send = (data: string | Uint8Array) => {
      if (expired()) {
        closeForPolicy(1008, "Credential expired or revoked");
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount + Buffer.byteLength(data) > 8 * 1024 * 1024) {
        terminateForPolicy();
        return;
      }
      ws.send(data);
    };
    const helloDeadline = setTimeout(() => closeForPolicy(1008, "Hello required"), 10000);
    const timer = setInterval(() => {
      if (expired()) {
        closeForPolicy(1008, "Credential expired or revoked");
        return;
      }
      if (lease && Date.now() - lastActivity > 45000) terminateForPolicy();
      if (principal.kind === "workspace")
        void options.store
          .workspaces()
          .then((rows) => {
            if (!principalIsActive(principal, rows)) closeForPolicy(1008, "Credential revoked");
          })
          .catch(() => closeForPolicy(1013, "Authorization state unavailable"));
      void session?.refreshDirectory().catch(() => {});
    }, 10000);
    ws.on("error", () => {
      /* close handles cleanup; never log frames or credentials */
    });
    ws.on("message", (data, binary) => {
      if (expired()) {
        closeForPolicy(1008, "Credential expired or revoked");
        return;
      }
      lastActivity = Date.now();
      if (binary) {
        const currentSession = session;
        if (!currentSession) {
          closeForPolicy(1008, "Hello required");
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
        closeForPolicy(1007, "Invalid JSON");
        return;
      }
      const parsed = WSInboundMessageSchema.safeParse(raw);
      if (!parsed.success) {
        closeForPolicy(1008, "Invalid protocol message");
        return;
      }
      const envelope = parsed.data;
      if (envelope.type === "hello") {
        if (session || envelope.protocolVersion !== 1) {
          closeForPolicy(1008, "Invalid hello");
          return;
        }
        clearTimeout(helloDeadline);
        initialHello = envelope;
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
            closeForPolicy(1012, "Workspace disconnected; reconnect and inspect before retrying"),
        });
        closeMain = trackSession(session);
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
        closeForPolicy(1008, "Hello required");
        return;
      }
      if (envelope.type === "ping") {
        lease = true;
        send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (envelope.type !== "session") return;
      const currentSession = session;
      if (!initialHello) {
        closeForPolicy(1008, "Hello required");
        return;
      }
      const requestId =
        "requestId" in envelope.message && typeof envelope.message.requestId === "string"
          ? envelope.message.requestId
          : undefined;
      if (inflight >= 64 || (requestId && requestIds.has(requestId))) {
        closeForPolicy(1008, "Too many or duplicate in-flight requests");
        return;
      }
      inflight++;
      if (requestId) requestIds.add(requestId);
      const isPermission = envelope.message.type === "agent_permission_response";
      if (isPermission && !permissionSession) {
        // A short-lived CLI closes immediately after this one-way message. Its
        // decision gets its own narrow session so ordinary in-flight work still
        // receives the original immediate-disconnect cancellation.
        const dedicated = new GatewaySession({
          ...options,
          operations: undefined,
          inventoryStore: undefined,
          runtime,
          directory,
          agentRouting,
          downloadHandles,
          principal,
          hello: { ...initialHello, clientId: randomUUID() },
          // The permission connection is only a one-way command path. Native
          // subscriptions on its backend socket must not duplicate desktop
          // timeline/catalog updates; preserve an error while the client lives.
          emit: (message) => {
            if (message.type === "rpc_error") send(JSON.stringify({ type: "session", message }));
          },
          emitBinary: () => {},
          disconnect: () => {
            // Expected close of an idle permission backend must not disconnect
            // the desktop, nor can an old batch retire a newer one.
            if (permissionSession === dedicated)
              closeForPolicy(1012, "Workspace disconnected; reconnect and inspect before retrying");
          },
        });
        permissionSession = dedicated;
        closePermission = trackSession(dedicated);
      }
      const target = isPermission ? permissionSession : currentSession;
      const action = () => {
        if (!target) throw new Error("Permission session unavailable");
        return target.handle(envelope.message);
      };
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
      if (isPermission) pendingPermissions.add(handled);
      const finish = () => {
        inflight--;
        if (requestId) requestIds.delete(requestId);
        if (isPermission) {
          pendingPermissions.delete(handled);
          // The socket can stay open for hours. Release the extra backend
          // subscription after this exact batch, without closing a newer one.
          if (
            !pendingPermissions.size &&
            ws.readyState === WebSocket.OPEN &&
            permissionSession === target
          ) {
            const closeIdlePermission = closePermission;
            permissionSession = undefined;
            closePermission = () => Promise.resolve();
            void closeIdlePermission().catch(() => {});
          }
        }
      };
      void handled.then(finish, finish);
    });
    ws.on("close", (code) => {
      clearInterval(timer);
      clearTimeout(helloDeadline);
      void closeMain().catch(() => {});
      if (!permissionSession) return;
      // The pinned CLI sends a permission decision, then closes without an RPC
      // acknowledgement. Let only already-accepted decisions finish their final
      // authorization reads. Policy/error closes and owner shutdown cancel them.
      if (
        policyClosing ||
        (code !== 1000 && code !== 1005) ||
        !pendingPermissions.size ||
        shutdown.signal.aborted
      ) {
        void closePermission().catch(() => {});
        return;
      }
      const graceMs = options.permissionCloseGraceMs ?? 45_000;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      const interrupted = new Promise<void>((resolve) => {
        stop = () => resolve();
        shutdown.signal.addEventListener("abort", stop, { once: true });
      });
      const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMs);
      });
      void Promise.race([Promise.allSettled([...pendingPermissions]), deadline, interrupted])
        .then(() => closePermission())
        .finally(() => {
          if (timeout) clearTimeout(timeout);
          if (stop) shutdown.signal.removeEventListener("abort", stop);
        })
        .catch(() => {});
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
      shutdown.abort();
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...sessionClosers.values()].map((close) => close()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
