import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resourceName } from "../src/controller/resources.js";
import { PaseoBackend } from "../src/gateway/backend.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, workspace } from "../tests/fixtures.js";
import { reportUpstreamFailure } from "./upstream-diagnostics.js";

// This contract test owns every container/volume it creates. It never touches a running user daemon.
const prefix = `paseo-contract-${randomUUID().slice(0, 8)}`;
const password = randomBytes(32).toString("hex");
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, PASEO_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const containers: string[] = [];
const volumes: string[] = [];
const ports = new Map<string, number>();
const nativeUploads: { workspaceId: string; path: string; id: string }[] = [];
const nativeFetch = globalThis.fetch;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let client: DaemonClient | undefined;

// The production gateway requests each workspace's internal Service URL. Docker
// fixtures have published loopback ports instead, so adapt only our two owned
// Service hostnames; the actual daemon handles the HTTP download request.
globalThis.fetch = (input, init) => {
  const url = new URL(
    input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
  );
  if (url.protocol === "http:" && url.port === "6767" && url.pathname === "/api/files/download") {
    const row = store.workspaceRows.find(
      (workspace) => `${resourceName(workspace)}.test.svc` === url.hostname,
    );
    const port = row && ports.get(row.metadata.name);
    if (!port) throw new Error("Unknown Docker workspace download target");
    url.hostname = "127.0.0.1";
    url.port = String(port);
    return nativeFetch(url, init);
  }
  return nativeFetch(input, init);
};

function gatewayHttpUrl(token: string) {
  const address = gateway?.server.address();
  if (!address || typeof address === "string") throw new Error("Gateway listener unavailable");
  const url = new URL(`http://127.0.0.1:${address.port}/api/files/download`);
  url.searchParams.set("token", token);
  return url;
}

async function startDaemon(id: string) {
  const name = `${prefix}-${id}`;
  const home = `${name}-home`;
  const checkout = `${name}-checkout`;
  for (const volume of [home, checkout]) {
    docker("volume", "create", volume);
    if (!volumes.includes(volume)) volumes.push(volume);
  }
  const setup = `mkdir -p /home/paseo/.paseo /workspaces/${id}; printf '%s' '{"daemon":{"mcp":{"enabled":false,"injectIntoAgents":false},"relay":{"enabled":false}}}' > /home/paseo/.paseo/config.json; if [ ! -f /workspaces/${id}/marker.txt ]; then printf '%s' '${id}' > /workspaces/${id}/marker.txt; fi; chown -R 1000:1000 /home/paseo /workspaces/${id}; exec /usr/local/bin/paseo-workspace-entrypoint`;
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--user",
    "0",
    "--publish",
    "127.0.0.1::6767",
    "--env",
    "PASEO_PASSWORD",
    "--env",
    "PASEO_WEB_UI_ENABLED=false",
    "--env",
    "PASEO_HOSTNAMES=127.0.0.1,localhost",
    "--mount",
    `type=volume,source=${home},target=/home/paseo`,
    "--mount",
    `type=volume,source=${checkout},target=/workspaces/${id}`,
    "--entrypoint",
    "/bin/sh",
    process.env.UPSTREAM_TEST_IMAGE ?? "paseo-workspace:dev",
    "-c",
    setup,
  );
  if (!containers.includes(name)) containers.push(name);
  const bindings = JSON.parse(
    docker("inspect", "--format", '{{json (index .NetworkSettings.Ports "6767/tcp")}}', name),
  );
  const port = Number(bindings[0].HostPort);
  ports.set(id, port);
  let lastProbeError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      password,
      clientId: randomUUID(),
      connectTimeoutMs: 1000,
      reconnect: { enabled: false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      await probe.connect();
      await probe.close();
      return;
    } catch (error) {
      lastProbeError = error;
      await probe.close();
      await delay(1000);
    }
  }
  reportUpstreamFailure(name, password, lastProbeError);
  throw new Error(`Upstream daemon did not start: ${id}`);
}

