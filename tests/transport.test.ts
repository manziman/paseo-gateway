import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WorkspaceController } from "../src/controller/controller.js";
import { desiredResources, resourceName } from "../src/controller/resources.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function certificate() {
  const root = await mkdtemp(join(tmpdir(), "paseo-tls-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    cert: await readFile(join(root, "cert.pem")),
    key: await readFile(join(root, "key.pem")),
  };
}
const config = {
  workspaceImage: "test:fixture",
  storageSize: "5Gi",
  backendSecret: "backend",
  imagePullPolicy: "Never" as const,
};

describe("encrypted gateway/workspace transport", () => {
  it("serves HTTPS and authenticated WSS, rejecting an untrusted certificate and missing bearer", async () => {
    const certificatePair = await certificate();
    const gateway = await startGateway({
      store: new MemoryStore(),
      namespace: "test",
      password: "a".repeat(32),
      backendPassword: "b".repeat(32),
      serverId: "retained",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      ready: async () => true,
      tls: certificatePair,
    });
    cleanups.push(() => gateway.close());
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("Missing gateway port");
    const status = (ca?: Buffer) =>
      new Promise<number>((resolve, reject) => {
        const request = https.get(
          `https://127.0.0.1:${address.port}/readyz`,
          { ca },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
      });
    await expect(status(certificatePair.cert)).resolves.toBe(200);
    await expect(status()).rejects.toThrow();
    const connect = (password?: string) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`wss://127.0.0.1:${address.port}/ws`, {
          ca: certificatePair.cert,
          headers: password ? { Authorization: `Bearer ${password}` } : {},
        });
        socket.once("error", reject);
        socket.once("open", () => {
          socket.close();
          resolve();
        });
      });
    await expect(connect("a".repeat(32))).resolves.toBeUndefined();
    await expect(connect()).rejects.toThrow("401");
  });

  it("preserves arbitrary bytes through verified TLS and closes failed upstream streams", async () => {
    const certificatePair = await certificate();
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve, reject) => {
      echo.once("error", reject);
      echo.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => echo.close(() => resolve())));
    const backend = echo.address();
    if (!backend || typeof backend === "string") throw new Error("Missing echo port");
    const { startTlsProxy } = await import(pathToFileURL(resolve("docker/tls-proxy.mjs")).href);
    const proxy = await startTlsProxy({
      ...certificatePair,
      port: 0,
      host: "127.0.0.1",
      backendPort: backend.port,
    });
    cleanups.push(() => proxy.close());
    const port = proxy.server.address().port;
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
    const received = await new Promise<Buffer>((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: certificatePair.cert,
      });
      const chunks: Buffer[] = [];
      socket.once("error", reject);
      socket.once("secureConnect", () => socket.write(bytes));
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length === bytes.length) {
          socket.destroy();
          resolve(Buffer.concat(chunks));
        }
      });
    });
    expect(received).toEqual(bytes);
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          servername: "foreign.invalid",
          ca: certificatePair.cert,
        });
        socket.once("error", reject);
        socket.once("secureConnect", () => {
          socket.destroy();
          resolve();
        });
      }),
    ).rejects.toThrow();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: certificatePair.cert,
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        reject(new Error("TLS connection remained open after backend refusal"));
      });
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
  });

  it("keeps plaintext loopback-only and projects only CA to the provider daemon", () => {
    const row = desiredResources(workspace(), project(), {
      ...config,
      tlsSecret: "workspace-tls",
      storageAccessMode: "ReadWriteOncePod",
      gatewayUrl: "wss://paseo-gateway.test.svc:8080/ws",
    });
    expect(row.pvc.spec?.accessModes).toEqual(["ReadWriteOncePod"]);
    expect(row.service.spec?.ports?.[0]?.targetPort).toBe(6768);
    const daemon = row.pod.spec?.containers[0];
    expect(daemon?.env).toContainEqual({ name: "PASEO_LISTEN", value: "127.0.0.1:6767" });
    expect(daemon?.volumeMounts?.some((mount) => mount.name === "transport")).toBe(false);
    expect(
      row.pod.spec?.volumes?.find((volume) => volume.name === "transport-ca")?.secret?.items,
    ).toEqual([{ key: "ca.crt", path: "ca.crt" }]);
    expect(row.pod.spec?.containers[1]?.securityContext?.readOnlyRootFilesystem).toBe(true);
  });

  it("can suspend a pod that never became ready without inventing an inventory snapshot", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    let snapshots = 0;
    const controller = new WorkspaceController(store, config, {
      beforeSuspend: async () => {
        snapshots++;
        throw new Error("not ready");
      },
    });
    await controller.reconcile(row, store.projectRows);
    row.spec.residency = "Suspended";
    await controller.reconcile(row, store.projectRows);
    await controller.reconcile(row, store.projectRows);
    expect(snapshots).toBe(0);
    expect(row.status?.phase).toBe("Suspended");
    expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(false);
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
  });

  it("refuses suspension when retained inventory cannot be captured", async () => {
    const store = new MemoryStore();
    const row = workspace();
    store.workspaceRows = [row];
    const controller = new WorkspaceController(store, config, {
      beforeSuspend: async () => {
        throw new Error("offline");
      },
    });
    await controller.reconcile(row, store.projectRows);
    const pod = store.objects.get(`Pod/${resourceName(row)}`);
    if (!pod) throw new Error("Missing fixture pod");
    Object.assign(pod, { status: { conditions: [{ type: "Ready", status: "True" }] } });
    row.spec.residency = "Suspended";
    await controller.reconcile(row, store.projectRows);
    expect(row.status?.phase).toBe("Failed");
    expect(row.status?.message).toContain("snapshot unavailable");
    expect(store.objects.has(`Pod/${resourceName(row)}`)).toBe(true);
    expect(store.objects.has(`PersistentVolumeClaim/${resourceName(row)}`)).toBe(true);
  });
});
