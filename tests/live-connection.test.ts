import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { liveConnection, liveConnectionConfig } from "../scripts/live-connection.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "paseo-harness-tls-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const caFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyFile,
      "-out",
      caFile,
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(caFile, "utf8");
  let requests = 0;
  const server = createServer({ cert, key: await readFile(keyFile) }, (_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    requests++;
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return { caFile, cert, port: address.port, requests: () => requests };
}
async function socketResult(connection: ReturnType<typeof liveConnection>) {
  const socket = connection.socket({ authorization: "Bearer test-only" });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("Connection rejected")));
    });
  } finally {
    socket.terminate();
  }
}
it("uses the selected CA and DNS hostname for both loopback HTTPS and WSS", async () => {
  const f = await fixture();
  const config = await liveConnectionConfig({
    PASEO_TEST_CA_FILE: f.caFile,
    PASEO_TEST_TLS_SERVER_NAME: "localhost",
    PASEO_IDENTITY_SECRET: "selected-identity",
  });
  expect(config.identitySecret).toBe("selected-identity");
  const connection = liveConnection(f.port, config);
  expect(await (await connection.http("/status", "test-only")).json()).toEqual({ ok: true });
  await expect(socketResult(connection)).resolves.toBeUndefined();
  expect(f.requests()).toBe(2);
});
it.each(["ca", "hostname"])(
  "rejects a wrong %s for HTTPS and WSS without plaintext downgrade",
  async (wrong) => {
    const f = await fixture();
    const other = wrong === "ca" ? await fixture() : undefined;
    const connection = liveConnection(f.port, {
      identitySecret: "fixture",
      tls: {
        ca: other?.cert ?? f.cert,
        serverName: wrong === "hostname" ? "wrong.invalid" : "localhost",
      },
    });
    await expect(connection.http("/status", "test-only")).rejects.toThrow(
      "Live HTTP request failed",
    );
    await expect(socketResult(connection)).rejects.toThrow("Connection rejected");
    expect(connection.url).toMatch(/^wss:/);
    expect(f.requests()).toBe(0);
  },
);
it("preserves explicit loopback defaults and rejects incomplete TLS selection", async () => {
  expect(await liveConnectionConfig({})).toEqual({ identitySecret: "paseo-identity" });
  await expect(liveConnectionConfig({ PASEO_TEST_CA_FILE: "not-read" })).rejects.toThrow(
    "configuration",
  );
  await expect(liveConnectionConfig({ PASEO_TEST_TLS_SERVER_NAME: "localhost" })).rejects.toThrow(
    "configuration",
  );
  expect(liveConnection(1234, { identitySecret: "fixture" }).url).toBe("ws://127.0.0.1:1234/ws");
});
