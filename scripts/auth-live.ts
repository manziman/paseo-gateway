import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import { z } from "zod";
import { KubernetesStore, loadKubernetesConfig } from "../src/kubernetes/client.js";
import { context, namespace } from "./local-config.js";

// This fixture reads Kubernetes records and one owner Secret, then mints ephemeral
// bearer values in memory. It never writes a workspace, runs an agent, or reads a signing key.
let stage = "fixture_configuration";
let proxy: ChildProcess | undefined;
let client: DaemonClient | undefined;
const sockets = new Set<WebSocket>();
const name = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Live check timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function forward(): Promise<number> {
  const child = spawn(
    "kubectl",
    [
      "--context",
      context,
      "--namespace",
      namespace,
      "port-forward",
      "--address",
      "127.0.0.1",
      "service/paseo-gateway",
      ":8080",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proxy = child;
  child.stderr?.on("data", () => {}); // Drain diagnostics without publishing command output.
  return bounded(
    new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-1024);
        const match = /127\.0\.0\.1:(\d+)/.exec(output);
        if (match?.[1]) resolve(Number(match[1]));
      });
      child.once("error", () => reject(new Error("Port-forward unavailable")));
      child.once("exit", () => reject(new Error("Port-forward exited")));
    }),
    15000,
  );
}

async function rawConnection(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.add(socket);
  socket.on("error", () => {});
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            clientId: randomUUID(),
            clientType: "cli",
            protocolVersion: 1,
          }),
        );
      });
      socket.once("message", (frame) => {
        try {
          const envelope = JSON.parse(frame.toString());
          if (envelope.type !== "session" || envelope.message?.payload?.status !== "server_info")
            throw new Error("Missing server info");
          resolve();
        } catch {
          reject(new Error("Authenticated hello failed"));
        }
      });
      socket.once("error", () => reject(new Error("Authenticated WebSocket failed")));
      socket.once("close", () => reject(new Error("WebSocket closed before hello")));
    }),
    10000,
  );
  return socket;
}

async function rejectedUpgrade(url: string, token: string): Promise<number | undefined> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.add(socket);
  socket.on("error", () => {});
  return bounded(
    new Promise<number | undefined>((resolve, reject) => {
      socket.once("open", () => {
        socket.terminate();
        reject(new Error("Expired credential accepted"));
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        const status = response.statusCode;
        socket.terminate();
        resolve(status);
      });
      socket.once("error", () =>
        reject(new Error("Expected a definite HTTP authentication denial")),
      );
    }),
    10000,
  );
}

async function run() {
  const workspaceId = name.parse(process.env.PASEO_TEST_WORKSPACE);
  const identitySecret = name.parse(process.env.PASEO_IDENTITY_SECRET ?? "paseo-identity");
  const store = new KubernetesStore(loadKubernetesConfig(context), namespace);
  stage = "fixture_workspace_read";
  const rows = await store.workspaces();
  const origin = rows.find((row) => row.metadata.name === workspaceId);
  assert.ok(
    origin?.metadata.uid &&
      !origin.metadata.deletionTimestamp &&
      origin.spec.residency === "Running",
    "Select an existing Running test workspace",
  );
  const otherProject = rows.find(
    (row) => row.spec.projectRef !== origin.spec.projectRef && !row.metadata.deletionTimestamp,
  );
  const otherRole = rows.find(
    (row) =>
      row.spec.projectRef === origin.spec.projectRef &&
      row.spec.credentialProfile !== origin.spec.credentialProfile &&
      !row.metadata.deletionTimestamp,
  );
  stage = "owner_secret_read";
  const encoded = (await store.secret(identitySecret)).data?.password;
  assert.ok(encoded, "Owner credential unavailable");
  const owner = Buffer.from(encoded, "base64").toString("utf8").trim();
  assert.ok(owner.length >= 32, "Invalid owner credential");
  stage = "port_forward";
  const port = await forward();
  const base = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  const http = (path: string, token: string, body?: object) =>
    fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  const mint = async (ttlSeconds: number) => {
    const response = await http("/auth/workspace-token", owner, { workspaceId, ttlSeconds });
    assert.equal(response.status, 201, "Owner minting failed");
    assert.equal(response.headers.get("cache-control"), "no-store");
    return z
      .object({ token: z.string().min(1), expiresIn: z.number().int().positive() })
      .parse(await response.json());
  };
  stage = "scoped_mint_and_project_list";
  const scoped = await mint(30);
  client = new DaemonClient({
    url,
    password: scoped.token,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await bounded(client.connect(), 10000);
  const projects = await bounded(client.listProjects(), 10000);
  assert.deepEqual(
    projects.projects.map((project) => project.projectId),
    [origin.spec.projectRef],
    "Scoped project inventory escaped or lost its project",
  );
  stage = "scoped_http_access";
  assert.equal((await http(`/workspaces/${workspaceId}/status`, scoped.token)).status, 200);
  if (otherProject)
    assert.equal(
      (await http(`/workspaces/${otherProject.metadata.name}/status`, scoped.token)).status,
      404,
      "Cross-project status was exposed",
    );
  if (otherRole)
    assert.equal(
      (await http(`/workspaces/${otherRole.metadata.name}/status`, scoped.token)).status,
      404,
      "Cross-role status was exposed",
    );
  stage = "scoped_cannot_mint";
  assert.equal(
    (await http("/auth/workspace-token", scoped.token, { workspaceId, ttlSeconds: 86400 })).status,
    403,
    "Scoped caller minted credentials",
  );
  await bounded(client.close(), 3000);
  client = undefined;
  stage = "expiry_open_websocket";
  const expiring = await mint(3);
  assert.equal(expiring.expiresIn, 3);
  const socket = await rawConnection(url, expiring.token);
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  // No ping or mutation is sent: verify the server closes an idle expired stream too.
  await delay(4100);
  stage = "expiry_http_denial";
  assert.equal(
    (await http(`/workspaces/${workspaceId}/status`, expiring.token)).status,
    401,
    "Expired HTTP credential accepted",
  );
  stage = "expiry_new_websocket_denial";
  assert.equal(
    await rejectedUpgrade(url, expiring.token),
    401,
    "Expired upgrade did not receive 401",
  );
  stage = "expiry_existing_websocket_closed";
  assert.equal(
    await bounded(closed, 15000),
    1008,
    "Expired stream did not close with policy violation",
  );
  return {
    event: "auth_live_passed",
    context,
    namespace,
    workspaceId,
    scopedProjectInventory: "passed",
    scopedCannotMint: "passed",
    expiryHttp: "passed",
    expiryNewWebSocket: "passed",
    expiryExistingWebSocket: "passed",
    crossProjectHttp: otherProject ? "passed" : "skipped_no_other_project_workspace",
    crossRoleHttp: otherRole ? "passed" : "skipped_no_other_role_workspace",
  };
}

try {
  const result = await bounded(run(), 60000);
  console.log(JSON.stringify(result));
} catch {
  // Never serialize exceptions, HTTP bodies, request options, or credential values.
  console.error(JSON.stringify({ event: "auth_live_failed", context, namespace, check: stage }));
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  if (client) await bounded(client.close(), 3000).catch(() => {});
  if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
    const child = proxy;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await bounded(exited, 3000).catch(() => {
      child.kill("SIGKILL");
    });
  }
}
