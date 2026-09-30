import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DownloadHandles } from "../src/gateway/downloads.js";
import { MemoryStore, workspace } from "./fixtures.js";

describe("download handle routing", () => {
  it("streams exact bytes once and fences workspace replacement", async () => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    const row = store.workspaceRows[0];
    if (!row) throw new Error("Missing fixture workspace");
    const requests: URL[] = [];
    const handles = new DownloadHandles({
      store,
      namespace: "test",
      backendPassword: "backend-secret",
      allowedHosts: ["127.0.0.1"],
      fetch: (async (url: URL | RequestInfo) => {
        requests.push(new URL(String(url)));
        return new Response(new Uint8Array([0, 1, 2, 255]), {
          status: 200,
          headers: { "content-length": "4" },
        });
      }) as typeof fetch,
    });
    async function request(token: string) {
      const source = new PassThrough() as unknown as IncomingMessage;
      source.url = `/api/files/download?token=${token}`;
      source.method = "GET";
      source.headers = { host: "127.0.0.1" };
      const target = new PassThrough() as PassThrough & { status?: number };
      const chunks: Buffer[] = [];
      target.on("data", (chunk: Buffer) => chunks.push(chunk));
      const fake = target as unknown as ServerResponse;
      fake.setHeader = (() => fake) as ServerResponse["setHeader"];
      fake.writeHead = ((status: number) => {
        target.status = status;
        return fake;
      }) as ServerResponse["writeHead"];
      await handles.handle(source, fake);
      return { status: target.status, bytes: Buffer.concat(chunks) };
    }
    const issue = () =>
      handles.issue({
        workspace: row,
        principal: { kind: "owner" },
        backendToken: "backend-only-token",
        mimeType: "application/octet-stream",
        fileName: "data.bin",
        size: 4,
      });
    const handle = issue();
    expect(handle).not.toContain("backend-only-token");
    const received = await request(handle);
    expect(received.status).toBe(200);
    expect(new Uint8Array(received.bytes)).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(requests[0]?.searchParams.get("token")).toBe("backend-only-token");
    expect((await request(handle)).status).toBe(403);
    const replacementHandle = issue();
    row.metadata.uid = "replacement";
    expect((await request(replacementHandle)).status).toBe(403);
    expect(requests).toHaveLength(1);
  });
});
