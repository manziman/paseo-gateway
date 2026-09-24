import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Workspace } from "../domain.js";

const scopeName = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  .max(63);
export const WorkspaceGrantSchema = z.strictObject({
  projectIds: z.array(scopeName).min(1).max(32),
  credentialProfiles: z.array(scopeName).min(1).max(32),
  originWorkspaceId: scopeName,
  originWorkspaceUid: z.string().min(1).max(200),
  ttlSeconds: z.number().int().min(1).max(86400),
});
export type WorkspaceGrant = z.infer<typeof WorkspaceGrantSchema>;
const ClaimsSchema = WorkspaceGrantSchema.omit({ ttlSeconds: true }).extend({
  kind: z.literal("workspace"),
  version: z.literal(1),
  audience: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  tokenId: z.string().uuid(),
});
export type GatewayPrincipal = { kind: "owner" } | z.infer<typeof ClaimsSchema>;
export interface ScopedAuthOptions {
  signingKey: string;
  audience: string;
  revokedTokenIds?: ReadonlySet<string>;
}

export function validateScopedAuth(options: ScopedAuthOptions): void {
  if (Buffer.byteLength(options.signingKey) < 32 || !options.audience.trim())
    throw new Error("Scoped authentication requires a dedicated 32-byte key and audience");
}

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

function requestToken(request: Pick<IncomingMessage, "headers">): string | undefined {
  const header = request.headers.authorization;
  // A malformed explicit Authorization header must not fall back to another credential.
  if (header !== undefined) return header.startsWith("Bearer ") ? header.slice(7) : undefined;
  return request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("paseo.bearer."))
    ?.slice(13);
}

/** Owner-compatible predicate retained for existing direct connection callers. */
export function authorized(request: Pick<IncomingMessage, "headers">, password: string): boolean {
  const token = requestToken(request);
  return !!token && !!password && equalSecret(token, password);
}

/** Issuance is trusted controller/owner code, never an operation exposed to scoped callers. */
export function issueWorkspaceToken(
  options: ScopedAuthOptions,
  grant: WorkspaceGrant,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  validateScopedAuth(options);
  const { ttlSeconds, ...scope } = WorkspaceGrantSchema.parse(grant);
  const claims = ClaimsSchema.parse({
    ...scope,
    kind: "workspace",
    version: 1,
    audience: options.audience,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
    tokenId: randomUUID(),
  });
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", options.signingKey)
    .update(`pgw1.${body}`)
    .digest("base64url");
  return `pgw1.${body}.${signature}`;
}

export function verifyWorkspaceToken(
  token: string,
  options: ScopedAuthOptions,
  nowSeconds = Math.floor(Date.now() / 1000),
): Extract<GatewayPrincipal, { kind: "workspace" }> | undefined {
  validateScopedAuth(options);
  if (token.length > 16384) return undefined;
  const match = /^pgw1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match?.[1] || !match[2]) return undefined;
  const expected = createHmac("sha256", options.signingKey)
    .update(`pgw1.${match[1]}`)
    .digest("base64url");
  if (!equalSecret(expected, match[2])) return undefined;
  try {
    const claims = ClaimsSchema.parse(
      JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")),
    );
    if (
      claims.audience !== options.audience ||
      claims.issuedAt > nowSeconds ||
      claims.expiresAt <= nowSeconds ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > 86400 ||
      options.revokedTokenIds?.has(claims.tokenId)
    )
      return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

export function authenticate(
  request: Pick<IncomingMessage, "headers">,
  password: string,
  options?: ScopedAuthOptions,
): GatewayPrincipal | undefined {
  if (authorized(request, password)) return { kind: "owner" };
  const token = requestToken(request);
  return token && options ? verifyWorkspaceToken(token, options) : undefined;
}

export function authorizeProject(principal: GatewayPrincipal, projectId: string): boolean {
  return principal.kind === "owner" || principal.projectIds.includes(projectId);
}

export function authorizeWorkspace(principal: GatewayPrincipal, workspace: Workspace): boolean {
  return (
    principal.kind === "owner" ||
    (principal.projectIds.includes(workspace.spec.projectRef) &&
      principal.credentialProfiles.includes(workspace.spec.credentialProfile))
  );
}

/** Re-read authoritative records: names reused after deletion must never revive an old grant. */
export function principalIsActive(principal: GatewayPrincipal, workspaces: Workspace[]): boolean {
  if (principal.kind === "owner") return true;
  if (principal.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const origin = workspaces.find((row) => row.metadata.name === principal.originWorkspaceId);
  return (
    !!origin &&
    origin.metadata.uid === principal.originWorkspaceUid &&
    !origin.metadata.deletionTimestamp &&
    origin.spec.residency === "Running" &&
    authorizeWorkspace(principal, origin)
  );
}