const store = new MemoryStore();
store.workspaceRows = [workspace("one"), workspace("two")];
async function connectGateway() {
  gateway = await startGateway({
    store,
    namespace: "test",
    password,
    backendPassword: password,
    serverId: "stable-contract-host",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    ready: async () => true,
    backendFactory: (row, onMessage, onBinary, onDisconnect) => {
      const backend = new PaseoBackend(
        `ws://127.0.0.1:${ports.get(row.metadata.name)}/ws`,
        password,
        { type: "hello", clientId: randomUUID(), clientType: "cli", protocolVersion: 1 },
        onMessage,
        onBinary,
        onDisconnect,
      );
      const request = backend.request.bind(backend);
      backend.request = async (message) => {
        const response = await request(message);
        if (
          message.type === "file.upload.request" &&
          response.type === "file.upload.response" &&
          response.payload.file
        )
          nativeUploads.push({
            workspaceId: row.metadata.name,
            path: response.payload.file.path,
            id: response.payload.file.id,
          });
        return response;
      };
      return backend;
    },
  });
  const address = gateway.server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  client = new DaemonClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    password,
    clientId: randomUUID(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  return client;
}

try {
  for (const id of ["one", "two"]) await startDaemon(id);
  console.log("Two unmodified upstream daemons are running in isolated containers.");
  let active = await connectGateway();
  const firstGeneration = gateway?.directory.id;
  const projects = await active.listProjects();
  assert.equal(projects.projects.length, 1);
  const workspaces = await active.fetchWorkspaces();
  assert.equal(workspaces.entries.length, 2);
  await active.fetchAgents();
  const terminals: string[] = [];
  for (const id of ["one", "two"]) {
    const file = await active.readFile(`/workspaces/${id}`, "marker.txt");
    assert.equal(file.kind, "text");
    if (file.kind === "text") assert.equal(Buffer.from(file.bytes).toString("utf8"), id);
    const terminal = await active.createTerminal(`/workspaces/${id}`, `Terminal ${id}`, undefined, {
      workspaceId: id,
    });
    assert.equal(terminal.error, null);
    assert.ok(terminal.terminal);
    terminals.push(terminal.terminal.id);
  }
  const download = await active.requestDownloadToken(
    "/workspaces/one",
    "/workspaces/one/marker.txt",
  );
  assert.ok(download.token, "Workspace one must issue an HTTP download token");
  const downloadUrl = gatewayHttpUrl(download.token);
  const contents = await fetch(downloadUrl);
  assert.equal(contents.status, 200);
  assert.equal(await contents.text(), "one");
  assert.equal((await fetch(downloadUrl)).status, 403, "Gateway handle must be single-use");
  await assert.rejects(
    active.requestDownloadToken("/workspaces/one", "/workspaces/two/marker.txt"),
    /outside|workspace|download/i,
  );
  const pendingDownload = await active.requestDownloadToken(
    "/workspaces/two",
    "/workspaces/two/marker.txt",
  );
  assert.ok(pendingDownload.token);
  const created = await active.createAgent({
    config: { provider: "claude", cwd: "/workspaces/one" },
    workspaceId: "one",
  });
  const attachedText = `paseo-contract-upload-${randomUUID()}`;
  const staged = await active.uploadFile({
    fileName: "contract-attachment.txt",
    mimeType: "text/plain",
    bytes: Buffer.from(attachedText),
  });
  assert.ok(staged.file);
  assert.match(staged.file.id, /^pgw-upload:/, "Gateway must stage an unscoped SDK upload");
  await active
    .sendAgentMessage(created.id, "Inspect the attached fixture file.", {
      attachments: [staged.file],
    })
    .catch(() => {
      // Provider authentication is deliberately absent; native upload precedes prompt dispatch.
    });
  assert.equal(
    nativeUploads.length,
    1,
    "Attached send must upload exactly once to a native daemon",
  );
  assert.equal(nativeUploads[0]?.workspaceId, "one");
  assert.notEqual(nativeUploads[0]?.id, staged.file.id, "Native upload replaces the staged handle");
  assert.equal(
    docker("exec", `${prefix}-one`, "cat", nativeUploads[0]?.path ?? ""),
    attachedText,
    "Native daemon must receive the staged bytes intact",
  );
  const secondAgent = await active.createAgent({
    config: { provider: "claude", cwd: "/workspaces/two" },
    workspaceId: "two",
  });
  const secondText = `paseo-contract-second-${randomUUID()}`;
  const secondStaged = await active.uploadFile({
    fileName: "second-attachment.txt",
    mimeType: "text/plain",
    bytes: Buffer.from(secondText),
  });
  assert.ok(secondStaged.file);
  await active
    .sendAgentMessage(secondAgent.id, "Inspect the second fixture file.", {
      attachments: [secondStaged.file],
    })
    .catch(() => {
      // Provider authentication is deliberately absent; verify native upload independently.
    });
  assert.equal(nativeUploads.length, 2);
  assert.equal(nativeUploads[1]?.workspaceId, "two");
  assert.equal(
    docker("exec", `${prefix}-two`, "cat", nativeUploads[1]?.path ?? ""),
    secondText,
    "The second staged file must reach only the selected workspace daemon",
  );
  await assert.rejects(
    active.sendAgentMessage(created.id, "Do not replay this attachment.", {
      attachments: [staged.file],
    }),
    /expired|unknown|changed/i,
  );
  assert.equal(nativeUploads.length, 2, "A consumed upload handle must never upload twice");
  assert.notEqual(terminals[0], terminals[1]);
  const one = terminals[0];
  const two = terminals[1];
  if (!one || !two) throw new Error("Missing terminals");
  const first = await active.subscribeTerminal(one);
  const second = await active.subscribeTerminal(two);
  assert.ok("slot" in first && "slot" in second);
  assert.notEqual(first.slot, second.slot);
  active.sendTerminalInput(one, { type: "input", data: "printf 'paseo-terminal-one\\n'\r" });
  await delay(500);
  const capture = await active.captureTerminal(one);
  assert.ok(JSON.stringify(capture).includes("paseo-terminal-one"));
  console.log(
    "PASS: aggregated directories, isolated binary file reads, terminal IDs, binary slots and terminal input.",
  );
  await active.close();
  await gateway?.close();
  active = await connectGateway();
  assert.notEqual(gateway?.directory.id, firstGeneration);
  assert.equal(
    (await fetch(gatewayHttpUrl(pendingDownload.token))).status,
    403,
    "Download handles must expire when the gateway is replaced",
  );
  const retained = await active.listTerminals("/workspaces/one", undefined, { workspaceId: "one" });
  assert.ok(retained.terminals.some((t) => t.id === one));
  console.log(
    "PASS: native HTTP download, two-Pod late-bound uploads, path isolation, single-use handles, and gateway-replacement recovery.",
  );
  await active.close();
  await gateway?.close();
  gateway = undefined;
  client = undefined;
  docker("rm", "--force", `${prefix}-one`);
  // Reproduce an interrupted PID-lock write after disk exhaustion, with no live writer.
  docker(
    "run",
    "--rm",
    "--user",
    "1000:1000",
    "--mount",
    `type=volume,source=${prefix}-one-home,target=/home/paseo`,
    "--entrypoint",
    "/bin/sh",
    process.env.UPSTREAM_TEST_IMAGE ?? "paseo-workspace:dev",
    "-c",
    ": > /home/paseo/.paseo/paseo.pid",
  );
  await startDaemon("one");
  active = await connectGateway();
  const recovered = await active.readFile("/workspaces/one", "marker.txt");
  if (recovered.kind !== "text") throw new Error("Expected recovered text");
  assert.equal(Buffer.from(recovered.bytes).toString("utf8"), "one");
  console.log(
    "PASS: daemon replacement recovers a truncated PID lock and preserves workspace files.",
  );
  console.log(
    "Authenticated Claude turn completion, subscription renewal and Kubernetes lifecycle are separate live acceptance checks.",
  );
} finally {
  globalThis.fetch = nativeFetch;
  await client?.close();
  await gateway?.close();
  for (const name of containers) {
    try {
      docker("rm", "--force", name);
    } catch {
      /* already removed */
    }
  }
  for (const name of volumes) {
    try {
      docker("volume", "rm", name);
    } catch {
      /* retained on cleanup failure */
    }
  }
}
