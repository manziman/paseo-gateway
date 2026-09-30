import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resourceName } from "../controller/resources.js";
import type { Workspace } from "../domain.js";
import type { Store } from "../kubernetes/store.js";
import {
  authorizeWorkspace,
  type GatewayPrincipal,
  principalIsActive,
  type ScopedAuthOptions,
} from "./auth.js";
import { allowedRequest } from "./auth-http.js";

const ttlMs = 60_000;
const maxBytes = 512 * 1024 * 1024;
interface Handle {
  workspaceId: string;
  workspaceUid: string;
  principal: GatewayPrincipal;
  backendToken: string;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  expiresAt: number;
}

/** Single-use gateway capabilities never expose backend tokens or cluster addresses. */
export class DownloadHandles {
  private readonly handles = new Map<string, Handle>();
  private active = 0;
  constructor(
    private readonly options: {
      store: Store;
      namespace: string;
      backendPassword: string;
      backendSecure?: boolean;
      allowedHosts: string[];
      scopedAuth?: ScopedAuthOptions;
      now?: () => number;
      fetch?: typeof fetch;
    },
  ) {}

  issue(input: {
    workspace: Workspace;
    principal: GatewayPrincipal;
    backendToken: string;
    mimeType: string | null;
    fileName: string | null;
    size: number | null;
  }): string {
    if (!input.workspace.metadata.uid || !input.backendToken || input.backendToken.length > 4096)
      throw new Error("Download target is unavailable");
    if (
      input.size !== null &&
      (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > maxBytes)
    )
      throw new Error("Download exceeds gateway transfer limit");
    if (input.mimeType && (input.mimeType.length > 200 || /[\r\n]/.test(input.mimeType)))
      throw new Error("Invalid download MIME type");
    if (input.fileName && (input.fileName.length > 255 || /[/\\\r\n]/.test(input.fileName)))
      throw new Error("Invalid download file name");
    const now = this.options.now?.() ?? Date.now();
    for (const [id, row] of this.handles) if (row.expiresAt <= now) this.handles.delete(id);
    if (this.handles.size >= 1024) throw new Error("Download handle capacity reached");
    const handle = randomUUID();
    this.handles.set(handle, {
      workspaceId: input.workspace.metadata.name,
      workspaceUid: input.workspace.metadata.uid,
      principal: input.principal,
      backendToken: input.backendToken,
      mimeType: input.mimeType,
      fileName: input.fileName,
      size: input.size,
      expiresAt: now + ttlMs,
    });
    return handle;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://gateway.invalid");
    } catch {
      return false;
    }
    if (url.pathname !== "/api/files/download") return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!allowedRequest(request, this.options.allowedHosts)) {
      response.writeHead(401).end();
      return true;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return true;
    }
    const token = url.searchParams.get("token");
    const now = this.options.now?.() ?? Date.now();
    const entry = token ? this.handles.get(token) : undefined;
    if (token) this.handles.delete(token); // Consume before any asynchronous work.
    if (!entry || entry.expiresAt <= now) {
      response.writeHead(403).end("Download handle expired or unknown");
      return true;
    }
    const workspaces = await this.options.store.workspaces();
    const workspace = workspaces.find((row) => row.metadata.name === entry.workspaceId);
    if (
      !workspace ||
      workspace.metadata.uid !== entry.workspaceUid ||
      workspace.metadata.deletionTimestamp ||
      workspace.spec.residency !== "Running" ||
      workspace.status?.phase !== "Ready" ||
      !principalIsActive(entry.principal, workspaces) ||
      !authorizeWorkspace(entry.principal, workspace) ||
      (entry.principal.kind === "workspace" &&
        this.options.scopedAuth?.revokedTokenIds?.has(entry.principal.tokenId))
    ) {
      response.writeHead(403).end("Download target unavailable or access revoked");
      return true;
    }
    if (this.active >= 16) {
      response.writeHead(503).end("Download capacity reached");
      return true;
    }
    this.active++;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
    const revokeCheck = setInterval(() => {
      void this.options.store
        .workspaces()
        .then((rows) => {
          const current = rows.find((row) => row.metadata.name === entry.workspaceId);
          if (
            !current ||
            current.metadata.uid !== entry.workspaceUid ||
            current.spec.residency !== "Running" ||
            current.status?.phase !== "Ready" ||
            !principalIsActive(entry.principal, rows) ||
            (entry.principal.kind === "workspace" &&
              this.options.scopedAuth?.revokedTokenIds?.has(entry.principal.tokenId))
          )
            controller.abort();
        })
        .catch(() => controller.abort());
    }, 1000);
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const protocol = this.options.backendSecure ? "https" : "http";
      const endpoint = new URL(
        `${protocol}://${resourceName(workspace)}.${this.options.namespace}.svc:6767/api/files/download`,
      );
      endpoint.searchParams.set("token", entry.backendToken);
      let upstream: Response;
      try {
        upstream = await (this.options.fetch ?? fetch)(endpoint, {
          headers: { Authorization: `Bearer ${this.options.backendPassword}` },
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        if (!response.headersSent) response.writeHead(502).end("Download backend unavailable");
        return true;
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        response.writeHead(502).end("Download backend rejected transfer");
        return true;
      }
      const rawContentLength = upstream.headers.get("content-length");
      const contentLength = rawContentLength === null ? null : Number(rawContentLength);
      if (
        contentLength !== null &&
        Number.isFinite(contentLength) &&
        (contentLength > maxBytes || (entry.size !== null && contentLength !== entry.size))
      ) {
        await upstream.body.cancel();
        response.writeHead(contentLength > maxBytes ? 413 : 502).end();
        return true;
      }
      const headers: Record<string, string> = {
        "Content-Type": entry.mimeType || "application/octet-stream",
      };
      if (entry.fileName)
        headers["Content-Disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`;
      if (entry.size !== null) headers["Content-Length"] = String(entry.size);
      response.writeHead(200, headers);
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > maxBytes || (entry.size !== null && bytes > entry.size)
              ? new Error("Download transfer limit exceeded")
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(upstream.body, limit, response, { signal: controller.signal });
        if (entry.size !== null && bytes !== entry.size) response.destroy();
      } catch {
        response.destroy();
      }
      return true;
    } finally {
      clearTimeout(deadline);
      clearInterval(revokeCheck);
      this.active--;
    }
  }
}
