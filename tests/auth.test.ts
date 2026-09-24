import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createPaseoClient } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  authenticate,
  authorizeWorkspace,
  issueWorkspaceToken,
  principalIsActive,
  verifyWorkspaceToken,
} from "../src/gateway/auth.js";
import { type ServerOptions, startGateway } from "../src/gateway/server.js";
import { buildServerInfo, ServerInfoConfigSchema } from "../src/gateway/server-info.js";
import { MemoryStore, workspace } from "./fixtures.js";

const auth = { signingKey: "separate-signing-key-0123456789abcdef", audience: "retained-host" };
const password = "owner-password-0123456789abcdef";
const grant = {
  projectIds: ["example"],
  credentialProfiles: ["claude-default"],
  originWorkspaceId: "one",
  originWorkspaceUid: "uid-one",
  ttlSeconds: 3600,
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scoped bearer credentials", () => {
  it("uses identical owner and scoped bearer parsing for HTTP and websocket", () => {
    const token = issueWorkspaceToken(auth, grant);
    for (const value of [token, password]) {
      const header = authenticate(
        { headers: { authorization: `Bearer ${value}` } },
        password,
        auth,
      );
      const protocol = authenticate(
        { headers: { "sec-websocket-protocol": `paseo.bearer.${value}` } },
        password,
        auth,
      );
      expect(header).toEqual(protocol);
      expect(header?.kind).toBe(value === password ? "owner" : "workspace");
    }
    expect(authenticate({ headers: {} }, password, auth)).toBeUndefined();
    expect(
      authenticate(
        {
          headers: {
            authorization: "Basic wrong",
            "sec-websocket-protocol": `paseo.bearer.${password}`,
          },
        },
        password,
        auth,
      ),
    ).toBeUndefined();
  });
  it("rejects expiry, future issuance, tampering, wrong audience, rotation, and revocation", () => {
    const token = issueWorkspaceToken(auth, grant, 100);
    expect(verifyWorkspaceToken(token, auth, 100)?.kind).toBe("workspace");
    expect(verifyWorkspaceToken(token, auth, 3700)).toBeUndefined();
    expect(verifyWorkspaceToken(token, auth, 99)).toBeUndefined();
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyWorkspaceToken(tampered, auth, 100)).toBeUndefined();
    expect(verifyWorkspaceToken(token, { ...auth, audience: "another-host" }, 100)).toBeUndefined();
    expect(
      verifyWorkspaceToken(
        token,
        { ...auth, signingKey: "new-signing-key-0123456789abcdef000" },
        100,
      ),
    ).toBeUndefined();
    const claims = verifyWorkspaceToken(token, auth, 100);
    expect(claims).toBeDefined();
    expect(
      verifyWorkspaceToken(
        token,
        { ...auth, revokedTokenIds: new Set([claims?.tokenId ?? ""]) },
        100,
      ),
    ).toBeUndefined();
  });
  it("rejects even signed owner escalation and undeclared claims", () => {
    const token = issueWorkspaceToken(auth, grant);
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    for (const extra of [{ kind: "owner" }, { permissions: ["access.manage"] }]) {
      const body = Buffer.from(JSON.stringify({ ...claims, ...extra })).toString("base64url");
      const signature = createHmac("sha256", auth.signingKey)
        .update(`pgw1.${body}`)
        .digest("base64url");
      expect(verifyWorkspaceToken(`pgw1.${body}.${signature}`, auth)).toBeUndefined();
    }
    expect(() => issueWorkspaceToken(auth, { ...grant, ttlSeconds: 86401 })).toThrow();
  });
  it("requires both project and profile and revokes deleted, suspended or recreated origin", () => {
    const claims = verifyWorkspaceToken(issueWorkspaceToken(auth, grant), auth);
    if (!claims) throw new Error("Missing claims");
    const row = workspace();
    expect(authorizeWorkspace(claims, row)).toBe(true);
    expect(
      authorizeWorkspace(claims, {
        ...row,
        spec: { ...row.spec, credentialProfile: "other-role" },
      }),
    ).toBe(false);
    expect(
      authorizeWorkspace(claims, { ...row, spec: { ...row.spec, projectRef: "other-project" } }),
    ).toBe(false);
    expect(principalIsActive(claims, [row])).toBe(true);
    expect(principalIsActive(claims, [])).toBe(false);
    expect(
      principalIsActive(claims, [{ ...row, metadata: { ...row.metadata, uid: "recreated" } }]),
    ).toBe(false);
    expect(
      principalIsActive(claims, [{ ...row, spec: { ...row.spec, residency: "Suspended" } }]),
    ).toBe(false);
  });
});

async function gatewayFixture(
  workspaceLogs?: ServerOptions["workspaceLogs"],
  operations?: ServerOptions["operations"],
) {
  const store = new MemoryStore();
  const row = workspace();
  row.status = { phase: "Pending", observedGeneration: 1, message: "starting" };
  store.workspaceRows = [row];
  const gateway = await startGateway({
    store,
    namespace: "test",
    backendPassword: "backend-password",
    password,
    serverId: auth.audience,
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    ready: async () => true,
    scopedAuth: auth,
    workspaceLogs,
    operations,
    advertised: { name: "Team Gateway" },
  });
  cleanups.push(() => gateway.close());
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  return {
    store,
    url: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
  };
}

