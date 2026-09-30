import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { GatewayPrincipal } from "../src/gateway/auth.js";
import { DownloadHandles } from "../src/gateway/downloads.js";
import { MemoryStore, workspace } from "./fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const scoped = (): GatewayPrincipal => ({
  kind: "workspace",
  version: 1,
  audience: "fixture",
  tokenId: "scoped-fixture",
  projectIds: ["example"],
  credentialProfiles: ["claude-default"],
  originWorkspaceId: "origin",
  originWorkspaceUid: "uid-origin",
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
async function fixture(fetcher: typeof fetch = async () => new Response("okay")) {
  const store = new MemoryStore();
  const target = workspace("target");
  const origin = workspace("origin");
  store.workspaceRows = [target, origin];
  let now = Date.now();
  let calls = 0;
  const revoked = new Set<string>();
  const handles = new DownloadHandles({
    store,
    namespace: "test",
    backendPassword: "never-public",
    allowedHosts: ["127.0.0.1"],
    now: () => now,
    scopedAuth: {
      signingKey: "fixture-signing-key",
      audience: "fixture",
      revokedTokenIds: revoked,
    },
    fetch: async (...args) => {
      calls++;
      return fetcher(...args);
    },
  });
  const server = createServer((request, response) => {
    void handles.handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port missing");
  const issue = (principal: GatewayPrincipal = { kind: "owner" }, size: number | null = 4) =>
    handles.issue({
      workspace: target,
      principal,
      backendToken: "backend-only-token",
      fileName: "same.bin",
      mimeType: "application/octet-stream",
      size,
    });
  const request = (token: string) =>
    fetch(
      `http://127.0.0.1:${address.port}/api/files/download?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(4000) },
    );
  return {
    store,
    target,
    origin,
    revoked,
    issue,
    request,
    calls: () => calls,
    advance: () => {
      now += 60_001;
    },
  };
}
it.each([
  "handle expiry",
  "unknown",
  "principal expiry",
  "project denial",
  "role denial",
  "origin suspended",
  "origin replaced",
  "explicit revocation",
])("denies %s before backend dispatch and consumes the handle", async (reason) => {
  const f = await fixture();
  const principal = scoped();
  if (principal.kind !== "workspace") throw new Error("Fixture principal missing");
  if (reason === "principal expiry") principal.expiresAt = 1;
  if (reason === "project denial") principal.projectIds = ["other"];
  if (reason === "role denial") principal.credentialProfiles = ["other"];
  const handle = reason === "unknown" ? "unknown" : f.issue(principal);
  if (reason === "handle expiry") f.advance();
  if (reason === "origin suspended") f.origin.spec.residency = "Suspended";
  if (reason === "origin replaced") f.origin.metadata.uid = "new-origin";
  if (reason === "explicit revocation") f.revoked.add(principal.tokenId);
  const result = await f.request(handle);
  expect(result.status).toBe(403);
  expect(await result.text()).not.toContain("backend-only-token");
  expect((await f.request(handle)).status).toBe(403);
  expect(f.calls()).toBe(0);
});
it.each(["client cancellation", "origin revocation"])(
  "aborts a real HTTP stream on %s and releases transfer capacity",
  async (reason) => {
    let aborted = 0;
    let cancelled = 0;
    const upstream = createServer((_request, response) => {
      response.writeHead(200);
      response.write("A");
      response.once("close", () => {
        cancelled++;
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream port");
    const f = await fixture(async (_url, options) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted++;
        },
        { once: true },
      );
      return fetch(`http://127.0.0.1:${address.port}/fixture`, options);
    });
    const responses: Response[] = [];
    cleanups.push(async () => {
      await Promise.allSettled(responses.map((response) => response.body?.cancel()));
    });
    for (let i = 0; i < 16; i++) {
      const response = await f.request(f.issue(scoped(), null));
      expect(response.status).toBe(200);
      responses.push(response);
    }
    const refused = await f.request(f.issue(scoped(), null));
    expect(refused.status).toBe(503);
    await refused.body?.cancel();
    if (reason === "client cancellation") await responses[0]?.body?.cancel();
    else f.origin.spec.residency = "Suspended";
    await expect.poll(() => aborted, { timeout: 2500 }).toBeGreaterThan(0);
    await expect.poll(() => cancelled, { timeout: 2500 }).toBeGreaterThan(0);
    // Owner remains authorized after the scoped origin is suspended.
    const next = await f.request(f.issue({ kind: "owner" }, null));
    responses.push(next);
    expect(next.status).toBe(200);
  },
);
it.each([
  { kind: "advertised oversize", status: 413 },
  { kind: "advertised mismatch", status: 502 },
  { kind: "backend error", status: 502 },
  { kind: "network error", status: 502 },
])("rejects $kind with a safe response and no credential body", async ({ kind, status }) => {
  const canary = "PRIVATE-BACKEND-CREDENTIAL-CANARY";
  const f = await fixture(async () => {
    if (kind === "network error") throw new Error(canary);
    return new Response(canary, {
      status: kind === "backend error" ? 401 : 200,
      headers:
        kind === "backend error"
          ? {}
          : {
              "content-length": String(kind === "advertised oversize" ? 512 * 1024 * 1024 + 1 : 5),
            },
    });
  });
  const handle = f.issue();
  const result = await f.request(handle);
  expect(result.status).toBe(status);
  expect(await result.text()).not.toContain(canary);
  expect((await f.request(handle)).status).toBe(403);
  expect(f.calls()).toBe(1);
});
it.each(["too long", "truncated"])(
  "does not deliver a successful declared-size download when the body is %s",
  async (kind) => {
    const f = await fixture(async () => new Response(new Uint8Array(kind === "too long" ? 5 : 3)));
    const handle = f.issue();
    await expect(f.request(handle).then((response) => response.arrayBuffer())).rejects.toThrow();
    expect((await f.request(handle)).status).toBe(403);
  },
);
it("rejects an oversize declaration without allocating the payload", async () => {
  const f = await fixture();
  expect(() => f.issue({ kind: "owner" }, 512 * 1024 * 1024 + 1)).toThrow("transfer limit");
  expect(f.calls()).toBe(0);
});
