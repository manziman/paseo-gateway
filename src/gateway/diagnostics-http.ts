import type { IncomingMessage, ServerResponse } from "node:http";
import type { Workspace } from "../domain.js";
import type { Store } from "../kubernetes/store.js";
import { authorizeWorkspace, type ScopedAuthOptions } from "./auth.js";
import { allowedRequest, authenticateRequest } from "./auth-http.js";

/** Bounded owner/role-scoped diagnostic access. Log bodies are never written to gateway logs. */
export async function handleDiagnostics(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    password: string;
    store: Store;
    allowedHosts: string[];
    scopedAuth?: ScopedAuthOptions;
    workspaceLogs?: (workspace: Workspace, tail: number) => Promise<string>;
  },
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://gateway.invalid");
  } catch {
    response.writeHead(400).end();
    return true;
  }
  const match = /^\/workspaces\/([a-z0-9-]+)\/(status|logs)$/.exec(url.pathname);
  if (!match) return false;
  response.setHeader("Cache-Control", "no-store");
  if (!allowedRequest(request, options.allowedHosts)) {
    response.writeHead(401).end();
    return true;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end();
    return true;
  }
  try {
    const principal = await authenticateRequest(
      request,
      options.password,
      options.store,
      options.scopedAuth,
    );
    if (!principal) {
      response.writeHead(401).end();
      return true;
    }
    const workspace = (await options.store.workspaces()).find(
      (row) => row.metadata.name === match[1],
    );
    if (!workspace || !authorizeWorkspace(principal, workspace)) {
      response.writeHead(404).end();
      return true;
    }
    if (match[2] === "status")
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          workspaceId: workspace.metadata.name,
          residency: workspace.spec.residency,
          status: workspace.status ?? { phase: "Pending" },
        }),
      );
    else if (!options.workspaceLogs) response.writeHead(503).end();
    else {
      const tail = Number(url.searchParams.get("tail") ?? "100");
      if (!Number.isInteger(tail) || tail < 1 || tail > 1000) {
        response.writeHead(400).end();
        return true;
      }
      const logs = await options.workspaceLogs(workspace, tail);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(logs);
    }
  } catch {
    if (!response.headersSent) response.writeHead(503);
    response.end("Workspace diagnostics unavailable\n");
  }
  return true;
}
