import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Store } from "../kubernetes/store.js";
import {
  authenticate,
  issueWorkspaceToken,
  principalIsActive,
  type ScopedAuthOptions,
} from "./auth.js";

export function allowedRequest(
  request: Pick<IncomingMessage, "headers">,
  allowedHosts: string[],
): boolean {
  try {
    const host = request.headers.host;
    if (!host || !allowedHosts.includes(new URL(`http://${host}`).hostname)) return false;
    const origin = request.headers.origin;
    // The unmodified macOS desktop uses this custom application origin. It is
    // not a network Host; accepting it must not expand allowed request hosts.
    return !origin || origin === "paseo://app" || allowedHosts.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export async function authenticateRequest(
  request: Pick<IncomingMessage, "headers">,
  password: string,
  store: Store,
  auth?: ScopedAuthOptions,
) {
  const principal = authenticate(request, password, auth);
  if (!principal || principal.kind === "owner") return principal;
  return principalIsActive(principal, await store.workspaces()) ? principal : undefined;
}

const MintRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).max(63),
  ttlSeconds: z.number().int().min(1).max(86400).default(3600),
});

/** Optional owner-only endpoint. Claims are derived from cluster records, not client claims. */
export async function handleTokenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    password: string;
    store: Store;
    allowedHosts: string[];
    scopedAuth?: ScopedAuthOptions;
  },
): Promise<boolean> {
  if (request.url !== "/auth/workspace-token" || !options.scopedAuth) return false;
  response.setHeader("Cache-Control", "no-store");
  if (!allowedRequest(request, options.allowedHosts)) {
    response.writeHead(401).end();
    return true;
  }
  const principal = authenticate(request, options.password, options.scopedAuth);
  if (!principal) response.writeHead(401).end();
  else if (principal.kind !== "owner") response.writeHead(403).end();
  else if (request.method !== "POST") response.writeHead(405, { Allow: "POST" }).end();
  else {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 4096) {
          response.writeHead(413).end();
          return true;
        }
        chunks.push(buffer);
      }
      const input = MintRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const origin = (await options.store.workspaces()).find(
        (w) => w.metadata.name === input.workspaceId,
      );
      if (
        !origin?.metadata.uid ||
        origin.metadata.deletionTimestamp ||
        origin.spec.residency !== "Running"
      ) {
        response.writeHead(404).end();
        return true;
      }
      const token = issueWorkspaceToken(options.scopedAuth, {
        projectIds: [origin.spec.projectRef],
        credentialProfiles: [origin.spec.credentialProfile],
        originWorkspaceId: origin.metadata.name,
        originWorkspaceUid: origin.metadata.uid,
        ttlSeconds: input.ttlSeconds,
      });
      response
        .writeHead(201, { "Content-Type": "application/json" })
        .end(JSON.stringify({ token, expiresIn: input.ttlSeconds }));
    } catch {
      response.writeHead(400).end();
    }
  }
  return true;
}
