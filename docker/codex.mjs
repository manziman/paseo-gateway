#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** Access-only projection. Never accept native auth.json or a refresh token here. */
export async function readCodexAccess(path, now = Date.now()) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join() !==
        "accessToken,chatgptAccountId,chatgptPlanType,expiresAt" ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      value.accessToken.length > 32768 ||
      typeof value.chatgptAccountId !== "string" ||
      !value.chatgptAccountId ||
      !(value.chatgptPlanType === null || typeof value.chatgptPlanType === "string") ||
      !(Date.parse(value.expiresAt) > now + 1000)
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("Codex access unavailable; check the subscription authority status");
  }
}

/** Transparent stdio bridge; only the authentication exchange belongs to the gateway. */
export function bridgeCodex({ input, output, child, accessFile, timeoutMs = 8000 }) {
  const incoming = createInterface({ input });
  const outgoing = createInterface({ input: child.stdout });
  let initialized = false;
  let initialization;
  let currentAccess;
  let authenticated = false;
  const queued = [];
  let queuedBytes = 0;
  const pendingAuth = new Map();
  const timers = new Set();
  let stopped = false;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const emit = (message) => output.write(`${JSON.stringify(message)}\n`);
  const failure = (id) =>
    emit({
      id,
      error: {
        code: -32001,
        message: "Codex subscription authority unavailable; inspect redacted broker status",
      },
    });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    pendingAuth.clear();
    incoming.close();
    outgoing.close();
    child.kill("SIGTERM");
  };
  incoming.on("close", stop);
  outgoing.on("close", stop);
  child.stdin.on("error", stop);
  incoming.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        if (initialization !== undefined) {
          failure(message.id);
          return;
        }
        initialization = message.id;
        message.params = {
          ...message.params,
          capabilities: { ...message.params?.capabilities, experimentalApi: true },
        };
        send(message);
        return;
      }
      if (message.method === "initialized" && initialized) return;
      if (["account/login/start", "account/logout"].includes(message.method)) {
        failure(message.id);
        return;
      }
      if (!authenticated) {
        queuedBytes += Buffer.byteLength(line);
        if (queued.length >= 128 || queuedBytes > 2 * 1024 * 1024) {
          stop();
          return;
        }
        queued.push(message);
        return;
      }
      send(message);
    } catch {
      stop();
    }
  });
  outgoing.on("line", async (line) => {
    try {
      const message = JSON.parse(line);
      const auth = pendingAuth.get(message.id);
      if (auth) {
        pendingAuth.delete(message.id);
        auth(message);
        return;
      }
      if (message.id === initialization && "result" in message && !initialized) {
        currentAccess = await readCodexAccess(accessFile);
        initialized = true;
        send({ method: "initialized", params: {} });
        const id = `paseo-auth-${randomUUID()}`;
        const timer = setTimeout(() => {
          pendingAuth.delete(id);
          failure(initialization);
          stop();
        }, timeoutMs);
        timers.add(timer);
        pendingAuth.set(id, (reply) => {
          clearTimeout(timer);
          timers.delete(timer);
          if (reply.error || reply.result?.type !== "chatgptAuthTokens") {
            failure(initialization);
            stop();
          } else {
            authenticated = true;
            emit(message);
            for (const pending of queued) if (pending.method !== "initialized") send(pending);
            queued.length = 0;
            queuedBytes = 0;
          }
        });
        const { expiresAt: _, ...credentials } = currentAccess;
        send({
          id,
          method: "account/login/start",
          params: { type: "chatgptAuthTokens", ...credentials },
        });
        return;
      }
      if (message.method === "account/chatgptAuthTokens/refresh" && "id" in message) {
        const deadline = Date.now() + timeoutMs;
        const previousToken = currentAccess?.accessToken;
        const previousAccount = currentAccess?.chatgptAccountId;
        while (!stopped && Date.now() < deadline) {
          try {
            const next = await readCodexAccess(accessFile);
            if (next.chatgptAccountId !== previousAccount) break;
            if (next.accessToken !== previousToken) {
              currentAccess = next;
              const { expiresAt: _, ...credentials } = next;
              send({ id: message.id, result: credentials });
              return;
            }
          } catch {
            /* Secret propagation is eventual; bounded wait does not refresh independently. */
          }
          await delay(100);
        }
        send({
          id: message.id,
          error: {
            code: -32001,
            message:
              "Codex authority has no replacement access credential; reauthentication may be required",
          },
        });
        return;
      }
      emit(message);
    } catch {
      if (initialization !== undefined) failure(initialization);
      stop();
    }
  });
  return stop;
}

async function main() {
  const args = process.argv.slice(2);
  const file = process.env.PASEO_CODEX_ACCESS_FILE;
  const native = "/usr/local/lib/node_modules/@openai/codex/bin/codex.js";
  if (!file || args.includes("--version") || args.includes("--help")) {
    const child = spawn(process.execPath, [native, ...args], { stdio: "inherit" });
    child.on("error", () => {
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (
    !args.includes("app-server") ||
    args.some((arg) => arg.startsWith("--listen") && arg !== "--listen=stdio://")
  )
    throw new Error("Subscription profiles require Paseo's local app-server integration");
  await readCodexAccess(file);
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[key];
  const child = spawn(process.execPath, [native, ...args], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const stop = bridgeCodex({
    input: process.stdin,
    output: process.stdout,
    child,
    accessFile: file,
  });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("error", () => {
    process.exitCode = 1;
    stop();
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
    stop();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error("Codex subscription bridge unavailable; inspect the credential authority status");
    process.exitCode = 1;
  });
