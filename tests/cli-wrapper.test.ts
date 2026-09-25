import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import { expect, it } from "vitest";

it("passes an upstream-supported TCP target when configured with a gateway WebSocket URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-wrapper-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "fixture-password\n");
  try {
    const source =
      "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {EventEmitter} from 'node:events'; cp.spawn=(_binary,args)=>{process.stdout.write(JSON.stringify(args));return new EventEmitter()}; syncBuiltinESMExports(); process.argv=['node','wrapper','ls']; await import(process.env.PASEO_WRAPPER_MODULE);";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_WRAPPER_MODULE: pathToFileURL(resolve("docker/paseo-cli.mjs")).href,
        PASEO_GATEWAY_URL: "ws://paseo-gateway.example.svc:8080/ws",
        PASEO_GATEWAY_TOKEN_FILE: tokenFile,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const args = JSON.parse(result.stdout);
    expect(args.slice(0, 2)).toEqual(["--host", "tcp://paseo-gateway.example.svc:8080"]);
    expect(parseConnectionUri(args[1])).toMatchObject({
      host: "paseo-gateway.example.svc",
      port: 8080,
      useTls: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  [
    "heartbeat create",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ],
  [
    "heartbeat update",
    `one~${Buffer.from("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").toString("base64url")}`,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ],
  [
    "send",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    `one~${Buffer.from("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").toString("base64url")}`,
  ],
])("passes the correct agent identity for %s", async (command, agentId, expected) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-wrapper-agent-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "fixture-password\n");
  try {
    const source =
      "import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {EventEmitter} from 'node:events'; cp.spawn=(_binary,args,options)=>{process.stdout.write(JSON.stringify({args,agentId:options.env.PASEO_AGENT_ID}));return new EventEmitter()}; syncBuiltinESMExports(); process.argv=['node','wrapper',...JSON.parse(process.env.PASEO_WRAPPER_ARGS)]; await import(process.env.PASEO_WRAPPER_MODULE);";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_WRAPPER_MODULE: pathToFileURL(resolve("docker/paseo-cli.mjs")).href,
        PASEO_WRAPPER_ARGS: JSON.stringify(command.split(" ")),
        PASEO_GATEWAY_URL: "ws://paseo-gateway.example.svc:8080/ws",
        PASEO_GATEWAY_TOKEN_FILE: tokenFile,
        PASEO_CLUSTER_WORKSPACE_ID: "one",
        PASEO_AGENT_ID: agentId,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).agentId).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a heartbeat identity scoped to another workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-wrapper-agent-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "fixture-password\n");
  try {
    const source =
      "process.argv=['node','wrapper','heartbeat','create']; await import(process.env.PASEO_WRAPPER_MODULE);";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_WRAPPER_MODULE: pathToFileURL(resolve("docker/paseo-cli.mjs")).href,
        PASEO_GATEWAY_URL: "ws://paseo-gateway.example.svc:8080/ws",
        PASEO_GATEWAY_TOKEN_FILE: tokenFile,
        PASEO_CLUSTER_WORKSPACE_ID: "one",
        PASEO_AGENT_ID: `two~${Buffer.from("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").toString("base64url")}`,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not belong to this workspace");
    expect(result.stderr).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["wss://gateway.example/ws", "tcp://gateway.example:443?ssl=true"],
  ["wss://gateway.example:8443/ws", "tcp://gateway.example:8443?ssl=true"],
  ["ws://[::1]:8080/ws", "tcp://[::1]:8080"],
  ["ws://gateway.example", "tcp://gateway.example:80"],
])("normalizes %s using upstream connection URI semantics", async (input, expected) => {
  const { cliTarget } = await import(new URL("../docker/cli-target.mjs", import.meta.url).href);
  const target = cliTarget(input);
  expect(target).toBe(expected);
  expect(() => parseConnectionUri(target)).not.toThrow();
});

it.each([
  "ws://user:private-password@gateway.example/ws",
  "ws://gateway.example/ws?password=private-password",
  "ws://gateway.example/ws#private-password",
  "ws://gateway.example/custom/ws",
  "https://gateway.example/ws",
  "not-a-url",
])("rejects unsupported endpoint without echoing credentials: %s", async (input) => {
  const { cliTarget } = await import(new URL("../docker/cli-target.mjs", import.meta.url).href);
  expect(() => cliTarget(input)).toThrow();
  try {
    cliTarget(input);
  } catch (error) {
    expect(String(error)).not.toContain("private-password");
  }
});
