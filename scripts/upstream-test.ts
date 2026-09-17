import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PaseoBackend } from "../src/gateway/backend.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, workspace } from "../tests/fixtures.js";

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
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let client: DaemonClient | undefined;

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
    "paseo-workspace:dev",
    "-c",
    setup,
  );
  if (!containers.includes(name)) containers.push(name);
  const bindings = JSON.parse(
    docker("inspect", "--format", '{{json (index .NetworkSettings.Ports "6767/tcp")}}', name),
  );
  const port = Number(bindings[0].HostPort);
  ports.set(id, port);
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
    } catch {
      await probe.close();
      await delay(1000);
    }
  }
  throw new Error("Upstream daemon did not start");
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
    backendFactory: (row, onMessage, onBinary, onDisconnect) =>
      new PaseoBackend(
        `ws://127.0.0.1:${ports.get(row.metadata.name)}/ws`,
        password,
        { type: "hello", clientId: randomUUID(), clientType: "cli", protocolVersion: 1 },
        onMessage,
        onBinary,
        onDisconnect,
      ),
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
  const retained = await active.listTerminals("/workspaces/one", undefined, { workspaceId: "one" });
  assert.ok(retained.terminals.some((t) => t.id === one));
  console.log(
    "PASS: gateway replacement preserves running workspace terminals and starts a new directory generation.",
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
    "paseo-workspace:dev",
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
    "Claude prompts, subscription renewal and Kubernetes lifecycle are separate live acceptance checks.",
  );
} finally {
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