describe("scoped authentication transport", () => {
  it("closes an expired scoped stream before sending another backend event", async () => {
    let emitEvent: Parameters<NonNullable<ServerOptions["operations"]>["handle"]>[1] | undefined;
    let capture!: () => void;
    const captured = new Promise<void>((resolve) => {
      capture = resolve;
    });
    const { wsUrl } = await gatewayFixture(undefined, {
      async handle(_message, emit) {
        emitEvent = emit;
        capture();
        return true;
      },
    });
    const token = issueWorkspaceToken(auth, grant);
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
    cleanups.push(async () => {
      ws.terminate();
    });
    const frames: string[] = [];
    ws.on("message", (data) => frames.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({ type: "hello", clientId: "expiry", clientType: "cli", protocolVersion: 1 }),
    );
    ws.send(
      JSON.stringify({
        type: "session",
        message: { type: "project.list.request", requestId: "capture" },
      }),
    );
    await captured;
    await expect.poll(() => frames.length).toBe(1);
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601000);
    emitEvent?.({
      type: "project.list.response",
      payload: { requestId: "after-expiry", projects: [] },
    });
    expect(await closed).toBe(1008);
    expect(frames.some((frame) => frame.includes("after-expiry"))).toBe(false);
  });
  it("rejects malformed raw HTTP targets without crashing the request handler", async () => {
    const { url } = await gatewayFixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { path: "//[invalid" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
  it("protects HTTP status and logs with the same role scope and suppresses backend errors", async () => {
    const tails: number[] = [];
    const { store, url } = await gatewayFixture(async (row, tail) => {
      tails.push(tail);
      if (row.metadata.name === "broken") throw new Error("provider-credential-sentinel");
      return "authorized workspace output\n";
    });
    const otherRole = workspace("other");
    otherRole.spec.credentialProfile = "other-role";
    store.workspaceRows.push(otherRole, workspace("broken"));
    const token = issueWorkspaceToken(auth, grant);
    const get = (path: string, bearer = token) =>
      fetch(`${url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await get("/workspaces/one/status", "")).status).toBe(401);
    expect((await get("/workspaces/one/status")).status).toBe(200);
    expect((await get("/workspaces/other/status")).status).toBe(404);
    expect((await get("/workspaces/other/logs")).status).toBe(404);
    const log = await get("/workspaces/one/logs?tail=12");
    expect(log.status).toBe(200);
    expect(log.headers.get("cache-control")).toBe("no-store");
    expect(await log.text()).toBe("authorized workspace output\n");
    expect((await get("/workspaces/one/logs?tail=1001")).status).toBe(400);
    expect(tails).toEqual([12]);
    expect((await get("/workspaces/other/status", password)).status).toBe(200);
    const failed = await get("/workspaces/broken/logs");
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("provider-credential-sentinel");
    const origin = store.workspaceRows[0];
    if (!origin) throw new Error("No origin");
    origin.spec.residency = "Archived";
    expect((await get("/workspaces/one/status")).status).toBe(401);
  });
  it("owner mints record-derived claims; scoped caller cannot mint or expand them", async () => {
    const { url } = await gatewayFixture();
    const mint = (token: string, body: unknown) =>
      fetch(`${url}/auth/workspace-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const response = await mint(password, { workspaceId: "one" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = (await response.json()) as { token: string };
    expect(verifyWorkspaceToken(data.token, auth)).toMatchObject({
      projectIds: ["example"],
      credentialProfiles: ["claude-default"],
      originWorkspaceUid: "uid-one",
    });
    expect((await mint(data.token, { workspaceId: "one" })).status).toBe(403);
    expect((await mint(password, { workspaceId: "one", projectIds: ["other"] })).status).toBe(400);
    expect((await mint("", { workspaceId: "one" })).status).toBe(401);
    expect(
      (
        await fetch(`${url}/auth/workspace-token`, {
          method: "POST",
          headers: { authorization: `Bearer ${password}`, origin: "https://evil.example" },
          body: JSON.stringify({ workspaceId: "one" }),
        })
      ).status,
    ).toBe(401);
  });
  it("permits same-role sibling creation through SDK and rejects expired or revoked upgrades", async () => {
    const { store, wsUrl } = await gatewayFixture();
    const token = issueWorkspaceToken(auth, grant);
    const client = createPaseoClient({
      url: wsUrl,
      password: token,
      reconnect: { enabled: false },
    });
    cleanups.push(() => client.close());
    await client.connect();
    expect((await client.projects.list()).projects.map((p) => p.projectId)).toEqual(["example"]);
    await client.workspaces.create({
      source: { kind: "directory", path: "/projects/example", projectId: "example" },
      title: "Worker",
    });
    expect(store.workspaceRows).toHaveLength(2);
    const origin = store.workspaceRows[0];
    if (!origin) throw new Error("Missing origin");
    origin.spec.residency = "Archived";
    const rejectUpgrade = (credential: string) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${credential}` } });
        ws.on("error", () => resolve());
        ws.on("open", () => {
          ws.close();
          reject(new Error("Unauthorized credential accepted"));
        });
      });
    await rejectUpgrade(token);
    await rejectUpgrade(issueWorkspaceToken(auth, grant, 1));
  });
});

describe("validated advertised server information", () => {
  it("retains identity/attribution and describes only implemented capabilities", () => {
    const info = buildServerInfo("retained-host", { name: "Team Gateway" });
    expect(info).toMatchObject({
      serverId: "retained-host",
      hostname: "Team Gateway (independent)",
      version: "0.9.1",
      capabilities: { voice: { dictation: { enabled: false } } },
      features: { directorySync: true, workspaceLabels: false },
    });
    expect(() =>
      ServerInfoConfigSchema.parse({ name: "Name", features: { workspaceLabels: true } }),
    ).toThrow();
    expect(() => buildServerInfo("retained-host", { name: " " })).toThrow();
    expect(() => buildServerInfo(" ")).toThrow();
  });
});
