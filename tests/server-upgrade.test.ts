import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { issueWorkspaceToken } from "../src/gateway/auth.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, workspace } from "./fixtures.js";

class UpgradeSocket extends Duplex {
  readonly writes: string[] = [];
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.writes.push(chunk.toString());
    callback();
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("WebSocket upgrade socket failures", () => {
  it.each(["denied", "pending", "failed"] as const)(
    "handles a reset while authentication is %s",
    async (stage) => {
      const store = new MemoryStore();
      const row = workspace();
      if (!row.metadata.uid) throw new Error("Fixture requires a workspace UID");
      store.workspaceRows = [row];
      const scopedAuth = { signingKey: "c".repeat(32), audience: "test" };
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reading = false;
      store.workspaces = async () => {
        reading = true;
        await pending;
        if (stage === "failed") throw new Error("Authorization state unavailable");
        return [row];
      };
      const gateway = await startGateway({
        store,
        namespace: "test",
        password: "a".repeat(32),
        backendPassword: "b".repeat(32),
        serverId: "test",
        host: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        ready: async () => true,
        scopedAuth,
      });
      cleanups.push(() => gateway.close());
      const socket = new UpgradeSocket();
      cleanups.push(async () => {
        release();
        socket.destroy();
      });
      const request = new IncomingMessage(new Socket());
      request.url = "/ws";
      request.method = "GET";
      request.headers = {
        host: "127.0.0.1",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(stage !== "denied"
          ? {
              authorization: `Bearer ${issueWorkspaceToken(scopedAuth, {
                projectIds: [row.spec.projectRef],
                credentialProfiles: [row.spec.credentialProfile],
                originWorkspaceId: row.metadata.name,
                originWorkspaceUid: row.metadata.uid,
                ttlSeconds: 60,
              })}`,
            }
          : {}),
      };
      gateway.server.emit("upgrade", request, socket, Buffer.alloc(0));
      await Promise.resolve();
      expect(reading).toBe(stage !== "denied");
      if (stage === "denied") expect(socket.writes.join("")).toContain("401 Unauthorized");
      expect(() =>
        socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
      ).not.toThrow();
      expect(socket.destroyed).toBe(true);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.writes.join("")).not.toContain("101 Switching Protocols");
      expect(socket.writes.join("")).not.toContain("503 Service Unavailable");
    },
  );
});
