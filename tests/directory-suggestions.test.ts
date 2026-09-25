import {
  type SessionInboundMessage,
  type SessionOutboundMessage,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { GatewayPrincipal } from "../src/gateway/auth.js";
import { DirectoryGeneration, workspaceDescriptor } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

function setup(principal?: GatewayPrincipal) {
  const store = new MemoryStore();
  store.workspaceRows = [workspace("one"), workspace("two")];
  const emitted: SessionOutboundMessage[] = [];
  const requests: { workspace: string; message: SessionInboundMessage }[] = [];
  const session = new GatewaySession({
    store,
    namespace: "test",
    backendPassword: "backend",
    principal,
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientId: "suggestions", clientType: "browser", protocolVersion: 1 },
    emit: (message) => emitted.push(SessionOutboundMessageSchema.parse(message)),
    emitBinary() {},
    disconnect() {},
    backendFactory: (row) => ({
      async connect() {},
      async close() {},
      send() {},
      binary() {},
      async request(message) {
        if (message.type === "open_project_request")
          return SessionOutboundMessageSchema.parse({
            type: "open_project_response",
            payload: {
              requestId: message.requestId,
              workspace: { ...workspaceDescriptor(row, project()), id: "native" },
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
              pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            },
          });
        if (message.type !== "directory_suggestions_request")
          throw new Error(`Unexpected native request ${message.type}`);
        requests.push({ workspace: row.metadata.name, message });
        return SessionOutboundMessageSchema.parse({
          type: "directory_suggestions_response",
          payload: {
            requestId: message.requestId,
            directories: [],
            entries: [{ path: "gateway-download-test.txt", kind: "file" }],
            error: null,
          },
        });
      },
    }),
  });
  return { store, emitted, requests, session };
}

describe("directory suggestions routing", () => {
  it("forwards the Desktop suffix file lookup to only the selected workspace", async () => {
    const fixture = setup();
    try {
      for (const id of ["one", "two"]) {
        await fixture.session.handle({
          type: "directory_suggestions_request",
          requestId: id,
          query: "gateway-download-test.txt",
          cwd: `/workspaces/${id}`,
          includeFiles: true,
          includeDirectories: false,
          matchMode: "suffix",
          limit: 1,
        });
      }
      expect(fixture.requests).toEqual([
        {
          workspace: "one",
          message: {
            type: "directory_suggestions_request",
            requestId: "one",
            query: "gateway-download-test.txt",
            cwd: "/workspaces/one",
            includeFiles: true,
            includeDirectories: false,
            matchMode: "suffix",
            limit: 1,
          },
        },
        {
          workspace: "two",
          message: {
            type: "directory_suggestions_request",
            requestId: "two",
            query: "gateway-download-test.txt",
            cwd: "/workspaces/two",
            includeFiles: true,
            includeDirectories: false,
            matchMode: "suffix",
            limit: 1,
          },
        },
      ]);
      expect(fixture.emitted).toEqual([
        {
          type: "directory_suggestions_response",
          payload: {
            requestId: "one",
            directories: [],
            entries: [{ path: "gateway-download-test.txt", kind: "file" }],
            error: null,
          },
        },
        {
          type: "directory_suggestions_response",
          payload: {
            requestId: "two",
            directories: [],
            entries: [{ path: "gateway-download-test.txt", kind: "file" }],
            error: null,
          },
        },
      ]);
    } finally {
      await fixture.session.close();
    }
  });

  it("keeps project suggestions local and refuses unknown or replaced workspace cwd", async () => {
    const fixture = setup();
    try {
      await fixture.session.handle({
        type: "directory_suggestions_request",
        requestId: "projects",
        query: "",
      });
      expect(fixture.emitted[0]).toMatchObject({
        type: "directory_suggestions_response",
        payload: { requestId: "projects", directories: ["/projects/example"] },
      });
      expect(fixture.requests).toEqual([]);
      await fixture.session.handle({
        type: "directory_suggestions_request",
        requestId: "foreign",
        query: "marker.txt",
        cwd: "/workspaces/foreign",
      });
      expect(fixture.emitted.at(-1)).toMatchObject({
        type: "rpc_error",
        payload: { requestId: "foreign" },
      });
      const first = fixture.store.workspaceRows[0];
      if (!first) throw new Error("Fixture workspace is unavailable");
      first.metadata.uid = "replacement";
      first.status = {
        phase: "Pending",
        message: "starting",
        observedGeneration: 1,
      };
      await fixture.session.handle({
        type: "directory_suggestions_request",
        requestId: "pending",
        query: "marker.txt",
        cwd: "/workspaces/one",
      });
      expect(fixture.emitted.at(-1)).toMatchObject({
        type: "rpc_error",
        payload: { requestId: "pending" },
      });
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.session.close();
    }
  });

  it("does not send a scoped caller's lookup into a workspace outside its profile grant", async () => {
    const principal: GatewayPrincipal = {
      kind: "workspace",
      version: 1,
      audience: "gateway",
      projectIds: ["example"],
      credentialProfiles: ["claude-default"],
      originWorkspaceId: "one",
      originWorkspaceUid: "uid-one",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      tokenId: "56b11769-8c6c-4306-ad99-3d0d08fa2f87",
    };
    const fixture = setup(principal);
    try {
      const second = fixture.store.workspaceRows[1];
      if (!second) throw new Error("Fixture workspace is unavailable");
      second.spec.credentialProfile = "different-profile";
      await fixture.session.handle({
        type: "directory_suggestions_request",
        requestId: "denied",
        query: "marker.txt",
        cwd: "/workspaces/two",
        includeFiles: true,
        includeDirectories: false,
        matchMode: "suffix",
        limit: 1,
      });
      expect(fixture.emitted.at(-1)).toMatchObject({
        type: "rpc_error",
        payload: { requestId: "denied" },
      });
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.session.close();
    }
  });
});
