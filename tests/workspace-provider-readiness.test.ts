import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayPrincipal } from "../src/gateway/auth.js";
import type { Backend } from "../src/gateway/backend.js";
import { DirectoryGeneration, workspaceDescriptor } from "../src/gateway/catalog.js";
import { GatewaySession } from "../src/gateway/session.js";
import { MemoryStore, project, workspace } from "./fixtures.js";

const cwd = "/workspaces/one";
const loading = [{ provider: "claude", enabled: true, status: "loading", models: [] }];
const ready = [{ provider: "claude", enabled: true, status: "ready", models: [] }];
const unrelatedGlobalCatalog = [{ provider: "codex", enabled: true, status: "ready", models: [] }];
const scoped: GatewayPrincipal = {
  kind: "workspace",
  version: 1,
  audience: "test",
  issuedAt: Math.floor(Date.now() / 1000) - 1,
  expiresAt: Math.floor(Date.now() / 1000) + 60,
  tokenId: "11111111-1111-4111-8111-111111111111",
  projectIds: ["example"],
  credentialProfiles: ["claude-default"],
  originWorkspaceId: "origin",
  originWorkspaceUid: "uid-origin",
};
afterEach(() => vi.restoreAllMocks());

function fixture(principal: GatewayPrincipal = { kind: "owner" }, providerReadyTimeoutMs = 25_000) {
  const store = new MemoryStore();
  const configuredProject = store.projectRows[0];
  if (!configuredProject) throw new Error("Missing fixture Project");
  configuredProject.metadata.uid = "project-uid";
  const target = workspace("one");
  target.status = { phase: "Pending", message: "starting", observedGeneration: 1 };
  store.workspaceRows = [target];
  if (principal.kind === "workspace") store.workspaceRows.push(workspace("origin"));
  const emitted: SessionOutboundMessage[] = [];
  const requests: string[] = [];
  let push: ((message: SessionOutboundMessage) => void) | undefined;
  let currentEntries = loading;
  let providerGate: Promise<void> | undefined;
  const backend = (row: ReturnType<typeof workspace>): Backend => ({
    async connect() {},
    async close() {},
    send() {},
    binary() {},
    async request(message) {
      requests.push(message.type);
      if (message.type === "open_project_request")
        return SessionOutboundMessageSchema.parse({
          type: "open_project_response",
          payload: {
            requestId: message.requestId,
            workspace: { ...workspaceDescriptor(row, project()), id: "local" },
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
      if (message.type === "get_providers_snapshot_request") await providerGate;
      if (message.type === "get_providers_snapshot_request")
        return SessionOutboundMessageSchema.parse({
          type: "get_providers_snapshot_response",
          payload: {
            requestId: message.requestId,
            cwd: message.cwd,
            entries: currentEntries,
            generatedAt: new Date().toISOString(),
          },
        });
      throw new Error(`Unexpected backend request ${message.type}`);
    },
  });
  const session = new GatewaySession({
    store,
    principal,
    providerReadyTimeoutMs,
    providerReadyPollMs: 5,
    namespace: "test",
    backendPassword: "test",
    directory: new DirectoryGeneration(),
    hello: { type: "hello", clientId: "test", clientType: "cli", protocolVersion: 1 },
    emit: (message) => emitted.push(SessionOutboundMessageSchema.parse(message)),
    emitBinary() {},
    disconnect() {},
    backendFactory: (row, onMessage) => {
      push = onMessage;
      return backend(row);
    },
  });
  return {
    store,
    target,
    session,
    emitted,
    requests,
    setReadyCatalog: () => {
      currentEntries = ready;
    },
    holdProviderRequest: () => {
      let release!: () => void;
      providerGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    push: (message: SessionOutboundMessage) => push?.(message),
  };
}

const get = (requestId: string) =>
  ({ type: "get_providers_snapshot_request", requestId, cwd }) as const;
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace provider catalog during initial creation", () => {
  it("waits for the same UID to become Ready, then relays loading and later ready pushes", async () => {
    const f = fixture();
    const first = f.session.handle(get("first"));
    const second = f.session.handle(get("second"));
    await turn();
    expect(f.requests).toEqual([]);
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    await Promise.all([first, second]);
    expect(f.requests.filter((type) => type === "get_providers_snapshot_request")).toHaveLength(2);
    expect(
      f.emitted.filter((message) => message.type === "get_providers_snapshot_response"),
    ).toHaveLength(2);
    f.push(
      SessionOutboundMessageSchema.parse({
        type: "providers_snapshot_update",
        payload: { cwd, entries: ready, generatedAt: new Date().toISOString() },
      }),
    );
    await turn();
    expect(f.emitted.at(-1)).toMatchObject({
      type: "providers_snapshot_update",
      payload: { cwd, entries: ready },
    });
    await f.session.close();
  });

  it("rejects UID replacement during the wait before opening any backend", async () => {
    const f = fixture();
    const pending = f.session.handle(get("replaced"));
    await turn();
    f.target.metadata.uid = "different-uid";
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    await pending;
    expect(f.requests).toEqual([]);
    expect(f.emitted).toMatchObject([{ type: "rpc_error", payload: { requestId: "replaced" } }]);
    await f.session.close();
  });

  it("rechecks scoped principal authorization while waiting", async () => {
    const f = fixture(scoped);
    const pending = f.session.handle(get("revoked"));
    await turn();
    const origin = f.store.workspaceRows.find((row) => row.metadata.name === "origin");
    if (!origin) throw new Error("Missing scoped origin workspace");
    origin.spec.residency = "Suspended";
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    await pending;
    expect(f.requests).toEqual([]);
    expect(f.emitted).toMatchObject([{ type: "rpc_error", payload: { requestId: "revoked" } }]);
    await f.session.close();
  });

  it("publishes a ready update after the bounded pull times out and the Pod later becomes Ready", async () => {
    const f = fixture({ kind: "owner" }, 25);
    await f.session.handle(get("early"));
    expect(f.emitted).toMatchObject([{ type: "rpc_error", payload: { requestId: "early" } }]);
    expect(f.requests).toEqual([]);
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    f.setReadyCatalog();
    await f.session.refreshDirectory();
    for (
      let n = 0;
      n < 30 && !f.emitted.some((message) => message.type === "providers_snapshot_update");
      n++
    )
      await turn();
    expect(f.emitted.at(-1)).toMatchObject({
      type: "providers_snapshot_update",
      payload: { cwd, entries: ready },
    });
    expect(f.requests).toContain("get_providers_snapshot_request");
    await f.session.close();
  });

  it("never publishes a pending catalog after workspace identity changes", async () => {
    const f = fixture({ kind: "owner" }, 25);
    await f.session.handle(get("early"));
    f.target.metadata.uid = "replacement-uid";
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    f.setReadyCatalog();
    await f.session.refreshDirectory();
    await turn();
    expect(f.requests).toEqual([]);
    expect(f.emitted.every((message) => message.type !== "providers_snapshot_update")).toBe(true);
    await f.session.close();
  });

  it("never publishes a pending catalog after Project identity changes", async () => {
    const f = fixture({ kind: "owner" }, 25);
    await f.session.handle(get("early"));
    const configuredProject = f.store.projectRows[0];
    if (!configuredProject) throw new Error("Missing fixture Project");
    configuredProject.metadata.uid = "replacement-project-uid";
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    f.setReadyCatalog();
    await f.session.refreshDirectory();
    await turn();
    expect(f.requests).toEqual([]);
    expect(f.emitted.every((message) => message.type !== "providers_snapshot_update")).toBe(true);
    await f.session.close();
  });

  it("does not publish a delayed backend reply after the bounded interest expires", async () => {
    const f = fixture({ kind: "owner" }, 25);
    await f.session.handle(get("early"));
    const release = f.holdProviderRequest();
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    f.setReadyCatalog();
    await f.session.refreshDirectory();
    for (let n = 0; n < 30 && !f.requests.includes("get_providers_snapshot_request"); n++)
      await turn();
    expect(f.requests).toContain("get_providers_snapshot_request");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    release();
    await turn();
    expect(f.emitted.every((message) => message.type !== "providers_snapshot_update")).toBe(true);
    await f.session.close();
  });

  it("does not publish after the scoped origin is suspended", async () => {
    const f = fixture(scoped, 25);
    await f.session.handle(get("early"));
    const origin = f.store.workspaceRows.find((row) => row.metadata.name === "origin");
    if (!origin) throw new Error("Missing scoped origin workspace");
    origin.spec.residency = "Suspended";
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    f.setReadyCatalog();
    await expect(f.session.refreshDirectory()).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(f.emitted.every((message) => message.type !== "providers_snapshot_update")).toBe(true);
    await f.session.close();
  });

  it("drops native global and foreign catalog pushes, retaining only exact workspace scope", async () => {
    const f = fixture();
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    await f.session.handle(get("ready"));
    const initial = f.emitted.length;
    f.push(
      SessionOutboundMessageSchema.parse({
        type: "providers_snapshot_update",
        payload: { entries: unrelatedGlobalCatalog, generatedAt: new Date().toISOString() },
      }),
    );
    await turn();
    expect(f.emitted).toHaveLength(initial);
    f.push(
      SessionOutboundMessageSchema.parse({
        type: "providers_snapshot_update",
        payload: {
          cwd: "/workspaces/foreign",
          entries: ready,
          generatedAt: new Date().toISOString(),
        },
      }),
    );
    await turn();
    expect(f.emitted).toHaveLength(initial);
    f.push(
      SessionOutboundMessageSchema.parse({
        type: "providers_snapshot_update",
        payload: { cwd, entries: ready, generatedAt: new Date().toISOString() },
      }),
    );
    await turn();
    expect(f.emitted.at(-1)).toMatchObject({
      type: "providers_snapshot_update",
      payload: { cwd, entries: ready },
    });
    await f.session.close();
  });

  it("closes a delayed Ready read without opening a backend or sending a late response", async () => {
    const f = fixture();
    const read = f.store.workspaces.bind(f.store);
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.store.workspaces = async () => {
      calls++;
      if (calls === 2) {
        entered();
        await gate;
      }
      return read();
    };
    const pending = f.session.handle(get("closed"));
    await waiting;
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    await f.session.close();
    release();
    await pending;
    expect(f.requests).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it("cannot open a backend when the session closes during the final forward validation", async () => {
    const f = fixture();
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    const read = f.store.workspaces.bind(f.store);
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.store.workspaces = async () => {
      calls++;
      if (calls === 2) {
        entered();
        await gate;
      }
      return read();
    };
    const pending = f.session.handle(get("closed-forward"));
    await waiting;
    await f.session.close();
    release();
    await pending;
    expect(f.requests).toEqual([]);
    expect(f.emitted).toEqual([]);
  });

  it("does not cap ordinary catalog reads across five Ready workspaces", async () => {
    const f = fixture();
    f.target.status = { phase: "Ready", message: "ready", observedGeneration: 1 };
    for (const name of ["two", "three", "four", "five"])
      f.store.workspaceRows.push(workspace(name));
    for (const name of ["one", "two", "three", "four", "five"])
      await f.session.handle({
        type: "get_providers_snapshot_request",
        requestId: `ready-${name}`,
        cwd: `/workspaces/${name}`,
      });
    expect(
      f.emitted.filter((message) => message.type === "get_providers_snapshot_response"),
    ).toHaveLength(5);
    expect(f.emitted.some((message) => message.type === "rpc_error")).toBe(false);
    await f.session.close();
  });
});
