import { randomUUID } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { expect, it } from "vitest";
import { scopedId } from "../src/domain.js";
import type { Backend } from "../src/gateway/backend.js";
import { workspaceDescriptor } from "../src/gateway/catalog.js";
import { startGateway } from "../src/gateway/server.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

it.each(["session", "gateway"])(
  "rejects an old staged upload after %s replacement without dispatching bytes or a prompt",
  async (replacement) => {
    const store = new MemoryStore();
    store.workspaceRows = [workspace()];
    let uploads = 0;
    let prompts = 0;
    let frames = 0;
    const backend: Backend = {
      async connect() {},
      async close() {},
      send() {},
      binary() {
        frames++;
      },
      async request(message) {
        if (message.type === "open_project_request")
          return SessionOutboundMessageSchema.parse({
            type: "open_project_response",
            payload: {
              requestId: message.requestId,
              workspace: { ...workspaceDescriptor(workspace(), project()), id: "local" },
              error: null,
            },
          });
        if (message.type === "fetch_workspaces_request")
          return SessionOutboundMessageSchema.parse({
            type: "fetch_workspaces_response",
            payload: {
              requestId: message.requestId,
              entries: [],
              emptyProjects: [],
              subscriptionId: null,
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        if (message.type === "file.upload.request") uploads++;
        if (message.type === "send_agent_message_request") prompts++;
        throw new Error("Unexpected backend dispatch");
      },
    };
    const password = "test-only-owner-password";
    const start = () =>
      startGateway({
        store,
        namespace: "test",
        backendPassword: "test-backend",
        password,
        serverId: "fixture",
        host: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        ready: async () => true,
        backendFactory: () => backend,
      });
    let gateway = await start();
    const clients: DaemonClient[] = [];
    async function connect() {
      const address = gateway.server.address();
      if (!address || typeof address === "string") throw new Error("Fixture port missing");
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${address.port}/ws`,
        password,
        clientId: randomUUID(),
        reconnect: { enabled: false },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      clients.push(client);
      await client.connect();
      return client;
    }
    try {
      const first = await connect();
      const staged = await first.uploadFile({
        fileName: "same.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("fixture"),
      });
      expect(staged.file?.id).toMatch(/^pgw-upload:/);
      if (!staged.file) throw new Error("No staged file");
      expect(uploads).toBe(0);
      await first.close();
      if (replacement === "gateway") {
        await gateway.close();
        gateway = await start();
      }
      const second = await connect();
      await expect(
        second.sendAgentMessage(scopedId("one", "agent"), "Read fixture", {
          attachments: [staged.file],
        }),
      ).rejects.toThrow("Uploaded file handle expired, unknown, or changed");
      expect({ uploads, prompts, frames }).toEqual({ uploads: 0, prompts: 0, frames: 0 });
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await gateway.close();
    }
  },
);
